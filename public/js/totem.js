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
    numero: $('numero'),
    fotoFinal: $('fotoFinal'),
    celebracao: $('celebracao'),
    qr: $('qr'),
    statusPublicacao: $('statusPublicacao'),
    chamada: $('chamada'),
    flash: $('flash'),
    tempo: $('tempoRestante'),
    detalheCamera: $('detalheCamera'),
    mensagemErro: $('mensagemErro'),
    diagnostico: $('diagnostico'),
  };

  const cfg = window.__BOOTH__ || {};
  const SESSAO = 'TOTM';

  const estado = {
    atual: 'BOOTING',
    contagemSegundos: 3,
    ultimaFoto: null,
    temporizador: null,
    camera: null,
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
      cena.toggleAttribute('data-ativa', nome === novo);
    }

    el.chamada.hidden = novo !== 'PRONTO';
    el.tempo.hidden = novo !== 'RESULTADO';

    atualizarDiagnostico();
    aoEntrar[novo]?.(dados);
  }

  const aoEntrar = {
    PRONTO() {
      // Reconecta o stream MJPEG. Trocar o src força o navegador a abrir
      // uma requisição nova — é o que traz o preview de volta depois de
      // cada captura, sem precisar recarregar a página.
      ligarPreview();
      // Some com a foto anterior: resultado velho na tela durante a
      // captura nova é o defeito mais confuso que um totem pode ter.
      el.fotoFinal.removeAttribute('src');
    },

    CONTAGEM() {
      let restam = estado.contagemSegundos;
      el.numero.textContent = restam;

      const passo = () => {
        restam--;
        if (restam > 0) {
          el.numero.textContent = restam;
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

  function ligarPreview() {
    const caminho = cfg.preview?.streamPath;
    if (!caminho) return; // modo 'nenhum' ou 'capturadora'
    // O parâmetro só existe para o navegador não reaproveitar a conexão
    // anterior, que já foi encerrada pelo servidor durante a captura.
    el.preview.src = `${caminho}?t=${Date.now()}`;
  }

  function desligarPreview() {
    // Solta a conexão MJPEG antes do disparo: a câmera precisa do USB
    // livre, e um stream pendurado atrasa a troca de mãos.
    el.preview.removeAttribute('src');
  }

  /* ── Disparo ──────────────────────────────────────────── */

  let disparando = false;

  async function disparar() {
    if (disparando) return;
    disparando = true;

    ir('CAPTURANDO');
    desligarPreview();

    try {
      // O servidor conduz obturador, moldura e gravação. Demora segundos
      // numa DSLR, e é por isso que a tela avisa em vez de parecer travada.
      const resposta = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aspectRatio: '3:4' }),
      });

      // A tela de "revelando" entra assim que o obturador solta.
      if (estado.atual === 'CAPTURANDO') ir('PROCESSANDO');

      const corpo = await resposta.json();
      if (!resposta.ok || !corpo.success) throw new Error(corpo.error || `HTTP ${resposta.status}`);

      estado.ultimaFoto = corpo.data;
      ir('RESULTADO', { foto: corpo.data });
    } catch (erro) {
      console.error('captura falhou', erro);
      ir('ERRO', { mensagem: mensagemAmigavel(erro.message) });
    } finally {
      disparando = false;
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
    return !!estado.camera?.transmitindo || cfg.preview?.fonte === 'nenhum';
  }

  function pedirFoto() {
    if (estado.atual !== 'PRONTO') return;
    ir('CONTAGEM');
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

  document.addEventListener('click', () => {
    // Da galeria, o toque volta ao preview em vez de disparar: o
    // convidado seguinte não deve fotografar por engano ao encostar.
    if (estado.galeria !== null) { estado.galeria = null; ir('PRONTO'); return; }
    pedirFoto();
  });

  document.addEventListener('keydown', evento => {
    if (evento.key === 'ArrowLeft' || evento.key === 'ArrowRight') {
      evento.preventDefault();
      abrirGaleria(evento.key === 'ArrowLeft' ? -1 : 1);
      return;
    }

    if (evento.code === 'Space' || evento.code === 'Enter') {
      evento.preventDefault();
      if (estado.galeria !== null) { estado.galeria = null; ir('PRONTO'); return; }
      pedirFoto();
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

      // Só troca de cena em estados de espera: interromper uma contagem
      // ou um resultado por causa de um poll seria pior que o problema.
      const emEspera = ['BOOTING', 'SEM_CAMERA', 'PRONTO'].includes(estado.atual);
      if (!emEspera) return;

      /* O que decide se dá para fotografar é a CÂMERA ESTAR CONECTADA,
         não o preview estar fluindo.

         A Sony hiberna o live view depois de alguns minutos parada, mas
         continua respondendo ao disparo — ela acorda para fotografar.
         Exigir preview fazia o totem se declarar fora do ar numa fila
         que só precisava de alguém apertar o botão.

         Sem preview a cena PRONTO mostra a chamada e o convidado se
         posiciona pela marca no chão. Menos confortável, e infinitamente
         melhor que um totem que se recusa a trabalhar. */
      const podeUsar = !!status.modelo && status.estado !== 'falha';
      if (podeUsar && estado.atual !== 'PRONTO') ir('PRONTO');
      else if (!podeUsar && estado.atual === 'PRONTO') ir('SEM_CAMERA');
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

  if (window.io) {
    const socket = window.io({ path: cfg.socketPath || '/socket.io' });

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
  }

  /* ── Boot ─────────────────────────────────────────────── */

  sincronizarCamera();
  setInterval(sincronizarCamera, 2500);

  // Um totem não deve mostrar menu de contexto nem barra de rolagem.
  document.addEventListener('contextmenu', e => e.preventDefault());
})();
