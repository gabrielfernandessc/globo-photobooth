/* ══════════════════════════════════════════════════════════
   CÂMERA DSLR VIA GPHOTO2

   A câmera é um recurso EXCLUSIVO: um processo por vez segura o USB.
   Não existe live view e captura ao mesmo tempo — é a restrição que
   define todo o desenho deste módulo.

   Por isso o ciclo é:

     live view  →  parar  →  disparar  →  live view

   O intervalo em que o preview congela cai exatamente sobre o disparo,
   que é quando o convidado espera que a imagem congele de qualquer
   forma. A limitação técnica coincide com a expectativa do usuário, e
   por isso ela não precisa ser escondida — precisa ser sincronizada.

   Fala com o binário gphoto2 em vez de usar binding nativo: o binário é
   o caminho mais testado do libgphoto2, sobrevive a atualização de
   Node, e quando quebra dá para reproduzir o erro na mão.
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SOI = Buffer.from([0xff, 0xd8, 0xff]); // início de um JPEG
const EOI = Buffer.from([0xff, 0xd9]);       // fim
const MODO_PROGRAMA_CANON = '/main/capturesettings/autoexposuremodedial=P';
const ABRIR_FLASH_CANON = '/main/actions/popupflash=1';

/**
 * Tempo para a sessão PTP terminar de fechar antes do obturador.
 *
 * A Sony precisa de uma margem maior; a Canon EOS abre e fecha a sessão
 * bem mais rápido. O preparo acontece durante o número 1, portanto este
 * tempo não aparece depois da contagem.
 */
function tempoAssentamento(modelo = '') {
  if (/sony/i.test(modelo)) return 600;
  if (/canon|eos/i.test(modelo)) return 120;
  return 300;
}

function prioridadeDaCamera(modelo = '') {
  if (/canon|eos/i.test(modelo)) return 0;
  if (/nikon|fujifilm|lumix|panasonic|olympus|om system/i.test(modelo)) return 1;
  if (/sony|alpha|ilce/i.test(modelo)) return 2;
  return 10;
}

function escolherCameraDetectada(saida = '') {
  const cameras = [];
  for (const linha of saida.split('\n').slice(2)) {
    const achado = /^(.+?)\s+(usb:[\d,]*)\s*$/.exec(linha.trim());
    if (!achado) continue;

    const modelo = achado[1].trim();
    // Celulares em MTP aparecem no gphoto2, mas não oferecem live view
    // nem obturador remoto e não podem tomar o lugar da DSLR do evento.
    if (/\b(mtp|galaxy|android|iphone|ipad|pixel)\b/i.test(modelo)) continue;
    cameras.push({ modelo, porta: achado[2] });
  }

  cameras.sort((a, b) => prioridadeDaCamera(a.modelo) - prioridadeDaCamera(b.modelo));
  return cameras[0] || null;
}

/**
 * Estados possíveis. Explícitos porque o meio do caminho importa: o
 * telão precisa saber a diferença entre "sem câmera" e "câmera ocupada
 * disparando", e o operador precisa saber a diferença entre "religando"
 * e "desistiu".
 */
const ESTADO = {
  PARADA: 'parada',
  PROCURANDO: 'procurando',
  LIVE_VIEW: 'live_view',
  PREPARANDO: 'preparando',
  DISPARANDO: 'disparando',
  RELIGANDO: 'religando',
  FALHA: 'falha',
};

