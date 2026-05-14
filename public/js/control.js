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

  /* ── Sony gphoto2 real controls ── */

  // Load on first Camera tab click + on explicit reload
  let gphotoLoaded = false;

  document.getElementById('tab-camera').addEventListener('click', () => {
    if (!gphotoLoaded) loadSonyControls();
  }, { once: true });

  const btnReloadConfigs = document.getElementById('btn-reload-configs');
  if (btnReloadConfigs) {
    btnReloadConfigs.addEventListener('click', () => loadSonyControls());
  }

  async function loadSonyControls() {
    const sonySection = document.getElementById('sony-section');
    const camDivider  = document.getElementById('cam-divider');
    const sonyControls = document.getElementById('sony-controls');

    try {
      // First check if gphoto2/camera is available
      const statusResp = await fetch('/api/gphoto/status');
      const statusData = await statusResp.json();

      if (!statusData.available) {
        sonySection.style.display = 'none';
        camDivider.style.display = 'none';
        document.getElementById('css-hint').textContent = 'Nenhuma câmera Sony detectada. Usando filtros visuais.';
        return;
      }

      // Camera detected — show Sony section
      const camName = statusData.camera.split(' — ')[0] || 'Sony Camera';
      document.getElementById('sony-camera-name').textContent = camName;
      sonySection.style.display = 'block';
      camDivider.style.display = 'block';

      // Load all configs in one bulk request
      sonyControls.innerHTML = '<p style="font-size:12px;color:var(--preto-50);text-align:center">Carregando…</p>';

      const resp = await fetch('/api/gphoto/all-configs');
      const configs = await resp.json();

      sonyControls.innerHTML = '';

      // Priority order for display
      const order = ['iso', 'aperture', 'shutter', 'ev', 'wb', 'focus', 'flash', 'metering', 'drive', 'quality', 'effect'];

      for (const key of order) {
        const cfg = configs[key];
        if (!cfg || !cfg.choices || cfg.choices.length === 0) continue;

        const row = document.createElement('div');
        row.className = 'cam-ctrl-row';

        const label = document.createElement('span');
        label.className = 'cam-label';
        label.textContent = cfg.label;

        const sel = document.createElement('select');
        sel.id = `gp-${key}`;
        cfg.choices.forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch;
          opt.textContent = ch;
          if (ch === cfg.current) opt.selected = true;
          sel.appendChild(opt);
        });

        // Status indicator
        const status = document.createElement('span');
        status.className = 'cam-status';
        status.textContent = '';

        sel.addEventListener('change', async () => {
          status.textContent = '…';
          status.className = 'cam-status';
          try {
            const r = await fetch(`/api/gphoto/config/${key}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: sel.value })
            });
            const d = await r.json();
            if (d.success) {
              status.textContent = '✓';
              status.className = 'cam-status cam-status-ok';
              setTimeout(() => { status.textContent = ''; }, 1500);
            } else {
              status.textContent = '✗';
              status.className = 'cam-status cam-status-err';
            }
          } catch {
            status.textContent = '✗';
            status.className = 'cam-status cam-status-err';
          }
        });

        row.appendChild(label);
        row.appendChild(sel);
        row.appendChild(status);
        sonyControls.appendChild(row);
      }

      if (sonyControls.children.length === 0) {
        sonyControls.innerHTML = '<p style="font-size:12px;color:var(--preto-50);text-align:center">Nenhuma configuração disponível.</p>';
      }

      gphotoLoaded = true;

    } catch (err) {
      console.error('Sony controls load error:', err);
      sonySection.style.display = 'none';
      camDivider.style.display = 'none';
    }
  }

  /* ── Autofocus trigger ── */
  const btnAutofocus = document.getElementById('btn-autofocus');
  if (btnAutofocus) {
    btnAutofocus.addEventListener('click', async () => {
      btnAutofocus.textContent = '…';
      btnAutofocus.disabled = true;
      vibrate(30);
      try {
        const r = await fetch('/api/gphoto/autofocus', { method: 'POST' });
        const d = await r.json();
        btnAutofocus.textContent = d.success ? '✓' : '✗';
        setTimeout(() => { btnAutofocus.textContent = 'AF'; }, 1200);
      } catch {
        btnAutofocus.textContent = '✗';
        setTimeout(() => { btnAutofocus.textContent = 'AF'; }, 1200);
      } finally {
        btnAutofocus.disabled = false;
      }
    });
  }

  /* ── Manual focus step buttons ── */
  document.querySelectorAll('.focus-btn[data-focus]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const direction = btn.dataset.focus;
      const orig = btn.textContent;
      btn.disabled = true;
      vibrate(20);
      try {
        await fetch('/api/gphoto/manual-focus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction })
        });
      } catch { /* best effort */ }
      btn.disabled = false;
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
