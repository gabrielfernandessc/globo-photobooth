/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — Tela do Totem
   Modo automático: detecta gphoto2 → Sony A7III full-res
   Fallback: getUserMedia (webcam/Imaging Edge) máxima qualidade
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM ── */
  const stateBooting  = document.getElementById('state-booting');
  const statePreview  = document.getElementById('state-preview');
  const stateResult   = document.getElementById('state-result');
  const stateError    = document.getElementById('state-error');
  const bootingMsg    = document.getElementById('booting-msg');
  const bootingSub    = document.getElementById('booting-sub');

  const video         = document.getElementById('camera-feed');
  const gphotoFeed    = document.getElementById('gphoto-feed');
  const frameOverlay  = document.getElementById('frame-overlay');
  const modeBadge     = document.getElementById('mode-badge');
  const modeLabel     = document.getElementById('mode-label');
  const stageCard     = document.getElementById('stage-card');
  const overlayText   = document.getElementById('overlay-text');
  const countdownOvl  = document.getElementById('countdown-overlay');
  const countdownNum  = document.getElementById('countdown-number');
  const flashOvl      = document.getElementById('flash-overlay');
  const sessionCodeEl = document.getElementById('session-code');
  const statusDot     = document.getElementById('status-dot');
  const resultPhoto   = document.getElementById('result-photo');
  const qrImg         = document.getElementById('qr-img');
  const qrLoading     = document.getElementById('qr-loading');
  const photoCountEl  = document.getElementById('photo-count');
  const resetBar      = document.getElementById('reset-bar');
  const captureCanvas = document.getElementById('capture-canvas');

  /* ── State ── */
  let sessionCode  = null;
  let stream       = null;
  let useGphoto    = false;
  let aspectRatio  = '4:5';
  let capturing    = false;
  let resultTimeout = null;

  const RESULT_MS  = 18000;

  /* Portrait = 1080×1920 (9:16 like fotototem-ref), Landscape = 1440×1080 */
  const RESOLUTIONS = {
    '4:5':  { w: 1080, h: 1920 },
    '16:9': { w: 1440, h: 1080 }
  };

  const IDLE_MESSAGES = [
    '📸 Faça uma pose incrível!',
    '🤩 Sorria para a câmera!',
    '😎 Mostre seu melhor lado!',
    '✌️ Seja você mesmo!',
    '🎉 Vamos tirar uma foto?',
  ];
  let msgIdx = 0;

  /* ── CSS filter state ── */
  let camFilters = { brightness: 100, contrast: 100, saturation: 100 };
  let camZoom = 1;

  /* ── Socket ── */
  const socket = io();

  /* ═══ INIT ═══ */
  async function init() {
    showState('booting');
    bootingMsg.textContent = 'Detectando câmera…';
    bootingSub.textContent  = 'Aguarde um instante';

    try {
      const r = await fetch('/api/gphoto/status');
      const data = await r.json();
      if (data.available) {
        useGphoto = true;
        bootingMsg.textContent = 'Sony detectada!';
        bootingSub.textContent  = data.camera;
        await sleep(800);
        startGphotoMode(data.camera);
      } else {
        await startWebcamMode();
      }
    } catch {
      await startWebcamMode();
    }

    createSession();
    startIdleMessages();
  }

  function showState(name) {
    [stateBooting, statePreview, stateResult, stateError].forEach(el => el.classList.add('hidden'));
    ({ booting: stateBooting, preview: statePreview, result: stateResult, error: stateError })[name]
      ?.classList.remove('hidden');
  }

  /* ═══ GPHOTO2 MODE ═══ */
  function startGphotoMode(cameraName) {
    gphotoFeed.classList.remove('hidden');
    video.classList.add('hidden');
    gphotoFeed.src = '/api/gphoto/preview';
    gphotoFeed.style.transform = 'scaleX(-1)';
    modeBadge.classList.remove('hidden');
    modeLabel.textContent = cameraName.split(' ').slice(0, 3).join(' ');
    showState('preview');
  }

  /* ═══ WEBCAM MODE — request highest possible resolution ═══ */
  async function startWebcamMode() {
    bootingMsg.textContent = 'Abrindo câmera…';

    // Try resolutions from highest to lowest
    const constraints = [
      { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, // 4K
      { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, // FHD
      { width: { ideal: 1280 }, height: { ideal:  720 }                             }, // HD
    ];

    for (const video_c of constraints) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
        video.srcObject = stream;
        await video.play();
        showState('preview');
        return;
      } catch { /* try next */ }
    }

    showState('error');
  }

  /* ── Idle message rotator ── */
  function startIdleMessages() {
    setInterval(() => {
      if (!capturing) {
        msgIdx = (msgIdx + 1) % IDLE_MESSAGES.length;
        overlayText.style.opacity = '0';
        setTimeout(() => {
          overlayText.textContent = IDLE_MESSAGES[msgIdx];
          overlayText.style.opacity = '1';
        }, 300);
      }
    }, 4000);
  }

  /* ── CSS Camera controls ── */
  function applyCamControl(cmd) {
    if (cmd.brightness !== undefined) camFilters.brightness = Math.round(100 + cmd.brightness * 10);
    if (cmd.contrast   !== undefined) camFilters.contrast   = cmd.contrast;
    if (cmd.saturation !== undefined) camFilters.saturation = cmd.saturation;
    if (cmd.zoom       !== undefined) camZoom = cmd.zoom;

    const filterStr = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    video.style.filter  = filterStr;
    video.style.transform = `scaleX(-1) scale(${camZoom})`;
    gphotoFeed.style.filter = filterStr;
    gphotoFeed.style.transform = `scaleX(-1) scale(${camZoom})`;
  }

  /* ── Session ── */
  function createSession() {
    socket.emit('create-session', ({ code }) => {
      sessionCode = code;
      sessionCodeEl.textContent = code; // 4-char alphanum
    });
  }

  /* ═══ SOCKET EVENTS ═══ */

  socket.on('controller-connected', () => {
    statusDot.classList.add('connected');
    document.getElementById('status-text').textContent = '✓ Controle conectado';
  });

  socket.on('controller-disconnected', () => {
    statusDot.classList.remove('connected');
    document.getElementById('status-text').textContent = 'Aguardando controle…';
  });

  socket.on('settings-updated', (s) => {
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

  socket.on('show-photo', ({ url }) => {
    if (url) showResult(url, false);
  });

  socket.on('photo-ready', ({ total }) => {
    photoCountEl.textContent = `Foto ${total} do evento`;
  });

  /* ═══ CAPTURE FLOW ═══ */

  async function startCountdown(seconds) {
    capturing = true;
    overlayText.style.opacity = '0';
    countdownOvl.classList.remove('hidden');

    for (let i = seconds; i > 0; i--) {
      countdownNum.textContent = i;
      countdownNum.style.animation = 'none';
      void countdownNum.offsetWidth;
      countdownNum.style.animation = 'countPop .7s ease both';
      await sleep(1000);
    }
    countdownNum.textContent = '📸';
    await sleep(300);
    countdownOvl.classList.add('hidden');

    if (useGphoto) {
      await doGphotoCapture();
    } else {
      await doWebcamCapture();
    }

    capturing = false;
    overlayText.style.opacity = '1';
    overlayText.textContent = IDLE_MESSAGES[msgIdx];
  }

  /* ── gphoto2 capture (server-side, full-resolution) ── */
  async function doGphotoCapture() {
    triggerFlash();
    showState('result');
    resultPhoto.src = '';
    resultPhoto.alt = 'Capturando em alta resolução…';
    photoCountEl.textContent = 'Capturando em alta resolução…';
    qrLoading.style.display = 'flex';
    qrImg.style.display = 'none';

    try {
      const resp = await fetch('/api/gphoto/capture', { method: 'POST' });
      const data = await resp.json();

      if (data.success && data.data) {
        const photoUrl = data.data.url;
        showResult(photoUrl, true);
        generateQR(photoUrl);
        socket.emit('photo-uploaded', {
          code: sessionCode,
          url: photoUrl,
          thumbnail: data.data.thumb?.url || photoUrl
        });
      } else {
        showState('preview');
      }
    } catch (err) {
      console.error('gphoto capture error:', err);
      showState('preview');
    }
  }

  /* ── Webcam capture — same technique as fotototem-ref ── */
  async function doWebcamCapture() {
    triggerFlash();

    const res = RESOLUTIONS[aspectRatio];
    captureCanvas.width  = res.w;
    captureCanvas.height = res.h;
    const ctx = captureCanvas.getContext('2d');

    // Crop video to target aspect (cover behavior)
    const vW = video.videoWidth  || video.offsetWidth;
    const vH = video.videoHeight || video.offsetHeight;
    const targetAspect = res.w / res.h;
    const videoAspect  = vW / vH;

    let sx, sy, sw, sh;
    if (videoAspect > targetAspect) {
      sh = vH; sw = vH * targetAspect;
      sx = (vW - sw) / 2; sy = 0;
    } else {
      sw = vW; sh = vW / targetAspect;
      sx = 0; sy = (vH - sh) / 2;
    }

    // Draw mirrored (mirror for natural selfie)
    ctx.save();
    ctx.filter = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    ctx.translate(res.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, res.w, res.h);
    ctx.restore();
    ctx.filter = 'none';

    // Composite frame overlay if loaded
    if (frameOverlay.classList.contains('loaded') && frameOverlay.naturalWidth > 0) {
      ctx.drawImage(frameOverlay, 0, 0, res.w, res.h);
    }

    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.93);
    showResult(dataUrl, true);

    const base64 = dataUrl.split(',')[1];
    qrLoading.style.display = 'flex';
    qrImg.style.display = 'none';

    try {
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 })
      });
      const data = await resp.json();
      if (data.success && data.data) {
        const photoUrl = data.data.url;
        generateQR(photoUrl);
        socket.emit('photo-uploaded', {
          code: sessionCode,
          url: photoUrl,
          thumbnail: data.data.thumb?.url || photoUrl
        });
      } else {
        showQRError('Upload falhou');
      }
    } catch {
      showQRError('Sem conexão');
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

  /* ═══ RESULT ═══ */

  function showResult(imgSrc, startTimer = true) {
    if (imgSrc) resultPhoto.src = imgSrc;
    showState('result');

    if (resultTimeout) clearTimeout(resultTimeout);
    if (startTimer) {
      resetBar.style.transition = 'none';
      resetBar.style.width = '100%';
      void resetBar.offsetWidth;
      resetBar.style.transition = `width ${RESULT_MS}ms linear`;
      resetBar.style.width = '0%';
      resultTimeout = setTimeout(resetToPreview, RESULT_MS);
    }
  }

  /* ── QR Code: use toDataURL + <img> (most reliable approach) ── */
  function generateQR(url) {
    if (typeof QRCode === 'undefined') {
      showQRError('Lib não carregada');
      return;
    }

    qrLoading.style.display = 'flex';
    qrImg.style.display = 'none';

    QRCode.toDataURL(url, {
      width: 200,
      margin: 2,
      color: { dark: '#003B71', light: '#FFFFFF' },
      errorCorrectionLevel: 'L',
    }, (err, dataUrl) => {
      qrLoading.style.display = 'none';
      if (err || !dataUrl) {
        showQRError(err?.message || 'Erro QR');
        return;
      }
      qrImg.src = dataUrl;
      qrImg.style.display = 'block';
    });
  }

  function showQRError(msg) {
    qrLoading.style.display = 'none';
    qrImg.style.display = 'none';
    const p = document.createElement('p');
    p.textContent = '⚠ ' + msg;
    p.style.cssText = 'font-size:12px;color:#888;width:200px;text-align:center;padding:20px 0;';
    qrImg.parentNode.appendChild(p);
  }

  function resetToPreview() {
    showState('preview');
    if (resultTimeout) { clearTimeout(resultTimeout); resultTimeout = null; }
  }

  function loadFrame() {
    if (!sessionCode) return;
    const url = `/api/frame/${sessionCode}?ratio=${aspectRatio}&t=${Date.now()}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { frameOverlay.src = url; frameOverlay.classList.add('loaded'); };
    img.onerror = () => frameOverlay.classList.remove('loaded');
    img.src = url;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  init();
})();
