/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — Globo Photo Booth Totem
   Estrutura de captura idêntica ao fotototem-ref/CameraFeed.tsx
   QR via api.qrserver.com (sem biblioteca, como react-qr-code mas mais simples)
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM ── */
  const $ = id => document.getElementById(id);
  const stateBooting  = $('state-booting');
  const statePreview  = $('state-preview');
  const stateResult   = $('state-result');
  const stateError    = $('state-error');
  const bootingMsg    = $('booting-msg');
  const bootingSub    = $('booting-sub');

  const video         = $('camera-feed');
  const gphotoFeed    = $('gphoto-feed');
  const frameOverlay  = $('frame-overlay');
  const modeBadge     = $('mode-badge');
  const modeLabel     = $('mode-label');
  const stageCard     = $('stage-card');
  const overlayText   = $('overlay-text');
  const countdownOvl  = $('countdown-overlay');
  const countdownNum  = $('countdown-number');
  const flashOvl      = $('flash-overlay');
  const sessionCodeEl = $('session-code');
  const statusDot     = $('status-dot');
  const resultPhoto   = $('result-photo');
  const qrImg         = $('qr-img');
  const qrLoader      = $('qr-loader');
  const qrBody        = $('qr-body');
  const photoCountEl  = $('photo-count');
  const resetBar      = $('reset-bar');
  const captureCanvas = $('capture-canvas');
  const btnDownload   = $('btn-download');

  /* ── State ── */
  let sessionCode   = null;
  let stream        = null;
  let useGphoto     = false;
  let aspectRatio   = '4:5';
  let capturing     = false;
  let resultTimeout = null;
  let lastDataUrl   = null; // for download button

  const RESULT_MS = 18000;

  /* Resoluções de captura — idênticas ao fotototem-ref/CameraFeed.tsx */
  const RESOLUTIONS = {
    '4:5':  { w: 1080, h: 1920 }, // portrait 9:16
    '16:9': { w: 1440, h: 1080 }, // landscape
  };

  const IDLE_MSGS = [
    '📸 Faça uma pose incrível!',
    '🤩 Sorria para a câmera!',
    '😎 Mostre seu melhor lado!',
    '✌️ Seja você mesmo!',
    '🎉 Vamos tirar uma foto?',
  ];
  let msgIdx = 0;

  let camFilters = { brightness: 100, contrast: 100, saturation: 100 };
  let camZoom = 1;

  const socket = io();

  /* ═══ INIT ═══ */
  async function init() {
    showState('booting');
    bootingMsg.textContent = 'Detectando câmera…';
    bootingSub.textContent  = 'Aguarde um instante';

    try {
      const r = await fetch('/api/gphoto/status');
      const d = await r.json();
      if (d.available) {
        useGphoto = true;
        bootingMsg.textContent = 'Sony detectada!';
        bootingSub.textContent  = d.camera;
        await sleep(800);
        startGphotoMode(d.camera);
      } else {
        await startWebcamMode();
      }
    } catch {
      await startWebcamMode();
    }

    createSession();
    startIdleMessages();
  }

  /* ── State switcher ── */
  function showState(name) {
    [stateBooting, statePreview, stateResult, stateError].forEach(el => el.classList.add('hidden'));
    ({ booting: stateBooting, preview: statePreview, result: stateResult, error: stateError }[name])
      ?.classList.remove('hidden');
  }

  /* ═══ GPHOTO2 MODE ═══ */
  function startGphotoMode(cam) {
    gphotoFeed.classList.remove('hidden');
    video.classList.add('hidden');
    gphotoFeed.src = '/api/gphoto/preview';
    modeBadge.classList.remove('hidden');
    modeLabel.textContent = cam.split(' ').slice(0, 3).join(' ');
    showState('preview');
  }

  /* ═══ WEBCAM MODE — tenta 4K → FHD → HD ═══ */
  async function startWebcamMode() {
    bootingMsg.textContent = 'Abrindo câmera…';
    const attempts = [
      { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
      { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      { width: { ideal: 1280 }, height: { ideal:  720 } },
    ];
    for (const vc of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
        video.srcObject = stream;
        await video.play();
        showState('preview');
        return;
      } catch { /* try next */ }
    }
    showState('error');
  }

  /* ── Idle messages ── */
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

  /* ── CSS filters (webcam quality fallback) ── */
  function applyCamControl(cmd) {
    if (cmd.brightness !== undefined) camFilters.brightness = Math.round(100 + cmd.brightness * 10);
    if (cmd.contrast   !== undefined) camFilters.contrast   = cmd.contrast;
    if (cmd.saturation !== undefined) camFilters.saturation = cmd.saturation;
    if (cmd.zoom       !== undefined) camZoom = cmd.zoom;
    const f = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    video.style.filter      = f;
    video.style.transform   = `scaleX(-1) scale(${camZoom})`;
    gphotoFeed.style.filter = f;
    gphotoFeed.style.transform = `scaleX(-1) scale(${camZoom})`;
  }

  /* ─────────────────────────────────────────
     QR CODE — sem biblioteca JS.
     api.qrserver.com gera PNG/SVG on-demand
     via parâmetro GET — 100% confiável,
     mesmo resultado que react-qr-code do ref.
     ───────────────────────────────────────── */
  function generateQR(url) {
    // Build QR image URL — same as react-qr-code but via free API
    const encoded = encodeURIComponent(url);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=003B71&bgcolor=FFFFFF&data=${encoded}&margin=10&ecc=L`;

    qrLoader.style.display = 'flex';
    qrImg.style.display    = 'none';

    qrImg.onload = () => {
      qrLoader.style.display = 'none';
      qrImg.style.display    = 'block';
      qrBody.textContent = 'Aponte a câmera do celular para abrir a foto.';
    };
    qrImg.onerror = () => {
      qrLoader.innerHTML = '<p style="font-size:12px;color:#c00;text-align:center">Sem acesso à internet para gerar QR</p>';
    };
    qrImg.src = qrUrl;
  }

  /* ── Session ── */
  function createSession() {
    socket.emit('create-session', ({ code }) => {
      sessionCode = code;
      sessionCodeEl.textContent = code;
    });
  }

  /* ═══ SOCKET EVENTS ═══ */

  socket.on('controller-connected', () => {
    statusDot.classList.add('connected');
    $('status-text').textContent = '✓ Controle conectado';
  });
  socket.on('controller-disconnected', () => {
    statusDot.classList.remove('connected');
    $('status-text').textContent = 'Aguardando controle…';
  });
  socket.on('settings-updated', s => {
    if (s.aspectRatio && s.aspectRatio !== aspectRatio) {
      aspectRatio = s.aspectRatio;
      stageCard.dataset.ratio = aspectRatio;
      loadFrame();
    }
  });
  socket.on('frame-updated', ({ aspectRatio: ratio, frameUrl }) => {
    if (ratio === aspectRatio) {
      frameOverlay.src = frameUrl;
      frameOverlay.onload = () => frameOverlay.classList.add('loaded');
    }
  });
  socket.on('start-countdown', ({ timer }) => {
    if (!capturing) startCountdown(timer);
  });
  socket.on('cam-control', ({ cmd }) => applyCamControl(cmd));
  socket.on('show-photo', ({ url }) => { if (url) showResult(url, false); });
  socket.on('photo-ready', ({ total }) => {
    photoCountEl.textContent = `Foto ${total} do evento`;
  });

  /* ═══ CAPTURE FLOW ═══ */

  async function startCountdown(seconds) {
    capturing = true;
    overlayText.style.opacity = '0';
    countdownOvl.classList.remove('hidden');

    for (let i = seconds; i > 0; i--) {
      countdownNum.textContent = String(i);
      countdownNum.style.animation = 'none';
      void countdownNum.offsetWidth;
      countdownNum.style.animation = 'countPop .7s ease both';
      await sleep(1000);
    }
    countdownNum.textContent = '📸';
    await sleep(200);
    countdownOvl.classList.add('hidden');

    if (useGphoto) await doGphotoCapture();
    else           await doWebcamCapture();

    capturing = false;
    overlayText.style.opacity = '1';
    overlayText.textContent = IDLE_MSGS[msgIdx];
  }

  /* ── gphoto2 (Sony A7III full-res) ── */
  async function doGphotoCapture() {
    triggerFlash();
    showState('result');
    resultPhoto.src = '';
    qrBody.textContent = 'Capturando em alta resolução…';
    qrLoader.innerHTML = '<div class="spinner" style="border-color:rgba(0,59,113,.12);border-top-color:#003B71"></div><p style="font-size:12px;color:#666;margin:4px 0 0">Capturando…</p>';
    qrLoader.style.display = 'flex';
    qrImg.style.display = 'none';
    btnDownload.classList.add('hidden');

    try {
      const resp = await fetch('/api/gphoto/capture', { method: 'POST' });
      const data = await resp.json();
      if (data.success && data.data) {
        const url = data.data.url;
        showResult(url, true);
        generateQR(url);
        socket.emit('photo-uploaded', { code: sessionCode, url, thumbnail: data.data.thumb?.url || url });
      } else { showState('preview'); }
    } catch { showState('preview'); }
  }

  /* ── Webcam (canvas) — exatamente como fotototem-ref/CameraFeed.tsx captureImage() ── */
  async function doWebcamCapture() {
    triggerFlash();

    /* fotototem-ref usa OUTPUT_WIDTH/HEIGHT fixos e calcula crop para cover */
    const res  = RESOLUTIONS[aspectRatio];
    captureCanvas.width  = res.w;
    captureCanvas.height = res.h;
    const ctx = captureCanvas.getContext('2d');

    const vW = video.videoWidth  || video.offsetWidth;
    const vH = video.videoHeight || video.offsetHeight;
    const canvasAspect = res.w / res.h;
    const videoAspect  = vW / vH;

    let drawW, drawH, offX, offY;
    if (videoAspect > canvasAspect) {
      /* vídeo mais largo — corta lados */
      drawH = res.h; drawW = res.h * videoAspect;
      offX = (res.w - drawW) / 2; offY = 0;
    } else {
      /* vídeo mais alto — corta topo/baixo */
      drawW = res.w; drawH = res.w / videoAspect;
      offX = 0; offY = (res.h - drawH) / 2;
    }

    /* Espelha (como -scale-x-100 do fotototem-ref) + filtros CSS */
    ctx.save();
    ctx.filter = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    ctx.translate(res.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, offX, offY, drawW, drawH);
    ctx.restore();
    ctx.filter = 'none';

    /* Composite frame — idêntico ao fotototem-ref captureImage() linhas 95-107 */
    if (frameOverlay.classList.contains('loaded') && frameOverlay.naturalWidth > 0) {
      ctx.drawImage(frameOverlay, 0, 0, res.w, res.h);
    }

    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.93);
    lastDataUrl = dataUrl;

    showResult(dataUrl, true);
    setupDownload(dataUrl);

    /* Upload para ImgBB via proxy do servidor */
    qrBody.textContent = 'Gerando link para compartilhamento…';
    qrLoader.innerHTML = '<div class="spinner" style="border-color:rgba(0,59,113,.12);border-top-color:#003B71"></div><p style="font-size:12px;color:#666;margin:4px 0 0">Enviando…</p>';
    qrLoader.style.display = 'flex';
    qrImg.style.display    = 'none';

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl.split(',')[1] })
      });
      const data = await resp.json();
      if (data.success && data.data?.url) {
        const url = data.data.url;
        generateQR(url);
        socket.emit('photo-uploaded', { code: sessionCode, url, thumbnail: data.data.thumb?.url || url });
      } else {
        qrBody.textContent = 'Upload falhou — salve via botão abaixo.';
        qrLoader.style.display = 'none';
      }
    } catch {
      qrBody.textContent = 'Sem conexão — salve via botão abaixo.';
      qrLoader.style.display = 'none';
    }
  }

  /* ── Flash ── */
  function triggerFlash() {
    flashOvl.classList.remove('hidden');
    flashOvl.style.animation = 'none';
    void flashOvl.offsetWidth;
    flashOvl.style.animation = 'flashEffect .5s ease-out forwards';
    setTimeout(() => flashOvl.classList.add('hidden'), 600);
  }

  /* ── Result ── */
  function showResult(src, startTimer) {
    if (src) resultPhoto.src = src;
    showState('result');
    if (resultTimeout) clearTimeout(resultTimeout);
    if (startTimer) {
      resetBar.style.transition = 'none';
      resetBar.style.width = '100%';
      void resetBar.offsetWidth;
      resetBar.style.transition = `width ${RESULT_MS}ms linear`;
      resetBar.style.width = '0%';
      resultTimeout = setTimeout(() => showState('preview'), RESULT_MS);
    }
  }

  /* ── Download button (fotototem-ref has this too) ── */
  function setupDownload(dataUrl) {
    btnDownload.classList.remove('hidden');
    btnDownload.onclick = () => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `globo_foto_${Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
  }

  /* ── Frame loader ── */
  function loadFrame() {
    if (!sessionCode) return;
    const url = `/api/frame/${sessionCode}?ratio=${aspectRatio}&t=${Date.now()}`;
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload  = () => { frameOverlay.src = url; frameOverlay.classList.add('loaded'); };
    img.onerror = () => frameOverlay.classList.remove('loaded');
    img.src = url;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  init();
})();