function createGphotoCamera({
  preview,
  sessionCode = null,
  log = () => {},
  binario = 'gphoto2',
  pastaTemp = path.join(os.tmpdir(), 'globo-photobooth-capturas'),
  /** Sonda de USB, injetada pelo teste para não ler o hardware real. */
  sondarUsb = null,
  intervaloReconexaoMs = 3_000,
  timeoutPrimeiroQuadroMs = 8_000,
  timeoutEntreQuadrosMs = 5_000,
  streamsMudosAntesReset = 2,
  esperaAposResetMs = 1_200,
  intervaloPreferenciaMs = 5_000,
} = {}) {
  let estado = ESTADO.PARADA;
  let processoLive = null;
  let camera = null; // { modelo, porta }
  let ultimoErro = null;
  let quadros = 0;
  let ultimoQuadroEm = 0;
  let pararPedido = false;
  let timerReconexao = null;
  let reconexaoEmCurso = null;
  let streamsMudosConsecutivos = 0;
  let resetsUsbConsecutivos = 0;
  let resetarPortaNaReconexao = false;
  let conflitoSonyAtivo = false;
  let preparoEmCurso = null;
  let preparadaEm = 0;
  let timerExpirarPreparo = null;
  let estadoAntesPreparo = ESTADO.PARADA;
  let capturaEmCurso = false;
  let configuracaoEmCurso = null;
  let trocaCameraEmCurso = false;
  let timerCameraPreferida = null;
  let estadoFlash = {
    suportado: null,
    podeLevantar: false,
    podeRecolher: false,
    carregado: null,
    acionadoEm: null,
  };
  const ouvintes = new Set();

  fs.mkdirSync(pastaTemp, { recursive: true });

  function mudarEstado(novo, detalhe = {}) {
    if (estado === novo) return;
    const anterior = estado;
    estado = novo;
    log('info', 'camera_estado', { de: anterior, para: novo, ...detalhe });
    for (const ouvir of ouvintes) {
      try { ouvir({ estado: novo, anterior, modelo: camera?.modelo || null, erro: ultimoErro, ...detalhe }); } catch { /* ouvinte ruim não derruba a câmera */ }
    }
  }

  function executar(args, { timeoutMs = 60_000 } = {}) {
    return new Promise(resolve => {
      execFile(binario, args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LANG: 'C' },
      }, (err, stdout, stderr) => resolve({ ok: !err, err, stdout: stdout || '', stderr: stderr || '' }));
    });
  }

  const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

  function processoExiste(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * O macOS assume a câmera PTP assim que ela conecta e o gphoto2 recebe
   * "could not claim the USB device". Derrubar o PTPCamera é obrigatório
   * e precisa ser refeito a cada reconexão, não só no boot.
   */
  async function liberarCamera() {
    /* Um gphoto2 órfão segura o USB e faz o processo novo morrer com
       "Movie capture finished (0 frames)" — sem dizer o motivo.
       Acontece sempre que o servidor cai sem encerrar o filho, que é
       justamente o caso em que alguém vai reiniciar às pressas.

       Mata só os que NÃO são nossos: o próprio live view em andamento
       tem que sobreviver a uma redetecção. */
    const binarioReal = binario === 'gphoto2'
      || /\/(?:opt\/homebrew|usr\/local|usr)\/bin\/gphoto2$/.test(binario);

    if (binarioReal) await new Promise(resolve => {
      execFile('pgrep', ['-x', 'gphoto2'], (err, saida) => {
        const meu = processoLive?.pid;
        const orfaos = (saida || '')
          .split('\n')
          .map(n => parseInt(n, 10))
          .filter(pid => Number.isFinite(pid) && pid !== meu && pid !== process.pid);

        for (const pid of orfaos) {
          try {
            process.kill(pid, 'SIGTERM');
            log('warn', 'gphoto2 órfão solicitado a encerrar', { pid, motivo: 'segurava o USB' });
          } catch { /* já morreu */ }
        }

        if (!orfaos.length) return resolve();
        setTimeout(() => {
          for (const pid of orfaos) {
            if (!processoExiste(pid)) continue;
            try {
              process.kill(pid, 'SIGKILL');
              log('warn', 'gphoto2 órfão forçado a encerrar', { pid, motivo: 'ignorou SIGTERM' });
            } catch { /* já morreu */ }
          }
          resolve();
        }, 900);
      });
    });

    if (process.platform !== 'darwin') return;
    // O macOS assume a câmera PTP assim que ela conecta. O icdd faz o
    // mesmo em nome do Image Capture e reaparece depois de reconectar.
    for (const processo of ['PTPCamera', 'icdd']) {
      await new Promise(resolve => execFile('pkill', ['-x', processo], () => resolve()));
    }

    conflitoSonyAtivo = await new Promise(resolve => {
      execFile('pgrep', ['-f', 'com.sony.imagingedge.iew.CameraExt'], (err, saida) => {
        resolve(!err && String(saida || '').trim().length > 0);
      });
    });
  }

  /**
   * Lê a câmera do --auto-detect.
   *
   * O nome do modelo pode conter espaços e parênteses ("Sony Alpha-A7
   * III (PC Control)"), e a coluna da porta é separada por um número
   * variável de espaços — a Sony imprime só um. Ancorar na PORTA, que
   * tem formato fixo (`usb:` seguido de dígitos e vírgulas), é a única
   * leitura que não depende do alinhamento das colunas.
   */
  async function detectar() {
    await liberarCamera();
    const r = await executar(['--auto-detect'], { timeoutMs: 15_000 });
    return escolherCameraDetectada(r.stdout);
  }

  async function verificarCameraPreferida() {
    if (
      !camera ||
      prioridadeDaCamera(camera.modelo) === 0 ||
      estado !== ESTADO.LIVE_VIEW ||
      capturaEmCurso ||
      preparoEmCurso ||
      configuracaoEmCurso ||
      reconexaoEmCurso ||
      trocaCameraEmCurso
    ) return;

    const r = await executar(['--auto-detect'], { timeoutMs: 15_000 });
    if (pararPedido) return;
    const preferida = escolherCameraDetectada(r.stdout);
    if (!preferida || prioridadeDaCamera(preferida.modelo) >= prioridadeDaCamera(camera.modelo)) return;
    if (capturaEmCurso || preparoEmCurso || configuracaoEmCurso || reconexaoEmCurso) return;

    trocaCameraEmCurso = true;
    const anterior = camera;
    try {
      mudarEstado(ESTADO.PREPARANDO, {
        modelo: anterior.modelo,
        operacao: `trocar para ${preferida.modelo}`,
      });
      await pararLiveView();
      await liberarCamera();
      if (pararPedido) return;
      camera = preferida;
      ultimoErro = null;
      streamsMudosConsecutivos = 0;
      resetsUsbConsecutivos = 0;
      resetarPortaNaReconexao = false;
      log('info', 'camera_preferida_selecionada', {
        anterior: anterior.modelo,
        modelo: preferida.modelo,
        porta: preferida.porta,
      });
      mudarEstado(ESTADO.RELIGANDO, { modelo: preferida.modelo });
      iniciarLiveView();
    } catch (err) {
      if (!pararPedido) {
        camera = anterior;
        ultimoErro = err.message;
        mudarEstado(ESTADO.RELIGANDO, { modelo: anterior.modelo });
        iniciarLiveView();
      }
      throw err;
    } finally {
      trocaCameraEmCurso = false;
    }
  }

  function iniciarVigilanciaDaCameraPreferida() {
    if (timerCameraPreferida) return;
    timerCameraPreferida = setInterval(() => {
      verificarCameraPreferida().catch(err => {
        log('warn', 'camera_preferida_falhou', { erro: err.message });
      });
    }, intervaloPreferenciaMs);
    timerCameraPreferida.unref?.();
  }

  /** Identifica a câmera para o gphoto2 — modelo e porta exatos. */
  function alvo() {
    return ['--camera', camera.modelo, '--port', camera.porta];
  }

  /* ── Live view ─────────────────────────────────────────── */

  /**
   * `--capture-movie --stdout` entrega um MJPEG contínuo. Os quadros
   * chegam picotados pelo pipe, então é preciso remontar procurando os
   * marcadores de início e fim de JPEG.
   */
  function iniciarLiveView({ preservarEstado = false } = {}) {
    if (processoLive || !camera) return;

    let buffer = Buffer.alloc(0);
    let erroSaida = '';
    let quadrosDoStream = 0;
    let streamMudoRegistrado = false;
    ultimoQuadroEm = 0;

    const proc = spawn(binario, [...alvo(), '--capture-movie', '--stdout'], {
      env: { ...process.env, LANG: 'C' },
    });
    processoLive = proc;

    /* Às vezes a Sony aceita a sessão PTP e fica eternamente em
       "A conectar...": o processo continua vivo, mas não entrega nem um
       quadro e, portanto, também não fecha para acionar a recuperação.
       Um stream mudo é tão quebrado quanto um processo morto. */
    function registrarStreamMudo(motivo) {
      if (streamMudoRegistrado) return;
      streamMudoRegistrado = true;
      streamsMudosConsecutivos++;
      const limite = /canon|eos/i.test(camera?.modelo || '') ? 1 : streamsMudosAntesReset;
      if (streamsMudosConsecutivos >= limite) {
        resetarPortaNaReconexao = true;
      }
      const canonPtpTravada = /canon|eos/i.test(camera?.modelo || '') && resetsUsbConsecutivos >= 2;
      ultimoErro = conflitoSonyAtivo
        ? 'Sony Imaging Edge Camera Extension está ativa e bloqueando a câmera — desative-a em Ajustes do Sistema > Geral > Itens de Início e Extensões > Extensões de Câmera'
        : canonPtpTravada
          ? 'a Canon está no cabo, mas a sessão USB travou — desligue e ligue a câmera uma vez; o app reconecta sozinho'
        : motivo;
      log('warn', 'live_view_sem_quadros', {
        erro: ultimoErro,
        conflitoSony: conflitoSonyAtivo,
        tentativas: streamsMudosConsecutivos,
        resetUsb: resetarPortaNaReconexao,
      });
    }

    const vigiarPrimeiroQuadro = setTimeout(() => {
      if (processoLive !== proc || quadrosDoStream > 0) return;
      registrarStreamMudo(`live view não entregou nenhum quadro em ${timeoutPrimeiroQuadroMs} ms`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (processoLive === proc) proc.kill('SIGKILL');
      }, 1500).unref?.();
    }, timeoutPrimeiroQuadroMs);
    vigiarPrimeiroQuadro.unref?.();

    /* O processo também pode congelar DEPOIS de já ter transmitido.
       Neste caso o watchdog do primeiro quadro já acabou, o PID segue
       vivo e só o status passa a dizer `transmitindo=false`. Sem esta
       segunda vigilância, o telão ficaria eternamente reconectando. */
    const vigiarFluxo = setInterval(() => {
      if (processoLive !== proc || quadrosDoStream === 0) return;
      const idadeMs = Date.now() - ultimoQuadroEm;
      if (idadeMs <= timeoutEntreQuadrosMs) return;

      ultimoErro = `live view congelou por ${idadeMs} ms`;
      log('warn', 'live_view_congelado', { erro: ultimoErro, quadros: quadrosDoStream });
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (processoLive === proc) proc.kill('SIGKILL');
      }, 1500).unref?.();
    }, Math.min(1000, Math.max(50, Math.floor(timeoutEntreQuadrosMs / 3))));
    vigiarFluxo.unref?.();

    proc.stdout.on('data', pedaco => {
      buffer = Buffer.concat([buffer, pedaco]);

      let inicio;
      while ((inicio = buffer.indexOf(SOI)) !== -1) {
        const fim = buffer.indexOf(EOI, inicio + SOI.length);
        if (fim === -1) break; // quadro ainda incompleto

        const jpeg = buffer.subarray(inicio, fim + EOI.length);
        buffer = buffer.subarray(fim + EOI.length);

        quadros++;
        quadrosDoStream++;
        ultimoQuadroEm = Date.now();
        if (quadrosDoStream === 1) {
          clearTimeout(vigiarPrimeiroQuadro);
          streamsMudosConsecutivos = 0;
          resetsUsbConsecutivos = 0;
          resetarPortaNaReconexao = false;
          ultimoErro = null;
          mudarEstado(ESTADO.LIVE_VIEW, { modelo: camera.modelo });
        }
        if (preview && sessionCode) preview.publicar(sessionCode, jpeg);
      }

      // Um buffer que só cresce significa lixo sem EOI: descarta para
      // não vazar memória ao longo de horas de evento.
      if (buffer.length > 8 * 1024 * 1024) buffer = Buffer.alloc(0);
    });

    proc.stderr.on('data', d => { erroSaida += d.toString().slice(-500); });

    proc.on('close', code => {
      clearTimeout(vigiarPrimeiroQuadro);
      clearInterval(vigiarFluxo);
      processoLive = null;

      // Encerramento pedido por nós (para disparar, ou para parar) não é
      // falha e não deve religar nada.
      if (pararPedido || estado === ESTADO.PREPARANDO || estado === ESTADO.DISPARANDO || estado === ESTADO.PARADA) return;

      const saida = erroSaida.trim().split('\n').filter(Boolean).pop() || '';

      /* Algumas Canon encerram por conta própria exatamente no quinto
         segundo com “Movie capture finished (0 frames)”. Isso acontece
         ANTES do watchdog de 8 s e antes passava despercebido para
         sempre. Zero quadros é falha mesmo quando o exit code é 0. */
      if (quadrosDoStream === 0) {
        registrarStreamMudo(saida || 'live view encerrou sem entregar quadros');
      }

      /* A Sony encerra o live view sozinha depois de alguns segundos e
         o gphoto2 sai com "Movie capture finished (N frames)" — código
         0, sem erro. Tratar isso como queda deixaria o telão preto a
         cada 20 segundos.

         O certo é reabrir na hora: a câmera continua ali, não há o que
         redetectar. Sem atraso e sem trocar de estado, a emenda fica
         invisível para quem está olhando. */
      const fimNormal = code === 0 && /movie capture finished/i.test(saida);
      if (fimNormal && quadrosDoStream > 0) {
        log('info', 'live_view_reaberto', { motivo: 'a câmera encerrou o stream sozinha', quadros: quadrosDoStream });
        // A Canon entrega o live view em blocos curtos. O último quadro
        // continua visível enquanto o próximo processo abre; anunciar
        // “reconectando” a cada bloco criaria uma falha que não existe.
        setImmediate(() => {
          if (!pararPedido && !processoLive) iniciarLiveView({ preservarEstado: true });
        });
        return;
      }

      ultimoErro = saida || `gphoto2 saiu com código ${code}`;
      log('warn', 'live_view_caiu', { erro: ultimoErro });
      mudarEstado(ESTADO.RELIGANDO);
      agendarReconexao(1500);
    });

    proc.on('error', err => {
      clearTimeout(vigiarPrimeiroQuadro);
      clearInterval(vigiarFluxo);
      ultimoErro = err.message;
      processoLive = null;
      mudarEstado(ESTADO.FALHA, { erro: err.message });
      agendarReconexao();
    });

    if (!preservarEstado) mudarEstado(ESTADO.RELIGANDO, { modelo: camera.modelo });
  }

  function pararLiveView() {
    const proc = processoLive;
    if (!proc) return Promise.resolve();
    processoLive = null;

    return new Promise(resolve => {
      // SIGTERM primeiro para o gphoto2 fechar a sessão PTP direito; um
      // SIGKILL deixa a câmera num estado em que a próxima conexão falha.
      const forcar = setTimeout(() => proc.kill('SIGKILL'), 2500);
      proc.once('close', () => { clearTimeout(forcar); resolve(); });
      proc.kill('SIGTERM');
    });
  }

  function cancelarExpiracaoDoPreparo() {
    if (timerExpirarPreparo) clearTimeout(timerExpirarPreparo);
    timerExpirarPreparo = null;
  }

  function restaurarLiveViewAposPreparo(motivo) {
    cancelarExpiracaoDoPreparo();
    preparadaEm = 0;
    estadoAntesPreparo = ESTADO.PARADA;
    if (pararPedido || capturaEmCurso || processoLive || !camera) return;

    log('info', 'camera_preparo_cancelado', { motivo });
    mudarEstado(ESTADO.RELIGANDO, { modelo: camera.modelo });
    iniciarLiveView();
  }

  /**
   * Solta o live view durante o último número da contagem.
   *
   * Antes, esses passos começavam somente depois do zero e faziam o
   * convidado ficar parado em “Sorria!” enquanto a sessão PTP fechava.
   * O preparo expira sozinho: uma contagem cancelada nunca deixa a
   * câmera presa fora do live view.
   */
  async function prepararCaptura({ validadeMs = 4_000, flash = false } = {}) {
    if (capturaEmCurso) throw new Error('Já existe um disparo em andamento');
    if (configuracaoEmCurso) throw new Error('A câmera está ocupada ajustando a configuração');
    if (trocaCameraEmCurso) throw new Error('A câmera está trocando para o modelo preferido');
    if (!camera) throw new Error('Nenhuma câmera conectada');
    if (preparadaEm) {
      return { pronta: true, ms: 0, assentamentoMs: tempoAssentamento(camera.modelo) };
    }
    if (preparoEmCurso) return preparoEmCurso;

    const inicio = Date.now();
    const modelo = camera.modelo;
    const assentamentoMs = tempoAssentamento(modelo);
    estadoAntesPreparo = estado;
    mudarEstado(ESTADO.PREPARANDO, { modelo });

    preparoEmCurso = (async () => {
      try {
        await pararLiveView();
        let flashResultado = null;
        if (flash) {
          try {
            flashResultado = await acionarFlashInterno();
          } catch (err) {
            flashResultado = { suportado: false, erro: err.message };
            log('warn', 'flash_nao_acionado', { modelo, erro: err.message });
          }
        }
        await esperar(assentamentoMs);
        if (pararPedido) throw new Error('Câmera foi encerrada durante o preparo');

        preparadaEm = Date.now();
        cancelarExpiracaoDoPreparo();
        timerExpirarPreparo = setTimeout(
          () => restaurarLiveViewAposPreparo('o disparo não chegou a tempo'),
          validadeMs,
        );
        timerExpirarPreparo.unref?.();

        const ms = Date.now() - inicio;
        log('info', 'camera_preparada', { modelo, ms, assentamentoMs });
        return { pronta: true, ms, assentamentoMs, flash: flashResultado };
      } catch (err) {
        preparadaEm = 0;
        if (!pararPedido && camera) {
          mudarEstado(ESTADO.RELIGANDO, { modelo: camera.modelo });
          iniciarLiveView();
        }
        throw err;
      } finally {
        preparoEmCurso = null;
      }
    })();

    return preparoEmCurso;
  }

  /**
   * A câmera está no cabo, mas em modo errado?
   *
   * Uma câmera em "Armazenamento em Massa" aparece para o sistema como
   * disco e é invisível ao gphoto2 — exatamente o mesmo sintoma de cabo
   * desconectado, com solução completamente diferente. E o modo VOLTA
   * sozinho: um erro de cartão que peça recuperação reseta a
   * configuração da Sony.
   *
   * Distinguir os dois casos é a diferença entre o operador procurar o
   * cabo e ele abrir o menu certo.
   */
  async function conectadaMasSemPtp() {
    // Injetável: sem isso o teste com gphoto2 falso leria o USB real da
    // máquina e mudaria de resultado conforme houvesse ou não uma
    // câmera de verdade plugada.
    if (sondarUsb) return sondarUsb();
    if (process.platform !== 'darwin') return false;
    return new Promise(resolve => {
      execFile('ioreg', ['-p', 'IOUSB', '-w0', '-l'], { maxBuffer: 8 * 1024 * 1024 }, (err, saida) => {
        if (err) return resolve(false);
        resolve(/ILCE|Canon|EOS|Nikon|"Sony"/i.test(saida || ''));
      });
    });
  }

  function cancelarReconexao() {
    if (!timerReconexao) return;
    clearTimeout(timerReconexao);
    timerReconexao = null;
  }

  function agendarReconexao(atrasoMs = intervaloReconexaoMs) {
    if (pararPedido || timerReconexao || processoLive) return;
    timerReconexao = setTimeout(() => {
      timerReconexao = null;
      religar();
    }, atrasoMs);
  }

  /**
   * Reenumera a porta USB quando a Sony aceita a sessão PTP mas não
   * entrega nenhum comando. Matar e recriar o processo não basta nesse
   * estado: a trava ficou no dispositivo, não no gphoto2.
   */
  async function resetarPortaUsb() {
    if (!camera) return false;

    resetsUsbConsecutivos++;
    log('warn', 'camera_usb_reset', {
      modelo: camera.modelo,
      porta: camera.porta,
      motivo: `${streamsMudosConsecutivos} streams sem quadros`,
      consecutivo: resetsUsbConsecutivos,
    });

    const r = await executar([...alvo(), '--reset'], { timeoutMs: 12_000 });
    if (!r.ok) {
      log('warn', 'camera_usb_reset_falhou', {
        erro: (r.stderr || r.stdout || r.err?.message || '').trim(),
      });
    }

    // O reset muda usb:001,001 para usb:001,002. A porta antiga nunca
    // pode ser reaproveitada; a próxima detecção precisa encontrá-la.
    camera = null;
    await new Promise(resolve => setTimeout(resolve, esperaAposResetMs));
    return r.ok;
  }

  async function religar() {
    if (pararPedido) return false;
    if (reconexaoEmCurso) return reconexaoEmCurso;

    reconexaoEmCurso = (async () => {
      mudarEstado(ESTADO.PROCURANDO);

      if (resetarPortaNaReconexao && camera) {
        resetarPortaNaReconexao = false;
        await resetarPortaUsb();
      }

      camera = await detectar();

      if (pararPedido) return false;

      if (!camera) {
        ultimoErro = (await conectadaMasSemPtp())
          ? 'a câmera está no cabo mas não respondeu para captura — confirme "Ligação USB" = PC Remoto; se já estiver, desligue e ligue a câmera ou reconecte o cabo USB'
          : 'nenhuma câmera detectada — confira o cabo e se ela está ligada';
        mudarEstado(ESTADO.FALHA, { erro: ultimoErro });
        agendarReconexao();
        return false;
      }

      cancelarReconexao();
      iniciarLiveView();
      return true;
    })();

    try {
      return await reconexaoEmCurso;
    } finally {
      reconexaoEmCurso = null;
    }
  }

  /* ── Captura ───────────────────────────────────────────── */

  /**
   * O disparo em si. Para o live view, fotografa, e devolve o live view.
   *
   * Devolve o CAMINHO do arquivo, não os bytes: uma foto de 24 MP são
   * dezenas de MB, e carregá-la inteira em memória a cada captura é
   * como um totem começa a engasgar depois de uma hora de evento.
   */
  async function capturar({ timeoutMs = 45_000, flash = false } = {}) {
    if (capturaEmCurso) throw new Error('Já existe um disparo em andamento');
    if (configuracaoEmCurso) throw new Error('A câmera está ocupada ajustando a configuração');
    if (trocaCameraEmCurso) throw new Error('A câmera está trocando para o modelo preferido');
    if (!camera) throw new Error('Nenhuma câmera conectada');

    capturaEmCurso = true;
    const comecou = Date.now();
    let usouPreparo = false;

    try {
      if (preparoEmCurso) await preparoEmCurso;
      usouPreparo = !!preparadaEm;

      cancelarExpiracaoDoPreparo();

      if (!usouPreparo) {
        // Fallback para chamadas diretas da API e ferramentas antigas:
        // continuam seguras, apenas não escondem o preparo na contagem.
        estadoAntesPreparo = estado;
        mudarEstado(ESTADO.PREPARANDO, { modelo: camera.modelo });
        await pararLiveView();
        await esperar(tempoAssentamento(camera.modelo));
      }

      const nome = `captura_${Date.now()}`;
      const destino = path.join(pastaTemp, `${nome}.%C`);

      preparadaEm = 0;
      mudarEstado(ESTADO.DISPARANDO, { modelo: camera.modelo, prearmada: usouPreparo });
      const comandoComecou = Date.now();
      const argumentos = [...alvo()];

      /* O popup e o obturador precisam compartilhar a sessão PTP.
         Na T6i, abrir o flash num processo gphoto2 e fotografar em outro
         deixa o corpo fisicamente aberto, mas às vezes não arma o disparo. */
      if (flash) {
        argumentos.push(
          '--set-config', MODO_PROGRAMA_CANON,
          '--set-config', ABRIR_FLASH_CANON,
        );
      }
      argumentos.push(
        '--capture-image-and-download',
        '--filename', destino,
        '--force-overwrite',
      );

      const r = await executar(argumentos, { timeoutMs });

      const gerados = fs.readdirSync(pastaTemp)
        .filter(f => f.startsWith(nome))
        .map(f => path.join(pastaTemp, f))
        .filter(f => fs.statSync(f).size > 0);

      /* O ARQUIVO manda, não o código de saída.
         A Sony devolve "PTP I/O Error" ao fim de um disparo que
         funcionou: a foto desce inteira e só então a sessão PTP
         reclama. Confiar no exit code jogaria fora uma foto que existe
         no disco — e perder a foto do convidado é o pior desfecho
         possível deste sistema. */
      if (!gerados.length) {
        const motivo = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() || 'falha desconhecida';
        throw new Error(`Disparo falhou: ${motivo}`);
      }

      if (!r.ok) {
        log('warn', 'gphoto2 reclamou mas a foto veio', {
          arquivos: gerados.length,
          aviso: (r.stderr || '').trim().split('\n').filter(Boolean).pop(),
        });
      }

      // Com RAW+JPEG a câmera devolve os dois; o JPEG é o que segue no
      // pipeline, e o RAW fica no cartão.
      const jpeg = gerados.find(f => /\.jpe?g$/i.test(f)) || gerados[0];

      log('info', 'captura_concluida', {
        arquivo: path.basename(jpeg),
        bytes: fs.statSync(jpeg).size,
        ms: Date.now() - comecou,
        comandoMs: Date.now() - comandoComecou,
        prearmada: usouPreparo,
        flash,
      });

      return {
        arquivo: jpeg,
        todos: gerados,
        ms: Date.now() - comecou,
        comandoMs: Date.now() - comandoComecou,
        prearmada: usouPreparo,
        flash,
      };
    } finally {
      capturaEmCurso = false;
      preparadaEm = 0;
      cancelarExpiracaoDoPreparo();
      estadoAntesPreparo = ESTADO.PARADA;
      // O live view volta mesmo se o disparo falhar: um erro numa foto
      // não pode deixar o telão preto pelo resto do evento.
      if (!pararPedido && camera) {
        mudarEstado(ESTADO.RELIGANDO);
        iniciarLiveView();
      }
    }
  }

  /* ── Perfil da câmera ──────────────────────────────────── */

  /**
   * Ajustes que definem a foto do evento e que a câmera perde sozinha.
   *
   * Um erro de cartão que peça recuperação reseta a configuração da
   * Sony — aconteceu no desenvolvimento e vai acontecer num evento. Sem
   * um perfil guardado, o operador reconfigura de cabeça às 22h e a
   * chance de esquecer um item é alta.
   *
   * O que NÃO está aqui, e não pode estar: "Ligação USB = PC Remoto".
   * Ela é a porta por onde o gphoto2 fala com a câmera; se estiver
   * fechada, não há como abri-la por software. Essa continua sendo a
   * única etapa obrigatoriamente manual.
   */
  const AJUSTES_DO_PERFIL = [
    'imagesize',      // L / M / S
    'imagequality',   // JPEG fine / extra fine
    'imageformat',    // Canon: RAW/JPEG e tamanho numa chave só
    'aspectratio',    // 3:2 / 16:9
    'iso',
    'f-number',
    'aperture',       // Canon usa este nome onde a Sony usa f-number
    'shutterspeed',
    'whitebalance',
    'capturetarget',
  ];

  /**
   * Perfil e flash também abrem uma sessão PTP. Parar o live view antes
   * de qualquer um deles evita que dois processos gphoto2 disputem o USB
   * e deixa a câmera num estado recuperável mesmo quando o comando falha.
   */
  async function comCameraExclusiva(nome, operacao) {
    if (!camera) throw new Error('Nenhuma câmera conectada');
    if (trocaCameraEmCurso) throw new Error('A câmera está trocando para o modelo preferido');
    if (capturaEmCurso || preparoEmCurso || preparadaEm) {
      throw new Error('A câmera está ocupada preparando ou tirando uma foto');
    }
    if (configuracaoEmCurso) throw new Error('A câmera já está ajustando outra configuração');

    const modelo = camera.modelo;
    configuracaoEmCurso = (async () => {
      mudarEstado(ESTADO.PREPARANDO, { modelo, operacao: nome });
      await pararLiveView();
      await esperar(tempoAssentamento(modelo));
      if (pararPedido) throw new Error('Câmera foi encerrada durante o ajuste');
      return operacao();
    })();

    try {
      return await configuracaoEmCurso;
    } finally {
      configuracaoEmCurso = null;
      if (!pararPedido && camera) {
        mudarEstado(ESTADO.RELIGANDO, { modelo: camera.modelo });
        iniciarLiveView();
      }
    }
  }

  function valorAtual(saida) {
    return /^Current:\s*(.*)$/m.exec(saida || '')?.[1]?.trim() ?? null;
  }

  function motivoGphoto(resultado) {
    return (resultado.stderr || resultado.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop() || 'comando recusado pela câmera';
  }

  async function lerCargaFlash() {
    const carga = await executar([
      ...alvo(), '--get-config', '/main/settings/flashcharged',
    ], { timeoutMs: 15_000 });
    if (!carga.ok) return null;

    const atual = valorAtual(carga.stdout);
    if (atual === '1') return true;
    if (atual === '0') return false;
    return null;
  }

  async function consultarFlashInterno() {
    const popup = await executar([
      ...alvo(), '--get-config', '/main/actions/popupflash',
    ], { timeoutMs: 15_000 });

    if (!popup.ok) {
      estadoFlash = {
        suportado: false,
        podeLevantar: false,
        podeRecolher: false,
        carregado: null,
        acionadoEm: null,
      };
      return { ...estadoFlash };
    }

    estadoFlash = {
      ...estadoFlash,
      suportado: true,
      podeLevantar: true,
      // O flash embutido da T6i tem mola para abrir, mas não motor para
      // fechar. Dizer o contrário faria o operador acreditar que está sem
      // flash quando o corpo ainda vai dispará-lo.
      podeRecolher: false,
      carregado: await lerCargaFlash(),
    };
    return { ...estadoFlash };
  }

  async function acionarFlashInterno() {
    const resultado = await executar([
      ...alvo(),
      // Em Auto, a T6i pode abrir o flash e ainda decidir não dispará-lo.
      // P mantém a exposição automática, mas torna o popup um flash forçado.
      '--set-config', MODO_PROGRAMA_CANON,
      '--set-config', ABRIR_FLASH_CANON,
    ], { timeoutMs: 15_000 });

    if (!resultado.ok) {
      estadoFlash = {
        suportado: false,
        podeLevantar: false,
        podeRecolher: false,
        carregado: null,
        acionadoEm: null,
      };
      throw new Error(`Esta câmera não permite levantar o flash pelo app: ${motivoGphoto(resultado)}`);
    }

    estadoFlash = {
      suportado: true,
      podeLevantar: true,
      podeRecolher: false,
      carregado: await lerCargaFlash(),
      acionadoEm: Date.now(),
    };
    log('info', 'flash_interno_acionado', { modelo: camera.modelo, carregado: estadoFlash.carregado });
    return { ...estadoFlash, comandoEnviado: true };
  }

  function lerFlash() {
    return comCameraExclusiva('consultar flash', consultarFlashInterno);
  }

  function levantarFlash() {
    return comCameraExclusiva('levantar flash', acionarFlashInterno);
  }

  async function lerPerfil() {
    return comCameraExclusiva('ler perfil', async () => {
      const perfil = {};
      for (const chave of AJUSTES_DO_PERFIL) {
        const r = await executar([...alvo(), '--get-config', chave], { timeoutMs: 15_000 });
        if (!r.ok) continue; // o corpo não expõe este ajuste; seguir adiante

        const valor = valorAtual(r.stdout);
        if (valor) perfil[chave] = valor;
      }
      return perfil;
    });
  }

  /**
   * Reaplica o perfil, item a item.
   *
   * Um ajuste que a câmera recusa não pode abortar os demais: é melhor
   * restaurar seis de oito e dizer quais faltaram do que não restaurar
   * nada porque um item mudou de nome entre firmwares.
   */
  async function aplicarPerfil(perfil = {}) {
    return comCameraExclusiva('aplicar perfil', async () => {
      const aplicados = [];
      const recusados = [];

      for (const [chave, valor] of Object.entries(perfil)) {
        const r = await executar([...alvo(), '--set-config', `${chave}=${valor}`], { timeoutMs: 15_000 });
        (r.ok ? aplicados : recusados).push(chave);
      }

      log('info', 'perfil da câmera reaplicado', { aplicados: aplicados.length, recusados });
      return { aplicados, recusados };
    });
  }

  /* ── Ciclo de vida ─────────────────────────────────────── */

  return {
    ESTADO,

    async start() {
      pararPedido = false;
      const conectou = await religar();
      iniciarVigilanciaDaCameraPreferida();
      return conectou;
    },

    async stop() {
      pararPedido = true;
      if (timerCameraPreferida) clearInterval(timerCameraPreferida);
      timerCameraPreferida = null;
      cancelarReconexao();
      cancelarExpiracaoDoPreparo();
      if (preparoEmCurso) await preparoEmCurso.catch(() => {});
      if (configuracaoEmCurso) await configuracaoEmCurso.catch(() => {});
      preparadaEm = 0;
      await pararLiveView();
      mudarEstado(ESTADO.PARADA);
    },

    prepararCaptura,
    capturar,
    lerFlash,
    levantarFlash,
    lerPerfil,
    aplicarPerfil,

    onChange(ouvir) {
      ouvintes.add(ouvir);
      return () => ouvintes.delete(ouvir);
    },

    status() {
      return {
        estado,
        modelo: camera?.modelo || null,
        erro: ultimoErro,
        conflitoSony: conflitoSonyAtivo,
        preparada: !!preparadaEm,
        flash: { ...estadoFlash },
        quadros,
        // Live view "vivo" é o que chegou agora, não o que já chegou um
        // dia: uma câmera que travou continuaria reportando o total.
        transmitindo: !!processoLive && Date.now() - ultimoQuadroEm < 3000,
        idadeUltimoQuadroMs: ultimoQuadroEm ? Date.now() - ultimoQuadroEm : null,
      };
    },

    /** Só para teste: força o modelo sem passar pela detecção. */
    _definirModelo(m) { camera = typeof m === 'string' ? { modelo: m, porta: 'usb:' } : m; },
  };
}

module.exports = { createGphotoCamera, ESTADO, tempoAssentamento, escolherCameraDetectada };
