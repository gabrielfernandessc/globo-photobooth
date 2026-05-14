/* ══════════════════════════════════════════════════════════
   DISPLAY.JS — Globo Photo Booth Totem v2
   
   Melhorias v2:
   ✅ Sessão persistente (localStorage + ?code= + auto-reconnect)
   ✅ Feedback sonoro na contagem (AudioContext beeps)
   ✅ Resultado otimizado para fila (12s, QR 300px, "Próximo")
   ✅ Atalhos de teclado (Espaço=capturar, Escape=voltar)
   ✅ Contador de fotos no header
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ── DOM ── */
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
  const photoCountHdr = $('photo-count-header');
  const resetBar      = $('reset-bar');
  const captureCanvas = $('capture-canvas');
  const btnDownload   = $('btn-download');

  /* ── State ── */
  let sessionCode   = null;
  let stream        = null;
  let videoTrack    = null; // MediaStreamTrack for camera control
  let useGphoto     = false;
  let aspectRatio   = '4:5';
  let capturing     = false;
  let resultTimeout = null;
  let lastDataUrl   = null;
  let photoTotal    = 0;
  let currentTimer  = 3;

  const RESULT_MS = 12000; // 12s — otimizado para fila

  const RESOLUTIONS = {
    '4:5':  { w: 1080, h: 1920 },
    '16:9': { w: 1440, h: 1080 },
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

  /* ── Audio Context for countdown beeps ── */
  let audioCtx = null;
  function initAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { audioCtx = null; }
    }
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
    } catch { /* audio not available */ }
  }

  /* ── Socket with auto-reconnect ── */
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
  });

  /* ═══ INIT ═══ */
  async function init() {
    showState('booting');
    bootingMsg.textContent = 'Detectando câmera…';
    bootingSub.textContent  = 'Aguarde um instante';

    // Init audio on first user interaction
    document.addEventListener('click', () => initAudio(), { once: true });
    document.addEventListener('keydown', () => initAudio(), { once: true });

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

    createOrRejoinSession();
    startIdleMessages();
    setupKeyboardShortcuts();
  }

  function showState(name) {
    [stateBooting, statePreview, stateResult, stateError].forEach(el => el.classList.add('hidden'));
    ({ booting: stateBooting, preview: statePreview, result: stateResult, error: stateError }[name])
      ?.classList.remove('hidden');
  }

  /* ═══ PERSISTENT SESSION ═══
     Priority:
     1. ?code=XXXX in URL (forced)
     2. localStorage saved code (auto-reconnect)
     3. Generate new code
  */
  function createOrRejoinSession() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlCode = urlParams.get('code')?.toUpperCase();
    const savedCode = localStorage.getItem('globo-booth-code');
    const requestedCode = urlCode || savedCode || null;

    socket.emit('create-session', { requestedCode }, ({ code, rejoined, photoCount }) => {
      sessionCode = code;
      sessionCodeEl.textContent = code;
      localStorage.setItem('globo-booth-code', code);

      if (photoCount) {
        photoTotal = photoCount;
        updatePhotoCount();
      }

      if (rejoined) {
        console.log('Rejoined session:', code);
      }

      // Load frame for current aspect ratio
      loadFrame();
    });
  }

  // Auto-reconnect: when socket reconnects, rejoin the same session
  socket.on('connect', () => {
    if (sessionCode) {
      socket.emit('create-session', { requestedCode: sessionCode }, ({ code }) => {
        sessionCodeEl.textContent = code;
      });
    }
  });

  /* ═══ GPHOTO2 MODE ═══ */
  function startGphotoMode(cam) {
    gphotoFeed.classList.remove('hidden');
    video.classList.add('hidden');
    gphotoFeed.src = '/api/gphoto/preview';
    modeBadge.classList.remove('hidden');
    modeLabel.textContent = cam.split(' ').slice(0, 3).join(' ');
    showState('preview');
  }

  /* ═══ WEBCAM MODE ═══ */
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

        // Get the video track for camera control
        videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          // Read and broadcast camera capabilities
          readAndBroadcastCapabilities();
          // Show camera name in badge
          const label = videoTrack.label || 'Webcam';
          modeBadge.classList.remove('hidden');
          modeLabel.textContent = label.length > 28 ? label.slice(0, 25) + '…' : label;
        }

        showState('preview');
        return;
      } catch { /* try next */ }
    }
    showState('error');
  }

  /* ═══ CAMERA CAPABILITIES (Browser-based) ═══
     Reads what the camera hardware supports directly from the browser.
     Works because the camera is connected to THIS machine (the totem),
     not to the server. Sends capabilities to controller via socket. */

  let cameraCapabilities = null;

  function readAndBroadcastCapabilities() {
    if (!videoTrack) return;

    try {
      const caps = videoTrack.getCapabilities();
      const settings = videoTrack.getSettings();

      // Build a clean capabilities object for the controller
      const LABELS = {
        brightness: 'Brilho', contrast: 'Contraste', saturation: 'Saturação',
        sharpness: 'Nitidez', colorTemperature: 'Temp. Cor (K)',
        exposureCompensation: 'Comp. Exposição', exposureMode: 'Modo Exposição',
        exposureTime: 'Tempo Exp. (µs)', focusMode: 'Modo Foco',
        focusDistance: 'Dist. Foco (m)', iso: 'ISO',
        whiteBalanceMode: 'Bal. Branco', zoom: 'Zoom',
        pan: 'Pan', tilt: 'Tilt',
      };

      const controls = {};

      for (const [key, label] of Object.entries(LABELS)) {
        if (!caps[key]) continue;

        const cap = caps[key];
        const current = settings[key];

        if (Array.isArray(cap)) {
          // Enum-type control (e.g., focusMode: ['continuous', 'manual'])
          controls[key] = { type: 'enum', label, options: cap, current };
        } else if (cap.min !== undefined && cap.max !== undefined) {
          // Range-type control (e.g., iso: {min: 100, max: 12800, step: 100})
          controls[key] = {
            type: 'range', label,
            min: cap.min, max: cap.max,
            step: cap.step || 1, current: current ?? cap.min
          };
        }
      }

      cameraCapabilities = controls;

      // Send to all connected sockets in this session
      if (sessionCode) {
        socket.emit('camera-capabilities', { code: sessionCode, capabilities: controls });
      }

      console.log('Camera capabilities:', Object.keys(controls));
    } catch (err) {
      console.warn('Could not read camera capabilities:', err);
    }
  }

  // Apply constraint from controller
  async function applyCameraConstraint(key, value) {
    if (!videoTrack) return { success: false, error: 'No video track' };

    try {
      const constraint = {};
      constraint[key] = value;
      await videoTrack.applyConstraints({ advanced: [constraint] });

      // Re-read current settings to confirm
      const newSettings = videoTrack.getSettings();
      return { success: true, applied: newSettings[key] };
    } catch (err) {
      console.warn(`Failed to apply ${key}=${value}:`, err);
      return { success: false, error: err.message };
    }
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

  /* ── CSS filters ── */
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

  /* ── QR Code via API (no library) ── */
  function generateQR(url) {
    const encoded = encodeURIComponent(url);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&color=003B71&bgcolor=FFFFFF&data=${encoded}&margin=12&ecc=L`;

    qrLoader.style.display = 'flex';
    qrImg.style.display    = 'none';

    qrImg.onload = () => {
      qrLoader.style.display = 'none';
      qrImg.style.display    = 'block';
      qrBody.textContent = 'Aponte a câmera do celular para abrir a foto.';
    };
    qrImg.onerror = () => {
      qrLoader.innerHTML = '<p style="font-size:12px;color:#c00;text-align:center">Sem internet para QR</p>';
    };
    qrImg.src = qrUrl;
  }

  /* ── Photo counter ── */
  function updatePhotoCount() {
    if (photoCountEl) photoCountEl.textContent = `Foto ${photoTotal} do evento`;
    if (photoCountHdr) photoCountHdr.textContent = `📷 ${photoTotal}`;
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
    if (s.timer) currentTimer = s.timer;
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

  // Controller requests camera capabilities
  socket.on('request-camera-capabilities', () => {
    if (cameraCapabilities && sessionCode) {
      socket.emit('camera-capabilities', { code: sessionCode, capabilities: cameraCapabilities });
    }
  });

  // Controller wants to change a real camera setting
  socket.on('apply-cam-constraint', async ({ key, value }, cb) => {
    const result = await applyCameraConstraint(key, value);
    if (cb) cb(result);
  });

  socket.on('show-photo', ({ url }) => { if (url) showResult(url, false); });
  socket.on('photo-ready', ({ total }) => {
    photoTotal = total;
    updatePhotoCount();
  });

  // Operator pressed "Next" on controller
  socket.on('reset-to-preview', () => {
    resetToPreview();
  });

  /* ═══ KEYBOARD SHORTCUTS ═══ */
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Space = trigger capture (same as pressing capture button)
      if (e.code === 'Space' && !capturing && !stateResult.classList.contains('hidden') === false) {
        e.preventDefault();
        if (!statePreview.classList.contains('hidden')) {
          startCountdown(currentTimer);
        }
      }
      // Escape = back to preview
      if (e.code === 'Escape') {
        e.preventDefault();
        resetToPreview();
      }
    });
  }

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

      // Audio beep on each countdown tick
      playBeep(i === 1 ? 880 : 440, i === 1 ? 200 : 80);

      await sleep(1000);
    }

    // Capture beep — higher pitch, longer
    playBeep(1200, 150);

    countdownNum.textContent = '📸';
    await sleep(200);
    countdownOvl.classList.add('hidden');

    if (useGphoto) await doGphotoCapture();
    else           await doWebcamCapture();

    capturing = false;
    overlayText.style.opacity = '1';
    overlayText.textContent = IDLE_MSGS[msgIdx];
  }

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

  async function doWebcamCapture() {
    triggerFlash();

    const res = RESOLUTIONS[aspectRatio];
    captureCanvas.width  = res.w;
    captureCanvas.height = res.h;
    const ctx = captureCanvas.getContext('2d');

    const vW = video.videoWidth  || video.offsetWidth;
    const vH = video.videoHeight || video.offsetHeight;
    const canvasAspect = res.w / res.h;
    const videoAspect  = vW / vH;

    let drawW, drawH, offX, offY;
    if (videoAspect > canvasAspect) {
      drawH = res.h; drawW = res.h * videoAspect;
      offX = (res.w - drawW) / 2; offY = 0;
    } else {
      drawW = res.w; drawH = res.w / videoAspect;
      offX = 0; offY = (res.h - drawH) / 2;
    }

    ctx.save();
    ctx.filter = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    ctx.translate(res.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, offX, offY, drawW, drawH);
    ctx.restore();
    ctx.filter = 'none';

    if (frameOverlay.classList.contains('loaded') && frameOverlay.naturalWidth > 0) {
      ctx.drawImage(frameOverlay, 0, 0, res.w, res.h);
    }

    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.93);
    lastDataUrl = dataUrl;

    showResult(dataUrl, true);
    setupDownload(dataUrl);

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

  function triggerFlash() {
    flashOvl.classList.remove('hidden');
    flashOvl.style.animation = 'none';
    void flashOvl.offsetWidth;
    flashOvl.style.animation = 'flashEffect .5s ease-out forwards';
    setTimeout(() => flashOvl.classList.add('hidden'), 600);
  }

  /* ═══ RESULT ═══ */

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
      resultTimeout = setTimeout(resetToPreview, RESULT_MS);
    }
  }

  function resetToPreview() {
    if (resultTimeout) { clearTimeout(resultTimeout); resultTimeout = null; }
    showState('preview');
  }

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
