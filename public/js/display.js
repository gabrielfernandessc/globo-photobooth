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
  const stageWrap     = $('stage-wrap');
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
  const photoCountHdr = $('header-photo-count');
  const resetBar      = $('reset-bar');
  const captureCanvas = $('capture-canvas');
  const btnDownload   = $('btn-download');
  const buildInfo     = $('build-info');
  const diagnosticsInfo = $('diagnostics-info');

  /* ── State ── */
  let sessionCode   = null;
  let stream        = null;
  let useGphoto     = false;
  let aspectRatio   = '3:4';
  let capturing     = false;
  let resultTimeout = null;
  let lastDataUrl   = null;
  let photoTotal    = 0;
  let currentTimer  = 3;
  const savedWidths = { '3:4': '', '4:3': '' };
  const diagnostics = {
    mode: 'Inicializando',
    preview: '--',
    track: '',
    capture: '--',
    payload: '--',
    final: '--',
    finalFile: '--',
  };

  const RESULT_MS = 12000; // 12s — otimizado para fila

  const IDLE_MSGS = [
    '📸 Faça uma pose incrível!',
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
    loadBuildInfo();

    try {
      const r = await fetch('/api/sony/status');
      const d = await r.json();
      if (d.available) {
        useGphoto = true; // Flag agora significa 'Use Native Sony API'
        bootingMsg.textContent = 'Sony conectada!';
        bootingSub.textContent  = d.camera;
        await sleep(800);
        startSonyMode(d.camera);
      } else {
        await startWebcamMode();
      }
    } catch {
      await startWebcamMode();
    }

    createOrRejoinSession();
    startIdleMessages();
    setupKeyboardShortcuts();
    setupDraggableResize();
  }

  function setupDraggableResize() {
    const handle = document.getElementById('resize-handle');
    if (!handle) return;

    let isResizing = false;

    const onMove = (e) => {
      if (!isResizing) return;
      
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      
      const rect = stageWrap.getBoundingClientRect();
      const newW = Math.max(200, Math.min(1200, clientX - rect.left));
      const newH = Math.max(200, Math.min(1200, clientY - rect.top));
      
      stageWrap.style.width = `${newW}px`;
      stageWrap.style.height = `${newH}px`;
      
      // Update control panel if connected
      socket.emit('cam-control', { previewWidth: Math.round(newW), previewHeight: Math.round(newH) });
    };

    const onEnd = () => {
      isResizing = false;
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      document.body.style.cursor = 'nwse-resize';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
    });

    handle.addEventListener('touchstart', (e) => {
      isResizing = true;
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
    });
  }

  function showState(name) {
    [stateBooting, statePreview, stateResult, stateError].forEach(el => el.classList.add('hidden'));
    ({ booting: stateBooting, preview: statePreview, result: stateResult, error: stateError }[name])
      ?.classList.remove('hidden');
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

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '--';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function estimateDataUrlBytes(dataUrl) {
    const base64 = (dataUrl || '').split(',')[1] || '';
    return Math.round(base64.length * 0.75);
  }

  function setDiagnostics(next) {
    Object.assign(diagnostics, next);
    if (!diagnosticsInfo) return;
    diagnosticsInfo.textContent = [
      `Modo: ${diagnostics.mode}`,
      `Preview: ${diagnostics.preview}`,
      diagnostics.track ? `Track: ${diagnostics.track}` : '',
      `Captura: ${diagnostics.capture}`,
      `Envio: ${diagnostics.payload}`,
      `Final: ${diagnostics.final}`,
      `Arquivo: ${diagnostics.finalFile}`,
    ].filter(Boolean).join(' | ');
  }

  function refreshPreviewDiagnostics() {
    if (useGphoto) {
      const w = gphotoFeed.naturalWidth || 0;
      const h = gphotoFeed.naturalHeight || 0;
      setDiagnostics({ mode: 'Sony SDK', preview: w && h ? `${w}x${h}` : '--' });
      return;
    }

    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    const track = stream?.getVideoTracks?.()[0];
    const settings = track?.getSettings?.() || {};
    const trackText = settings.width && settings.height
      ? `${settings.width}x${settings.height}${settings.frameRate ? ` @ ${Math.round(settings.frameRate)}fps` : ''}`
      : '';
    setDiagnostics({ mode: 'Webcam web', preview: w && h ? `${w}x${h}` : '--', track: trackText });
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

  /* ═══ SONY SDK MODE ═══ */
  let sonyLiveViewInterval = null;

  function startSonyMode(cam) {
    gphotoFeed.classList.remove('hidden');
    video.classList.add('hidden');
    
    // Poll for live view frames
    if (sonyLiveViewInterval) clearInterval(sonyLiveViewInterval);
    sonyLiveViewInterval = setInterval(() => {
      if (!capturing && !statePreview.classList.contains('hidden')) {
        gphotoFeed.src = '/api/sony/preview?t=' + Date.now();
      }
    }, 80);

    modeBadge.classList.remove('hidden');
    modeLabel.textContent = cam.split(' ').slice(0, 3).join(' ');
    setDiagnostics({ mode: 'Sony SDK' });
    setInterval(refreshPreviewDiagnostics, 1000);
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
        refreshPreviewDiagnostics();
        setInterval(refreshPreviewDiagnostics, 1000);
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

  /* ── CSS filters ── */
  function applyCamControl(cmd) {
    if (cmd.brightness !== undefined) camFilters.brightness = Math.round(100 + cmd.brightness * 10);
    if (cmd.contrast   !== undefined) camFilters.contrast   = cmd.contrast;
    if (cmd.saturation !== undefined) camFilters.saturation = cmd.saturation;
    if (cmd.zoom       !== undefined) camZoom = cmd.zoom;
    
    if (cmd.previewWidth  !== undefined) stageWrap.style.width  = `${cmd.previewWidth}px`;
    if (cmd.previewHeight !== undefined) stageWrap.style.height = `${cmd.previewHeight}px`;

    const f = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    video.style.filter      = f;
    video.style.transform   = `scale(${camZoom})`;
    gphotoFeed.style.filter = f;
    gphotoFeed.style.transform = `scale(${camZoom})`;
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
    if (photoCountHdr) photoCountHdr.textContent = `${photoTotal} fotos`;
  }

  /* ═══ SOCKET EVENTS ═══ */

  socket.on('controller-connected', () => {
    statusDot.classList.add('connected');
    $('status-text').textContent = 'Tudo pronto para a foto.';
  });
  socket.on('controller-disconnected', () => {
    statusDot.classList.remove('connected');
    $('status-text').textContent = 'Aguardando liberação...';
  });
  socket.on('settings-updated', s => {
    if (s.timer) currentTimer = s.timer;
    if (s.aspectRatio && s.aspectRatio !== aspectRatio) {
      // Save current width for the old aspect ratio
      savedWidths[aspectRatio] = stageWrap.style.width;

      aspectRatio = s.aspectRatio;
      stageCard.dataset.ratio = aspectRatio;

      // Restore saved width for the new aspect ratio
      if (savedWidths[aspectRatio]) {
        stageWrap.style.width = savedWidths[aspectRatio];
      } else {
        stageWrap.style.width = ''; // back to CSS default
      }

      loadFrame();
    }
  });
  socket.on('frame-updated', ({ aspectRatio: ratio, frameUrl }) => {
    if (ratio === aspectRatio && frameUrl) {
      frameOverlay.onload = () => {
        frameOverlay.classList.add('loaded');
        $('stage-card').style.aspectRatio = `${frameOverlay.naturalWidth} / ${frameOverlay.naturalHeight}`;
      };
      frameOverlay.src = frameUrl;
    }
  });
  socket.on('start-countdown', ({ timer }) => {
    if (!capturing) startCountdown(timer);
  });
  socket.on('cam-control', ({ cmd }) => applyCamControl(cmd));

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
    const statusText = $('status-text');
    if (statusText) statusText.textContent = 'Preparando o registro...';

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

    if (useGphoto) await doSonyCapture();
    else           await doWebcamCapture();

    capturing = false;
    overlayText.style.opacity = '1';
    overlayText.textContent = IDLE_MSGS[msgIdx];
  }

  async function doSonyCapture() {
    triggerFlash();
    showState('result');
    resultPhoto.src = '';
    qrBody.textContent = 'Capturando na câmera em alta resolução…';
    qrLoader.innerHTML = '<div class="spinner" style="border-color:rgba(0,59,113,.12);border-top-color:#003B71"></div><p style="font-size:12px;color:#666;margin:4px 0 0">Capturando…</p>';
    qrLoader.style.display = 'flex';
    qrImg.style.display = 'none';
    btnDownload.classList.add('hidden');

    try {
      const resp = await fetch('/api/sony/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: sessionCode, aspectRatio })
      });
      const data = await resp.json();
      if (data.success && data.data) {
        const imageUrl = data.data.imageUrl;
        const pageUrl = data.data.pageUrl || imageUrl;
        showResult(imageUrl, true);
        generateQR(pageUrl);
        setupDownloadUrl(data.data.downloadUrl || imageUrl);
        applyFinalDiagnostics(data.data.meta);
        socket.emit('photo-uploaded', { code: sessionCode, url: imageUrl, thumbnail: imageUrl });
      } else { showState('preview'); }
    } catch { showState('preview'); }
  }

  async function doWebcamCapture() {
    triggerFlash();

    const videoW = video.videoWidth || 1920;
    const videoH = video.videoHeight || 1080;
    
    // Alvo de alta resolução (ex: 1600px de altura para garantir nitidez no download)
    const targetH = 1600;
    const targetW = aspectRatio === '4:3' ? Math.round(targetH * 4/3) : Math.round(targetH * 3/4);
    
    captureCanvas.width  = targetW;
    captureCanvas.height = targetH;
    const ctx = captureCanvas.getContext('2d', { alpha: false });

    // Máxima qualidade de interpolação do navegador (GPU)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Calcula o corte (crop) para preencher o canvas (Object Fit Cover manual)
    const sourceRatio = videoW / videoH;
    const targetRatio = targetW / targetH;
    let sw, sh, sx, sy;

    if (sourceRatio > targetRatio) {
      sh = videoH;
      sw = sh * targetRatio;
      sx = (videoW - sw) / 2;
      sy = 0;
    } else {
      sw = videoW;
      sh = sw / targetRatio;
      sx = 0;
      sy = (videoH - sh) / 2;
    }

    ctx.save();
    // Aplica os mesmos filtros do preview para o "Save State" ser idêntico
    ctx.filter = `brightness(${camFilters.brightness}%) contrast(${camFilters.contrast}%) saturate(${camFilters.saturation}%)`;
    
    // Espelha e desenha com o crop calculado (pedido pelo usuário para ser espelhado no final)
    ctx.translate(targetW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
    ctx.restore();

    // Captura em JPEG com qualidade máxima (menor chance de artefatos de "pixels rasgados" que o PNG em upscales via CPU)
    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.98);
    lastDataUrl = dataUrl;
    
    setDiagnostics({
      capture: `${targetW}x${targetH} (upscaled)`,
      payload: formatBytes(estimateDataUrlBytes(dataUrl)),
      final: 'processando',
      finalFile: '--',
    });

    showResult(dataUrl, true);

    qrBody.textContent = 'Gerando link para compartilhamento…';
    qrLoader.innerHTML = '<div class="spinner" style="border-color:rgba(0,59,113,.12);border-top-color:#003B71"></div><p style="font-size:12px;color:#666;margin:4px 0 0">Finalizando…</p>';
    qrLoader.style.display = 'flex';
    qrImg.style.display    = 'none';
    btnDownload.classList.add('hidden');

    try {
      const resp = await fetch('/api/photo/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          image: dataUrl, 
          code: sessionCode, 
          aspectRatio
        })
      });
      const data = await resp.json();
      if (data.success && data.data?.imageUrl) {
        const imageUrl = data.data.imageUrl;
        const pageUrl = data.data.pageUrl || imageUrl;
        showResult(imageUrl, true);
        generateQR(pageUrl);
        setupDownloadUrl(data.data.downloadUrl || imageUrl);
        applyFinalDiagnostics(data.data.meta);
        socket.emit('photo-uploaded', { code: sessionCode, url: imageUrl, thumbnail: imageUrl });
      } else {
        qrBody.textContent = 'Upload falhou — salve via botão abaixo.';
        qrLoader.style.display = 'none';
        setupDownload(dataUrl);
      }
    } catch {
      qrBody.textContent = 'Sem conexão — salve via botão abaixo.';
      qrLoader.style.display = 'none';
      setupDownload(dataUrl);
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
    const statusText = $('status-text');
    if (statusText) {
      statusText.textContent = $('status-dot').classList.contains('connected') 
        ? 'Tudo pronto para a foto.' 
        : 'Aguardando liberação...';
    }
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

  function setupDownloadUrl(url) {
    if (!url) return;
    btnDownload.classList.remove('hidden');
    btnDownload.onclick = () => {
      window.open(url, '_blank', 'noopener');
    };
  }

  function applyFinalDiagnostics(meta) {
    if (!meta) return;
    const upscale = meta.upscaleFactor && meta.upscaleFactor > 1 ? ` up${meta.upscaleFactor}x` : '';
    const crop = meta.cropWidth && meta.cropHeight ? ` (crop ${meta.cropWidth}x${meta.cropHeight})` : '';
    setDiagnostics({
      final: meta.finalWidth && meta.finalHeight ? `${meta.finalWidth}x${meta.finalHeight}${crop}` : '--',
      finalFile: `${formatBytes(meta.finalBytes)} ${meta.format || ''} q${meta.quality || ''}${upscale}`.trim(),
      payload: meta.inputBytes ? formatBytes(meta.inputBytes) : diagnostics.payload,
    });
  }

  function loadFrame() {
    if (!sessionCode) return;
    const url = `/api/frame/${sessionCode}?ratio=${aspectRatio}&t=${Date.now()}`;
    const img = new Image();
    img.onload  = () => { 
      frameOverlay.src = url; 
      frameOverlay.classList.add('loaded'); 
      $('stage-card').style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    };
    img.onerror = () => {
      frameOverlay.classList.remove('loaded');
      $('stage-card').style.aspectRatio = '';
    };
    img.src = url;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  init();
})();
