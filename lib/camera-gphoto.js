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

/** Respiro entre soltar o live view e disparar. Medido na A7 III. */
const ASSENTAR_MS = 600;

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
} = {}) {
  let estado = ESTADO.PARADA;
  let processoLive = null;
  let camera = null; // { modelo, porta }
  let ultimoErro = null;
  let quadros = 0;
  let ultimoQuadroEm = 0;
  let pararPedido = false;
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
    await new Promise(resolve => {
      execFile('pgrep', ['-f', 'gphoto2 --camera'], (err, saida) => {
        const meu = processoLive?.pid;
        const orfaos = (saida || '')
          .split('\n')
          .map(n => parseInt(n, 10))
          .filter(pid => Number.isFinite(pid) && pid !== meu && pid !== process.pid);

        for (const pid of orfaos) {
          try {
            process.kill(pid, 'SIGKILL');
            log('warn', 'gphoto2 órfão encerrado', { pid, motivo: 'segurava o USB' });
          } catch { /* já morreu */ }
        }
        resolve();
      });
    });

    if (process.platform !== 'darwin') return;
    // O macOS assume a câmera PTP assim que ela conecta.
    await new Promise(resolve => execFile('pkill', ['-x', 'PTPCamera'], () => resolve()));
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

    for (const linha of r.stdout.split('\n').slice(2)) {
      const achado = /^(.+?)\s+(usb:[\d,]*)\s*$/.exec(linha.trim());
      if (achado) return { modelo: achado[1].trim(), porta: achado[2] };
    }
    return null;
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
  function iniciarLiveView() {
    if (processoLive || !camera) return;

    let buffer = Buffer.alloc(0);
    let erroSaida = '';

    processoLive = spawn(binario, [...alvo(), '--capture-movie', '--stdout'], {
      env: { ...process.env, LANG: 'C' },
    });

    processoLive.stdout.on('data', pedaco => {
      buffer = Buffer.concat([buffer, pedaco]);

      let inicio;
      while ((inicio = buffer.indexOf(SOI)) !== -1) {
        const fim = buffer.indexOf(EOI, inicio + SOI.length);
        if (fim === -1) break; // quadro ainda incompleto

        const jpeg = buffer.subarray(inicio, fim + EOI.length);
        buffer = buffer.subarray(fim + EOI.length);

        quadros++;
        ultimoQuadroEm = Date.now();
        if (preview && sessionCode) preview.publicar(sessionCode, jpeg);
      }

      // Um buffer que só cresce significa lixo sem EOI: descarta para
      // não vazar memória ao longo de horas de evento.
      if (buffer.length > 8 * 1024 * 1024) buffer = Buffer.alloc(0);
    });

    processoLive.stderr.on('data', d => { erroSaida += d.toString().slice(-500); });

    processoLive.on('close', code => {
      processoLive = null;

      // Encerramento pedido por nós (para disparar, ou para parar) não é
      // falha e não deve religar nada.
      if (pararPedido || estado === ESTADO.DISPARANDO || estado === ESTADO.PARADA) return;

      const saida = erroSaida.trim().split('\n').filter(Boolean).pop() || '';

      /* A Sony encerra o live view sozinha depois de alguns segundos e
         o gphoto2 sai com "Movie capture finished (N frames)" — código
         0, sem erro. Tratar isso como queda deixaria o telão preto a
         cada 20 segundos.

         O certo é reabrir na hora: a câmera continua ali, não há o que
         redetectar. Sem atraso e sem trocar de estado, a emenda fica
         invisível para quem está olhando. */
      const fimNormal = code === 0 && /movie capture finished/i.test(saida);
      if (fimNormal && quadros > 0) {
        log('info', 'live_view_reaberto', { motivo: 'a câmera encerrou o stream sozinha', quadros });
        setImmediate(() => { if (!pararPedido && !processoLive) iniciarLiveView(); });
        return;
      }

      ultimoErro = saida || `gphoto2 saiu com código ${code}`;
      log('warn', 'live_view_caiu', { erro: ultimoErro });
      mudarEstado(ESTADO.RELIGANDO);
      setTimeout(() => { if (!pararPedido) religar(); }, 1500);
    });

    processoLive.on('error', err => {
      ultimoErro = err.message;
      processoLive = null;
      mudarEstado(ESTADO.FALHA, { erro: err.message });
    });

    mudarEstado(ESTADO.LIVE_VIEW, { modelo: camera.modelo });
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

  async function religar() {
    if (pararPedido) return;
    mudarEstado(ESTADO.PROCURANDO);
    camera = await detectar();

    if (!camera) {
      ultimoErro = (await conectadaMasSemPtp())
        ? 'a câmera está no cabo mas em modo de armazenamento — mude "Ligação USB" para PC Remoto'
        : 'nenhuma câmera detectada — confira o cabo e se ela está ligada';
      mudarEstado(ESTADO.FALHA, { erro: ultimoErro });
      return false;
    }

    ultimoErro = null;
    iniciarLiveView();
    return true;
  }

  /* ── Captura ───────────────────────────────────────────── */

  /**
   * O disparo em si. Para o live view, fotografa, e devolve o live view.
   *
   * Devolve o CAMINHO do arquivo, não os bytes: uma foto de 24 MP são
   * dezenas de MB, e carregá-la inteira em memória a cada captura é
   * como um totem começa a engasgar depois de uma hora de evento.
   */
  async function capturar({ timeoutMs = 45_000 } = {}) {
    if (estado === ESTADO.DISPARANDO) throw new Error('Já existe um disparo em andamento');
    if (!camera) throw new Error('Nenhuma câmera conectada');

    const estadoAnterior = estado;
    mudarEstado(ESTADO.DISPARANDO);
    const comecou = Date.now();

    try {
      // A câmera é exclusiva: sem soltar o live view o disparo falha com
      // "could not claim the USB device".
      await pararLiveView();

      const nome = `captura_${Date.now()}`;
      const destino = path.join(pastaTemp, `${nome}.%C`);

      /* A Sony precisa de um respiro entre soltar o live view e
         disparar. Sem ele a sessão PTP ainda está fechando e o disparo
         falha com "PTP I/O Error". */
      await new Promise(r => setTimeout(r, ASSENTAR_MS));

      const r = await executar([
        ...alvo(),
        '--capture-image-and-download',
        '--filename', destino,
        '--force-overwrite',
      ], { timeoutMs });

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
      });

      return { arquivo: jpeg, todos: gerados, ms: Date.now() - comecou };
    } finally {
      // O live view volta mesmo se o disparo falhar: um erro numa foto
      // não pode deixar o telão preto pelo resto do evento.
      if (!pararPedido && estadoAnterior !== ESTADO.PARADA) {
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
    'aspectratio',    // 3:2 / 16:9
    'iso',
    'f-number',
    'shutterspeed',
    'whitebalance',
    'capturetarget',
  ];

  async function lerPerfil() {
    if (!camera) throw new Error('Nenhuma câmera conectada');

    const perfil = {};
    for (const chave of AJUSTES_DO_PERFIL) {
      const r = await executar([...alvo(), '--get-config', chave], { timeoutMs: 15_000 });
      if (!r.ok) continue; // o corpo não expõe este ajuste; seguir adiante

      const valor = /^Current:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim();
      if (valor) perfil[chave] = valor;
    }
    return perfil;
  }

  /**
   * Reaplica o perfil, item a item.
   *
   * Um ajuste que a câmera recusa não pode abortar os demais: é melhor
   * restaurar seis de oito e dizer quais faltaram do que não restaurar
   * nada porque um item mudou de nome entre firmwares.
   */
  async function aplicarPerfil(perfil = {}) {
    if (!camera) throw new Error('Nenhuma câmera conectada');

    const aplicados = [];
    const recusados = [];

    for (const [chave, valor] of Object.entries(perfil)) {
      const r = await executar([...alvo(), '--set-config', `${chave}=${valor}`], { timeoutMs: 15_000 });
      (r.ok ? aplicados : recusados).push(chave);
    }

    log('info', 'perfil da câmera reaplicado', { aplicados: aplicados.length, recusados });
    return { aplicados, recusados };
  }

  /* ── Ciclo de vida ─────────────────────────────────────── */

  return {
    ESTADO,

    async start() {
      pararPedido = false;
      return religar();
    },

    async stop() {
      pararPedido = true;
      await pararLiveView();
      mudarEstado(ESTADO.PARADA);
    },

    capturar,
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

module.exports = { createGphotoCamera, ESTADO };
