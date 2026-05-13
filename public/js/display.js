/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — Lógica da tela do totem
   States: booting → preview (waiting/ready) → countdown → result
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM ── */
  const stateBooting = document.getElementById('state-booting');
  const statePreview = document.getElementById('state-preview');
  const stateResult  = document.getElementById('state-result');
  const stateError   = document.getElementById('state-error');

  const video         = document.getElementById('camera-feed');
  const frameOverlay  = document.getElementById('frame-overlay');
  const stageCard     = document.getElementById('stage-card');
  const countdownOvl  = document.getElementById('countdown-overlay');
  const countdownNum  = document.getElementById('countdown-number');
  const flashOvl      = document.getElementById('flash-overlay');
  const pillText      = document.getElementById('pill-text');
  const sessionCodeEl = document.getElementById('session-code');
  const statusDot     = document.getElementById('status-dot');
  const statusText    = document.getElementById('status-text');
  const resultPhoto   = document.getElementById('result-photo');
  const qrCanvas      = document.getElementById('qr-canvas');
  const photoCountEl  = document.getElementById('photo-count');
  const resetBar      = document.getElementById('reset-bar');
  const captureCanvas = document.getElementById('capture-canvas');

  /* ── State ── */
  let sessionCode = null;
  let stream = null;
  let actualW = 0, actualH = 0;
  let aspectRatio = '4:5';
  let capturing = false;
  let controllerConnected = false;
  let resultTimeout = null;

  const RESOLUTIONS = {
    '4:5':  { w: 1080, h: 1350 },
    '16:9': { w: 1920, h: 1080 }
  };

  const RESULT_DISPLAY_MS = 18000;

  /* ── Socket ── */
  const socket = io();

  /* ═══ INIT ═══ */
  async function init() {
    showState('booting');
    await startCamera();
    createSession();
  }

  function showState(name) {
    [stateBooting, statePreview, stateResult, stateError].forEach(el => {
      el.classList.add('hidden');
    });
    const el = {
      booting: stateBooting,
      preview: statePreview,
      result: stateResult,
      error: stateError
    }[name];
    if (el) el.classList.remove('hidden');
  }

  /* ── Camera ── */
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 4096 }, height: { ideal: 2160 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();

      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      actualW = s.width;
      actualH = s.height;
      console.log(`Camera: ${actualW}x${actualH}`);
    } catch (err) {
      console.error('Camera error:', err);
      showState('error');
    }
  }

  /* ── Session ── */
  function createSession() {
    socket.emit('create-session', ({ code }) => {
      sessionCode = code;
      sessionCodeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
      showState('preview');
      updatePill();
    });
  }

  /* ── Pill messages based on state ── */
  function updatePill() {
    if (controllerConnected) {
      pillText.textContent = 'Posicione-se e sorria!';
    } else {
      pillText.textContent = 'Use o código abaixo para conectar o controle';
    }
  }

  /* ═══ SOCKET EVENTS ═══ */

  socket.on('controller-connected', () => {
    controllerConnected = true;
    statusDot.classList.add('connected');
    statusText.textContent = 'Controle conectado';
    updatePill();
  });

  socket.on('controller-disconnected', () => {
    controllerConnected = false;
    statusDot.classList.remove('connected');
    statusText.textContent = 'Controle desconectado';
    updatePill();
  });

  socket.on('settings-updated', (settings) => {
    if (settings.aspectRatio && settings.aspectRatio !== aspectRatio) {
      aspectRatio = settings.aspectRatio;
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

  /* ═══ CAPTURE FLOW ═══ */

  async function startCountdown(seconds) {
    capturing = true;
    pillText.textContent = 'Prepare seu melhor sorriso!';
    countdownOvl.classList.remove('hidden');

    for (let i = seconds; i > 0; i--) {
      countdownNum.textContent = i;
      countdownNum.style.animation = 'none';
      void countdownNum.offsetWidth;
      countdownNum.style.animation = 'countPop .7s ease both';
      await sleep(1000);
    }

    countdownOvl.classList.add('hidden');
    await doCapture();
    capturing = false;
  }

  async function doCapture() {
    // Flash
    flashOvl.classList.remove('hidden');
    flashOvl.style.animation = 'none';
    void flashOvl.offsetWidth;
    flashOvl.style.animation = 'flashEffect .5s ease-out forwards';
    setTimeout(() => flashOvl.classList.add('hidden'), 600);

    // Composite
    const res = RESOLUTIONS[aspectRatio];
    captureCanvas.width = res.w;
    captureCanvas.height = res.h;
    const ctx = captureCanvas.getContext('2d');

    const targetAspect = res.w / res.h;
    const videoAspect = actualW / actualH;
    let sx, sy, sw, sh;

    if (videoAspect > targetAspect) {
      sh = actualH;
      sw = actualH * targetAspect;
      sx = (actualW - sw) / 2;
      sy = 0;
    } else {
      sw = actualW;
      sh = actualW / targetAspect;
      sx = 0;
      sy = (actualH - sh) / 2;
    }

    // Mirror + draw
    ctx.save();
    ctx.translate(res.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, res.w, res.h);
    ctx.restore();

    // Frame overlay
    if (frameOverlay.classList.contains('loaded') && frameOverlay.naturalWidth > 0) {
      ctx.drawImage(frameOverlay, 0, 0, res.w, res.h);
    }

    // Export & upload
    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
    const base64 = dataUrl.split(',')[1];

    showResult(dataUrl);

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
        showQRError();
      }
    } catch (err) {
      console.error('Upload failed:', err);
      showQRError();
    }
  }

  /* ═══ RESULT ═══ */

  function showResult(imgSrc) {
    resultPhoto.src = imgSrc;
    showState('result');

    if (resultTimeout) clearTimeout(resultTimeout);
    resetBar.style.transition = 'none';
    resetBar.style.width = '100%';
    void resetBar.offsetWidth;
    resetBar.style.transition = `width ${RESULT_DISPLAY_MS}ms linear`;
    resetBar.style.width = '0%';

    resultTimeout = setTimeout(resetToPreview, RESULT_DISPLAY_MS);
  }

  function generateQR(url) {
    if (typeof QRCode === 'undefined') return;
    QRCode.toCanvas(qrCanvas, url, {
      width: 200,
      margin: 2,
      color: { dark: '#003B71', light: '#FFFFFF' }
    }, (err) => {
      if (err) console.error('QR error:', err);
    });
  }

  function showQRError() {
    const ctx = qrCanvas.getContext('2d');
    qrCanvas.width = 200;
    qrCanvas.height = 200;
    ctx.fillStyle = '#F2F2F2';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#FF0C1F';
    ctx.font = '500 14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Erro no upload', 100, 100);
  }

  function resetToPreview() {
    showState('preview');
    updatePill();
    if (resultTimeout) { clearTimeout(resultTimeout); resultTimeout = null; }
  }

  socket.on('photo-ready', ({ total }) => {
    photoCountEl.textContent = `Foto ${total} do evento`;
  });

  /* ── Frame loader ── */
  function loadFrame() {
    const url = `/api/frame/${sessionCode}?ratio=${aspectRatio}&t=${Date.now()}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      frameOverlay.src = url;
      frameOverlay.classList.add('loaded');
    };
    img.onerror = () => {
      frameOverlay.classList.remove('loaded');
    };
    img.src = url;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  init();
})();
