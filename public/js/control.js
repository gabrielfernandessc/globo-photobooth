/* ══════════════════════════════════════════════════════════
   CONTROL.JS — Lógica do controle remoto (celular)
   Pairing → Settings → Capture trigger
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── DOM refs ── */
  const pairingScreen = document.getElementById('pairing-screen');
  const controlScreen = document.getElementById('control-screen');
  const codeInputs    = document.querySelectorAll('#code-inputs input');
  const btnConnect    = document.getElementById('btn-connect');
  const pairingError  = document.getElementById('pairing-error');
  const connStatus    = document.getElementById('conn-status');
  const connText      = document.getElementById('conn-text');
  const btnCapture    = document.getElementById('btn-capture');
  const captureHint   = document.getElementById('capture-hint');
  const timerOptions  = document.getElementById('timer-options');
  const ratioOptions  = document.getElementById('ratio-options');
  const btnFrame4x5   = document.getElementById('btn-frame-4x5');
  const btnFrame16x9  = document.getElementById('btn-frame-16x9');
  const frameInput    = document.getElementById('frame-input');
  const lastPhotoSect = document.getElementById('last-photo-section');
  const lastPhotoImg  = document.getElementById('last-photo-img');
  const photoCountEl  = document.getElementById('photo-count');

  /* ── State ── */
  let sessionCode = null;
  let timer = 3;
  let aspectRatio = '4:5';
  let pendingFrameRatio = null;
  let isCapturing = false;

  /* ── Socket.IO ── */
  const socket = io();

  /* ═══════════════════════════════════════════════════════
     PAIRING — Code input UX
     ═══════════════════════════════════════════════════════ */

  codeInputs.forEach((inp, i) => {
    inp.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val.slice(0, 1);
      if (val && i < 5) codeInputs[i + 1].focus();
      if (val) e.target.classList.add('filled');
      else e.target.classList.remove('filled');
      checkCodeComplete();
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && i > 0) {
        codeInputs[i - 1].focus();
        codeInputs[i - 1].value = '';
        codeInputs[i - 1].classList.remove('filled');
      }
      if (e.key === 'Enter') btnConnect.click();
    });

    // Handle paste
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '');
      pasted.split('').slice(0, 6).forEach((ch, j) => {
        if (codeInputs[j]) {
          codeInputs[j].value = ch;
          codeInputs[j].classList.add('filled');
        }
      });
      const lastIdx = Math.min(pasted.length, 6) - 1;
      if (lastIdx >= 0) codeInputs[Math.min(lastIdx + 1, 5)].focus();
      checkCodeComplete();
    });
  });

  function checkCodeComplete() {
    const code = getCode();
    btnConnect.disabled = code.length < 6;
  }

  function getCode() {
    return Array.from(codeInputs).map(i => i.value).join('');
  }

  /* ── Connect ── */
  btnConnect.addEventListener('click', () => {
    const code = getCode();
    if (code.length !== 6) return;

    btnConnect.disabled = true;
    btnConnect.textContent = 'Conectando...';
    pairingError.textContent = '';

    socket.emit('join-session', code, (resp) => {
      if (resp.error) {
        pairingError.textContent = resp.error;
        btnConnect.disabled = false;
        btnConnect.textContent = 'Conectar';
        vibrate(200);
        return;
      }

      sessionCode = code;
      timer = resp.settings?.timer || 3;
      aspectRatio = resp.settings?.aspectRatio || '4:5';

      // Update UI
      updateTimerUI();
      updateRatioUI();
      if (resp.hasFrame4x5) btnFrame4x5.classList.add('has-frame');
      if (resp.hasFrame16x9) btnFrame16x9.classList.add('has-frame');
      if (resp.photoCount) photoCountEl.textContent = resp.photoCount;

      pairingScreen.classList.add('hidden');
      controlScreen.classList.remove('hidden');
      vibrate(50);
    });
  });

  /* ═══════════════════════════════════════════════════════
     CAPTURE
     ═══════════════════════════════════════════════════════ */

  btnCapture.addEventListener('click', () => {
    if (isCapturing || !sessionCode) return;
    isCapturing = true;
    btnCapture.classList.add('capturing');
    btnCapture.disabled = true;
    captureHint.textContent = `Capturando em ${timer}s...`;
    vibrate(100);

    socket.emit('trigger-capture', { code: sessionCode, timer });

    // Re-enable after timer + capture time
    setTimeout(() => {
      isCapturing = false;
      btnCapture.classList.remove('capturing');
      btnCapture.disabled = false;
      captureHint.textContent = 'Toque para capturar';
    }, (timer + 4) * 1000);
  });

  /* ═══════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════ */

  // Timer
  timerOptions.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    timer = parseInt(pill.dataset.timer);
    updateTimerUI();
    emitSettings();
    vibrate(30);
  });

  // Aspect ratio
  ratioOptions.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    aspectRatio = pill.dataset.ratio;
    updateRatioUI();
    emitSettings();
    vibrate(30);
  });

  function updateTimerUI() {
    timerOptions.querySelectorAll('.pill').forEach(p => {
      p.classList.toggle('active', parseInt(p.dataset.timer) === timer);
    });
  }
  function updateRatioUI() {
    ratioOptions.querySelectorAll('.pill').forEach(p => {
      p.classList.toggle('active', p.dataset.ratio === aspectRatio);
    });
  }

  function emitSettings() {
    if (!sessionCode) return;
    socket.emit('update-settings', {
      code: sessionCode,
      settings: { timer, aspectRatio }
    });
  }

  /* ═══════════════════════════════════════════════════════
     FRAME UPLOAD
     ═══════════════════════════════════════════════════════ */

  btnFrame4x5.addEventListener('click', () => { pendingFrameRatio = '4:5'; frameInput.click(); });
  btnFrame16x9.addEventListener('click', () => { pendingFrameRatio = '16:9'; frameInput.click(); });

  frameInput.addEventListener('change', async () => {
    const file = frameInput.files[0];
    if (!file || !sessionCode || !pendingFrameRatio) return;

    const btn = pendingFrameRatio === '4:5' ? btnFrame4x5 : btnFrame16x9;
        btn.textContent = 'Enviando...';

    const formData = new FormData();
    formData.append('frame', file);
    formData.append('aspectRatio', pendingFrameRatio);

    try {
      const resp = await fetch(`/api/frame/${sessionCode}`, {
        method: 'POST',
        body: formData
      });
      const data = await resp.json();
      if (data.success) {
        btn.classList.add('has-frame');
        btn.textContent = `Pronto ${pendingFrameRatio}`;
        vibrate(50);
      }
    } catch (err) {
      console.error('Frame upload error:', err);
      btn.textContent = `Erro ao enviar`;
      setTimeout(() => {
        btn.textContent = `Enviar frame ${pendingFrameRatio}`;
      }, 2000);
    }

    frameInput.value = '';
    pendingFrameRatio = null;
  });

  /* ═══════════════════════════════════════════════════════
     SOCKET EVENTS
     ═══════════════════════════════════════════════════════ */

  socket.on('photo-ready', ({ url, thumbnail, total }) => {
    photoCountEl.textContent = total;
    lastPhotoImg.src = thumbnail || url;
    lastPhotoSect.classList.remove('hidden');
    vibrate([50, 50, 50]);
  });

  socket.on('settings-updated', (settings) => {
    timer = settings.timer;
    aspectRatio = settings.aspectRatio;
    updateTimerUI();
    updateRatioUI();
  });

  socket.on('display-disconnected', () => {
    connStatus.classList.remove('online');
    connStatus.classList.add('offline');
    connText.textContent = 'Totem desconectado';
    btnCapture.disabled = true;
  });

  socket.on('disconnect', () => {
    connStatus.classList.remove('online');
    connStatus.classList.add('offline');
    connText.textContent = 'Sem conexão';
    btnCapture.disabled = true;
  });

  socket.on('connect', () => {
    if (sessionCode) {
      // Reconnect to session
      socket.emit('join-session', sessionCode, (resp) => {
        if (resp.error) {
          // Session expired, go back to pairing
          controlScreen.classList.add('hidden');
          pairingScreen.classList.remove('hidden');
          sessionCode = null;
          return;
        }
        connStatus.classList.remove('offline');
        connStatus.classList.add('online');
        connText.textContent = 'Reconectado';
        btnCapture.disabled = false;
      });
    }
  });

  /* ── Vibrate helper ── */
  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  /* ── Auto-focus first input ── */
  setTimeout(() => codeInputs[0].focus(), 300);
})();
