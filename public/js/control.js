/* ══════════════════════════════════════════════════════════
   CONTROL.JS — controle remoto

   Dispara a foto, ajusta a sessão e — quando há um celular pareado
   como câmera — controla o sensor dele de verdade (lanterna, foco,
   zoom, exposição) por relay via Socket.IO.
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ── Pareamento ── */
  const pairingScreen = $('pairing-screen');
  const controlScreen = $('control-screen');
  const digits        = Array.from(document.querySelectorAll('.code-inputs input'));
  const btnConnect    = $('btn-connect');
  const pairError     = $('pair-error');

  /* ── Header ── */
  const ctrlDot       = $('ctrl-dot');
  const ctrlStatusTxt = $('ctrl-status-text');
  const ctrlCount     = $('ctrl-count');
  const btnDisconnect = $('btn-disconnect');

  /* ── Tabs ── */
  const tabs   = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');

  /* ── Disparo ── */
  const sourceHint  = $('source-hint');
  const captureBtn  = $('capture-btn');
  const btnNext     = $('btn-next');
  const timerPills  = document.querySelectorAll('[data-timer]');
  const ratioPills  = document.querySelectorAll('[data-ratio]:not(.frame-btn)');
  const btnFrame3x4 = $('btn-frame-3x4');
  const btnFrame4x3 = $('btn-frame-4x3');
  const frameInput  = $('frame-input');

  /* ── Galeria ── */
  const galleryGrid = $('gallery-grid');
  const noPhotos    = $('no-photos');

  /* ── Celular-câmera ── */
  const phoneSection   = $('phone-section');
  const phoneName      = $('phone-name');
  const phoneSub       = $('phone-sub');
  const phoneCaps      = $('phone-caps');
  const camDivider     = $('cam-divider');
  const cssHint        = $('css-hint');
  const btnTorch       = $('btn-torch');
  const btnAutofocus   = $('btn-autofocus');
  const ctrlPhoneZoom  = $('ctrl-phone-zoom');
  const valPhoneZoom   = $('val-phone-zoom');
  const ctrlPhoneEv    = $('ctrl-phone-ev');
  const valPhoneEv     = $('val-phone-ev');
  const btnPhoneMirror = $('btn-phone-mirror');
  const ctrlLead       = $('ctrl-lead');
  const valLead        = $('val-lead');

  /* ── Filtros do preview do totem ── */
  const ctrlBrightness = $('ctrl-brightness');
  const ctrlContrast   = $('ctrl-contrast');
  const ctrlSaturation = $('ctrl-saturation');
  const ctrlPreviewW   = $('ctrl-preview-w');
  const ctrlPreviewH   = $('ctrl-preview-h');
  const ctrlZoom       = $('ctrl-zoom');
  const valBrightness  = $('val-brightness');
  const valContrast    = $('val-contrast');
  const valSaturation  = $('val-saturation');
  const valPreviewW    = $('val-preview-w');
  const valPreviewH    = $('val-preview-h');
  const valZoom        = $('val-zoom');
  const btnResetCam    = $('btn-reset-cam');

  /* ── Estado ── */
  let sessionCode   = null;
  let selectedTimer = 3;
  let selectedRatio = '3:4';
  let pendingFrameRatio = null;
  let capturing   = false;
  let torchOn     = false;
  let phoneMirror = false;
  let hasCamera   = false;

  const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

  /* ═══════════════════════════════════════════════════════
     PAREAMENTO
     ═══════════════════════════════════════════════════════ */

  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.slice(-1).toUpperCase();
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
      checkReady();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].value = '';
        digits[i - 1].focus();
        checkReady();
      }
    });
  });

  function checkReady() {
    btnConnect.disabled = !digits.every(d => d.value.length === 1);
    digits.forEach(d => d.classList.toggle('filled', d.value.length === 1));
  }

  btnConnect.addEventListener('click', () => {
    btnConnect.disabled = true;
    pairError.classList.add('hidden');
    join(digits.map(d => d.value).join('').toUpperCase(), true);
  });

  function join(code, interactive) {
    socket.emit('join-session', { code, role: 'control' }, res => {
      if (!res?.success) {
        if (interactive) {
          pairError.textContent = res?.error || 'Código inválido.';
          pairError.classList.remove('hidden');
          btnConnect.disabled = false;
          digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
          digits[0].focus();
        } else {
          localStorage.removeItem('globo-booth-ctrl-code');
          sessionCode = null;
        }
        return;
      }

      sessionCode = code;
      localStorage.setItem('globo-booth-ctrl-code', code);
      pairingScreen.classList.add('hidden');
      controlScreen.classList.remove('hidden');
      setStatus(true);
      applySnapshot(res);
    });
  }

  (function autoReconnect() {
    const saved = localStorage.getItem('globo-booth-ctrl-code');
    if (saved) join(saved, false);
  })();

  socket.on('connect', () => { if (sessionCode) join(sessionCode, false); });

  btnDisconnect?.addEventListener('click', () => {
    localStorage.removeItem('globo-booth-ctrl-code');
    sessionCode = null;
    galleryGrid.querySelectorAll('.gallery-thumb').forEach(el => el.remove());
    noPhotos.style.display = '';
    controlScreen.classList.add('hidden');
    pairingScreen.classList.remove('hidden');
    digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
    digits[0].focus();
    setStatus(false);
  });

  /* ═══════════════════════════════════════════════════════
     ESTADO DA SESSÃO
     ═══════════════════════════════════════════════════════ */

  function applySnapshot(snapshot = {}) {
    if (snapshot.settings) applySettings(snapshot.settings);
    if (snapshot.photoCount !== undefined) ctrlCount.textContent = `${snapshot.photoCount} fotos`;
    if (snapshot.hasFrame3x4) markFrame(btnFrame3x4);
    if (snapshot.hasFrame4x3) markFrame(btnFrame4x3);
    hasCamera = !!snapshot.hasCamera;
    updateSource(snapshot.cameraInfo);
  }

  socket.on('presence', applySnapshot);
  socket.on('camera-state', ({ state }) => { hasCamera = true; updateSource(state); });
  socket.on('camera-connected', ({ info }) => { hasCamera = true; updateSource(info); });
  socket.on('camera-disconnected', () => { hasCamera = false; updateSource(null); });
  socket.on('display-reconnected', () => { setStatus(true); ctrlStatusTxt.textContent = 'Reconectado'; });
  socket.on('display-disconnected', () => { setStatus(false); ctrlStatusTxt.textContent = 'Totem desconectado'; });

  function updateSource(state) {
    phoneSection.style.display = hasCamera ? 'block' : 'none';
    camDivider.style.display = hasCamera ? 'block' : 'none';

    if (!hasCamera) {
      sourceHint.textContent = 'Fonte: webcam do totem. Abra /camera.html no celular para usar o sensor dele.';
      cssHint.textContent = 'Ajustes visuais aplicados ao preview do totem.';
      phoneName.textContent = 'Celular-câmera';
      phoneSub.textContent = 'Nenhum aparelho pareado';
      phoneCaps.textContent = '';
      torchOn = false;
      btnTorch.textContent = 'Ligar';
      btnTorch.classList.remove('has-frame');
      return;
    }

    const mp = state?.photoWidth && state?.photoHeight
      ? ((state.photoWidth * state.photoHeight) / 1e6).toFixed(1)
      : null;

    sourceHint.textContent = mp
      ? `Fonte: celular · fotos de ${state.photoWidth}×${state.photoHeight} (${mp} MP)`
      : 'Fonte: celular pareado';

    phoneName.textContent = shortLabel(state?.label) || 'Celular-câmera';
    phoneSub.textContent = state?.streamWidth
      ? `Preview ${state.streamWidth}×${state.streamHeight} · foto ${state.photoWidth}×${state.photoHeight}`
      : 'Controles reais do sensor';

    phoneCaps.textContent = [
      mp ? `Resolução da foto: ${state.photoWidth} × ${state.photoHeight} (${mp} MP)` : '',
      state?.facingMode ? `Lente: ${state.facingMode === 'user' ? 'frontal' : 'traseira'}` : '',
      `Lanterna: ${state?.hasTorch ? 'disponível' : 'indisponível'}`,
      `Zoom: ${state?.hasZoom ? 'disponível' : 'indisponível'}`,
    ].filter(Boolean).join('\n');

    btnTorch.disabled = !state?.hasTorch;
    ctrlPhoneZoom.disabled = !state?.hasZoom;
  }

  function shortLabel(label = '') {
    return label.replace(/\s*\(.*\)$/, '').slice(0, 32);
  }

  function setStatus(online) {
    ctrlDot.classList.toggle('connected', online);
    ctrlStatusTxt.textContent = online ? 'Conectado' : 'Desconectado';
    captureBtn.disabled = !online || capturing;
  }

  /* ═══════════════════════════════════════════════════════
     TABS
     ═══════════════════════════════════════════════════════ */

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      $(`panel-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });

  /* ═══════════════════════════════════════════════════════
     DISPARO
     ═══════════════════════════════════════════════════════ */

  captureBtn.addEventListener('click', () => {
    if (!sessionCode || capturing) return;
    capturing = true;
    captureBtn.classList.add('capturing');
    captureBtn.disabled = true;
    socket.emit('trigger-capture', { code: sessionCode, timer: selectedTimer });
    vibrate(40);

    // Destrava mesmo se a foto falhar do outro lado.
    setTimeout(releaseShutter, (selectedTimer + 25) * 1000);
  });

  function releaseShutter() {
    capturing = false;
    captureBtn.classList.remove('capturing');
    captureBtn.disabled = !ctrlDot.classList.contains('connected');
  }

  socket.on('photo-ready', ({ thumbnail, page, url, total }) => {
    releaseShutter();
    ctrlCount.textContent = `${total} fotos`;
    addToGallery(page || url, thumbnail || url);
    vibrate([80, 50, 80]);
  });

  socket.on('camera-status', ({ status }) => { if (status === 'error') releaseShutter(); });

  btnNext?.addEventListener('click', () => {
    if (!sessionCode) return;
    socket.emit('reset-to-preview', { code: sessionCode });
    vibrate(30);
  });

  /* ═══════════════════════════════════════════════════════
     GALERIA
     ═══════════════════════════════════════════════════════ */

  function addToGallery(url, thumb) {
    noPhotos.style.display = 'none';
    const time = new Date();
    const item = document.createElement('div');
    item.className = 'gallery-thumb';
    item.innerHTML = `
      <img src="${thumb}" alt="foto" loading="lazy">
      <span class="gallery-time">${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}</span>
    `;
    item.addEventListener('click', () => {
      socket.emit('show-photo', { code: sessionCode, url: thumb });
      vibrate(30);
    });
    galleryGrid.prepend(item);
  }

  socket.on('session-photos', ({ photos }) => {
    galleryGrid.querySelectorAll('.gallery-thumb').forEach(el => el.remove());
    photos.forEach(p => addToGallery(p.page || p.url, p.thumbnail || p.url));
  });

  /* ═══════════════════════════════════════════════════════
     AJUSTES DA SESSÃO
     ═══════════════════════════════════════════════════════ */

  timerPills.forEach(pill => {
    pill.addEventListener('click', () => {
      selectedTimer = parseInt(pill.dataset.timer, 10);
      timerPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      pushSettings({ timer: selectedTimer });
    });
  });

  ratioPills.forEach(pill => {
    pill.addEventListener('click', () => {
      selectedRatio = pill.dataset.ratio;
      ratioPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      pushSettings({ aspectRatio: selectedRatio });
      syncPreviewFields();
    });
  });

  ctrlLead.addEventListener('input', () => {
    valLead.textContent = `${ctrlLead.value}ms`;
    pushSettings({ shutterLeadMs: parseInt(ctrlLead.value, 10) });
  });

  function pushSettings(settings) {
    if (sessionCode) socket.emit('update-settings', { code: sessionCode, settings });
  }

  socket.on('settings-updated', applySettings);

  function applySettings(settings = {}) {
    if (settings.timer) {
      selectedTimer = settings.timer;
      timerPills.forEach(p => p.classList.toggle('active', parseInt(p.dataset.timer, 10) === settings.timer));
    }
    if (settings.aspectRatio) {
      selectedRatio = settings.aspectRatio;
      ratioPills.forEach(p => p.classList.toggle('active', p.dataset.ratio === settings.aspectRatio));
      syncPreviewFields();
    }
    if (settings.shutterLeadMs !== undefined) {
      ctrlLead.value = settings.shutterLeadMs;
      valLead.textContent = `${settings.shutterLeadMs}ms`;
    }
  }

  function syncPreviewFields() {
    const [a, b] = selectedRatio.split(':').map(Number);
    const width = parseInt(ctrlPreviewW.value, 10);
    const height = Math.round(width / (a / b));
    ctrlPreviewH.value = height;
    valPreviewH.textContent = `${height}px`;
  }

  /* ═══════════════════════════════════════════════════════
     MOLDURA
     ═══════════════════════════════════════════════════════ */

  [btnFrame3x4, btnFrame4x3].forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFrameRatio = btn.dataset.ratio;
      frameInput.click();
    });
  });

  frameInput.addEventListener('change', async () => {
    const file = frameInput.files[0];
    if (!file || !sessionCode || !pendingFrameRatio) return;

    const btn = pendingFrameRatio === '3:4' ? btnFrame3x4 : btnFrame4x3;
    const original = btn.textContent;
    btn.textContent = 'Enviando…';
    btn.disabled = true;

    try {
      const form = new FormData();
      form.append('frame', file);
      form.append('aspectRatio', pendingFrameRatio);
      const resp = await fetch(`/api/frame/${sessionCode}`, { method: 'POST', body: form });
      const data = await resp.json();
      if (data.success) markFrame(btn);
      else throw new Error(data.error);
    } catch {
      btn.textContent = 'Erro';
      setTimeout(() => { btn.textContent = original; }, 2000);
    } finally {
      btn.disabled = false;
      frameInput.value = '';
    }
  });

  function markFrame(btn) {
    btn.classList.add('has-frame');
    btn.textContent = 'Pronto ✓';
  }

  /* ═══════════════════════════════════════════════════════
     CONTROLES REAIS DO CELULAR
     ═══════════════════════════════════════════════════════ */

  function sendCameraControl(cmd) {
    if (sessionCode) socket.emit('camera-control', { code: sessionCode, cmd });
  }

  btnTorch.addEventListener('click', () => {
    torchOn = !torchOn;
    btnTorch.textContent = torchOn ? 'Desligar' : 'Ligar';
    btnTorch.classList.toggle('has-frame', torchOn);
    sendCameraControl({ torch: torchOn });
    vibrate(20);
  });

  btnAutofocus.addEventListener('click', () => {
    sendCameraControl({ autofocus: true });
    btnAutofocus.textContent = 'Focando…';
    setTimeout(() => { btnAutofocus.textContent = 'Focar agora (AF)'; }, 1500);
    vibrate(20);
  });

  ctrlPhoneZoom.addEventListener('input', () => {
    valPhoneZoom.textContent = `${(+ctrlPhoneZoom.value).toFixed(1)}x`;
    sendCameraControl({ zoom: parseFloat(ctrlPhoneZoom.value) });
  });

  ctrlPhoneEv.addEventListener('input', () => {
    valPhoneEv.textContent = (+ctrlPhoneEv.value).toFixed(1);
    sendCameraControl({ exposureCompensation: parseFloat(ctrlPhoneEv.value) });
  });

  btnPhoneMirror.addEventListener('click', () => {
    phoneMirror = !phoneMirror;
    btnPhoneMirror.textContent = phoneMirror ? 'Ligado' : 'Desligado';
    btnPhoneMirror.classList.toggle('has-frame', phoneMirror);
    sendCameraControl({ mirror: phoneMirror });
  });

  /* ═══════════════════════════════════════════════════════
     FILTROS DO PREVIEW DO TOTEM
     ═══════════════════════════════════════════════════════ */

  function sendCamControl(cmd) {
    if (sessionCode) socket.emit('cam-control', { code: sessionCode, cmd });
  }

  ctrlBrightness.addEventListener('input', () => {
    valBrightness.textContent = ctrlBrightness.value;
    sendCamControl({ brightness: parseFloat(ctrlBrightness.value) });
  });
  ctrlContrast.addEventListener('input', () => {
    valContrast.textContent = `${ctrlContrast.value}%`;
    sendCamControl({ contrast: parseInt(ctrlContrast.value, 10) });
  });
  ctrlSaturation.addEventListener('input', () => {
    valSaturation.textContent = `${ctrlSaturation.value}%`;
    sendCamControl({ saturation: parseInt(ctrlSaturation.value, 10) });
  });
  ctrlPreviewW.addEventListener('input', () => {
    const [a, b] = selectedRatio.split(':').map(Number);
    const width = parseInt(ctrlPreviewW.value, 10);
    const height = Math.round(width / (a / b));
    valPreviewW.textContent = `${width}px`;
    ctrlPreviewH.value = height;
    valPreviewH.textContent = `${height}px`;
    sendCamControl({ previewWidth: width, previewHeight: height });
  });
  ctrlPreviewH.addEventListener('input', () => {
    const [a, b] = selectedRatio.split(':').map(Number);
    const height = parseInt(ctrlPreviewH.value, 10);
    const width = Math.round(height * (a / b));
    valPreviewH.textContent = `${height}px`;
    ctrlPreviewW.value = width;
    valPreviewW.textContent = `${width}px`;
    sendCamControl({ previewWidth: width, previewHeight: height });
  });
  ctrlZoom.addEventListener('input', () => {
    valZoom.textContent = `${ctrlZoom.value}x`;
    sendCamControl({ zoom: parseFloat(ctrlZoom.value) });
  });

  btnResetCam.addEventListener('click', () => {
    const [a, b] = selectedRatio.split(':').map(Number);
    const width = 600;
    const height = Math.round(width / (a / b));

    ctrlBrightness.value = 0;   valBrightness.textContent = '0';
    ctrlContrast.value = 100;   valContrast.textContent = '100%';
    ctrlSaturation.value = 100; valSaturation.textContent = '100%';
    ctrlPreviewW.value = width; valPreviewW.textContent = `${width}px`;
    ctrlPreviewH.value = height; valPreviewH.textContent = `${height}px`;
    ctrlZoom.value = 1;         valZoom.textContent = '1x';

    sendCamControl({ brightness: 0, contrast: 100, saturation: 100, previewWidth: width, previewHeight: height, zoom: 1 });
  });

  socket.on('cam-control', ({ cmd = {} }) => {
    if (cmd.brightness !== undefined) { ctrlBrightness.value = cmd.brightness; valBrightness.textContent = cmd.brightness; }
    if (cmd.contrast !== undefined) { ctrlContrast.value = cmd.contrast; valContrast.textContent = `${cmd.contrast}%`; }
    if (cmd.saturation !== undefined) { ctrlSaturation.value = cmd.saturation; valSaturation.textContent = `${cmd.saturation}%`; }
    if (cmd.zoom !== undefined) { ctrlZoom.value = cmd.zoom; valZoom.textContent = `${cmd.zoom}x`; }
    if (cmd.previewWidth !== undefined) { ctrlPreviewW.value = cmd.previewWidth; valPreviewW.textContent = `${cmd.previewWidth}px`; }
    if (cmd.previewHeight !== undefined) { ctrlPreviewH.value = cmd.previewHeight; valPreviewH.textContent = `${cmd.previewHeight}px`; }
  });

  function vibrate(pattern) {
    navigator.vibrate?.(pattern);
  }
})();
