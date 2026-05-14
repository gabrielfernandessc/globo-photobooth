/* ══════════════════════════════════════════════════════════
   CONTROL.JS — Controle Remoto v2
   
   Melhorias v2:
   ✅ Sessão persistente (localStorage + auto-reconnect)
   ✅ Botão "Próximo" (reset-to-preview)
   ✅ Galeria com timestamp
   ✅ Feedback haptic mais forte
   ✅ Botão desconectar
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
  const btnNext       = document.getElementById('btn-next');
  const timerPills    = document.querySelectorAll('[data-timer]');
  const ratioPills    = document.querySelectorAll('[data-ratio]:not(.frame-btn)');
  const btnFrame4x5   = document.getElementById('btn-frame-4x5');
  const btnFrame16x9  = document.getElementById('btn-frame-16x9');
  const frameInput    = document.getElementById('frame-input');

  /* ── DOM: Gallery ── */
  const galleryGrid   = document.getElementById('gallery-grid');
  const noPhotos      = document.getElementById('no-photos');

  /* ── DOM: Camera controls (CSS filter refs moved to camera section) ── */

  /* ── State ── */
  let sessionCode     = null;
  let selectedTimer   = 3;
  let selectedRatio   = '4:5';
  let pendingFrameRatio = null;
  let photoLog        = [];
  let photoTotal      = 0;
  let capturing       = false;

  /* ── Socket with auto-reconnect ── */
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
  });

  /* ═══ AUTO-RECONNECT ON PAGE LOAD ═══
     If we have a saved session code, try to rejoin immediately
     without showing the pairing screen. */
  (function tryAutoReconnect() {
    const saved = localStorage.getItem('globo-booth-ctrl-code');
    if (saved) {
      sessionCode = saved;
      socket.emit('join-session', saved, (res) => {
        if (res.success) {
          if (res.settings) applySettings(res.settings);
          pairingScreen.classList.add('hidden');
          controlScreen.classList.remove('hidden');
          setStatus(true);
          if (res.photoCount) {
            ctrlCount.textContent = `${res.photoCount} fotos`;
          }
        } else {
          // Session expired — clear and show pairing
          localStorage.removeItem('globo-booth-ctrl-code');
          sessionCode = null;
        }
      });
    }
  })();

  /* ── Auto-rejoin on socket reconnect ── */
  socket.on('connect', () => {
    if (sessionCode) {
      socket.emit('join-session', sessionCode, (res) => {
        if (res.success) {
          setStatus(true);
        } else {
          setStatus(false);
          ctrlStatusTxt.textContent = 'Sessão expirou';
        }
      });
    }
  });

  /* ── Display reconnected after refresh ── */
  socket.on('display-reconnected', () => {
    setStatus(true);
    ctrlStatusTxt.textContent = 'Reconectado';
  });

  /* ═══ PAIRING ═══ */

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
    const code = digits.map(d => d.value).join('').toUpperCase();
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
        localStorage.setItem('globo-booth-ctrl-code', code);
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
    vibrate([80, 50, 80]); // stronger feedback
  });

  /* ═══ NEXT BUTTON — reset display to preview ═══ */

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      if (!sessionCode) return;
      socket.emit('reset-to-preview', { code: sessionCode });
      vibrate(30);
    });
  }

  /* ═══ DISCONNECT BUTTON ═══ */

  const btnDisconnect = document.getElementById('btn-disconnect');
  if (btnDisconnect) {
    btnDisconnect.addEventListener('click', () => {
      localStorage.removeItem('globo-booth-ctrl-code');
      sessionCode = null;
      photoLog = [];
      photoTotal = 0;
      controlScreen.classList.add('hidden');
      pairingScreen.classList.remove('hidden');
      digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
      digits[0].focus();
      setStatus(false);
    });
  }

  /* ═══ GALLERY — with timestamp ═══ */

  function addToGallery(url, thumb) {
    const ts = Date.now();
    photoLog.push({ url, thumb, ts });
    noPhotos.style.display = 'none';

    const item = document.createElement('div');
    item.className = 'gallery-thumb';
    const time = new Date(ts);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    item.innerHTML = `
      <img src="${thumb}" alt="foto" loading="lazy">
      <span class="gallery-time">${timeStr}</span>
    `;
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

  /* ═══ CAMERA CONTROLS ═══ */

  function sendCamControl(cmd) {
    socket.emit('cam-control', { code: sessionCode, cmd });
  }

  /* ── Real camera controls via browser capabilities ──
     These controls are READ from the display's MediaStreamTrack
     (which runs on the totem PC where the camera is connected)
     and APPLIED via socket relay. No gphoto2 needed. */

  let cameraCapsLoaded = false;

  // Request capabilities when camera tab is first opened
  document.getElementById('tab-camera').addEventListener('click', () => {
    if (!cameraCapsLoaded) {
      requestCameraCapabilities();
    }
  }, { once: true });

  const btnReloadConfigs = document.getElementById('btn-reload-configs');
  if (btnReloadConfigs) {
    btnReloadConfigs.addEventListener('click', () => requestCameraCapabilities());
  }

  function requestCameraCapabilities() {
    if (!sessionCode) return;
    const sonyControls = document.getElementById('sony-controls');
    if (sonyControls) {
      sonyControls.innerHTML = '<p style="font-size:12px;color:var(--preto-50);text-align:center">Solicitando controles da câmera…</p>';
    }
    socket.emit('request-camera-capabilities', { code: sessionCode });
  }

  // Receive capabilities from display
  socket.on('camera-capabilities', ({ capabilities }) => {
    renderCameraControls(capabilities);
  });

  function renderCameraControls(capabilities) {
    const sonySection = document.getElementById('sony-section');
    const camDivider  = document.getElementById('cam-divider');
    const sonyControls = document.getElementById('sony-controls');

    const keys = Object.keys(capabilities || {});

    if (keys.length === 0) {
      sonySection.style.display = 'none';
      camDivider.style.display = 'none';
      document.getElementById('css-hint').textContent =
        'A câmera não expõe controles avançados ao navegador. Use os filtros visuais abaixo.';
      return;
    }

    // Show section
    document.getElementById('sony-camera-name').textContent = 'Câmera Detectada';
    const subEl = sonySection.querySelector('.cam-section-sub');
    if (subEl) subEl.textContent = keys.length + ' controles disponíveis · via navegador';
    sonySection.style.display = 'block';
    camDivider.style.display = 'block';
    sonyControls.innerHTML = '';

    // Priority order
    const order = [
      'iso', 'exposureTime', 'exposureCompensation', 'exposureMode',
      'focusMode', 'focusDistance', 'whiteBalanceMode', 'colorTemperature',
      'brightness', 'contrast', 'saturation', 'sharpness', 'zoom', 'pan', 'tilt'
    ];

    const orderedKeys = order.filter(k => capabilities[k]);
    const remainingKeys = keys.filter(k => !order.includes(k));
    const allKeys = [...orderedKeys, ...remainingKeys];

    for (const key of allKeys) {
      const cap = capabilities[key];
      const row = document.createElement('div');
      row.className = 'cam-ctrl-row';

      const label = document.createElement('span');
      label.className = 'cam-label';
      label.textContent = cap.label;

      const status = document.createElement('span');
      status.className = 'cam-status';

      if (cap.type === 'enum') {
        const sel = document.createElement('select');
        sel.id = 'cam-' + key;
        cap.options.forEach(opt => {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = formatOption(key, opt);
          if (opt === cap.current) el.selected = true;
          sel.appendChild(el);
        });
        sel.addEventListener('change', () => applyCamConstraint(key, sel.value, status));
        row.appendChild(label);
        row.appendChild(sel);
        row.appendChild(status);
      } else if (cap.type === 'range') {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = 'cam-' + key;
        slider.min = cap.min;
        slider.max = cap.max;
        slider.step = cap.step;
        slider.value = cap.current;

        const valSpan = document.createElement('span');
        valSpan.className = 'cam-val';
        valSpan.textContent = formatValue(key, cap.current);

        let debounceTimer;
        slider.addEventListener('input', () => {
          valSpan.textContent = formatValue(key, slider.value);
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            applyCamConstraint(key, parseFloat(slider.value), status);
          }, 150);
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(valSpan);
        row.appendChild(status);
      }

      sonyControls.appendChild(row);
    }

    // Show/hide focus section
    const focusSection = document.getElementById('focus-section');
    if (focusSection) {
      focusSection.style.display = (capabilities.focusMode || capabilities.focusDistance) ? 'flex' : 'none';
    }

    cameraCapsLoaded = true;
  }

  function formatOption(key, value) {
    const t = { 'continuous': 'Contínuo', 'manual': 'Manual', 'single-shot': 'Único' };
    return t[value] || value;
  }

  function formatValue(key, val) {
    if (key === 'iso') return 'ISO ' + val;
    if (key === 'exposureTime') return val + 'µs';
    if (key === 'exposureCompensation') return (val > 0 ? '+' : '') + val + ' EV';
    if (key === 'focusDistance') return parseFloat(val).toFixed(2) + 'm';
    if (key === 'colorTemperature') return val + 'K';
    if (key === 'zoom') return parseFloat(val).toFixed(1) + 'x';
    return String(val);
  }

  function applyCamConstraint(key, value, statusEl) {
    if (!sessionCode) return;
    if (statusEl) { statusEl.textContent = '…'; statusEl.className = 'cam-status'; }

    socket.emit('apply-cam-constraint', { code: sessionCode, key, value }, (result) => {
      if (!statusEl) return;
      if (result && result.success) {
        statusEl.textContent = '✓';
        statusEl.className = 'cam-status cam-status-ok';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      } else {
        statusEl.textContent = '✗';
        statusEl.className = 'cam-status cam-status-err';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      }
    });
  }

  /* ── Focus controls ── */
  const btnAutofocus = document.getElementById('btn-autofocus');
  if (btnAutofocus) {
    btnAutofocus.addEventListener('click', () => {
      btnAutofocus.textContent = '…';
      vibrate(30);
      applyCamConstraint('focusMode', 'continuous', null);
      setTimeout(() => { btnAutofocus.textContent = 'AF'; }, 1200);
    });
  }

  document.querySelectorAll('.focus-btn[data-focus]').forEach(btn => {
    btn.addEventListener('click', () => {
      vibrate(20);
      const direction = btn.dataset.focus;
      const slider = document.getElementById('cam-focusDistance');
      if (!slider) return;
      const step = direction.includes('coarse') ? 0.3 : direction.includes('fine') ? 0.02 : 0.1;
      const delta = direction.includes('near') ? -step : step;
      const newVal = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max),
        parseFloat(slider.value) + delta));
      slider.value = newVal;
      slider.dispatchEvent(new Event('input'));
    });
  });

  /* ── CSS filter controls (always available) ── */
  const ctrlBrightness = document.getElementById('ctrl-brightness');
  const ctrlContrast   = document.getElementById('ctrl-contrast');
  const ctrlSaturation = document.getElementById('ctrl-saturation');
  const ctrlZoom       = document.getElementById('ctrl-zoom');
  const valBrightness  = document.getElementById('val-brightness');
  const valContrast    = document.getElementById('val-contrast');
  const valSaturation  = document.getElementById('val-saturation');
  const valZoom        = document.getElementById('val-zoom');
  const btnResetCam    = document.getElementById('btn-reset-cam');

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
  ctrlZoom.addEventListener('input', () => {
    valZoom.textContent = ctrlZoom.value + 'x';
    sendCamControl({ zoom: parseFloat(ctrlZoom.value) });
  });
  btnResetCam.addEventListener('click', () => {
    ctrlBrightness.value = 0;  valBrightness.textContent = '0';
    ctrlContrast.value = 100;  valContrast.textContent = '100%';
    ctrlSaturation.value = 100; valSaturation.textContent = '100%';
    ctrlZoom.value = 1;        valZoom.textContent = '1x';
    sendCamControl({ brightness: 0, contrast: 100, saturation: 100, zoom: 1 });
  });

  /* ═══ DISCONNECT ═══ */

  socket.on('display-disconnected', () => {
    setStatus(false);
    ctrlStatusTxt.textContent = 'Totem desconectado';
  });

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

})();
