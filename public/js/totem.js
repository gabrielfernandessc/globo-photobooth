/* ══════════════════════════════════════════════════════════
   TOTEM — a máquina de estados do telão

   Uma variável de estado, e só ela decide o que aparece. O desenho
   anterior espalhava booleanos independentes e chegava a combinações
   impossíveis: "processando" e "resultado" ao mesmo tempo, loader
   infinito, foto antiga sobrando na tela durante a captura seguinte.

   Aqui cada estado tem uma cena, e trocar de estado troca a cena. Se
   um estado impossível não pode ser representado, ele não acontece.
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const ESTADOS = [
    'BOOTING',      // subindo, ainda não sabemos nada
    'SEM_CAMERA',   // cabo fora, câmera desligada, ou religando
    'PRONTO',       // preview ao vivo, esperando o convidado
    'CONTAGEM',     // 3, 2, 1
    'CAPTURANDO',   // obturador
    'PROCESSANDO',  // moldura e derivadas
    'RESULTADO',    // foto grande + QR
    'ERRO',         // recuperável: volta sozinho
  ];

  const $ = id => document.getElementById(id);
  const cenas = new Map(
    [...document.querySelectorAll('[data-cena]')].map(el => [el.dataset.cena, el])
  );

  const el = {
    preview: $('preview'),
    molduraPreview: $('molduraPreview'),
    palcoPreview: $('palcoPreview'),
    semSinal: $('semSinal'),
    numero: $('numero'),
    fotoFinal: $('fotoFinal'),
    celebracao: $('celebracao'),
    qr: $('qr'),
    statusPublicacao: $('statusPublicacao'),
    chamada: $('chamada'),
    flash: $('flash'),
    tempo: $('tempoRestante'),
    tituloCamera: $('tituloCamera'),
    mensagemCamera: $('mensagemCamera'),
    detalheCamera: $('detalheCamera'),
    mensagemErro: $('mensagemErro'),
    diagnostico: $('diagnostico'),
  };

  const cfg = window.__BOOTH__ || {};
  const SESSAO = 'TOTM';
  const previewViewerKey = 'globo-booth-display-preview-viewer';
  const previewViewerId = sessionStorage.getItem(previewViewerKey) ||
    (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  sessionStorage.setItem(previewViewerKey, previewViewerId);

  const estado = {
    atual: 'BOOTING',
    contagemSegundos: 3,
    ultimaFoto: null,
    temporizador: null,
    temporizadorPreview: null,
    preparacaoDisparo: null,
    requestId: null,
    camera: null,
    aspectRatio: '3:4',
    // null = não está na galeria; número = índice da foto revisitada
    galeria: null,
  };

  /* ── Transição ────────────────────────────────────────── */

  function ir(novo, dados = {}) {
    if (!ESTADOS.includes(novo)) throw new Error(`estado desconhecido: ${novo}`);
    if (estado.atual === novo && !dados.forcar) return;

    // Cancela o que o estado anterior tinha agendado: sem isto uma
    // contagem antiga dispararia por cima da captura seguinte.
    clearTimeout(estado.temporizador);
    estado.temporizador = null;

    estado.atual = novo;
    for (const [nome, cena] of cenas) {
      const manterPreview = novo === 'CONTAGEM' && nome === 'PRONTO';
      cena.toggleAttribute('data-ativa', nome === novo || manterPreview);
    }

    el.chamada.hidden = novo !== 'PRONTO';
    el.tempo.hidden = novo !== 'RESULTADO';

    atualizarDiagnostico();
    aoEntrar[novo]?.(dados);
    socket?.emit('display-state', { code: SESSAO, state: novo });
  }

  const aoEntrar = {
    PRONTO() {
      // A conexão é aberta uma vez e permanece viva entre fotos. O
      // último quadro continua visível enquanto a câmera usa o USB.
      ligarPreview();
      // Some com a foto anterior: resultado velho na tela durante a
      // captura nova é o defeito mais confuso que um totem pode ter.
      el.fotoFinal.removeAttribute('src');
    },

    SEM_CAMERA() {
      desligarPreview();
    },

    CONTAGEM({ timer, requestId } = {}) {
      let restam = Number(timer) || estado.contagemSegundos;
      el.numero.textContent = restam;
      estado.preparacaoDisparo = null;
      estado.requestId = requestId || null;

      if (restam === 1) prepararDisparo();

      const passo = () => {
        restam--;
        if (restam > 0) {
          el.numero.textContent = restam;
          if (restam === 1) prepararDisparo();
          // Reinicia a animação do número.
          el.numero.style.animation = 'none';
          void el.numero.offsetWidth;
          el.numero.style.animation = '';
          estado.temporizador = setTimeout(passo, 1000);
          return;
        }
        disparar();
      };

      estado.temporizador = setTimeout(passo, 1000);
    },

    CAPTURANDO() {
      el.flash.classList.remove('dispara');
      void el.flash.offsetWidth;
      el.flash.classList.add('dispara');
    },

    RESULTADO({ foto, deVolta, posicao }) {
      el.celebracao.textContent = deVolta ? (posicao || 'Sua foto') : proximaCelebracao();
      el.fotoFinal.src = foto.imageUrl;
      el.qr.src = foto.qrUrl;
      marcarPublicacao(foto.share);

      // Tempo de olhar e escanear. A barra mostra quanto resta, para o
      // convidado não ser surpreendido pela volta ao preview.
      if (deVolta) {
        // Revisitada fica na tela até alguém sair: quem voltou para
        // pegar o QR não pode ser expulso por um cronômetro.
        el.tempo.hidden = true;
        return;
      }

      const SEGUNDOS = 22;
      el.tempo.style.transition = 'none';
      el.tempo.style.transform = 'scaleX(1)';
      void el.tempo.offsetWidth;
      el.tempo.style.transition = `transform ${SEGUNDOS}s linear`;
      el.tempo.style.transform = 'scaleX(0)';

      estado.temporizador = setTimeout(() => { estado.galeria = null; ir('PRONTO'); }, SEGUNDOS * 1000);
    },

    ERRO({ mensagem }) {
      el.mensagemErro.textContent = mensagem || 'Vamos tentar de novo.';
      // Erro nunca é final: o totem sempre volta a poder fotografar.
      estado.temporizador = setTimeout(() => ir(podeFotografar() ? 'PRONTO' : 'SEM_CAMERA'), 4000);
    },
  };

  /* ── Preview ──────────────────────────────────────────── */

  function ligarPreview({ forcar = false } = {}) {
    const caminho = cfg.preview?.streamPath;
    if (!caminho) return; // modo 'nenhum' ou 'capturadora'
    if (!forcar && el.preview.getAttribute('src')) return;
    clearTimeout(estado.temporizadorPreview);
    estado.temporizadorPreview = null;

    /* "Aguardando a câmera" some quando o primeiro quadro pinta. Uma
       <img> de MJPEG dispara onload no primeiro quadro e nunca mais, e
       é o único aviso que existe de que a imagem está viva. */
    if (el.semSinal) el.semSinal.hidden = false;
    el.preview.onload = () => { if (el.semSinal) el.semSinal.hidden = true; };

    el.preview.src = `${caminho}?viewer=${encodeURIComponent(previewViewerId)}&t=${Date.now()}`;
  }

  /**
   * Encaixa o preview na janela real da moldura.
   *
   * Sem isto o convidado se posiciona olhando um retângulo cheio e
   * recebe uma foto recortada noutro lugar — exatamente o problema que
   * a janela recortada existe para evitar. A geometria vem do servidor,
   * medida no canal alpha da mesma arte que a composição usa, então
   * preview e foto final concordam por construção.
   *
   * Falhar aqui é aceitável: sem a arte por cima o preview aparece
   * igual, só sem a referência de enquadramento.
   */
  async function montarMolduraDoPreview() {
    if (!el.palcoPreview || !el.molduraPreview) return;

    try {
      const g = await (await fetch(
        `/api/frame/${SESSAO}/geometria?ratio=${encodeURIComponent(estado.aspectRatio)}`
      )).json();
      if (!g.temMoldura || !g.janela) {
        // Sem arte para esta orientação, some com a anterior: manter a
        // moldura errada prometeria um enquadramento que a foto não tem.
        el.molduraPreview.hidden = true;
        el.molduraPreview.removeAttribute('src');
        return;
      }

      const raiz = document.documentElement.style;
      raiz.setProperty('--moldura-proporcao', `${g.moldura.largura} / ${g.moldura.altura}`);
      raiz.setProperty('--janela-x', `${(g.janela.esquerda * 100).toFixed(3)}%`);
      raiz.setProperty('--janela-y', `${(g.janela.topo * 100).toFixed(3)}%`);
      raiz.setProperty('--janela-w', `${(g.janela.largura * 100).toFixed(3)}%`);
      raiz.setProperty('--janela-h', `${(g.janela.altura * 100).toFixed(3)}%`);

      el.molduraPreview.src = `${g.frameUrl}&t=${Date.now()}`;
      el.molduraPreview.hidden = false;
    } catch (erro) {
      console.warn('moldura do preview indisponível', erro);
    }
  }

  function desligarPreview() {
    // O stream é entre servidor e tela, não ocupa o USB da câmera. Deixá-lo
    // vivo preserva o último quadro e elimina o clarão entre estados.
    clearTimeout(estado.temporizadorPreview);
    estado.temporizadorPreview = null;
  }

  /* ── Disparo ──────────────────────────────────────────── */

  let disparando = false;
  let sequenciaDisparo = 0;
  const capturasSocketPendentes = new Map();

  function novoRequestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function cancelarCapturaLocal() {
    sequenciaDisparo++;
    disparando = false;
    estado.preparacaoDisparo = null;
    estado.requestId = null;
    for (const concluir of capturasSocketPendentes.values()) {
      concluir({ success: false, error: 'Captura cancelada pelo operador' });
    }
    capturasSocketPendentes.clear();
  }

  function capturarPeloSocket(payload) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error('Socket do telão desconectado'));

      let terminou = false;
      const concluir = resultado => {
        if (terminou) return;
        terminou = true;
        clearTimeout(limite);
        capturasSocketPendentes.delete(payload.requestId);
        resolve(resultado);
      };
      const limite = setTimeout(() => {
        if (terminou) return;
        terminou = true;
        capturasSocketPendentes.delete(payload.requestId);
        reject(new Error('O disparo não foi confirmado pelo socket'));
      }, 15_000);

      capturasSocketPendentes.set(payload.requestId, concluir);
      socket.emit('dslr-capture', payload, concluir);
    });
  }

  async function capturarPorHttp(payload) {
    const controlador = new AbortController();
    const limite = setTimeout(() => controlador.abort(), 30_000);
    try {
      const resposta = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controlador.signal,
      });
      const corpo = await resposta.json();
      if (!resposta.ok) throw new Error(corpo.error || `HTTP ${resposta.status}`);
      return corpo;
    } catch (erro) {
      if (erro.name === 'AbortError') throw new Error('A captura excedeu o limite de 30 segundos');
      throw erro;
    } finally {
      clearTimeout(limite);
    }
  }

  async function solicitarCaptura(payload) {
    try {
      return await capturarPeloSocket(payload);
    } catch (erroSocket) {
      console.warn('socket de captura falhou; usando HTTP com timeout', erroSocket);
      return capturarPorHttp(payload);
    }
  }

  function prepararDisparo() {
    if (estado.preparacaoDisparo) return estado.preparacaoDisparo;

    estado.preparacaoDisparo = fetch('/api/camera/prepare', { method: 'POST' })
      .then(async resposta => {
        if (resposta.ok) return resposta.json();
        const corpo = await resposta.json().catch(() => ({}));
        throw new Error(corpo.error || `HTTP ${resposta.status}`);
      })
      .catch(erro => {
        // /api/capture mantém o caminho seguro sem preparo. Não cancela
        // a foto por uma otimização que falhou.
        console.warn('pré-armação da câmera indisponível', erro);
        return null;
      });

    return estado.preparacaoDisparo;
  }

  async function disparar() {
    if (disparando) return;
    disparando = true;
    const minhaSequencia = ++sequenciaDisparo;
    estado.requestId ||= novoRequestId();

    // A preparação é uma otimização, nunca uma etapa visual. Se a
    // câmera demorar para soltar o live view, ela continua em paralelo;
    // a contagem não pode congelar no número 1 esperando USB/PTP.
    if (!estado.preparacaoDisparo) prepararDisparo();
    ir('CAPTURANDO');
    desligarPreview();

    try {
      // “Sorria!” marca o clique, não a transferência USB inteira. O
      // JPEG ainda pode levar segundos para chegar, mas a tela muda para
      // “Revelando” logo depois do obturador.
      const requisicao = solicitarCaptura({
        code: SESSAO,
        aspectRatio: estado.aspectRatio,
        requestId: estado.requestId,
      });
      estado.temporizador = setTimeout(() => {
        if (estado.atual === 'CAPTURANDO') ir('PROCESSANDO');
      }, 700);

      const corpo = await requisicao;
      if (minhaSequencia !== sequenciaDisparo) return;

      // Resposta muito rápida também respeita a máquina de estados.
      if (estado.atual === 'CAPTURANDO') ir('PROCESSANDO');

      if (!corpo.success) throw new Error(corpo.error || 'A câmera não concluiu a foto');

      estado.ultimaFoto = corpo.data;
      ir('RESULTADO', { foto: corpo.data });
    } catch (erro) {
      if (minhaSequencia !== sequenciaDisparo) return;
      console.error('captura falhou', erro);
      ir('ERRO', { mensagem: mensagemAmigavel(erro.message) });
    } finally {
      if (minhaSequencia !== sequenciaDisparo) return;
      disparando = false;
      estado.preparacaoDisparo = null;
      estado.requestId = null;
    }
  }

  /**
   * Erro técnico vira frase que o operador entende.
   *
   * "Could not claim the USB device" não diz nada a quem está no evento;
   * "a câmera não respondeu" diz o suficiente para ele checar o cabo.
   */
  function mensagemAmigavel(bruto = '') {
    const texto = bruto.toLowerCase();
    if (texto.includes('claim') || texto.includes('usb')) return 'A câmera não respondeu. Vamos tentar de novo.';
    if (texto.includes('focus') || texto.includes('foco')) return 'A câmera não conseguiu focar. Tente novamente.';
    if (texto.includes('nenhuma câmera')) return 'A câmera está desconectada.';
    if (texto.includes('timeout') || texto.includes('tempo')) return 'A câmera demorou demais para responder.';
    return 'Vamos tentar de novo.';
  }

  /**
   * A frase que comemora a foto.
   *
   * Varia porque numa fila os convidados veem a tela um do outro, e a
   * mesma frase repetida vira ruído de máquina. Tom próximo e
   * espontâneo, sem gíria forçada — coisas que alguém realmente diria.
   *
   * Percorre a lista embaralhada antes de repetir: sorteio puro
   * repetiria a mesma frase duas vezes seguidas com frequência alta.
   */
  const CELEBRACOES = [
    'Ficou ótima! 🎉',
    'Que foto! ✨',
    'Essa vai pro álbum 📸',
    'Perfeita! 💙',
    'Arrasou! 🌟',
    'Ficou linda! 😍',
    'Essa ficou show 🤩',
    'Momento registrado ✅',
  ];

  let filaCelebracoes = [];

  function proximaCelebracao() {
    if (!filaCelebracoes.length) {
      filaCelebracoes = [...CELEBRACOES].sort(() => Math.random() - 0.5);
    }
    return filaCelebracoes.pop();
  }

  function marcarPublicacao(share) {
    const estados = {
      published: 'foto publicada',
      pending_sync: 'publicando…',
      failed: 'salva no totem',
      skipped: 'salva no totem',
      local: 'salva no totem',
    };
    const chave = share?.status || 'local';
    el.statusPublicacao.textContent = estados[chave] || 'salva no totem';
    el.statusPublicacao.dataset.estado = chave;
  }

  /* ── Gatilhos ─────────────────────────────────────────── */

  function podeFotografar() {
    return !!estado.camera?.transmitindo;
  }

  function pedirFoto(timer, requestId) {
    if (estado.atual !== 'PRONTO' || !podeFotografar()) return;
    estado.galeria = null;
    ir('CONTAGEM', { timer, requestId });
  }

  /* ── Galeria ──────────────────────────────────────────
     A tela de resultado volta ao preview sozinha, e o convidado que
     demorou a pegar o celular perde o QR. Sem uma forma de voltar, a
     única saída seria tirar outra foto — e a primeira, que era a boa,
     fica inacessível.

     As setas percorrem as fotos do evento; qualquer outra tecla ou o
     toque volta ao preview. */

  async function abrirGaleria(passo = -1) {
    try {
      const { photos } = await (await fetch(`/api/photos/${SESSAO}`)).json();
      if (!photos.length) return;

      estado.galeria = estado.galeria === null
        ? photos.length - 1
        : Math.min(photos.length - 1, Math.max(0, estado.galeria + passo));

      const foto = photos[estado.galeria];
      const alvo = foto.publicUrl || `${location.origin}${foto.page}`;

      ir('RESULTADO', {
        forcar: true,
        deVolta: true,
        foto: {
          imageUrl: foto.url,
          qrUrl: `/api/qr?size=520&data=${encodeURIComponent(alvo)}`,
          share: { status: foto.publicUrl ? 'published' : 'local' },
          pageUrl: foto.page,
        },
        posicao: `${estado.galeria + 1} de ${photos.length}`,
      });
    } catch (erro) {
      console.warn('galeria indisponível', erro);
    }
  }

  document.addEventListener('keydown', evento => {
    if (evento.key === 'ArrowLeft' || evento.key === 'ArrowRight') {
      evento.preventDefault();
      abrirGaleria(evento.key === 'ArrowLeft' ? -1 : 1);
      return;
    }

    if (evento.key === 'd' || evento.key === 'D') {
      el.diagnostico.toggleAttribute('data-visivel');
      atualizarDiagnostico();
    }
  });

  /* ── Estado da câmera ─────────────────────────────────── */

  async function sincronizarCamera() {
    try {
      const status = await (await fetch('/api/camera/status')).json();
      estado.camera = status;

      if (!status.disponivel) {
        el.detalheCamera.textContent = `fonte: ${status.fonte} (sem câmera cabeada)`;
        if (estado.atual === 'BOOTING') ir('SEM_CAMERA');
        return;
      }

      el.detalheCamera.textContent = status.modelo
        ? `${status.modelo} — ${status.estado}`
        : status.erro || 'procurando câmera…';

      if (status.conflitoSony) {
        el.tituloCamera.textContent = 'Sony Imaging Edge está bloqueando a câmera';
        el.mensagemCamera.textContent = 'Desative “Sony CameraExt” em Ajustes do Sistema › Geral › Itens de Início e Extensões › Extensões de Câmera.';
      } else if (status.modelo && !status.transmitindo) {
        el.tituloCamera.textContent = 'Reconectando a imagem';
        el.mensagemCamera.textContent = 'A câmera está conectada. Aguarde o preview voltar antes da próxima foto.';
      } else {
        el.tituloCamera.textContent = 'Câmera desconectada';
        el.mensagemCamera.innerHTML = 'Confira o cabo USB e se a câmera está ligada.<br>O totem religa sozinho assim que ela voltar.';
      }

      // Só troca de cena em estados de espera: interromper uma contagem
      // ou um resultado por causa de um poll seria pior que o problema.
      const emEspera = ['BOOTING', 'SEM_CAMERA', 'PRONTO'].includes(estado.atual);
      if (!emEspera) return;

      // Reconhecer o corpo sem receber quadros não basta: mostrar uma
      // tela vazia como se estivesse pronta induz o operador ao erro.
      const podeUsar = !!status.transmitindo;
      const transicaoEsperada = ['preparando', 'disparando', 'religando'].includes(status.estado);
      if (podeUsar && estado.atual !== 'PRONTO') ir('PRONTO');
      else if (!podeUsar && !transicaoEsperada && estado.atual === 'PRONTO') ir('SEM_CAMERA');
      else if (estado.atual === 'BOOTING') ir('SEM_CAMERA');
    } catch (erro) {
      console.warn('status da câmera indisponível', erro);
      if (estado.atual === 'BOOTING') ir('SEM_CAMERA');
    }
    atualizarDiagnostico();
  }

  function atualizarDiagnostico() {
    if (!el.diagnostico.hasAttribute('data-visivel')) return;
    const c = estado.camera || {};
    el.diagnostico.textContent = [
      `estado    ${estado.atual}`,
      `camera    ${c.estado || '—'}`,
      `modelo    ${c.modelo || '—'}`,
      `quadros   ${c.quadros ?? '—'}`,
      `ao vivo   ${c.transmitindo ? 'sim' : 'não'}`,
      `preview   ${cfg.preview?.fonte || '—'}`,
      `erro      ${c.erro || '—'}`,
    ].join('\n');
  }

  /* ── Publicação: o QR pode virar online depois de exibido ── */

  let socket = null;

  function fotoRevisitada(foto) {
    const alvo = foto.publicUrl || foto.share?.publicUrl || `${location.origin}${foto.page || foto.pageUrl}`;
    estado.galeria = 0;
    ir('RESULTADO', {
      forcar: true,
      deVolta: true,
      foto: {
        imageUrl: foto.url || foto.imageUrl,
        qrUrl: `/api/qr?size=520&data=${encodeURIComponent(alvo)}`,
        share: { status: foto.publicUrl || foto.share?.publicUrl ? 'published' : 'local' },
        pageUrl: foto.page || foto.pageUrl,
      },
      posicao: 'Foto recuperada',
    });
  }

  if (window.io) {
    socket = window.io({ path: cfg.socketPath || '/socket.io' });

    const entrarNaSessao = () => {
      socket.emit('create-session', { requestedCode: SESSAO }, resposta => {
        if (resposta?.settings) {
          estado.contagemSegundos = Number(resposta.settings.timer) || 3;
          estado.aspectRatio = resposta.settings.aspectRatio || '3:4';
        }
        socket.emit('display-state', { code: SESSAO, state: estado.atual });
      });
    };

    socket.on('connect', entrarNaSessao);

    socket.on('share-status', ({ photoId, status, publicUrl }) => {
      const atual = estado.ultimaFoto;
      if (!atual || estado.atual !== 'RESULTADO') return;
      if (!atual.pageUrl?.endsWith(photoId)) return;

      marcarPublicacao({ status });
      // A foto publicou enquanto o convidado ainda olha: o QR passa a
      // apontar para a URL que funciona fora da rede do evento.
      if (publicUrl) {
        el.qr.src = `/api/qr?size=520&data=${encodeURIComponent(publicUrl)}`;
      }
    });

    socket.on('camera-estado', () => sincronizarCamera());
    socket.on('dslr-capture-result', ({ requestId, resultado } = {}) => {
      capturasSocketPendentes.get(requestId)?.(resultado);
    });
    socket.on('controller-connected', () => {
      socket.emit('display-state', { code: SESSAO, state: estado.atual });
    });
    socket.on('start-countdown', ({ timer, requestId } = {}) => pedirFoto(timer, requestId));
    socket.on('settings-updated', settings => {
      estado.contagemSegundos = Number(settings?.timer) || estado.contagemSegundos;
      const anterior = estado.aspectRatio;
      estado.aspectRatio = settings?.aspectRatio || estado.aspectRatio;

      /* Girar a proporção no painel troca a arte no telão na hora. Sem
         isto o convidado se posicionaria pela moldura antiga e receberia
         a foto na nova — o descompasso que a janela medida existe para
         eliminar. */
      if (estado.aspectRatio !== anterior) montarMolduraDoPreview();
    });
    socket.on('show-photo', ({ photo } = {}) => { if (photo) fotoRevisitada(photo); });
    socket.on('reset-to-preview', () => {
      cancelarCapturaLocal();
      estado.galeria = null;
      ir(podeFotografar() ? 'PRONTO' : 'SEM_CAMERA', { forcar: true });
    });
  }

  el.preview.addEventListener('error', () => {
    el.preview.removeAttribute('src');
    if (['PRONTO', 'CONTAGEM'].includes(estado.atual)) {
      clearTimeout(estado.temporizadorPreview);
      estado.temporizadorPreview = setTimeout(() => ligarPreview({ forcar: true }), 250);
    }
  });

  el.preview.addEventListener('load', () => {
    clearTimeout(estado.temporizadorPreview);
    estado.temporizadorPreview = null;
  });

  /* ── Boot ─────────────────────────────────────────────── */

  montarMolduraDoPreview();
  sincronizarCamera();
  setInterval(sincronizarCamera, 2500);

  // Um totem não deve mostrar menu de contexto nem barra de rolagem.
  document.addEventListener('contextmenu', e => e.preventDefault());
})();
