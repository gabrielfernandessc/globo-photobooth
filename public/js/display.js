/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — Tela do Totem
   Estados: booting → preview → countdown → result
   Recebe: cam-control, show-photo via socket
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM ── */
  const stateBooting  = document.getElementById('state-booting');
  const statePreview  = document.getElementById('state-preview');
  const stateResult   = document.getElementById('state-result');
  const stateError    = document.getElementById('state-error');

  const video         = document.getElementById('camera-feed');
  const frameOverlay  = document.getElementById('frame-overlay');
  const stageCard     = document.getElementById('stage-card');
  const overlayText   = document.getElementById('overlay-text');
  const countdownOvl  = document.getElementById('countdown-overlay');
  const countdownNum  = document.getElementById('countdown-number');
  const flashOvl      = document.getElementById('flash-overlay');
  const sessionCodeEl = document.getElementById('session-code');
  const statusDot     = document.getElementById('status-dot');
  const statusText    = document.getElementById('status-text');
  const resultPhoto   = document.getElementById('result-photo');
  const qrCanvas      = document.getElementById('qr-canvas');
  const photoCountEl  = document.getElementById('photo-count');
  const resetBar      = document.getElementById('reset-bar');
  const captureCanvas = document.getElementById('capture-canvas');

  /* ── State ── */
  let sessionCode  = null;
  let stream       = null;
  let videoTrack   = null;
  let imageCapture = null;
  let actualW = 0, actualH = 0;
  let aspectRatio  = '4:5';
  let capturing    = false;
  let resultTimeout = null;
  const RESULT_MS  = 18000;

  const RESOLUTIONS = {
    '4:5':  { w: 1080, h: 1350 },
    '16:9': { w: 1920, h: 1080 }
  };

  const IDLE_MESSAGES = [
    '📸 Faça uma pose incrível!',
    '🤩 Sorria para a câmera!',
    '😎 Mostre seu melhor lado!',
    '✌️ Seja você mesmo!',
    '🎉 Vamos tirar uma foto?',
  ];
  let msgIdx = 0;

  /* ── Socket ── */
  const socket = io();

  /* ═══ INIT ═══ */
  async function init() {
    showState('booting');
    await startCamera();
    createSession();
    startIdleMessages();
  }

  function showState(name) {
    stateBooting.classList.add('hidden');
    statePreview.classList.add('hidden');
    stateResult.classList.add('hidden');
    stateError.classList.add('hidden');
    const map = { booting: stateBooting, preview: statePreview, result: stateResult, error: stateError };
    map[name]?.classList.remove('hidden');
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

  /* ── Camera ── */
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 4096 }, height: { ideal: 2160 }, facingMode: 'user' },
        audio: false
      });
      video.srcObject = stream;
      await video.play();

      videoTrack = stream.getVideoTracks()[0];
      const s = videoTrack.getSettings();
      actualW = s.width; actualH = s.height;

      // ImageCapture for camera controls
      if ('ImageCapture' in window) {
        imageCapture = new ImageCapture(videoTrack);
      }

      console.log(`Camera: ${actualW}x${actualH}`);
    } catch (err) {
      console.error('Camera error:', err);
      showState('error');
    }
  }

  /* ── Apply camera controls via ImageCapture ── */
  async function applyCamControl(cmd) {
    if (!videoTrack) return;
    try {
      const constraints = {};
      if (cmd.brightness !== undefined) constraints.brightness = cmd.brightness;
      if (cmd.contrast   !== undefined) constraints.contrast   = cmd.contrast;
      if (cmd.saturation !== undefined) constraints.saturation = cmd.saturation;
      if (cmd.zoom       !== undefined) constraints.zoom       = cmd.zoom;
      if (cmd.focusMode  !== undefined && cmd.focusMode !== '') constraints.focusMode = cmd.focusMode;
      if (cmd.focusDistance !== undefined) constraints.focusDistance = cmd.focusDistance;

      if (Object.keys(constraints).length > 0) {
        await videoTrack.applyConstraints({ advanced: [constraints] });
      }
    } catch (err) {
      console.warn('Camera control not supported:', err.message);
    }
  }

  /* ── Session ── */
  function createSession() {
    socket.emit('create-session', ({ code }) => {
      sessionCode = code;
      sessionCodeEl.textContent = code.slice(0,3) + ' ' + code.slice(3);
      showState('preview');
    });
  }

  /* ═══ SOCKET EVENTS ═══ */

  socket.on('controller-connected', () => {
    statusDot.classList.add('connected');
    statusText.textContent = 'Controle conectado';
  });

  socket.on('controller-disconnected', () => {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Aguardando controle';
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

  socket.on('cam-control', ({ cmd }) => {
    applyCamControl(cmd);
  });

  socket.on('show-photo', ({ url }) => {
    if (url) showResult(url, false);
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

    countdownOvl.classList.add('hidden');
    await doCapture();
    capturing = false;
    overlayText.style.opacity = '1';
    overlayText.textContent = IDLE_MESSAGES[msgIdx];
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
    const videoAspect  = actualW / actualH;
    let sx, sy, sw, sh;
    if (videoAspect > targetAspect) {
      sh = actualH; sw = actualH * targetAspect;
      sx = (actualW - sw) / 2; sy = 0;
    } else {
      sw = actualW; sh = actualW / targetAspect;
      sx = 0; sy = (actualH - sh) / 2;
    }

    ctx.save();
    ctx.translate(res.w, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, res.w, res.h);
    ctx.restore();

    if (frameOverlay.classList.contains('loaded') && frameOverlay.naturalWidth > 0) {
      ctx.drawImage(frameOverlay, 0, 0, res.w, res.h);
    }

    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
    const base64  = dataUrl.split(',')[1];

    showResult(dataUrl, true);

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
          code: sessionCode, url: photoUrl,
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

  function showResult(imgSrc, startTimer = true) {
    resultPhoto.src = imgSrc;
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

  function generateQR(url) {
    if (typeof QRCode === 'undefined') return;
    QRCode.toCanvas(qrCanvas, url, {
      width: 180, margin: 2,
      color: { dark: '#003B71', light: '#FFFFFF' }
    }, err => { if (err) console.error('QR error:', err); });
  }

  function showQRError() {
    const ctx = qrCanvas.getContext('2d');
    qrCanvas.width = 180; qrCanvas.height = 180;
    ctx.fillStyle = '#F2F2F2'; ctx.fillRect(0, 0, 180, 180);
    ctx.fillStyle = '#FF0C1F'; ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('Erro no upload', 90, 90);
  }

  function resetToPreview() {
    showState('preview');
    if (resultTimeout) { clearTimeout(resultTimeout); resultTimeout = null; }
  }

  socket.on('photo-ready', ({ total }) => {
    photoCountEl.textContent = `Foto ${total} do evento`;
  });

  /* ── Frame loader ── */
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
