/* ══════════════════════════════════════════════════════════
   CONTROL.JS — Lógica do controle remoto
   Tabs: Foto | Galeria | Câmera
   Galeria: re-exibe fotos no display via socket
   Câmera: controles via ImageCapture API
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM: Pairing ── */
  const pairingScreen = document.getElementById('pairing-screen');
  const controlScreen = document.getElementById('control-screen');
  const digits        = Array.from(document.querySelectorAll('.code-inputs input'));
  const btnConnect    = document.getElementById('btn-connect');
  const pairError     = document.getElementById('pair-error');

  /* ── DOM: Control header ── */
  const ctrlDot       = document.getElementById('ctrl-dot');
  const ctrlStatusTxt = document.getElementById('ctrl-status-text');
  const ctrlCount     = document.getElementById('ctrl-count');

  /* ── DOM: Tabs ── */
  const tabs          = document.querySelectorAll('.tab');
  const panels        = document.querySelectorAll('.tab-panel');

  /* ── DOM: Shoot ── */
  const captureBtn    = document.getElementById('capture-btn');
  const timerPills    = document.querySelectorAll('[data-timer]');
  const ratioPills    = document.querySelectorAll('[data-ratio]:not(.frame-btn)');
  const btnFrame4x5   = document.getElementById('btn-frame-4x5');
  const btnFrame16x9  = document.getElementById('btn-frame-16x9');
  const frameInput    = document.getElementById('frame-input');

  /* ── DOM: Gallery ── */
  const galleryGrid   = document.getElementById('gallery-grid');
  const noPhotos      = document.getElementById('no-photos');

  /* ── DOM: Camera controls ── */
  const ctrlBrightness = document.getElementById('ctrl-brightness');
  const ctrlContrast   = document.getElementById('ctrl-contrast');
  const ctrlSaturation = document.getElementById('ctrl-saturation');
  const ctrlFocusMode  = document.getElementById('ctrl-focus-mode');
  const ctrlFocusDist  = document.getElementById('ctrl-focus-distance');
  const focusDistRow   = document.getElementById('focus-distance-row');
  const ctrlZoom       = document.getElementById('ctrl-zoom');
  const valBrightness  = document.getElementById('val-brightness');
  const valContrast    = document.getElementById('val-contrast');
  const valSaturation  = document.getElementById('val-saturation');
  const valFocus       = document.getElementById('val-focus');
  const valZoom        = document.getElementById('val-zoom');
  const btnResetCam    = document.getElementById('btn-reset-cam');

  /* ── State ── */
  let sessionCode     = null;
  let selectedTimer   = 3;
  let selectedRatio   = '4:5';
  let pendingFrameRatio = null;
  let photoLog        = []; // {url, thumbnail}
  let photoTotal      = 0;
  let capturing       = false;
  let imageCapture    = null; // ImageCapture instance (from display via relay)

  /* ── Socket ── */
  const socket = io();

  /* ═══ PAIRING ═══ */

  // Digit inputs — auto-advance
  digits.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.slice(-1).toUpperCase();
      if (inp.value && i < 3) digits[i + 1].focus();
      checkReady();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) {
        digits[i - 1].value = '';
        digits[i - 1].focus();
        checkReady();
      }
    });
  });

  function checkReady() {
    const full = digits.every(d => d.value.length === 1);
    btnConnect.disabled = !full;
    digits.forEach(d => d.classList.toggle('filled', d.value.length === 1));
  }

  btnConnect.addEventListener('click', connect);

  function connect() {
    const code = digits.map(d => d.value).join('');
    btnConnect.disabled = true;
    pairError.classList.add('hidden');

    socket.emit('join-session', code, (res) => {
      if (res.error) {
        pairError.textContent = res.error;
        pairError.classList.remove('hidden');
        btnConnect.disabled = false;
        digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
        digits[0].focus();
      } else {
        sessionCode = code;
        if (res.settings) applySettings(res.settings);
        pairingScreen.classList.add('hidden');
        controlScreen.classList.remove('hidden');
        setStatus(true);
        if (res.photoCount) {
          ctrlCount.textContent = `${res.photoCount} fotos`;
        }
      }
    });
  }

  /* ═══ TABS ═══ */

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`panel-${target}`).classList.remove('hidden');
    });
  });

  /* ═══ STATUS ═══ */

  function setStatus(online) {
    ctrlDot.classList.toggle('connected', online);
    ctrlStatusTxt.textContent = online ? 'Conectado' : 'Desconectado';
    captureBtn.disabled = !online || capturing;
  }

  /* ═══ CAPTURE ═══ */

  captureBtn.addEventListener('click', () => {
    if (!sessionCode || capturing) return;
    capturing = true;
    captureBtn.classList.add('capturing');
    captureBtn.disabled = true;
    socket.emit('trigger-capture', { code: sessionCode, timer: selectedTimer });
    vibrate(40);
  });

  socket.on('photo-ready', ({ url, thumbnail, total }) => {
    capturing = false;
    captureBtn.classList.remove('capturing');
    captureBtn.disabled = false;
    photoTotal = total;
    ctrlCount.textContent = `${total} fotos`;
    addToGallery(url, thumbnail || url);
    vibrate([50, 30, 50]);
  });

  /* ═══ GALLERY ═══ */

  function addToGallery(url, thumb) {
    photoLog.push({ url, thumb });
    noPhotos.style.display = 'none';

    const item = document.createElement('div');
    item.className = 'gallery-thumb';
    item.innerHTML = `<img src="${thumb}" alt="foto" loading="lazy">`;
    item.addEventListener('click', () => {
      socket.emit('show-photo', { code: sessionCode, url });
      vibrate(30);
    });
    galleryGrid.prepend(item);
  }

  socket.on('session-photos', ({ photos }) => {
    photos.forEach(p => addToGallery(p.url, p.thumbnail || p.url));
  });

  /* ═══ SETTINGS ═══ */

  timerPills.forEach(p => {
    p.addEventListener('click', () => {
      selectedTimer = parseInt(p.dataset.timer);
      timerPills.forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      socket.emit('update-settings', { code: sessionCode, settings: { timer: selectedTimer } });
    });
  });

  ratioPills.forEach(p => {
    p.addEventListener('click', () => {
      selectedRatio = p.dataset.ratio;
      ratioPills.forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      socket.emit('update-settings', { code: sessionCode, settings: { aspectRatio: selectedRatio } });
    });
  });

  function applySettings(s) {
    if (s.timer) {
      selectedTimer = s.timer;
      timerPills.forEach(p => p.classList.toggle('active', parseInt(p.dataset.timer) === s.timer));
    }
    if (s.aspectRatio) {
      selectedRatio = s.aspectRatio;
      ratioPills.forEach(p => p.classList.toggle('active', p.dataset.ratio === s.aspectRatio));
    }
  }

  /* ═══ FRAME UPLOAD ═══ */

  [btnFrame4x5, btnFrame16x9].forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFrameRatio = btn.dataset.ratio;
      frameInput.click();
    });
  });

  frameInput.addEventListener('change', async () => {
    const file = frameInput.files[0];
    if (!file || !sessionCode || !pendingFrameRatio) return;
    const btn = pendingFrameRatio === '4:5' ? btnFrame4x5 : btnFrame16x9;
    const orig = btn.textContent;
    btn.textContent = 'Enviando…';
    btn.disabled = true;

    try {
      const fd = new FormData();
      fd.append('frame', file);
      fd.append('aspectRatio', pendingFrameRatio);
      const r = await fetch(`/api/frame/${sessionCode}`, { method: 'POST', body: fd });
      const d = await r.json();
      if (d.success) {
        btn.classList.add('has-frame');
        btn.textContent = `Pronto ✓`;
      }
    } catch {
      btn.textContent = 'Erro';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } finally {
      btn.disabled = false;
      frameInput.value = '';
    }
  });

  /* ═══ CAMERA CONTROLS via relay ═══ */
  // Controls are sent to display via socket; display applies via ImageCapture API

  function sendCamControl(cmd) {
    socket.emit('cam-control', { code: sessionCode, cmd });
  }

  /* ═══ CAMERA CONTROLS ═══ */

  // Detect gphoto2 on tab open
  let gphotoMode = false;
  document.getElementById('tab-camera').addEventListener('click', () => {
    if (!gphotoMode) loadGphotoStatus();
  }, { once: true });

  async function loadGphotoStatus() {
    try {
      const r = await fetch('/api/gphoto/status');
      const d = await r.json();
      if (d.available) {
        gphotoMode = true;
        renderGphotoControls(d.camera);
      }
      // else: CSS filter sliders are already visible (default HTML)
    } catch {}
  }

  async function renderGphotoControls(cameraName) {
    const panel = document.getElementById('panel-camera');
    panel.innerHTML = `
      <p class="camera-hint" style="color:var(--azul);font-weight:600">🎛 ${cameraName}</p>
      <p class="camera-hint">Configurações reais da câmera Sony via USB.</p>
      <div class="cam-control" id="sony-controls">
        <p style="font-size:13px;color:var(--preto-50);text-align:center">Carregando…</p>
      </div>
    `;

    const keys = ['iso', 'shutter', 'aperture', 'wb', 'ev', 'focus'];
    const labels = { iso: 'ISO', shutter: 'Velocidade', aperture: 'Abertura', wb: 'Bal. Branco', ev: 'Exp. Comp.', focus: 'Foco' };
    const container = document.getElementById('sony-controls');
    container.innerHTML = '';

    for (const key of keys) {
      try {
        const r = await fetch(`/api/gphoto/config/${key}`);
        const d = await r.json();
        if (!d.choices || d.choices.length === 0) continue;

        const row = document.createElement('div');
        row.className = 'cam-ctrl-row';
        const sel = document.createElement('select');
        sel.id = `gp-${key}`;
        d.choices.forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch; opt.textContent = ch;
          if (ch === d.current) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => setGphotoConfig(key, sel.value));
        row.innerHTML = `<span class="cam-label">${labels[key]}</span>`;
        row.appendChild(sel);
        container.appendChild(row);
      } catch {}
    }

    const resetRow = document.createElement('div');
    resetRow.innerHTML = `<button class="btn btn-outline btn-sm" onclick="location.reload()">Recarregar configs</button>`;
    container.appendChild(resetRow);
  }

  async function setGphotoConfig(key, value) {
    try {
      await fetch(`/api/gphoto/config/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });
    } catch (err) {
      console.error('Config error:', err);
    }
  }

  // CSS filter controls (fallback for webcam mode)
  ctrlBrightness.addEventListener('input', () => {
    valBrightness.textContent = ctrlBrightness.value;
    sendCamControl({ brightness: parseFloat(ctrlBrightness.value) });
  });
  ctrlContrast.addEventListener('input', () => {
    valContrast.textContent = ctrlContrast.value + '%';
    sendCamControl({ contrast: parseInt(ctrlContrast.value) });
  });
  ctrlSaturation.addEventListener('input', () => {
    valSaturation.textContent = ctrlSaturation.value + '%';
    sendCamControl({ saturation: parseInt(ctrlSaturation.value) });
  });
  ctrlFocusMode.addEventListener('change', () => {
    const manual = ctrlFocusMode.value === 'manual';
    focusDistRow.style.display = manual ? 'flex' : 'none';
    sendCamControl({ focusMode: ctrlFocusMode.value });
  });
  ctrlFocusDist.addEventListener('input', () => {
    valFocus.textContent = ctrlFocusDist.value;
    sendCamControl({ focusDistance: parseInt(ctrlFocusDist.value) });
  });
  ctrlZoom.addEventListener('input', () => {
    valZoom.textContent = ctrlZoom.value + 'x';
    sendCamControl({ zoom: parseFloat(ctrlZoom.value) });
  });
  btnResetCam.addEventListener('click', () => {
    ctrlBrightness.value = 0;  valBrightness.textContent = '0';
    ctrlContrast.value = 100;  valContrast.textContent = '100%';
    ctrlSaturation.value = 100; valSaturation.textContent = '100%';
    ctrlZoom.value = 1;        valZoom.textContent = '1x';
    ctrlFocusMode.value = ''; focusDistRow.style.display = 'none';
    sendCamControl({ brightness: 0, contrast: 100, saturation: 100, zoom: 1 });
  });



  /* ═══ DISCONNECT ═══ */

  socket.on('display-disconnected', () => {
    setStatus(false);
    ctrlStatusTxt.textContent = 'Totem desconectado';
  });

  /* ── Vibrate ── */
  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

})();
