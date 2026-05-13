/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — Lógica da tela do totem
   Camera → Preview → Capture → Composite → Upload → QR
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM refs ── */
  const video         = document.getElementById('camera-feed');
  const frameOverlay  = document.getElementById('frame-overlay');
  const previewWrap   = document.getElementById('preview-wrapper');
  const previewMode   = document.getElementById('preview-mode');
  const countdownOvl  = document.getElementById('countdown-overlay');
  const countdownNum  = document.getElementById('countdown-number');
  const flashOvl      = document.getElementById('flash-overlay');
  const sessionCodeEl = document.getElementById('session-code');
  const statusDot     = document.getElementById('status-dot');
  const statusText    = document.getElementById('status-text');
  const idleMsg       = document.getElementById('idle-msg');
  const resultView    = document.getElementById('result-view');
  const resultPhoto   = document.getElementById('result-photo');
  const qrCanvas      = document.getElementById('qr-canvas');
  const photoCountEl  = document.getElementById('photo-count');
  const resetBar      = document.getElementById('reset-bar');
  const captureCanvas = document.getElementById('capture-canvas');
  const cameraError   = document.getElementById('camera-error');

  /* ── State ── */
  let sessionCode = null;
  let stream = null;
  let actualW = 0, actualH = 0;
  let aspectRatio = '4:5';
  let capturing = false;
  let resultTimeout = null;

  /* ── Output resolutions ── */
  const RESOLUTIONS = {
    '4:5':  { w: 1080, h: 1350 },
    '16:9': { w: 1920, h: 1080 }
  };

  const RESULT_DISPLAY_MS = 18000; // 18s to show QR

  /* ── Socket.IO ── */
  const socket = io();

  /* ═══════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════ */

  async function init() {
    await startCamera();
    createSession();
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
      const settings = track.getSettings();
      actualW = settings.width;
      actualH = settings.height;
      console.log(`📷 Câmera: ${actualW}×${actualH}`);
    } catch (err) {
      console.error('Camera error:', err);
      previewMode.classList.add('hidden');
      cameraError.classList.remove('hidden');
    }
  }

  /* ── Session ── */
  function createSession() {
    socket.emit('create-session', ({ code }) => {
      sessionCode = code;
      sessionCodeEl.textContent = code.slice(0,3) + ' ' + code.slice(3);
      console.log('🔑 Session:', code);
    });
  }

  /* ═══════════════════════════════════════════════════════
     SOCKET EVENTS
     ═══════════════════════════════════════════════════════ */

  socket.on('controller-connected', () => {
    statusDot.classList.add('connected');
    statusText.textContent = 'Controle conectado';
  });

  socket.on('controller-disconnected', () => {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Controle desconectado';
  });

  socket.on('settings-updated', (settings) => {
    if (settings.aspectRatio && settings.aspectRatio !== aspectRatio) {
      aspectRatio = settings.aspectRatio;
      previewWrap.dataset.ratio = aspectRatio;
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

  /* ═══════════════════════════════════════════════════════
     CAPTURE FLOW
     ═══════════════════════════════════════════════════════ */

  async function startCountdown(seconds) {
    capturing = true;
    idleMsg.classList.add('hidden');
    countdownOvl.classList.remove('hidden');

    for (let i = seconds; i > 0; i--) {
      countdownNum.textContent = i;
      countdownNum.style.animation = 'none';
      // Trigger reflow
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

    // Composite on canvas
    const res = RESOLUTIONS[aspectRatio];
    captureCanvas.width = res.w;
    captureCanvas.height = res.h;
    const ctx = captureCanvas.getContext('2d');

    // Crop video to match aspect ratio
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

    // Mirror + draw video
    ctx.save();
    ctx.translate(res.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, res.w, res.h);
    ctx.restore();

    // Draw frame overlay
    if (frameOverlay.classList.contains('loaded') && frameOverlay.naturalWidth > 0) {
      ctx.drawImage(frameOverlay, 0, 0, res.w, res.h);
    }

    // Export & upload
    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
    const base64 = dataUrl.split(',')[1];

    showResult(dataUrl, 'Enviando...');

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
        console.error('Upload response error:', data);
        showQRError();
      }
    } catch (err) {
      console.error('Upload failed:', err);
      showQRError();
    }
  }

  /* ═══════════════════════════════════════════════════════
     RESULT VIEW
     ═══════════════════════════════════════════════════════ */

  function showResult(imgSrc, statusMsg) {
    resultPhoto.src = imgSrc;
    resultView.classList.remove('hidden');
    previewMode.classList.add('hidden');

    // Start auto-reset timer
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
      width: 220,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    }, (err) => {
      if (err) console.error('QR error:', err);
    });
  }

  function showQRError() {
    const ctx = qrCanvas.getContext('2d');
    qrCanvas.width = 220;
    qrCanvas.height = 220;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, 220, 220);
    ctx.fillStyle = '#FF0C1F';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Erro no upload', 110, 110);
  }

  function resetToPreview() {
    resultView.classList.add('hidden');
    previewMode.classList.remove('hidden');
    idleMsg.classList.remove('hidden');
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

  /* ── Utility ── */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Start ── */
  init();
})();
