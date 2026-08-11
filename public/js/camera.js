/* ══════════════════════════════════════════════════════════
   CAMERA.JS — o celular (Galaxy S22) como câmera do totem

   Dois caminhos independentes, de propósito:

   PREVIEW  track de vídeo → WebRTC → tela do totem.
            Baixa latência, qualidade suficiente para enquadrar.

   FOTO     ImageCapture.takePhoto() na resolução máxima do sensor.
            Passa pelo pipeline de still do Android (HDR, multiframe,
            redução de ruído) — nada a ver com o frame do vídeo, que é
            comprimido para streaming. É daqui que sai o arquivo final.

   Se takePhoto falhar, há uma cadeia de fallback até o frame de vídeo,
   e a interface diz em qual nível a foto foi tirada.
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ── DOM ── */
  const screenPair   = $('screen-pair');
  const screenCamera = $('screen-camera');
  const digits       = Array.from(document.querySelectorAll('#code-inputs input'));
  const btnPair      = $('btn-pair');
  const pairError    = $('pair-error');

  const video        = $('preview');
  const viewfinder   = $('viewfinder');
  const ratioGuide   = $('ratio-guide');
  const dotLink      = $('dot-link');
  const txtLink      = $('txt-link');
  const chipRes      = $('chip-res');
  const chipCode     = $('chip-code');
  const countdownEl  = $('countdown');
  const countdownNum = $('countdown-num');
  const shotFlash    = $('shot-flash');
  const toastEl      = $('toast');

  const btnTorch     = $('btn-torch');
  const btnFlip      = $('btn-flip');
  const btnFocus     = $('btn-focus');
  const btnMore      = $('btn-more');
  const btnShutter   = $('btn-shutter');
  const shutterHint  = $('shutter-hint');
  const settingsEl   = $('settings');

  const selDevice    = $('sel-device');
  const selPhotoSize = $('sel-photo-size');
  const hintPhotoSize = $('hint-photo-size');
  const selStream    = $('sel-stream');
  const selFlash     = $('sel-flash');
  const fieldZoom    = $('field-zoom');
  const ctrlZoom     = $('ctrl-zoom');
  const valZoom      = $('val-zoom');
  const fieldEv      = $('field-ev');
  const ctrlEv       = $('ctrl-ev');
  const valEv        = $('val-ev');
  const chkMirror    = $('chk-mirror');
  const chkKeepAwake = $('chk-keep-awake');
  const capsEl       = $('caps');
  const btnUnpair    = $('btn-unpair');

  /* ── Estado ── */
  const LS = {
    code: 'globo-cam-code',
    device: 'globo-cam-device',
    stream: 'globo-cam-stream',
    photoSize: 'globo-cam-photo-size',
    mirror: 'globo-cam-mirror',
    flash: 'globo-cam-flash',
  };

  let sessionCode = null;
  let stream = null;
  let track = null;
  let imageCapture = null;
  let capabilities = {};
  let photoCapabilities = null;
  let devices = [];
  let currentDeviceId = null;
  let facingMode = 'environment';
  let aspectRatio = '3:4';
  let mirror = false;
  let flashMode = 'off';
  let busy = false;
  let wakeLock = null;
  let pc = null;
  let videoSender = null;
  let pendingIce = [];

  const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

  /* ═══════════════════════════════════════════════════════
     PAREAMENTO
     ═══════════════════════════════════════════════════════ */

  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.slice(-1).toUpperCase();
      input.classList.toggle('filled', !!input.value);
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
      btnPair.disabled = !digits.every(d => d.value);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].value = '';
        digits[i - 1].classList.remove('filled');
        digits[i - 1].focus();
        btnPair.disabled = true;
      }
    });
  });

  btnPair.addEventListener('click', () => pair(digits.map(d => d.value).join('').toUpperCase()));

  function pair(code) {
    btnPair.disabled = true;
    pairError.classList.add('hidden');

    socket.emit('join-session', { code, role: 'camera', info: { label: navigator.userAgent.slice(0, 60) } }, res => {
      if (!res?.success) {
        pairError.textContent = res?.error || 'Não foi possível conectar.';
        pairError.classList.remove('hidden');
        btnPair.disabled = false;
        digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
        digits[0].focus();
        return;
      }

      sessionCode = code;
      localStorage.setItem(LS.code, code);
      chipCode.textContent = code;
      if (res.settings) applySettings(res.settings);

      screenPair.classList.add('hidden');
      screenCamera.classList.remove('hidden');
      startCamera();
    });
  }

  (function autoPair() {
    const saved = localStorage.getItem(LS.code);
    const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase();
    const code = urlCode || saved;
    if (!code || !/^[A-Z0-9]{4}$/.test(code)) return;
    socket.once('connect', () => pair(code));
  })();

  btnUnpair.addEventListener('click', () => {
    localStorage.removeItem(LS.code);
    location.href = '/camera.html';
  });

  /* ═══════════════════════════════════════════════════════
     ABERTURA DA CÂMERA

     A permissão precisa vir antes de enumerateDevices() — sem ela o
     Android devolve a lista sem labels e não dá para escolher a lente.
     ═══════════════════════════════════════════════════════ */

  async function startCamera() {
    try {
      toast('Abrindo a câmera…');
      const bootstrap = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      bootstrap.getTracks().forEach(t => t.stop());

      devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      buildDeviceList();

      const saved = localStorage.getItem(LS.device);
      currentDeviceId = devices.some(d => d.deviceId === saved) ? saved : pickDefaultDevice();
      selDevice.value = currentDeviceId || '';

      await openStream(currentDeviceId);
    } catch (err) {
      console.error(err);
      toast(describeCameraError(err), 'err', 9000);
    }
  }

  function describeCameraError(err) {
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      return 'A câmera só abre em HTTPS. Use o endereço https:// do totem.';
    }
    if (err?.name === 'NotAllowedError') return 'Permissão de câmera negada. Libere nas configurações do site.';
    if (err?.name === 'NotFoundError') return 'Nenhuma câmera encontrada neste aparelho.';
    if (err?.name === 'NotReadableError') return 'A câmera está em uso por outro app. Feche-o e recarregue.';
    return `Falha ao abrir a câmera: ${err?.name || err}`;
  }

  /** A traseira principal costuma ser a primeira "back" da lista no Chrome Android. */
  function pickDefaultDevice() {
    const back = devices.filter(d => /back|rear|traseira|environment/i.test(d.label));
    return (back[0] || devices[0])?.deviceId || null;
  }

  function buildDeviceList() {
    selDevice.innerHTML = '';
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Câmera ${i + 1}`;
      selDevice.appendChild(opt);
    });
  }

  async function openStream(deviceId) {
    if (stream) stream.getTracks().forEach(t => t.stop());

    const streamHeight = parseInt(selStream.value || localStorage.getItem(LS.stream) || '1080', 10);
    const streamWidth = Math.round((streamHeight * 16) / 9);

    const constraints = {
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
        width: { ideal: streamWidth },
        height: { ideal: streamHeight },
        frameRate: { ideal: 30 },
        resizeMode: 'none',
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => {});

    currentDeviceId = track.getSettings().deviceId || deviceId;
    if (currentDeviceId) localStorage.setItem(LS.device, currentDeviceId);
    facingMode = track.getSettings().facingMode || guessFacing(track.label);

    capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    imageCapture = 'ImageCapture' in window ? new ImageCapture(track) : null;
    photoCapabilities = null;

    if (imageCapture) {
      try { photoCapabilities = await imageCapture.getPhotoCapabilities(); }
      catch { photoCapabilities = null; }
    }

    await applyQualityConstraints();
    buildPhotoSizes();
    bindCapabilityControls();
    updateChips();
    updateRatioGuide();
    reportState();
    restartPeerConnection();
    requestWakeLock();

    toast('Câmera pronta', 'ok', 1600);
  }

  function guessFacing(label = '') {
    return /front|frontal|user|selfie/i.test(label) ? 'user' : 'environment';
  }

  /** Foco/exposição/white balance contínuos — o enquadramento muda a cada convidado. */
  async function applyQualityConstraints() {
    const advanced = [];
    if (capabilities.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    if (capabilities.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
    if (capabilities.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
    if (!advanced.length) return;
    try { await track.applyConstraints({ advanced }); } catch { /* opcional */ }
  }

  function buildPhotoSizes() {
    selPhotoSize.innerHTML = '';
    const settings = track.getSettings();
    const options = [];

    const maxW = photoCapabilities?.imageWidth?.max;
    const maxH = photoCapabilities?.imageHeight?.max;

    if (maxW && maxH) {
      options.push({ value: `${maxW}x${maxH}`, label: `Máxima — ${maxW} × ${maxH} (${mp(maxW, maxH)} MP)` });
      const halfW = Math.round(maxW / 2 / 2) * 2;
      const halfH = Math.round(maxH / 2 / 2) * 2;
      if (halfW > settings.width) {
        options.push({ value: `${halfW}x${halfH}`, label: `Média — ${halfW} × ${halfH} (${mp(halfW, halfH)} MP)` });
      }
    }
    options.push({
      value: 'video',
      label: `Frame do vídeo — ${settings.width} × ${settings.height} (${mp(settings.width, settings.height)} MP)`,
    });

    options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      selPhotoSize.appendChild(opt);
    });

    const saved = localStorage.getItem(LS.photoSize);
    selPhotoSize.value = options.some(o => o.value === saved) ? saved : options[0].value;

    hintPhotoSize.textContent = maxW
      ? 'A foto máxima passa pelo processamento de still do Android — bem melhor que o frame do vídeo.'
      : 'Este navegador não expõe a resolução do sensor; a foto sai do frame do vídeo.';
  }

  const mp = (w, h) => +((w * h) / 1e6).toFixed(1);

  /* ═══════════════════════════════════════════════════════
     CONTROLES DEPENDENTES DAS CAPACIDADES
     ═══════════════════════════════════════════════════════ */

  function bindCapabilityControls() {
    btnTorch.disabled = !capabilities.torch;
    btnTorch.setAttribute('aria-pressed', 'false');

    if (capabilities.zoom) {
      fieldZoom.classList.remove('hidden');
      ctrlZoom.min = capabilities.zoom.min;
      ctrlZoom.max = capabilities.zoom.max;
      ctrlZoom.step = capabilities.zoom.step || 0.1;
      ctrlZoom.value = track.getSettings().zoom ?? capabilities.zoom.min;
      valZoom.textContent = `${(+ctrlZoom.value).toFixed(1)}x`;
    } else {
      fieldZoom.classList.add('hidden');
    }

    if (capabilities.exposureCompensation) {
      fieldEv.classList.remove('hidden');
      ctrlEv.min = capabilities.exposureCompensation.min;
      ctrlEv.max = capabilities.exposureCompensation.max;
      ctrlEv.step = capabilities.exposureCompensation.step || 0.33;
      ctrlEv.value = track.getSettings().exposureCompensation ?? 0;
      valEv.textContent = (+ctrlEv.value).toFixed(1);
    } else {
      fieldEv.classList.add('hidden');
    }

    btnFocus.disabled = !capabilities.focusMode?.includes('single-shot') && !capabilities.pointsOfInterest;

    const settings = track.getSettings();
    capsEl.textContent = [
      `Lente: ${track.label || '—'}`,
      `Vídeo: ${settings.width} × ${settings.height} @ ${Math.round(settings.frameRate || 0)}fps`,
      photoCapabilities?.imageWidth?.max
        ? `Sensor (still): até ${photoCapabilities.imageWidth.max} × ${photoCapabilities.imageHeight.max}`
        : 'Sensor (still): não exposto pelo navegador',
      `Recursos: ${[
        capabilities.torch && 'lanterna',
        capabilities.zoom && 'zoom',
        capabilities.focusMode && 'foco',
        capabilities.exposureCompensation && 'exposição',
        capabilities.whiteBalanceMode && 'white balance',
      ].filter(Boolean).join(', ') || 'básicos'}`,
    ].join('\n');
  }

  ctrlZoom.addEventListener('input', async () => {
    valZoom.textContent = `${(+ctrlZoom.value).toFixed(1)}x`;
    try { await track.applyConstraints({ advanced: [{ zoom: +ctrlZoom.value }] }); } catch {}
  });

  ctrlEv.addEventListener('input', async () => {
    valEv.textContent = (+ctrlEv.value).toFixed(1);
    try { await track.applyConstraints({ advanced: [{ exposureCompensation: +ctrlEv.value }] }); } catch {}
  });

  btnTorch.addEventListener('click', () => {
    const on = btnTorch.getAttribute('aria-pressed') !== 'true';
    setTorch(on);
  });

  async function setTorch(on) {
    if (!capabilities.torch) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      btnTorch.setAttribute('aria-pressed', String(on));
    } catch { /* nem todo aparelho aceita torch fora de foto */ }
  }

  btnFocus.addEventListener('click', () => triggerAutofocus());

  async function triggerAutofocus(point) {
    const advanced = [];
    if (point && capabilities.pointsOfInterest) advanced.push({ pointsOfInterest: [point] });
    if (capabilities.focusMode?.includes('single-shot')) advanced.push({ focusMode: 'single-shot' });
    if (!advanced.length) return;
    try {
      await track.applyConstraints({ advanced });
      toast('Focando…', 'ok', 900);
      setTimeout(() => applyQualityConstraints(), 2500);
    } catch {}
  }

  // Toque no visor = foco naquele ponto
  viewfinder.addEventListener('click', e => {
    const rect = video.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    triggerAutofocus({ x: mirror ? 1 - x : x, y });
  });

  btnFlip.addEventListener('click', async () => {
    if (devices.length < 2) return;
    const index = devices.findIndex(d => d.deviceId === currentDeviceId);
    const next = devices[(index + 1) % devices.length];
    await switchDevice(next.deviceId);
  });

  selDevice.addEventListener('change', () => switchDevice(selDevice.value));

  async function switchDevice(deviceId) {
    try {
      toast('Trocando de lente…');
      await openStream(deviceId);
      selDevice.value = currentDeviceId;
    } catch (err) {
      toast(describeCameraError(err), 'err', 6000);
    }
  }

  selStream.addEventListener('change', async () => {
    localStorage.setItem(LS.stream, selStream.value);
    await switchDevice(currentDeviceId);
  });

  selPhotoSize.addEventListener('change', () => localStorage.setItem(LS.photoSize, selPhotoSize.value));

  selFlash.addEventListener('change', () => {
    flashMode = selFlash.value;
    localStorage.setItem(LS.flash, flashMode);
    if (flashMode !== 'torch') setTorch(false);
    socket.emit('update-settings', { code: sessionCode, settings: { flashMode } });
  });

  chkMirror.addEventListener('change', () => {
    mirror = chkMirror.checked;
    localStorage.setItem(LS.mirror, String(mirror));
    video.classList.toggle('mirrored', mirror);
  });

  chkKeepAwake.addEventListener('change', () => (chkKeepAwake.checked ? requestWakeLock() : releaseWakeLock()));

  btnMore.addEventListener('click', () => {
    const open = settingsEl.classList.toggle('hidden');
    btnMore.classList.toggle('active', !open);
    if (!open) settingsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  /* ═══════════════════════════════════════════════════════
     WEBRTC — envia o preview para a tela do totem
     ═══════════════════════════════════════════════════════ */

  const RTC_CONFIG = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  };

  function restartPeerConnection() {
    // Troca de lente só precisa de replaceTrack: a negociação segue válida.
    if (pc && pc.connectionState === 'connected' && videoSender && track) {
      videoSender.replaceTrack(track).catch(() => createPeerConnection());
      return;
    }
    createPeerConnection();
  }

  function createPeerConnection() {
    if (pc) { try { pc.close(); } catch {} }
    pendingIce = [];

    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = e => {
      if (e.candidate) signal({ type: 'ice', candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      setLink(pc.connectionState);
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setTimeout(() => { if (pc?.connectionState !== 'connected') createPeerConnection(); }, 2500);
      }
    };

    if (track) videoSender = pc.addTrack(track, stream);
    negotiate();
  }

  async function negotiate() {
    if (!pc) return;
    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);
      await tuneEncoder();
      signal({ type: 'offer', sdp: pc.localDescription });
    } catch (err) {
      console.error('negotiate', err);
    }
  }

  /** Preview nítido vale mais que fps aqui: o totem exibe uma pessoa parada. */
  async function tuneEncoder() {
    if (!videoSender) return;
    try {
      const params = videoSender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      params.encodings = [{ maxBitrate: 8_000_000, maxFramerate: 30, networkPriority: 'high' }];
      await videoSender.setParameters(params);
    } catch { /* nem todo browser aceita todos os campos */ }
  }

  function signal(data) {
    if (!sessionCode) return;
    socket.emit('webrtc-signal', { code: sessionCode, to: 'display', data });
  }

  socket.on('webrtc-signal', async ({ data }) => {
    if (!pc || !data) return;
    try {
      if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.type === 'ice' && data.candidate) {
        const candidate = new RTCIceCandidate(data.candidate);
        if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
        else pendingIce.push(candidate);
      }
    } catch (err) {
      console.error('signal', err);
    }
  });

  socket.on('display-ready', () => { if (track) createPeerConnection(); });
  socket.on('display-disconnected', () => setLink('disconnected'));

  function setLink(state) {
    const map = {
      connected: ['on', 'Transmitindo'],
      connecting: ['', 'Conectando…'],
      new: ['', 'Conectando…'],
      disconnected: ['off', 'Totem offline'],
      failed: ['off', 'Falha na conexão'],
      closed: ['off', 'Desconectado'],
    };
    const [cls, label] = map[state] || ['', state];
    dotLink.className = `dot ${cls}`;
    txtLink.textContent = label;
  }

  /* ═══════════════════════════════════════════════════════
     CAPTURA
     ═══════════════════════════════════════════════════════ */

  btnShutter.addEventListener('click', () => {
    if (busy || !sessionCode) return;
    // O totem conduz a contagem; a foto volta por 'camera-shoot'.
    socket.emit('trigger-capture', { code: sessionCode });
    navigator.vibrate?.(30);
  });

  socket.on('start-countdown', ({ timer }) => runCountdown(timer || 3));

  let torchSafety = null;

  async function runCountdown(seconds) {
    if (flashMode === 'torch') {
      setTorch(true);
      // Rede de segurança: se o disparo não vier, a lanterna não fica acesa.
      clearTimeout(torchSafety);
      torchSafety = setTimeout(() => { if (!busy) setTorch(false); }, (seconds + 20) * 1000);
    }
    countdownEl.classList.remove('hidden');
    for (let i = seconds; i > 0; i--) {
      countdownNum.textContent = String(i);
      countdownNum.style.animation = 'none';
      void countdownNum.offsetWidth;
      countdownNum.style.animation = 'pop .6s ease both';
      await sleep(1000);
    }
    countdownEl.classList.add('hidden');
  }

  socket.on('camera-shoot', ({ aspectRatio: ratio, flashMode: mode } = {}) => {
    if (ratio) { aspectRatio = ratio; updateRatioGuide(); }
    if (mode) flashMode = mode;
    shoot();
  });

  async function shoot() {
    if (busy) return;
    busy = true;
    btnShutter.classList.add('busy');
    btnShutter.disabled = true;
    countdownEl.classList.add('hidden');
    flash();
    navigator.vibrate?.([40, 30, 40]);
    status('capturing');

    try {
      const { blob, tier } = await capturePhoto();
      status('uploading', { bytes: blob.size, tier });
      shutterHint.textContent = `Enviando ${formatBytes(blob.size)}…`;

      const result = await uploadPhoto(blob);
      const meta = result?.meta || {};
      shutterHint.textContent = `Enviada · ${meta.finalWidth}×${meta.finalHeight} · ${formatBytes(meta.finalBytes)} · ${tier}`;
      toast('Foto enviada ✓', 'ok', 2200);
      status('done', { tier, ...meta });
    } catch (err) {
      console.error(err);
      toast(`Falha na foto: ${err.message}`, 'err', 6000);
      shutterHint.textContent = 'Falhou. Toque para tentar de novo.';
      status('error', { message: err.message });
    } finally {
      clearTimeout(torchSafety);
      if (flashMode === 'torch') setTorch(false);
      busy = false;
      btnShutter.classList.remove('busy');
      btnShutter.disabled = false;
    }
  }

  /**
   * Cadeia de captura, da melhor para a mais pobre. Devolve também o nível
   * usado para a operação saber, em campo, o que está saindo do aparelho.
   */
  async function capturePhoto() {
    const wanted = selPhotoSize.value;

    if (imageCapture && wanted !== 'video') {
      const [w, h] = wanted.split('x').map(Number);
      const settings = { imageWidth: w, imageHeight: h };
      if (flashMode === 'flash' && photoCapabilities?.fillLightMode?.includes('flash')) {
        settings.fillLightMode = 'flash';
      }
      try {
        return { blob: await imageCapture.takePhoto(settings), tier: `still ${w}×${h}` };
      } catch (err) {
        console.warn('takePhoto com resolução explícita falhou:', err.name);
      }
      try {
        return { blob: await imageCapture.takePhoto(), tier: 'still padrão' };
      } catch (err) {
        console.warn('takePhoto padrão falhou:', err.name);
      }
    }

    if (imageCapture) {
      try {
        const bitmap = await imageCapture.grabFrame();
        return { blob: await bitmapToJpeg(bitmap), tier: `grabFrame ${bitmap.width}×${bitmap.height}` };
      } catch (err) {
        console.warn('grabFrame falhou:', err.name);
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error('Sem sinal de vídeo');
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0);
    return { blob: await canvasToJpeg(canvas), tier: `vídeo ${canvas.width}×${canvas.height}` };
  }

  async function bitmapToJpeg(bitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return canvasToJpeg(canvas);
  }

  function canvasToJpeg(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Falha ao codificar JPEG'))), 'image/jpeg', 0.97);
    });
  }

  async function uploadPhoto(blob) {
    const form = new FormData();
    form.append('photo', blob, 'capture.jpg');
    form.append('code', sessionCode);
    form.append('aspectRatio', aspectRatio);
    form.append('mirror', String(mirror));
    form.append('source', 'phone');

    const resp = await fetch('/api/photo/capture', { method: 'POST', body: form });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) throw new Error(data.error || `HTTP ${resp.status}`);
    return data.data;
  }

  function status(state, detail) {
    if (sessionCode) socket.emit('camera-status', { code: sessionCode, status: state, detail });
  }

  function reportState() {
    if (!sessionCode || !track) return;
    const settings = track.getSettings();
    socket.emit('camera-state', {
      code: sessionCode,
      state: {
        label: track.label,
        streamWidth: settings.width,
        streamHeight: settings.height,
        photoWidth: photoCapabilities?.imageWidth?.max || settings.width,
        photoHeight: photoCapabilities?.imageHeight?.max || settings.height,
        hasTorch: !!capabilities.torch,
        hasZoom: !!capabilities.zoom,
        facingMode,
      },
    });
  }

  /* ═══════════════════════════════════════════════════════
     CONTROLE REMOTO → CELULAR
     ═══════════════════════════════════════════════════════ */

  socket.on('camera-control', ({ cmd } = {}) => {
    if (!cmd || !track) return;
    if (cmd.torch !== undefined) setTorch(!!cmd.torch);
    if (cmd.autofocus) triggerAutofocus();
    if (cmd.zoom !== undefined && capabilities.zoom) {
      ctrlZoom.value = cmd.zoom;
      ctrlZoom.dispatchEvent(new Event('input'));
    }
    if (cmd.exposureCompensation !== undefined && capabilities.exposureCompensation) {
      ctrlEv.value = cmd.exposureCompensation;
      ctrlEv.dispatchEvent(new Event('input'));
    }
    if (cmd.mirror !== undefined) {
      chkMirror.checked = !!cmd.mirror;
      chkMirror.dispatchEvent(new Event('change'));
    }
    if (cmd.deviceId) switchDevice(cmd.deviceId);
  });

  socket.on('settings-updated', applySettings);

  function applySettings(settings = {}) {
    if (settings.aspectRatio && settings.aspectRatio !== aspectRatio) {
      aspectRatio = settings.aspectRatio;
      updateRatioGuide();
    }
    if (settings.flashMode && settings.flashMode !== flashMode) {
      flashMode = settings.flashMode;
      selFlash.value = flashMode;
    }
  }

  socket.on('connect', () => {
    if (!sessionCode) return;
    socket.emit('join-session', { code: sessionCode, role: 'camera', info: { label: track?.label } }, res => {
      if (res?.success) reportState();
    });
  });

  /* ═══════════════════════════════════════════════════════
     UI AUXILIAR
     ═══════════════════════════════════════════════════════ */

  /** Desenha o retângulo que o servidor vai recortar, sobre o vídeo exibido. */
  function updateRatioGuide() {
    if (!video.videoWidth) return;
    const box = video.getBoundingClientRect();
    const videoRatio = video.videoWidth / video.videoHeight;

    // object-fit: contain — a área útil pode ser menor que o elemento.
    let shownW = box.width;
    let shownH = box.width / videoRatio;
    if (shownH > box.height) {
      shownH = box.height;
      shownW = box.height * videoRatio;
    }

    const [a, b] = aspectRatio.split(':').map(Number);
    const target = a / b;
    let w = shownW;
    let h = shownW / target;
    if (h > shownH) {
      h = shownH;
      w = shownH * target;
    }

    ratioGuide.style.width = `${Math.round(w)}px`;
    ratioGuide.style.height = `${Math.round(h)}px`;
  }

  video.addEventListener('loadedmetadata', () => { updateRatioGuide(); updateChips(); });
  window.addEventListener('resize', updateRatioGuide);
  window.addEventListener('orientationchange', () => setTimeout(updateRatioGuide, 400));

  function updateChips() {
    if (!track) return;
    const s = track.getSettings();
    const photo = photoCapabilities?.imageWidth?.max
      ? `${mp(photoCapabilities.imageWidth.max, photoCapabilities.imageHeight.max)} MP`
      : `${mp(s.width, s.height)} MP`;
    chipRes.textContent = `${s.width}×${s.height} · foto ${photo}`;
  }

  function flash() {
    shotFlash.classList.remove('hidden');
    shotFlash.style.animation = 'none';
    void shotFlash.offsetWidth;
    shotFlash.style.animation = 'fade .45s ease-out forwards';
    setTimeout(() => shotFlash.classList.add('hidden'), 500);
  }

  let toastTimer = null;
  function toast(message, kind = '', ms = 2600) {
    toastEl.textContent = message;
    toastEl.className = `vf-toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function formatBytes(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /* ── Wake lock: o celular fica horas apoiado, a tela não pode dormir ── */
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || !chkKeepAwake.checked) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* negado pelo sistema */ }
  }
  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  });

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Preferências salvas ── */
  mirror = localStorage.getItem(LS.mirror) === 'true';
  chkMirror.checked = mirror;
  video.classList.toggle('mirrored', mirror);
  flashMode = localStorage.getItem(LS.flash) || 'off';
  selFlash.value = flashMode;
  selStream.value = localStorage.getItem(LS.stream) || '1080';
})();
