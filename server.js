require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pkg = require('./package.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const sessions = new Map();
const APP_UPDATED_AT = '2026-05-13T23:03:56-03:00';
const FINAL_JPEG_QUALITY = 100;

const PHOTO_DIRS = {
  uploads: path.join(__dirname, 'public', 'uploads'),
  original: path.join(__dirname, 'public', 'uploads', 'original'),
  final: path.join(__dirname, 'public', 'uploads', 'final'),
};
const SONY_SLOT = 1;
const ENABLE_SONY_SDK = process.env.ENABLE_SONY_SDK === 'true';

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use('/uploads', express.static(PHOTO_DIRS.uploads));

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (sessions.has(code));
  return code;
}

function ensurePhotoDirs() {
  Object.values(PHOTO_DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
}

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function publicUploadUrl(req, folder, filename) {
  return `${getBaseUrl(req)}/uploads/${folder}/${encodeURIComponent(filename)}`;
}

function buildPhotoUrls(req, finalFilename, originalFilename = null) {
  return {
    imageUrl: publicUploadUrl(req, 'final', finalFilename),
    pageUrl: `${getBaseUrl(req)}/photo/${encodeURIComponent(finalFilename)}`,
    downloadUrl: `${getBaseUrl(req)}/download/${encodeURIComponent(finalFilename)}`,
    originalUrl: originalFilename ? publicUploadUrl(req, 'original', originalFilename) : null,
  };
}

function getSessionFrame(code, aspectRatio) {
  const session = sessions.get(code);
  if (!session) return null;
  const key = aspectRatio === '4:3' ? 'frame4x3' : 'frame3x4';
  const frame = session[key];
  if (!frame?.data) return null;
  return Buffer.from(frame.data, 'base64');
}

function decodeDataImage(image) {
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

function safeBasename(value, fallback) {
  return path.basename(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function fileKey(file) {
  const contentId = file.content_id ?? file.contentId;
  const fileId = file.file_id ?? file.fileId;
  return `${contentId}:${fileId}`;
}

function getFileIds(file) {
  return {
    contentId: file.content_id ?? file.contentId,
    fileId: file.file_id ?? file.fileId ?? 0,
  };
}

function isLikelyJpeg(file) {
  return /\.(jpe?g)$/i.test(file.file_path || file.name || '');
}

function fileTimestamp(file) {
  const parts = [
    file.creation_year,
    file.creation_month,
    file.creation_day,
    file.creation_hour,
    file.creation_minute,
    file.creation_second,
  ];
  if (parts.some(v => v === undefined || v === null)) return 0;
  return new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime();
}

function chooseBestPhoto(files, previousKeys = new Set()) {
  const candidates = (files || [])
    .filter(file => getFileIds(file).contentId !== undefined)
    .filter(file => !/\.(arw|mp4|mov)$/i.test(file.file_path || ''));

  const newFiles = candidates.filter(file => !previousKeys.has(fileKey(file)));
  const pool = newFiles.length ? newFiles : candidates;

  return pool
    .slice()
    .sort((a, b) => {
      const jpegScore = Number(isLikelyJpeg(b)) - Number(isLikelyJpeg(a));
      if (jpegScore) return jpegScore;
      const timeScore = fileTimestamp(b) - fileTimestamp(a);
      if (timeScore) return timeScore;
      return (b.file_size || 0) - (a.file_size || 0);
    })[0];
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForStableFile(candidates, sinceMs, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastPath = null;
  let lastSize = -1;
  let stableSince = 0;

  while (Date.now() < deadline) {
    const currentCandidates = typeof candidates === 'function' ? candidates() : candidates;
    const existing = currentCandidates
      .filter(Boolean)
      .filter(filePath => fs.existsSync(filePath))
      .map(filePath => ({ filePath, stat: fs.statSync(filePath) }))
      .filter(({ stat }) => stat.size > 0 && stat.mtimeMs >= sinceMs - 1000)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    if (existing.length) {
      const current = existing[0];
      if (current.filePath === lastPath && current.stat.size === lastSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 700) return current.filePath;
      } else {
        lastPath = current.filePath;
        lastSize = current.stat.size;
        stableSince = 0;
      }
    }

    await wait(300);
  }

  throw new Error('Sony download did not finish in time');
}

async function composeFinalPhoto(input, { code, aspectRatio = '3:4' }) {
  ensurePhotoDirs();

  const targetRatio = aspectRatio === '4:3' ? 4 / 3 : 3 / 4;
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Invalid image metadata');

  let sourceWidth = metadata.width;
  let sourceHeight = metadata.height;
  if ([5, 6, 7, 8].includes(metadata.orientation)) {
    sourceWidth = metadata.height;
    sourceHeight = metadata.width;
  }

  const source = sharp(input).rotate();
  const sourceRatio = sourceWidth / sourceHeight;
  let cropWidth;
  let cropHeight;

  if (sourceRatio > targetRatio) {
    cropHeight = sourceHeight;
    cropWidth = Math.round(cropHeight * targetRatio);
  } else {
    cropWidth = sourceWidth;
    cropHeight = Math.round(cropWidth / targetRatio);
  }

  let targetWidth = cropWidth;
  let targetHeight = cropHeight;

  const frameBuffer = getSessionFrame(code, aspectRatio);
  if (frameBuffer) {
    const frameMeta = await sharp(frameBuffer).metadata();
    // Se a moldura for maior que a foto cortada, usamos o tamanho da moldura como alvo
    if (frameMeta.width > targetWidth || frameMeta.height > targetHeight) {
      targetWidth = frameMeta.width;
      targetHeight = frameMeta.height;
    }
  }

  // Garantir uma resolução mínima para "Alta Qualidade" (ex: 1600px de altura)
  // Isso evita que fotos de webcam fiquem minúsculas/pixeladas ao baixar no celular
  const MIN_HEIGHT = 1600;
  if (targetHeight < MIN_HEIGHT) {
    const factor = MIN_HEIGHT / targetHeight;
    targetWidth = Math.round(targetWidth * factor);
    targetHeight = MIN_HEIGHT;
  }

  let pipeline = source.resize(targetWidth, targetHeight, { 
    fit: 'cover', 
    position: 'centre', 
    kernel: sharp.kernel.lanczos3 
  });

  if (frameBuffer) {
    const frame = await sharp(frameBuffer)
      .resize(targetWidth, targetHeight, { fit: 'fill' })
      .png()
      .toBuffer();
    pipeline = pipeline.composite([{ input: frame, left: 0, top: 0 }]);
  }

  const finalFilename = `globo_final_${Date.now()}_${aspectRatio.replace(':', 'x')}.jpg`;
  const finalPath = path.join(PHOTO_DIRS.final, finalFilename);

  await pipeline
    .jpeg({ quality: FINAL_JPEG_QUALITY, chromaSubsampling: '4:4:4' })
    .withMetadata()
    .toFile(finalPath);

  const stat = fs.statSync(finalPath);
  return {
    finalFilename,
    finalPath,
    meta: {
      sourceWidth,
      sourceHeight,
      cropWidth,
      cropHeight,
      finalWidth: targetWidth,
      finalHeight: targetHeight,
      finalBytes: stat.size,
      format: 'jpeg',
      quality: FINAL_JPEG_QUALITY,
      upscaleFactor: Number((targetHeight / cropHeight).toFixed(2)),
      aspectRatio,
      frameApplied: !!frameBuffer,
    },
  };
}

function renderDownloadPage(filename) {
  const safeName = safeBasename(filename, 'foto.jpg');
  const imagePath = `/uploads/final/${encodeURIComponent(safeName)}`;
  const downloadPath = `/download/${encodeURIComponent(safeName)}`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Baixar foto Globo</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #06121f; color: #fff; display: flex; align-items: center; justify-content: center; padding: 20px; }
    main { width: min(100%, 520px); display: flex; flex-direction: column; gap: 18px; align-items: center; }
    img { width: 100%; height: auto; border: 10px solid #fff; border-radius: 8px; box-shadow: 0 24px 80px rgba(0,0,0,.45); background: #fff; }
    h1 { font-size: 24px; line-height: 1.15; margin: 4px 0 0; text-align: center; }
    p { color: rgba(255,255,255,.72); font-size: 14px; line-height: 1.5; margin: 0; text-align: center; }
    a { width: 100%; display: inline-flex; align-items: center; justify-content: center; min-height: 52px; border-radius: 999px; background: #fff; color: #003B71; text-decoration: none; font-weight: 800; font-size: 16px; }
  </style>
</head>
<body>
  <main>
    <img src="${imagePath}" alt="Sua foto">
    <h1>Sua foto está pronta</h1>
    <p>Toque no botão para baixar a versão em alta qualidade com a moldura.</p>
    <a href="${downloadPath}">Baixar em alta qualidade</a>
  </main>
</body>
</html>`;
}

/* ── REST API ─────────────────────────────────────────── */

// Upload photo locally to avoid ImgBB compression
app.post('/api/upload', async (req, res) => {
  try {
    const { image, code, aspectRatio = '3:4' } = req.body;
    if (!image) return res.status(400).json({ error: 'No image data' });

    const inputBuffer = decodeDataImage(image);
    const { finalFilename, meta } = await composeFinalPhoto(inputBuffer, { code, aspectRatio });
    const urls = buildPhotoUrls(req, finalFilename);
    
    res.json({ success: true, data: { ...urls, url: urls.imageUrl, image: { url: urls.imageUrl }, meta: { ...meta, inputBytes: inputBuffer.length } } });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Upload frame PNG
app.post('/api/frame/:code', upload.single('frame'), (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const ratio = req.body.aspectRatio || '3:4';
  const key = ratio === '4:3' ? 'frame4x3' : 'frame3x4';

  session[key] = { data: req.file.buffer.toString('base64'), mime: req.file.mimetype };

  io.to(req.params.code).emit('frame-updated', {
    aspectRatio: ratio,
    frameUrl: `/api/frame/${req.params.code}?ratio=${ratio}&t=${Date.now()}`
  });
  res.json({ success: true });
});

// Get frame
app.get('/api/frame/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).send('Not found');
  const key = (req.query.ratio === '4:3') ? 'frame4x3' : 'frame3x4';
  const frame = session[key];
  if (!frame) return res.status(404).send('No frame');
  res.set('Content-Type', frame.mime);
  res.send(Buffer.from(frame.data, 'base64'));
});

// Get photos list
app.get('/api/photos/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.json({ photos: [] });
  res.json({ photos: session.photos || [] });
});

app.get('/api/version', (req, res) => {
  const date = new Date(APP_UPDATED_AT);
  res.json({
    version: pkg.version,
    updatedAt: APP_UPDATED_AT,
    label: `v${pkg.version} • ${date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`,
  });
});

app.post('/api/photo/finalize', async (req, res) => {
  try {
    const { image, code, aspectRatio = '3:4' } = req.body;
    if (!image) return res.status(400).json({ error: 'No image data' });

    const inputBuffer = decodeDataImage(image);
    const { finalFilename, meta } = await composeFinalPhoto(inputBuffer, { code, aspectRatio });
    const urls = buildPhotoUrls(req, finalFilename);

    res.json({ success: true, data: { ...urls, meta: { ...meta, inputBytes: inputBuffer.length } } });
  } catch (err) {
    console.error('Finalize photo error:', err);
    res.status(500).json({ error: err.message || 'Finalize failed' });
  }
});

app.get('/photo/:filename', (req, res) => {
  const filename = safeBasename(req.params.filename, '');
  const finalPath = path.join(PHOTO_DIRS.final, filename);
  if (!filename || !fs.existsSync(finalPath)) return res.status(404).send('Foto não encontrada');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDownloadPage(filename));
});

app.get('/download/:filename', (req, res) => {
  const filename = safeBasename(req.params.filename, '');
  const finalPath = path.join(PHOTO_DIRS.final, filename);
  if (!filename || !fs.existsSync(finalPath)) return res.status(404).send('Foto não encontrada');
  res.download(finalPath, `globo_foto_${Date.now()}.jpg`);
});

/* ── SONY CAMERA REMOTE API INTEGRATION ────────────────── */

let sonyServer = null;
let sonyClient = null;
let sonyCameraId = null;
let sonyCapturing = false;
let sonyQualityConfiguredFor = null;

if (ENABLE_SONY_SDK) {
  try {
    const { ServerManager } = require('@alpha-sdk/api');
    const { AlphaSDKClient } = require('@alpha-sdk/client');
    sonyServer = new ServerManager({ port: 8080 });
    sonyClient = new AlphaSDKClient({ environment: 'http://localhost:8080' });
    sonyServer.start().catch(err => console.error('Error starting Sony SDK server:', err));
  } catch (err) {
    console.error('Sony SDK unavailable. Running in web-only camera mode:', err.message);
  }
}

app.get('/api/sony/status', async (req, res) => {
  if (!sonyClient) return res.json({ available: false, mode: 'webcam' });

  try {
    const { cameras } = await sonyClient.cameras.list();
    const camera = cameras.find(c => c.connected !== true) ?? cameras[0];
    
    if (!camera) return res.json({ available: false });
    
    sonyCameraId = camera.id;
    if (!camera.connected) {
      await sonyClient.cameras.connect({
        cameraId: sonyCameraId,
        mode: "remote-transfer", // full control + download
        reconnecting: "on"
      });
      await sonyClient.properties.setPriorityKey({ cameraId: sonyCameraId, setting: "pc-remote" });
    }
    await trySetBestSonyQuality(sonyCameraId);
    res.json({ available: true, camera: camera.model });
  } catch (err) {
    console.error('Sony status error:', err);
    res.json({ available: false });
  }
});

// Proxy for live view polling
app.get('/api/sony/preview', async (req, res) => {
  if (!sonyClient) return res.status(404).end();
  if (!sonyCameraId) return res.status(404).end();
  
  try {
    const status = await sonyClient.liveView.getStatus({ cameraId: sonyCameraId });
    if (!status.data.enabled) {
      await sonyClient.liveView.enable({ cameraId: sonyCameraId });
    }
    if (!status.data.streaming) {
      await sonyClient.liveView.start({ cameraId: sonyCameraId });
    }

    const frameResponse = await sonyClient.liveView.getFrame({ cameraId: sonyCameraId });
    const buffer = Buffer.from(await frameResponse.arrayBuffer());
    
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (err) {
    res.status(500).end();
  }
});

app.post('/api/sony/capture', async (req, res) => {
  if (!sonyClient) return res.status(400).json({ error: 'Sony SDK disabled in web-only mode' });
  if (sonyCapturing || !sonyCameraId) return res.status(429).json({ error: 'Capture unavailable' });

  sonyCapturing = true;

  try {
    const { code, aspectRatio = '3:4' } = req.body || {};
    ensurePhotoDirs();

    const beforeList = await sonyClient.sdCard.list({ cameraId: sonyCameraId, slotNumber: SONY_SLOT });
    const beforeFiles = beforeList.files || beforeList.data?.files || [];
    const beforeKeys = new Set(beforeFiles.map(fileKey));

    // Fire the shutter
    await sonyClient.actions.shutter({ cameraId: sonyCameraId });

    // Wait for the camera to write the file and expose it through the SDK.
    await wait(1200);
    
    let latest = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const list = await sonyClient.sdCard.list({ cameraId: sonyCameraId, slotNumber: SONY_SLOT });
      const files = list.files || list.data?.files || [];
      latest = chooseBestPhoto(files, beforeKeys);
      if (latest && !beforeKeys.has(fileKey(latest))) break;
      await wait(500);
    }
    if (!latest || beforeKeys.has(fileKey(latest))) throw new Error('No new photo found on SD card');

    const { contentId, fileId } = getFileIds(latest);
    if (contentId === undefined || fileId === undefined) throw new Error('Sony file id not found');

    const downloadStartedAt = Date.now();
    const cameraBaseName = safeBasename(latest.file_path, `sony_${Date.now()}.jpg`);
    const expectedPath = path.join(PHOTO_DIRS.original, cameraBaseName);

    await sonyClient.sdCard.download({
      cameraId: sonyCameraId,
      slotNumber: SONY_SLOT,
      contentId,
      fileId,
      body: { save_path: PHOTO_DIRS.original },
    });

    const downloadedPath = await waitForStableFile(() => {
      const files = fs.existsSync(PHOTO_DIRS.original)
        ? fs.readdirSync(PHOTO_DIRS.original).map(name => path.join(PHOTO_DIRS.original, name))
        : [];
      return [expectedPath, ...files];
    }, downloadStartedAt);

    const originalFilename = `sony_original_${Date.now()}_${safeBasename(downloadedPath, cameraBaseName)}`;
    const originalPath = path.join(PHOTO_DIRS.original, originalFilename);
    if (downloadedPath !== originalPath) fs.copyFileSync(downloadedPath, originalPath);

    const { finalFilename, meta } = await composeFinalPhoto(originalPath, { code, aspectRatio });
    const urls = buildPhotoUrls(req, finalFilename, originalFilename);

    sonyCapturing = false;
    res.json({ success: true, data: { ...urls, meta } });
  } catch (err) {
    sonyCapturing = false;
    console.error('Sony capture error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const SONY_PROPERTIES = ['iso', 'f-number', 'shutter-speed', 'white-balance', 'exposure-compensation', 'file-format', 'image-quality', 'image-size'];
const SONY_LABELS = {
  'iso': 'ISO', 
  'f-number': 'Abertura (f/)', 
  'shutter-speed': 'Velocidade', 
  'white-balance': 'Bal. Branco',
  'exposure-compensation': 'Compensação EV',
  'file-format': 'Formato',
  'image-quality': 'Qualidade',
  'image-size': 'Tamanho'
};

async function trySetBestSonyQuality(cameraId) {
  if (sonyQualityConfiguredFor === cameraId) return;

  const preferences = {
    'file-format': ['jpeg', 'jpg', 'jpeg + raw', 'raw & jpeg'],
    'image-quality': ['extra fine', 'xfine', 'fine'],
    'image-size': ['large', 'l:'],
  };

  for (const [propertyName, preferredTerms] of Object.entries(preferences)) {
    try {
      const propData = await sonyClient.properties.get({ cameraId, propertyName });
      const values = propData.data?.supportedValues || [];
      const current = String(propData.data?.value || '').toLowerCase();
      const best = values.find(value => preferredTerms.some(term => String(value).toLowerCase().includes(term)));

      if (best && !preferredTerms.some(term => current.includes(term))) {
        await sonyClient.properties.set({ cameraId, propertyName, value: best.toString() });
      }
    } catch (err) {
      // Some bodies/firmware do not expose these settings over USB.
    }
  }

  sonyQualityConfiguredFor = cameraId;
}

app.get('/api/sony/all-configs', async (req, res) => {
  if (!sonyClient) return res.json({});
  if (!sonyCameraId) return res.json({});
  
  const results = {};
  try {
    for (const key of SONY_PROPERTIES) {
      try {
        const propData = await sonyClient.properties.get({ cameraId: sonyCameraId, propertyName: key });
        if (propData.data && propData.data.supportedValues) {
          results[key] = { 
            current: propData.data.value, 
            choices: propData.data.supportedValues, 
            label: SONY_LABELS[key] || key 
          };
        }
      } catch (e) {
        // Ignorar propriedades não suportadas
      }
    }
  } catch (err) {
    console.error('Error fetching properties:', err);
  }
  res.json(results);
});

app.post('/api/sony/config/:key', async (req, res) => {
  if (!sonyClient) return res.status(400).json({ error: 'Sony SDK disabled in web-only mode' });
  if (!sonyCameraId) return res.status(400).json({ error: 'No camera' });
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'No value' });

  try {
    await sonyClient.properties.set({
      cameraId: sonyCameraId,
      propertyName: req.params.key,
      value: value.toString()
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Sony set property error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Autofocus & manual focus actions
app.post('/api/sony/autofocus', async (req, res) => {
  if (!sonyClient) return res.status(400).json({ error: 'Sony SDK disabled in web-only mode' });
  if (!sonyCameraId) return res.status(400).json({ error: 'No camera' });
  try {
    await sonyClient.actions.startHalfPress({ cameraId: sonyCameraId });
    await new Promise(r => setTimeout(r, 500));
    await sonyClient.actions.stopHalfPress({ cameraId: sonyCameraId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sony/manual-focus', async (req, res) => {
  if (!sonyClient) return res.status(400).json({ error: 'Sony SDK disabled in web-only mode' });
  if (!sonyCameraId) return res.status(400).json({ error: 'No camera' });
  const { direction } = req.body;
  
  // Mapping 'near'/'far' from control.js to Sony API Focus actions
  let action;
  if (direction.startsWith('near')) action = 'focus-near';
  else if (direction.startsWith('far')) action = 'focus-far';
  else return res.status(400).json({ error: 'Invalid direction' });

  try {
    await sonyClient.actions[action]({ cameraId: sonyCameraId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



/* ═══════════════════════════════════════════════════════
   SOCKET.IO — Sessão Persistente
   
   Regras:
   1. create-session aceita code opcional → reutiliza sessão existente
   2. Disconnect do display NÃO deleta a sessão (só nullifica displaySocket)
   3. Disconnect do controle NÃO deleta a sessão (só nullifica controlSocket)
   4. Sessão só é deletada após 24h de inatividade
   5. Reconexão: display e controle podem re-join ao mesmo código
   ═══════════════════════════════════════════════════════ */

io.on('connection', (socket) => {
  console.log('+ connected', socket.id);

  /* ── Create or rejoin session (display side) ── */
  socket.on('create-session', ({ requestedCode } = {}, cb) => {
    // If a code was requested and the session exists, rejoin it
    if (requestedCode && sessions.has(requestedCode)) {
      const s = sessions.get(requestedCode);
      // Update display socket to new connection
      s.displaySocket = socket.id;
      s.lastActivity = Date.now();
      socket.join(requestedCode);
      socket.sessionCode = requestedCode;

      // Notify connected controller that display is back
      if (s.controlSocket) {
        io.to(s.controlSocket).emit('display-reconnected');
      }

      console.log('Display rejoined session:', requestedCode);
      cb({ code: requestedCode, rejoined: true, photoCount: (s.photos || []).length });
      return;
    }

    // Create new session (use requested code if unique, otherwise generate)
    const code = (requestedCode && !sessions.has(requestedCode)) ? requestedCode : generateCode();
    sessions.set(code, {
      displaySocket: socket.id,
      controlSocket: null,
      photos: [],
      settings: { timer: 3, aspectRatio: '3:4' },
      frame3x4: null,
      frame4x3: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
    socket.join(code);
    socket.sessionCode = code;
    cb({ code, rejoined: false, photoCount: 0 });
    console.log('Session created:', code);
  });

  /* ── Join session (controller side) ── */
  socket.on('join-session', (code, cb) => {
    const s = sessions.get(code);
    if (!s) return cb({ error: 'Código inválido' });

    s.controlSocket = socket.id;
    s.lastActivity = Date.now();
    socket.join(code);
    socket.sessionCode = code;

    // Notify display
    if (s.displaySocket) {
      io.to(s.displaySocket).emit('controller-connected');
    }

    cb({
      success: true,
      settings: s.settings,
      hasFrame3x4: !!s.frame3x4,
      hasFrame4x3: !!s.frame4x3,
      photoCount: (s.photos || []).length
    });

    // Send existing photos to the joining controller
    if (s.photos && s.photos.length > 0) {
      socket.emit('session-photos', { photos: s.photos });
    }
    console.log('Controller joined:', code);
  });

  /* ── Trigger capture ── */
  socket.on('trigger-capture', ({ code, timer }) => {
    const s = sessions.get(code);
    if (s) {
      s.lastActivity = Date.now();
      if (s.displaySocket) io.to(s.displaySocket).emit('start-countdown', { timer });
    }
  });

  /* ── Photo uploaded ── */
  socket.on('photo-uploaded', ({ code, url, thumbnail }) => {
    const s = sessions.get(code);
    if (s) {
      s.photos.push({ url, thumbnail, ts: Date.now() });
      s.lastActivity = Date.now();
      io.to(code).emit('photo-ready', { url, thumbnail, total: s.photos.length });
    }
  });

  /* ── Update settings ── */
  socket.on('update-settings', ({ code, settings }) => {
    const s = sessions.get(code);
    if (s) {
      Object.assign(s.settings, settings);
      s.lastActivity = Date.now();
      io.to(code).emit('settings-updated', s.settings);
    }
  });

  /* ── Re-show photo on display (gallery tap) ── */
  socket.on('show-photo', ({ code, url }) => {
    const s = sessions.get(code);
    if (s && s.displaySocket) io.to(s.displaySocket).emit('show-photo', { url });
  });

  /* ── Reset to preview (operator "Next" button) ── */
  socket.on('reset-to-preview', ({ code }) => {
    const s = sessions.get(code);
    if (s && s.displaySocket) io.to(s.displaySocket).emit('reset-to-preview');
  });

  /* ── Camera control relay ── */
  socket.on('cam-control', ({ code, cmd }) => {
    const s = sessions.get(code);
    if (s && s.displaySocket) io.to(s.displaySocket).emit('cam-control', { cmd });
  });


  /* ── Disconnect — DOES NOT DELETE SESSION ──
     Session survives both display and controller disconnects.
     Only cleaned up after 24h of inactivity. */
  socket.on('disconnect', () => {
    const code = socket.sessionCode;
    if (!code) return;
    const s = sessions.get(code);
    if (!s) return;

    if (s.displaySocket === socket.id) {
      s.displaySocket = null;
      // Notify controller that display went away (but session lives)
      if (s.controlSocket) {
        io.to(s.controlSocket).emit('display-disconnected');
      }
      console.log('Display disconnected (session preserved):', code);
    } else if (s.controlSocket === socket.id) {
      s.controlSocket = null;
      // Notify display that controller went away
      if (s.displaySocket) {
        io.to(s.displaySocket).emit('controller-disconnected');
      }
      console.log('Controller disconnected (session preserved):', code);
    }
  });
});

// Cleanup sessions older than 24h of inactivity
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (now - (s.lastActivity || s.createdAt) > 86400000) {
      sessions.delete(code);
      console.log('Session expired:', code);
    }
  }
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 Globo Photo Booth → http://localhost:${PORT}\n`);
});
