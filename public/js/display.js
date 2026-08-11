/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — tela do totem

   Duas fontes de imagem, com prioridade:
     1. celular pareado (/camera.html) → preview via WebRTC,
        foto tirada no sensor do aparelho em resolução máxima
     2. webcam local do próprio totem → fallback

   A tela conduz a contagem regressiva e dispara o celular com uma
   antecedência configurável (shutterLeadMs), para compensar o atraso
   do obturador do Android e a foto sair exatamente no "0".
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ── DOM ── */
  const stateBooting = $('state-booting');
  const statePreview = $('state-preview');
  const stateResult  = $('state-result');
  const stateError   = $('state-error');
  const bootingMsg   = $('booting-msg');
  const bootingSub   = $('booting-sub');

  const video        = $('camera-feed');
  const remoteVideo  = $('remote-feed');
  const frameOverlay = $('frame-overlay');
  const modeBadge    = $('mode-badge');
  const modeLabel    = $('mode-label');
  const stageWrap    = $('stage-wrap');
  const stageCard    = $('stage-card');
  const overlayText  = $('overlay-text');
  const countdownOvl = $('countdown-overlay');
  const countdownNum = $('countdown-number');
  const flashOvl     = $('flash-overlay');
  const sessionCodeEl = $('session-code');
  const statusDot    = $('status-dot');
  const statusText   = $('status-text');
  const resultPhoto  = $('result-photo');
  const qrImg        = $('qr-img');
  const qrLoader     = $('qr-loader');
  const qrBody       = $('qr-body');
  const photoCountEl = $('photo-count');
  const photoCountHdr = $('header-photo-count');
  const resetBar     = $('reset-bar');
  const captureCanvas = $('capture-canvas');
  const btnDownload  = $('btn-download');
  const buildInfo    = $('build-info');
  const diagnosticsInfo = $('diagnostics-info');

  const pairPanel    = $('pair-panel');
  const pairQr       = $('pair-qr');
  const pairUrlEl    = $('pair-url');
  const btnDismissPair = $('btn-dismiss-pair');

  /* ── Estado ── */
  const AUTO_SAVE = new URLSearchParams(location.search).has('autosave');
  const RESULT_MS = 12000;

  let sessionCode  = null;
  let localStream  = null;
  let source       = 'none';       // 'phone' | 'webcam' | 'none'
  let aspectRatio  = '3:4';
  let capturing    = false;
  let resultTimeout = null;
  let photoTotal   = 0;
  let currentTimer = 3;
  let shutterLead  = 250;
  let flashMode    = 'off';
  let pc           = null;
  let pendingIce   = [];
  let awaitingPhoto = null;
  let phoneStreamTimeout = null;

  const savedWidths = { '3:4': '', '4:3': '' };
  const camFilters  = { brightness: 100, contrast: 100, saturation: 100 };
  let camZoom = 1;

  const diagnostics = {
    fonte: 'Inicializando', preview: '--', captura: '--', final: '--', arquivo: '--',
  };

  const IDLE_MSGS = [
    '📸 Faça uma pose incrível!',
    '😎 Mostre seu melhor lado!',
    '✌️ Seja você mesmo!',
    '🎉 Vamos tirar uma foto?',
  ];
  let msgIdx = 0;

  const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

  /* ═══════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════ */

  async function init() {
    showState('booting');
    bootingMsg.textContent = 'Conectando…';
    bootingSub.textContent = 'Preparando a sessão';

    document.addEventListener('click', initAudio, { once: true });
    document.addEventListener('keydown', initAudio, { once: true });

    loadBuildInfo();
    createOrRejoinSession();
    startIdleMessages();
    setupKeyboardShortcuts();
    setupDraggableResize();
    setInterval(refreshPreviewDiagnostics, 1000);
  }

  function showState(name) {
    [stateBooting, statePreview, stateResult, stateError].forEach(el => el?.classList.add('hidden'));
    ({ booting: stateBooting, preview: statePreview, result: stateResult, error: stateError }[name])
      ?.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════════════
     SESSÃO
     ═══════════════════════════════════════════════════════ */

  function createOrRejoinSession() {
    const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase();
    const requestedCode = urlCode || localStorage.getItem('globo-booth-code') || null;

    socket.emit('create-session', { requestedCode }, res => {
      sessionCode = res.code;
      sessionCodeEl.textContent = res.code;
      localStorage.setItem('globo-booth-code', res.code);

      if (res.settings) applySettings(res.settings);
      if (res.photoCount) { photoTotal = res.photoCount; updatePhotoCount(); }

      renderPairPanel();
      loadFrame();

      if (res.hasCamera) awaitPhoneStream();
      else startWebcamMode();
    });
  }

  socket.on('connect', () => {
    if (!sessionCode) return;
    socket.emit('create-session', { requestedCode: sessionCode }, res => {
      sessionCodeEl.textContent = res.code;
      if (res.hasCamera && source !== 'phone') awaitPhoneStream();
    });
  });

  /**
   * A sessão diz que há um celular pareado, mas o vídeo ainda não chegou.
   * Trocar a fonte agora deixaria o totem preto — então segura, e se o
   * stream não vier em 10s cai para a webcam local.
   */
  function awaitPhoneStream() {
    pairPanel?.classList.add('hidden');
    showState('preview');
    setDiagnostics({ fonte: 'Celular: aguardando vídeo…' });
    statusText.textContent = 'Conectando ao celular…';

    clearTimeout(phoneStreamTimeout);
    phoneStreamTimeout = setTimeout(() => {
      if (source === 'phone') return;
      setDiagnostics({ fonte: 'Celular sem vídeo — usando webcam' });
      renderPairPanel();
      startWebcamMode();
    }, 10000);
  }

  /** QR que abre a página da câmera já com o código preenchido. */
  function renderPairPanel() {
    if (!pairQr || !sessionCode) return;
    const url = `${location.origin}/camera.html?code=${sessionCode}`;
    pairQr.src = `/api/qr?size=360&data=${encodeURIComponent(url)}`;
    pairUrlEl.textContent = url.replace(/^https?:\/\//, '');
    pairPanel.classList.toggle('hidden', source === 'phone');
  }

  btnDismissPair?.addEventListener('click', () => pairPanel.classList.add('hidden'));

  /* ═══════════════════════════════════════════════════════
     FONTE DE IMAGEM
     ═══════════════════════════════════════════════════════ */

  function useSource(next) {
    source = next;

    const phone = next === 'phone';
    remoteVideo.classList.toggle('hidden', !phone);
    video.classList.toggle('hidden', phone);
    modeBadge.classList.toggle('hidden', !phone);
    modeLabel.textContent = 'Celular';
    pairPanel?.classList.toggle('hidden', phone);

    if (phone && localStream) {
      // Solta a webcam do totem: nada de duas fontes disputando a cena.
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      video.srcObject = null;
    }

    setDiagnostics({ fonte: phone ? 'Celular (WebRTC)' : 'Webcam local' });
    showState('preview');
  }

  async function startWebcamMode() {
    if (source === 'phone') return;
    bootingMsg.textContent = 'Abrindo a webcam…';

    const attempts = [
      { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
      { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      { width: { ideal: 1280 }, height: { ideal: 720 } },
    ];

    for (const constraints of attempts) {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
        // O celular pode ter assumido enquanto o getUserMedia resolvia.
        if (source === 'phone') { media.getTracks().forEach(t => t.stop()); return; }
        localStream = media;
        video.srcObject = media;
        await video.play();
        useSource('webcam');
        return;
      } catch { /* tenta a próxima */ }
    }
    if (source === 'phone') return;

    // Sem webcam local não é erro fatal: o celular ainda pode assumir.
    setDiagnostics({ fonte: 'Aguardando celular' });
    showState('preview');
    statusText.textContent = 'Sem webcam local — pareie um celular pelo QR ao lado.';
  }

  /* ═══════════════════════════════════════════════════════
     WEBRTC — recebe o preview do celular
     ═══════════════════════════════════════════════════════ */

  const RTC_CONFIG = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  };

  socket.on('camera-connected', () => {
    awaitPhoneStream();
    signal({ type: 'ready' });
  });

  socket.on('camera-disconnected', () => {
    clearTimeout(phoneStreamTimeout);
    closePeer();
    source = 'none';
    remoteVideo.srcObject = null;
    setDiagnostics({ fonte: 'Celular desconectado' });
    statusText.textContent = 'Celular desconectado — reabra /camera.html no aparelho.';
    startWebcamMode();
    renderPairPanel();
  });

  socket.on('webrtc-signal', async ({ data }) => {
    if (!data) return;
    try {
      if (data.type === 'offer') {
        closePeer();
        pc = new RTCPeerConnection(RTC_CONFIG);

        pc.ontrack = e => {
          clearTimeout(phoneStreamTimeout);
          remoteVideo.srcObject = e.streams[0];
          remoteVideo.play().catch(() => {});
          useSource('phone');
          statusText.textContent = statusDot.classList.contains('connected')
            ? 'Tudo pronto para a foto.'
            : 'Aguardando liberação…';
        };
        pc.onicecandidate = e => { if (e.candidate) signal({ type: 'ice', candidate: e.candidate }); };
        pc.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(pc.connectionState)) {
            setDiagnostics({ fonte: 'Celular: falha na conexão' });
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal({ type: 'answer', sdp: pc.localDescription });
      } else if (data.type === 'ice' && data.candidate) {
        const candidate = new RTCIceCandidate(data.candidate);
        if (pc?.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
        else pendingIce.push(candidate);
      }
    } catch (err) {
      console.error('webrtc', err);
    }
  });

  function signal(data) {
    if (sessionCode) socket.emit('webrtc-signal', { code: sessionCode, to: 'camera', data });
  }

  function closePeer() {
    if (pc) { try { pc.close(); } catch {} }
    pc = null;
    pendingIce = [];
  }

  /* ═══════════════════════════════════════════════════════
     CAPTURA
     ═══════════════════════════════════════════════════════ */

  socket.on('start-countdown', ({ timer }) => { if (!capturing) startCountdown(timer); });

  async function startCountdown(seconds = currentTimer) {
    capturing = true;
    overlayText.style.opacity = '0';
    countdownOvl.classList.remove('hidden');
    statusText.textContent = 'Preparando o registro…';

    const usePhone = source === 'phone';
    let shootSent = false;

    for (let i = seconds; i > 0; i--) {
      countdownNum.textContent = String(i);
      countdownNum.style.animation = 'none';
      void countdownNum.offsetWidth;
      countdownNum.style.animation = 'countPop .7s ease both';
      playBeep(i === 1 ? 880 : 440, i === 1 ? 200 : 80);

      // No último segundo, o disparo sai antes do "0" para compensar o
      // tempo de obturador do celular.
      if (usePhone && i === 1 && shutterLead > 0 && shutterLead < 1000) {
        await sleep(1000 - shutterLead);
        socket.emit('camera-shoot', { code: sessionCode, aspectRatio, flashMode });
        shootSent = true;
        await sleep(shutterLead);
      } else {
        await sleep(1000);
      }
    }

    playBeep(1200, 150);
    countdownNum.textContent = '📸';
    await sleep(200);
    countdownOvl.classList.add('hidden');

    if (usePhone) {
      if (!shootSent) socket.emit('camera-shoot', { code: sessionCode, aspectRatio, flashMode });
      awaitPhoneResult();
    } else {
      await captureFromWebcam();
    }

    capturing = false;
    overlayText.style.opacity = '1';
    overlayText.textContent = IDLE_MSGS[msgIdx];
  }

  /** A foto vem do celular via HTTP; a tela só espera o evento do servidor. */
  function awaitPhoneResult() {
    triggerFlash();
    showState('result');
    resultPhoto.removeAttribute('src');
    qrBody.textContent = 'Capturando no celular em resolução máxima…';
    showQrSpinner('Capturando…');
    btnDownload.classList.add('hidden');
    setDiagnostics({ captura: 'aguardando celular', final: '--', arquivo: '--' });

    clearTimeout(awaitingPhoto);
    awaitingPhoto = setTimeout(() => {
      qrBody.textContent = 'O celular não respondeu. Verifique o aparelho.';
      qrLoader.innerHTML = '<p style="font-size:12px;color:#c00;text-align:center">Sem resposta da câmera</p>';
      resultTimeout = setTimeout(resetToPreview, 4000);
    }, 25000);
  }

  socket.on('camera-status', ({ status, detail }) => {
    if (status === 'capturing') qrBody.textContent = 'Capturando no celular em resolução máxima…';
    if (status === 'uploading') {
      qrBody.textContent = 'Enviando a foto…';
      setDiagnostics({ captura: detail?.tier || 'still', final: 'processando' });
    }
    if (status === 'error') {
      clearTimeout(awaitingPhoto);
      qrBody.textContent = `Falha no celular: ${detail?.message || 'erro desconhecido'}`;
      qrLoader.innerHTML = '<p style="font-size:12px;color:#c00;text-align:center">Erro na captura</p>';
    }
  });

  socket.on('capture-result', payload => {
    clearTimeout(awaitingPhoto);
    presentResult(payload);
  });

  async function captureFromWebcam() {
    triggerFlash();

    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    if (!videoW || !videoH) { showState('preview'); return; }

    // Sem upscale: o canvas recebe o recorte no tamanho nativo do sensor.
    const targetRatio = aspectRatio === '4:3' ? 4 / 3 : 3 / 4;
    let sw = videoW;
    let sh = Math.round(videoW / targetRatio);
    if (sh > videoH) { sh = videoH; sw = Math.round(videoH * targetRatio); }
    const sx = Math.round((videoW - sw) / 2);
    const sy = Math.round((videoH - sh) / 2);

    captureCanvas.width = sw;
    captureCanvas.height = sh;
    const ctx = captureCanvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.97);
    setDiagnostics({ captura: `${sw}×${sh} nativo`, final: 'processando' });

    showResult(dataUrl, false);
    qrBody.textContent = 'Gerando link para compartilhamento…';
    showQrSpinner('Finalizando…');
    btnDownload.classList.add('hidden');

    try {
      const resp = await fetch('/api/photo/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A webcam é espelhada no preview; a foto sai igual ao que a pessoa viu.
        body: JSON.stringify({ image: dataUrl, code: sessionCode, aspectRatio, mirror: true }),
      });
      const data = await resp.json();
      if (data.success) presentResult(data.data);
      else throw new Error(data.error || 'falhou');
    } catch {
      qrBody.textContent = 'Sem conexão com o servidor — salve pelo botão abaixo.';
      qrLoader.style.display = 'none';
      setupLocalDownload(dataUrl);
    }
  }

  function presentResult({ imageUrl, pageUrl, downloadUrl, meta }) {
    showResult(imageUrl, true);
    generateQR(pageUrl || imageUrl);
    setupRemoteDownload(downloadUrl || imageUrl);
    applyFinalDiagnostics(meta);
  }

  /* ═══════════════════════════════════════════════════════
     RESULTADO
     ═══════════════════════════════════════════════════════ */

  function showResult(src, startTimer) {
    if (src) resultPhoto.src = src;
    showState('result');
    clearTimeout(resultTimeout);
    if (!startTimer) return;

    resetBar.style.transition = 'none';
    resetBar.style.width = '100%';
    void resetBar.offsetWidth;
    resetBar.style.transition = `width ${RESULT_MS}ms linear`;
    resetBar.style.width = '0%';
    resultTimeout = setTimeout(resetToPreview, RESULT_MS);
  }

  function resetToPreview() {
    clearTimeout(resultTimeout);
    clearTimeout(awaitingPhoto);
    resultTimeout = null;
    showState('preview');
    statusText.textContent = statusDot.classList.contains('connected')
      ? 'Tudo pronto para a foto.'
      : 'Aguardando liberação…';
  }

  function showQrSpinner(label) {
    qrLoader.innerHTML =
      `<div class="spinner" style="border-color:rgba(0,59,113,.12);border-top-color:#003B71"></div>` +
      `<p style="font-size:12px;color:#666;margin:4px 0 0">${label}</p>`;
    qrLoader.style.display = 'flex';
    qrImg.style.display = 'none';
  }

  /** QR gerado pelo próprio servidor — o evento funciona sem internet. */
  function generateQR(url) {
    qrLoader.style.display = 'flex';
    qrImg.style.display = 'none';
    qrImg.onload = () => {
      qrLoader.style.display = 'none';
      qrImg.style.display = 'block';
      qrBody.textContent = 'Aponte a câmera do celular para abrir a foto.';
    };
    qrImg.onerror = () => {
      qrLoader.innerHTML = '<p style="font-size:12px;color:#c00;text-align:center">Falha ao gerar o QR</p>';
    };
    qrImg.src = `/api/qr?size=300&data=${encodeURIComponent(url)}`;
  }

  function setupLocalDownload(dataUrl) {
    btnDownload.classList.remove('hidden');
    btnDownload.onclick = () => downloadHref(dataUrl);
  }

  function setupRemoteDownload(url) {
    if (!url) return;
    btnDownload.classList.remove('hidden');
    btnDownload.onclick = () => downloadHref(url);
    // Salvar automático no PC do totem só com ?autosave na URL — o servidor
    // já guarda uma cópia em Downloads/Globo-Photobooth.
    if (AUTO_SAVE) downloadHref(url);
  }

  function downloadHref(href) {
    const a = document.createElement('a');
    a.href = href;
    a.download = `globo_foto_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ═══════════════════════════════════════════════════════
     EVENTOS DE SESSÃO
     ═══════════════════════════════════════════════════════ */

  socket.on('controller-connected', () => {
    statusDot.classList.add('connected');
    statusText.textContent = 'Tudo pronto para a foto.';
  });
  socket.on('controller-disconnected', () => {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Aguardando liberação…';
  });

  socket.on('settings-updated', applySettings);

  function applySettings(settings = {}) {
    if (settings.timer) currentTimer = settings.timer;
    if (settings.shutterLeadMs !== undefined) shutterLead = settings.shutterLeadMs;
    if (settings.flashMode) flashMode = settings.flashMode;

    if (settings.aspectRatio && settings.aspectRatio !== aspectRatio) {
      savedWidths[aspectRatio] = stageWrap.style.width || '600px';
      aspectRatio = settings.aspectRatio;
      stageCard.dataset.ratio = aspectRatio;

      const [a, b] = aspectRatio.split(':').map(Number);
      const targetW = parseInt(savedWidths[aspectRatio], 10) || 600;
      const targetH = Math.round(targetW / (a / b));

      stageWrap.style.width = `${targetW}px`;
      stageWrap.style.height = `${targetH}px`;
      sendCamControl({ previewWidth: targetW, previewHeight: targetH });
      loadFrame();
    }
  }

  socket.on('frame-updated', ({ aspectRatio: ratio, frameUrl }) => {
    if (ratio !== aspectRatio) return;
    if (!frameUrl) {
      frameOverlay.classList.remove('loaded');
      frameOverlay.removeAttribute('src');
      stageCard.style.aspectRatio = '';
      return;
    }
    frameOverlay.onload = () => {
      frameOverlay.classList.add('loaded');
      stageCard.style.aspectRatio = `${frameOverlay.naturalWidth} / ${frameOverlay.naturalHeight}`;
    };
    frameOverlay.src = frameUrl;
  });

  socket.on('cam-control', ({ cmd }) => applyCamControl(cmd));
  socket.on('show-photo', ({ url }) => { if (url) showResult(url, false); });
  socket.on('photo-ready', ({ total }) => { photoTotal = total; updatePhotoCount(); });
  socket.on('reset-to-preview', resetToPreview);

  function loadFrame() {
    if (!sessionCode) return;
    const url = `/api/frame/${sessionCode}?ratio=${aspectRatio}&t=${Date.now()}`;
    const img = new Image();
    img.onload = () => {
      frameOverlay.src = url;
      frameOverlay.classList.add('loaded');
      stageCard.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    };
    img.onerror = () => {
      frameOverlay.classList.remove('loaded');
      stageCard.style.aspectRatio = '';
    };
    img.src = url;
  }

  /* ═══════════════════════════════════════════════════════
     FILTROS E TAMANHO DO PREVIEW
     ═══════════════════════════════════════════════════════ */

  function sendCamControl(cmd) {
    socket.emit('cam-control', { code: sessionCode, cmd });
  }

  function applyCamControl(cmd = {}) {
    if (cmd.brightness !== undefined) camFilters.brightness = Math.round(100 + cmd.brightness * 10);
    if (cmd.contrast !== undefined) camFilters.contrast = cmd.contrast;
    if (cmd.saturation !== undefined) camFilters.saturation = cmd.saturation;
    if (cmd.zoom !== undefined) camZoom = cmd.zoom;
    if (cmd.previewWidth !== undefined) stageWrap.style.width = `${cmd.previewWidth}px`;
    if (cmd.previewHeight !== undefined) stageWrap.style.height = `${cmd.previewHeight}px`;

    const filter = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    video.style.filter = filter;
    remoteVideo.style.filter = filter;
    // A webcam local é espelhada por CSS; o zoom precisa preservar isso.
    video.style.transform = `scaleX(-1) scale(${camZoom})`;
    remoteVideo.style.transform = `scale(${camZoom})`;
  }

  function setupDraggableResize() {
    const handle = $('resize-handle');
    if (!handle) return;
    let resizing = false;

    const onMove = e => {
      if (!resizing) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const rect = stageWrap.getBoundingClientRect();
      const [a, b] = aspectRatio.split(':').map(Number);
      const newW = Math.max(200, Math.min(1200, clientX - rect.left));
      const newH = Math.round(newW / (a / b));

      stageWrap.style.width = `${newW}px`;
      stageWrap.style.height = `${newH}px`;
      sendCamControl({ previewWidth: Math.round(newW), previewHeight: newH });
    };

    const onEnd = () => {
      resizing = false;
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      resizing = true;
      document.body.style.cursor = 'nwse-resize';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
    });
    handle.addEventListener('touchstart', () => {
      resizing = true;
      window.addEventListener('touchmove', onMove, { passive: true });
      window.addEventListener('touchend', onEnd);
    });
  }

  /* ═══════════════════════════════════════════════════════
     ATALHOS, ÁUDIO, DIAGNÓSTICO
     ═══════════════════════════════════════════════════════ */

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !capturing && !statePreview.classList.contains('hidden')) {
        e.preventDefault();
        startCountdown(currentTimer);
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        resetToPreview();
      }
    });
  }

  let audioCtx = null;
  function initAudio() {
    if (audioCtx) return;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
  }

  function playBeep(freq = 440, duration = 80) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.value = 0.3;
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration / 1000);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + duration / 1000);
    } catch { /* áudio indisponível */ }
  }

  function triggerFlash() {
    flashOvl.classList.remove('hidden');
    flashOvl.style.animation = 'none';
    void flashOvl.offsetWidth;
    flashOvl.style.animation = 'flashEffect .5s ease-out forwards';
    setTimeout(() => flashOvl.classList.add('hidden'), 600);
  }

  function startIdleMessages() {
    setInterval(() => {
      if (capturing) return;
      msgIdx = (msgIdx + 1) % IDLE_MSGS.length;
      overlayText.style.opacity = '0';
      setTimeout(() => {
        overlayText.textContent = IDLE_MSGS[msgIdx];
        overlayText.style.opacity = '1';
      }, 300);
    }, 4000);
  }

  function updatePhotoCount() {
    if (photoCountEl) photoCountEl.textContent = `Foto ${photoTotal} do evento`;
    if (photoCountHdr) photoCountHdr.textContent = `${photoTotal} fotos`;
  }

  async function loadBuildInfo() {
    try {
      const resp = await fetch('/api/version', { cache: 'no-store' });
      const data = await resp.json();
      if (buildInfo && data.label) buildInfo.textContent = data.label;
    } catch {
      if (buildInfo) buildInfo.textContent = 'versão indisponível';
    }
  }

  function setDiagnostics(next) {
    Object.assign(diagnostics, next);
    if (!diagnosticsInfo) return;
    diagnosticsInfo.textContent = Object.entries(diagnostics)
      .map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`)
      .join(' | ');
  }

  function refreshPreviewDiagnostics() {
    const el = source === 'phone' ? remoteVideo : video;
    const w = el.videoWidth || 0;
    const h = el.videoHeight || 0;
    setDiagnostics({ preview: w && h ? `${w}×${h}` : '--' });
  }

  function applyFinalDiagnostics(meta) {
    if (!meta) return;
    setDiagnostics({
      captura: meta.sourceWidth ? `${meta.sourceWidth}×${meta.sourceHeight} (${meta.sourceMegapixels} MP)` : diagnostics.captura,
      final: `${meta.finalWidth}×${meta.finalHeight}`,
      arquivo: `${formatBytes(meta.finalBytes)} jpeg q${meta.quality}`,
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return '--';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  init();
})();
