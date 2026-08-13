/* ══════════════════════════════════════════════════════════
   PAINEL DO OPERADOR — tela 1

   O operador conduz a sessão daqui. O telão nunca inicia uma foto:
   ele só mostra preview, contagem, resultado e QR.
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const BOOTH = window.__BOOTH__ || {};
  const params = new URLSearchParams(location.search);
  const codeFromUrl = params.get('code')?.toUpperCase() || null;
  const embedded = params.get('embedded') === '1';

  const pairingScreen = $('pairing-screen');
  const controlScreen = $('control-screen');
  const digits = [...document.querySelectorAll('.code-inputs input')];
  const btnConnect = $('btn-connect');
  const pairError = $('pair-error');
  const ctrlDot = $('ctrl-dot');
  const ctrlStatusTxt = $('ctrl-status-text');
  const ctrlCount = $('ctrl-count');
  const btnDisconnect = $('btn-disconnect');
  const captureBtn = $('capture-btn');
  const captureLabel = $('capture-label');
  const btnNext = $('btn-next');
  const sourceHint = $('source-hint');
  const displayStateEl = $('display-state');
  const cameraBadge = $('camera-live-badge');
  const controlPreview = $('control-preview');
  const controlPreviewEmpty = $('control-preview-empty');
  const operatorCameraState = $('operator-camera-state');
  const timerPills = [...document.querySelectorAll('[data-timer]')];
  const ratioPills = [...document.querySelectorAll('[data-ratio]:not(.frame-btn)')];
  const flashPills = [...document.querySelectorAll('[data-flash]')];
  const flashControlStatus = $('flash-control-status');
  const btnFrame3x4 = $('btn-frame-3x4');
  const btnFrame4x3 = $('btn-frame-4x3');
  const frameInput = $('frame-input');
  const galleryGrid = $('gallery-grid');
  const noPhotos = $('no-photos');
  const cameraModel = $('camera-model');
  const cameraDetail = $('camera-detail');
  const btnSaveProfile = $('btn-save-profile');
  const btnApplyProfile = $('btn-apply-profile');
  const cameraProfileStatus = $('camera-profile-status');
  const tabs = [...document.querySelectorAll('.tab')];
  const panels = [...document.querySelectorAll('.tab-panel')];

  let sessionCode = null;
  let selectedTimer = 3;
  let selectedRatio = '3:4';
  let selectedFlashMode = 'off';
  let flashBusy = false;
  let pendingFrameRatio = null;
  let capturing = false;
  let displayOnline = false;
  let displayState = 'BOOTING';
  let cameraStatus = null;
  let releaseTimer = null;
  let previewRetry = null;
  let joinRetry = null;
  let desiredCode = null;
  let joining = false;

  const previewViewerKey = 'globo-booth-control-preview-viewer';
  const previewViewerId = sessionStorage.getItem(previewViewerKey) ||
    (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  sessionStorage.setItem(previewViewerKey, previewViewerId);

  if (embedded) document.body.classList.add('embedded-control');

  const socket = io({
    path: BOOTH.socketPath || '/socket.io',
    transports: BOOTH.transports || ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });

  function cameraReady() {
    return !!cameraStatus?.transmitindo;
  }

  function updateAvailability() {
    const socketOnline = socket.connected && !!sessionCode;
    const pronta = socketOnline && displayOnline && cameraReady() && displayState === 'PRONTO' && !capturing;

    ctrlDot.classList.toggle('connected', socketOnline && displayOnline);
    ctrlStatusTxt.textContent = !socketOnline
      ? 'Servidor desconectado'
      : displayOnline ? 'Telão conectado' : 'Telão desconectado';

    captureBtn.disabled = !pronta;
    captureLabel.textContent = capturing
      ? 'Foto em andamento…'
      : pronta ? 'Tirar foto' : cameraReady() ? 'Aguardando o telão' : 'Aguardando a câmera';

    cameraBadge.textContent = cameraReady() ? 'Ao vivo' : 'Sem imagem';
    cameraBadge.classList.toggle('online', cameraReady());
    btnNext.disabled = !socketOnline || !displayOnline;
    flashPills.forEach(pill => {
      pill.disabled = flashBusy || capturing || !socketOnline;
    });
  }

  function applySettings(settings = {}) {
    if (settings.timer) {
      selectedTimer = Number(settings.timer);
      timerPills.forEach(pill => pill.classList.toggle('active', Number(pill.dataset.timer) === selectedTimer));
    }
    if (settings.aspectRatio) {
      selectedRatio = settings.aspectRatio;
      ratioPills.forEach(pill => pill.classList.toggle('active', pill.dataset.ratio === selectedRatio));
    }
    if (settings.flashMode) {
      selectedFlashMode = settings.flashMode === 'flash' ? 'flash' : 'off';
      flashPills.forEach(pill => pill.classList.toggle('active', pill.dataset.flash === selectedFlashMode));
      if (!flashBusy) {
        flashControlStatus.textContent = selectedFlashMode === 'flash'
          ? 'Flash ativo: a câmera o levanta antes de cada foto.'
          : 'Flash desligado.';
        flashControlStatus.className = 'flash-control-status';
      }
    }
  }

  function applySnapshot(snapshot = {}) {
    applySettings(snapshot.settings);
    if (snapshot.photoCount !== undefined) ctrlCount.textContent = `${snapshot.photoCount} fotos`;
    if (snapshot.hasFrame3x4) markFrame(btnFrame3x4);
    if (snapshot.hasFrame4x3) markFrame(btnFrame4x3);
    displayOnline = !!snapshot.hasDisplay;
    if (snapshot.cameraStatus) applyCameraStatus(snapshot.cameraStatus);
    updateAvailability();
  }

  function join(code, interactive) {
    desiredCode = code;
    if (joining || !socket.connected) return;
    joining = true;
    clearTimeout(joinRetry);
    socket.emit('join-session', { code, role: 'control' }, response => {
      joining = false;
      if (!response?.success) {
        if (interactive || embedded) {
          pairError.textContent = response?.error || 'Código inválido.';
          pairError.classList.remove('hidden');
          btnConnect.disabled = false;
        }
        if (!interactive && desiredCode === code) {
          joinRetry = setTimeout(() => join(code, false), 750);
        }
        return;
      }

      clearTimeout(joinRetry);
      sessionCode = code;
      localStorage.setItem('globo-booth-ctrl-code', code);
      pairingScreen.classList.add('hidden');
      controlScreen.classList.remove('hidden');
      applySnapshot(response);
      refreshCamera();
    });
  }

  digits.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.slice(-1).toUpperCase();
      if (input.value && index < digits.length - 1) digits[index + 1].focus();
      btnConnect.disabled = !digits.every(digit => digit.value.length === 1);
    });
  });

  btnConnect.addEventListener('click', () => {
    pairError.classList.add('hidden');
    join(digits.map(digit => digit.value).join('').toUpperCase(), true);
  });

  const initialCode = codeFromUrl || localStorage.getItem('globo-booth-ctrl-code');
  if (initialCode) desiredCode = initialCode;

  socket.on('connect', () => {
    joining = false;
    if (sessionCode || desiredCode) join(sessionCode || desiredCode, false);
  });
  socket.on('disconnect', () => { joining = false; updateAvailability(); });
  socket.on('presence', applySnapshot);
  socket.on('settings-updated', applySettings);
  socket.on('display-state', ({ state }) => {
    displayState = state || displayState;
    const labels = {
      BOOTING: 'Preparando o telão', SEM_CAMERA: 'Reconectando a câmera', PRONTO: 'Pronto para fotografar',
      CONTAGEM: 'Contagem regressiva', CAPTURANDO: 'Disparando', PROCESSANDO: 'Processando a foto',
      RESULTADO: 'Exibindo foto e QR', ERRO: 'Erro recuperável',
    };
    displayStateEl.textContent = labels[displayState] || displayState;
    if (['CONTAGEM', 'CAPTURANDO', 'PROCESSANDO'].includes(displayState)) capturing = true;
    else if (['PRONTO', 'RESULTADO', 'ERRO'].includes(displayState)) releaseShutter();
    updateAvailability();
  });
  socket.on('display-disconnected', () => { displayOnline = false; updateAvailability(); });
  socket.on('display-reconnected', () => { displayOnline = true; updateAvailability(); });
  socket.on('camera-estado', refreshCamera);

  async function refreshCamera() {
    try {
      const response = await fetch('/api/camera/status', { cache: 'no-store' });
      applyCameraStatus(await response.json());
    } catch {
      applyCameraStatus({ disponivel: false, erro: 'Servidor da câmera indisponível' });
    }
  }

  function applyCameraStatus(status = {}) {
    cameraStatus = status;
    const model = status.modelo || 'Sony DSLR';
    cameraModel.textContent = model;
    cameraDetail.textContent = status.transmitindo
      ? `Preview ativo · ${status.quadros || 0} quadros`
      : status.erro || `Estado: ${status.estado || 'procurando'}`;
    operatorCameraState.textContent = status.transmitindo
      ? `${model} conectada e transmitindo`
      : status.conflitoSony
        ? 'Sony Imaging Edge está bloqueando a câmera. Desative “Sony CameraExt” nas Extensões de Câmera.'
        : status.modelo ? `${model} conectada; restaurando o preview…` : 'Câmera não detectada';
    sourceHint.textContent = operatorCameraState.textContent;

    if (status.transmitindo) {
      ligarPreviewControle();
      controlPreviewEmpty.hidden = true;
    } else if (!['preparando', 'disparando', 'religando'].includes(status.estado)) {
      controlPreviewEmpty.hidden = false;
    }
    updateAvailability();
  }

  function ligarPreviewControle(forcar = false) {
    const path = BOOTH.preview?.streamPath;
    if (!path || (!forcar && controlPreview.getAttribute('src'))) return;
    clearTimeout(previewRetry);
    controlPreview.src = `${path}?viewer=${encodeURIComponent(previewViewerId)}&t=${Date.now()}`;
  }

  controlPreview.addEventListener('error', () => {
    clearTimeout(previewRetry);
    controlPreview.removeAttribute('src');
    if (cameraReady()) previewRetry = setTimeout(() => ligarPreviewControle(true), 250);
  });

  controlPreview.addEventListener('load', () => {
    clearTimeout(previewRetry);
    previewRetry = null;
    controlPreviewEmpty.hidden = true;
  });

  setInterval(refreshCamera, 2000);

  function startCapture() {
    if (captureBtn.disabled || !sessionCode || capturing) return;
    capturing = true;
    captureBtn.classList.add('capturing');
    updateAvailability();
    socket.emit('trigger-capture', { code: sessionCode, timer: selectedTimer });
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseShutter, (selectedTimer + 55) * 1000);
  }

  function releaseShutter() {
    capturing = false;
    captureBtn.classList.remove('capturing');
    updateAvailability();
  }

  captureBtn.addEventListener('click', startCapture);
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || /INPUT|BUTTON|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    event.preventDefault();
    startCapture();
  });

  btnNext.addEventListener('click', () => {
    if (!sessionCode) return;
    socket.emit('reset-to-preview', { code: sessionCode });
    releaseShutter();
  });

  socket.on('photo-ready', photo => {
    releaseShutter();
    ctrlCount.textContent = `${photo.total} fotos`;
    addToGallery({ ...photo, ts: Date.now() }, true);
  });
  socket.on('camera-status', ({ status }) => { if (status === 'error') releaseShutter(); });

  function photoId(photo) {
    return String(photo.page || photo.pageUrl || '').split('/').filter(Boolean).pop();
  }

  function addToGallery(photo, prepend = false) {
    const id = photoId(photo);
    if (!id || galleryGrid.querySelector(`[data-photo-id="${CSS.escape(id)}"]`)) return;
    noPhotos.style.display = 'none';

    const time = new Date(photo.ts || Date.now());
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'gallery-thumb';
    item.dataset.photoId = id;
    item.innerHTML = `
      <img src="${photo.thumbnail || photo.thumbUrl || photo.url || photo.imageUrl}" alt="Foto de ${time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}" loading="lazy">
      <span class="gallery-time">${time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="gallery-action">Exibir QR</span>
    `;
    item.addEventListener('click', () => socket.emit('show-photo', { code: sessionCode, photoId: id }));
    if (prepend) galleryGrid.prepend(item);
    else galleryGrid.append(item);
  }

  socket.on('session-photos', ({ photos = [] }) => {
    galleryGrid.querySelectorAll('.gallery-thumb').forEach(item => item.remove());
    [...photos].reverse().forEach(photo => addToGallery(photo));
    noPhotos.style.display = photos.length ? 'none' : '';
  });

  timerPills.forEach(pill => pill.addEventListener('click', () => {
    selectedTimer = Number(pill.dataset.timer);
    timerPills.forEach(item => item.classList.toggle('active', item === pill));
    socket.emit('update-settings', { code: sessionCode, settings: { timer: selectedTimer } });
  }));

  ratioPills.forEach(pill => pill.addEventListener('click', () => {
    selectedRatio = pill.dataset.ratio;
    ratioPills.forEach(item => item.classList.toggle('active', item === pill));
    socket.emit('update-settings', { code: sessionCode, settings: { aspectRatio: selectedRatio } });
  }));

  function ajustarFlashPeloSocket(mode) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) return reject(new Error('Servidor desconectado'));

      let terminou = false;
      const concluir = resposta => {
        if (terminou) return;
        terminou = true;
        clearTimeout(limite);
        if (!resposta?.success) reject(new Error(resposta?.error || 'Não foi possível ajustar o flash'));
        else resolve(resposta);
      };
      const limite = setTimeout(() => {
        if (terminou) return;
        terminou = true;
        reject(new Error('A câmera não confirmou o flash em 20 segundos'));
      }, 20_000);

      socket.emit('camera-flash', { code: sessionCode, mode }, concluir);
    });
  }

  flashPills.forEach(pill => pill.addEventListener('click', async () => {
    const mode = pill.dataset.flash;
    if (!sessionCode || flashBusy || (mode === selectedFlashMode && mode === 'off')) return;

    const anterior = selectedFlashMode;
    flashBusy = true;
    flashControlStatus.className = 'flash-control-status';
    flashControlStatus.textContent = mode === 'flash'
      ? 'Levantando o flash e verificando a carga…'
      : 'Desligando o flash no app…';
    updateAvailability();

    try {
      const data = await ajustarFlashPeloSocket(mode);

      applySettings({ flashMode: mode });
      if (mode === 'off') {
        flashControlStatus.textContent = data.requerFechamentoManual
          ? 'Sem flash selecionado. Abaixe o flash da câmera manualmente.'
          : 'Flash desligado.';
      } else if (data.flash?.carregado === true) {
        flashControlStatus.textContent = 'Flash levantado e carregado. Pronto para fotografar.';
        flashControlStatus.classList.add('ready');
      } else {
        flashControlStatus.textContent = 'Comando enviado. Confirme que o flash abriu; o app repetirá antes da foto.';
      }
    } catch (error) {
      applySettings({ flashMode: anterior });
      flashControlStatus.textContent = error.message || 'Não foi possível ajustar o flash';
      flashControlStatus.className = 'flash-control-status error';
    } finally {
      flashBusy = false;
      updateAvailability();
    }
  }));

  [btnFrame3x4, btnFrame4x3].forEach(button => button.addEventListener('click', () => {
    pendingFrameRatio = button.dataset.ratio;
    frameInput.click();
  }));

  frameInput.addEventListener('change', async () => {
    const file = frameInput.files[0];
    if (!file || !sessionCode || !pendingFrameRatio) return;
    const button = pendingFrameRatio === '3:4' ? btnFrame3x4 : btnFrame4x3;
    button.textContent = 'Enviando…';
    button.disabled = true;
    try {
      const form = new FormData();
      form.append('frame', file);
      form.append('aspectRatio', pendingFrameRatio);
      const response = await fetch(`/api/frame/${sessionCode}`, { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Falha no envio');
      markFrame(button);
    } catch {
      button.textContent = 'Erro — tentar novamente';
    } finally {
      button.disabled = false;
      frameInput.value = '';
    }
  });

  function markFrame(button) {
    button.classList.add('has-frame');
    button.textContent = 'Pronto ✓';
  }

  async function profileAction(path, pendingText) {
    cameraProfileStatus.textContent = pendingText;
    try {
      const response = await fetch(path, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      cameraProfileStatus.textContent = path.endsWith('/apply')
        ? `Perfil restaurado · ${data.aplicados?.length || 0} ajustes`
        : `Perfil salvo · ${Object.keys(data.perfil || {}).length} ajustes`;
    } catch (error) {
      cameraProfileStatus.textContent = error.message || 'Não foi possível concluir';
    }
  }

  btnSaveProfile.addEventListener('click', () => profileAction('/api/camera/profile', 'Lendo a câmera…'));
  btnApplyProfile.addEventListener('click', () => profileAction('/api/camera/profile/apply', 'Restaurando ajustes…'));

  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(item => item.classList.toggle('active', item === tab));
    panels.forEach(panel => panel.classList.toggle('hidden', panel.id !== `panel-${tab.dataset.tab}`));
  }));

  btnDisconnect.addEventListener('click', () => {
    localStorage.removeItem('globo-booth-ctrl-code');
    location.href = '/control.html';
  });
})();
