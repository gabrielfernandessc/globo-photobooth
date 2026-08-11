require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const multer = require('multer');
const sharp = require('sharp');
const QRCode = require('qrcode');
const pkg = require('./package.json');

/* ═══════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════ */

const PORT = int(process.env.PORT, 3000);
const HTTPS_PORT = int(process.env.HTTPS_PORT, 3443);
const ENABLE_HTTPS = process.env.ENABLE_HTTPS !== 'false';

// Qualidade do master (a foto que sai no botão "alta qualidade").
const FINAL_JPEG_QUALITY = clamp(int(process.env.FINAL_JPEG_QUALITY, 100), 1, 100);
// Teto opcional do lado maior do master. 0 = sem teto (resolução nativa do sensor).
const MAX_FINAL_LONG_SIDE = int(process.env.MAX_FINAL_LONG_SIDE, 0);
// Derivadas leves: preview da página de download e miniatura da galeria.
const WEB_LONG_SIDE = int(process.env.WEB_LONG_SIDE, 2048);
const WEB_JPEG_QUALITY = clamp(int(process.env.WEB_JPEG_QUALITY, 88), 1, 100);
const THUMB_LONG_SIDE = 480;

const SAVE_ORIGINAL = process.env.SAVE_ORIGINAL !== 'false';
const SAVE_TO_DOWNLOADS = process.env.SAVE_TO_DOWNLOADS !== 'false';

const MAX_UPLOAD_BYTES = int(process.env.MAX_UPLOAD_MB, 60) * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_RE = /^[A-Z0-9]{4}$/;

const APP_UPDATED_AT = new Date().toISOString();

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads', 'Globo-Photobooth');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTO_DIRS = {
  uploads: path.join(PUBLIC_DIR, 'uploads'),
  original: path.join(PUBLIC_DIR, 'uploads', 'original'),
  final: path.join(PUBLIC_DIR, 'uploads', 'final'),
  web: path.join(PUBLIC_DIR, 'uploads', 'web'),
  thumb: path.join(PUBLIC_DIR, 'uploads', 'thumb'),
};

function int(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ═══════════════════════════════════════════════════════════
   APP
   ═══════════════════════════════════════════════════════════ */

const app = express();
const server = http.createServer(app);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const sessions = new Map();

// Sharp: fotos de 12–50 MP entram aqui. Sem cache de arquivo, com paralelismo
// limitado para não estourar a RAM da máquina do totem.
sharp.cache(false);
sharp.concurrency(clamp(int(process.env.SHARP_CONCURRENCY, 2), 1, 8));

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));
app.use('/uploads', express.static(PHOTO_DIRS.uploads, { maxAge: '1h', immutable: true }));

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

function ensurePhotoDirs() {
  Object.values(PHOTO_DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  if (SAVE_TO_DOWNLOADS) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (sessions.has(code));
  return code;
}

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function getSession(value) {
  const code = normalizeCode(value);
  if (!code) return null;
  const session = sessions.get(code);
  if (session) session.lastActivity = Date.now();
  return session || null;
}

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function safeBasename(value, fallback) {
  return path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function publicUploadUrl(req, folder, filename) {
  return `${getBaseUrl(req)}/uploads/${folder}/${encodeURIComponent(filename)}`;
}

function buildPhotoUrls(req, names) {
  const base = getBaseUrl(req);
  return {
    imageUrl: publicUploadUrl(req, 'web', names.web),
    fullUrl: publicUploadUrl(req, 'final', names.final),
    thumbUrl: publicUploadUrl(req, 'thumb', names.thumb),
    originalUrl: names.original ? publicUploadUrl(req, 'original', names.original) : null,
    pageUrl: `${base}/photo/${encodeURIComponent(names.final)}`,
    downloadUrl: `${base}/download/${encodeURIComponent(names.final)}`,
  };
}

function getSessionFrame(code, aspectRatio) {
  const session = sessions.get(normalizeCode(code) || '');
  if (!session) return null;
  const frame = session.frames[aspectRatio === '4:3' ? '4:3' : '3:4'];
  return frame?.data ? Buffer.from(frame.data, 'base64') : null;
}

function decodeDataImage(image) {
  return Buffer.from(String(image).replace(/^data:image\/\w+;base64,/, ''), 'base64');
}

function ratioValue(aspectRatio) {
  const [a, b] = String(aspectRatio || '3:4').split(':').map(Number);
  return a > 0 && b > 0 ? a / b : 3 / 4;
}

/**
 * Maior retângulo centralizado com a proporção alvo que cabe na imagem —
 * um crop "cover" sem reamostrar nada, então nenhum pixel do sensor é perdido
 * fora da área cortada.
 */
function centerCrop(width, height, ratio) {
  let w = width;
  let h = Math.round(width / ratio);
  if (h > height) {
    h = height;
    w = Math.round(height * ratio);
  }
  return {
    left: Math.max(0, Math.floor((width - w) / 2)),
    top: Math.max(0, Math.floor((height - h) / 2)),
    width: Math.min(w, width),
    height: Math.min(h, height),
  };
}

/* ═══════════════════════════════════════════════════════════
   COMPOSIÇÃO DA FOTO FINAL

   Pipeline (uma única reamostragem, uma única codificação JPEG):
     auto-rotate por EXIF → crop central na proporção → espelho opcional
     → teto opcional de resolução → moldura por cima → JPEG.

   Metadados (incluindo GPS do celular) são removidos das versões públicas.
   O arquivo original, com EXIF intacto, fica em uploads/original.
   ═══════════════════════════════════════════════════════════ */

async function composeFinalPhoto(input, options = {}) {
  const { code, aspectRatio = '3:4', mirror = false, source = 'web' } = options;
  ensurePhotoDirs();

  const meta = await sharp(input, { limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height) throw new Error('Imagem inválida (sem dimensões)');

  // Após o auto-rotate, largura e altura trocam nas orientações 5–8.
  const rotates = (meta.orientation || 1) >= 5;
  const srcWidth = rotates ? meta.height : meta.width;
  const srcHeight = rotates ? meta.width : meta.height;

  const crop = centerCrop(srcWidth, srcHeight, ratioValue(aspectRatio));

  let finalWidth = crop.width;
  let finalHeight = crop.height;
  const longSide = Math.max(finalWidth, finalHeight);
  const capped = MAX_FINAL_LONG_SIDE > 0 && longSide > MAX_FINAL_LONG_SIDE;
  if (capped) {
    const scale = MAX_FINAL_LONG_SIDE / longSide;
    finalWidth = Math.round(finalWidth * scale);
    finalHeight = Math.round(finalHeight * scale);
  }

  let pipeline = sharp(input, { limitInputPixels: false }).rotate().extract(crop);
  if (mirror) pipeline = pipeline.flop();
  if (capped) {
    pipeline = pipeline.resize(finalWidth, finalHeight, { fit: 'fill', kernel: 'lanczos3' });
  }

  const frameBuffer = getSessionFrame(code, aspectRatio);
  if (frameBuffer) {
    const frame = await sharp(frameBuffer)
      .resize(finalWidth, finalHeight, { fit: 'fill' })
      .png()
      .toBuffer();
    pipeline = pipeline.composite([{ input: frame, left: 0, top: 0 }]);
  }

  const finalBuffer = await pipeline
    .jpeg({ quality: FINAL_JPEG_QUALITY, chromaSubsampling: '4:4:4', mozjpeg: false })
    .toBuffer();

  const stamp = `${Date.now()}_${aspectRatio.replace(':', 'x')}`;
  const names = {
    final: `globo_${stamp}.jpg`,
    web: `globo_${stamp}_web.jpg`,
    thumb: `globo_${stamp}_thumb.jpg`,
    original: null,
  };

  await fs.promises.writeFile(path.join(PHOTO_DIRS.final, names.final), finalBuffer);

  // Derivadas para rede: a página do QR carrega a versão web (rápida no 4G do
  // convidado); o master fica atrás do botão de download.
  const [webBuffer, thumbBuffer] = await Promise.all([
    sharp(finalBuffer)
      .resize(WEB_LONG_SIDE, WEB_LONG_SIDE, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .jpeg({ quality: WEB_JPEG_QUALITY, mozjpeg: true })
      .toBuffer(),
    sharp(finalBuffer)
      .resize(THUMB_LONG_SIDE, THUMB_LONG_SIDE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer(),
  ]);

  await Promise.all([
    fs.promises.writeFile(path.join(PHOTO_DIRS.web, names.web), webBuffer),
    fs.promises.writeFile(path.join(PHOTO_DIRS.thumb, names.thumb), thumbBuffer),
  ]);

  if (SAVE_ORIGINAL) {
    names.original = `globo_${stamp}_original.jpg`;
    fs.promises
      .writeFile(path.join(PHOTO_DIRS.original, names.original), input)
      .catch(err => console.error('Falha ao salvar original:', err.message));
  }

  if (SAVE_TO_DOWNLOADS) {
    fs.promises
      .writeFile(path.join(DOWNLOADS_DIR, names.final), finalBuffer)
      .catch(err => console.error('Falha ao copiar para Downloads:', err.message));
  }

  return {
    names,
    meta: {
      source,
      sourceWidth: srcWidth,
      sourceHeight: srcHeight,
      sourceMegapixels: +((srcWidth * srcHeight) / 1e6).toFixed(1),
      cropWidth: crop.width,
      cropHeight: crop.height,
      finalWidth,
      finalHeight,
      finalBytes: finalBuffer.length,
      webBytes: webBuffer.length,
      inputBytes: input.length,
      format: 'jpeg',
      quality: FINAL_JPEG_QUALITY,
      aspectRatio,
      mirror,
      frameApplied: !!frameBuffer,
      resampled: capped,
    },
  };
}

/* ═══════════════════════════════════════════════════════════
   PÁGINA DE DOWNLOAD (aberta pelo QR Code)
   ═══════════════════════════════════════════════════════════ */

function renderDownloadPage(finalName) {
  const safeName = safeBasename(finalName, 'foto.jpg');
  const webName = safeName.replace(/\.jpg$/i, '_web.jpg');
  const webPath = fs.existsSync(path.join(PHOTO_DIRS.web, webName))
    ? `/uploads/web/${encodeURIComponent(webName)}`
    : `/uploads/final/${encodeURIComponent(safeName)}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sua foto — Globo</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; background: #06121f; color: #fff; display: flex; align-items: center; justify-content: center; padding: 20px; }
    main { width: min(100%, 520px); display: flex; flex-direction: column; gap: 18px; align-items: center; }
    img { width: 100%; height: auto; border: 10px solid #fff; border-radius: 8px; box-shadow: 0 24px 80px rgba(0,0,0,.45); background: #fff; }
    h1 { font-size: 24px; line-height: 1.15; margin: 4px 0 0; text-align: center; }
    p { color: rgba(255,255,255,.72); font-size: 14px; line-height: 1.5; margin: 0; text-align: center; }
    a.dl { width: 100%; display: inline-flex; align-items: center; justify-content: center; min-height: 52px; border-radius: 999px; background: #fff; color: #003B71; text-decoration: none; font-weight: 800; font-size: 16px; }
  </style>
</head>
<body>
  <main>
    <img src="${webPath}" alt="Sua foto">
    <h1>Sua foto está pronta</h1>
    <p>Toque no botão para baixar o arquivo em resolução máxima, com a moldura.</p>
    <a class="dl" href="/download/${encodeURIComponent(safeName)}">Baixar em alta qualidade</a>
  </main>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════
   REST API
   ═══════════════════════════════════════════════════════════ */

app.get('/api/version', (req, res) => {
  const date = new Date(APP_UPDATED_AT);
  res.json({
    version: pkg.version,
    updatedAt: APP_UPDATED_AT,
    label: `v${pkg.version} • ${date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`,
  });
});

// QR Code gerado localmente — o evento não depende de internet.
app.get('/api/qr', async (req, res) => {
  const data = String(req.query.data || '');
  if (!data) return res.status(400).send('missing data');
  try {
    const png = await QRCode.toBuffer(data, {
      type: 'png',
      width: clamp(int(req.query.size, 420), 120, 1200),
      margin: 2,
      errorCorrectionLevel: req.query.ecc || 'M',
      color: { dark: `#${(req.query.color || '003B71').replace('#', '')}`, light: '#FFFFFFFF' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    console.error('QR error:', err.message);
    res.status(500).send('qr failed');
  }
});

/**
 * Captura vinda do celular: JPEG binário direto do sensor (multipart).
 * Sem base64 — 12 MP viram ~5 MB em vez de ~7 MB, e sem custo de encode.
 */
app.post('/api/photo/capture', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Arquivo ausente' });

    const { finalName, meta, urls } = await processCapture(req, req.file.buffer, {
      code: req.body.code,
      aspectRatio: req.body.aspectRatio || '3:4',
      mirror: String(req.body.mirror) === 'true',
      source: req.body.source || 'phone',
    });

    res.json({ success: true, data: { ...urls, finalName, meta } });
  } catch (err) {
    console.error('Capture error:', err);
    res.status(500).json({ error: err.message || 'Falha ao processar a foto' });
  }
});

/** Captura vinda da webcam do próprio totem (data URL) — caminho legado. */
app.post('/api/photo/finalize', async (req, res) => {
  try {
    const { image, code, aspectRatio = '3:4', mirror = true } = req.body;
    if (!image) return res.status(400).json({ error: 'Sem imagem' });

    const buffer = decodeDataImage(image);
    const { finalName, meta, urls } = await processCapture(req, buffer, {
      code,
      aspectRatio,
      mirror: !!mirror,
      source: 'webcam',
    });

    res.json({ success: true, data: { ...urls, finalName, meta } });
  } catch (err) {
    console.error('Finalize error:', err);
    res.status(500).json({ error: err.message || 'Falha ao finalizar' });
  }
});

async function processCapture(req, buffer, options) {
  const { names, meta } = await composeFinalPhoto(buffer, options);
  const urls = buildPhotoUrls(req, names);

  const session = getSession(options.code);
  if (session) {
    const entry = { url: urls.imageUrl, full: urls.fullUrl, thumbnail: urls.thumbUrl, page: urls.pageUrl, ts: Date.now() };
    session.photos.push(entry);
    io.to(session.code).emit('photo-ready', { ...entry, total: session.photos.length });
    if (session.displaySocket) {
      io.to(session.displaySocket).emit('capture-result', { ...urls, meta });
    }
  }

  return { finalName: names.final, meta, urls };
}

// Upload da moldura PNG
app.post('/api/frame/:code', upload.single('frame'), (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Arquivo ausente' });

  const ratio = req.body.aspectRatio === '4:3' ? '4:3' : '3:4';
  session.frames[ratio] = { data: req.file.buffer.toString('base64'), mime: req.file.mimetype };

  io.to(session.code).emit('frame-updated', {
    aspectRatio: ratio,
    frameUrl: `/api/frame/${session.code}?ratio=${encodeURIComponent(ratio)}&t=${Date.now()}`,
  });
  res.json({ success: true });
});

app.delete('/api/frame/:code', (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  const ratio = req.query.ratio === '4:3' ? '4:3' : '3:4';
  session.frames[ratio] = null;
  io.to(session.code).emit('frame-updated', { aspectRatio: ratio, frameUrl: null });
  res.json({ success: true });
});

app.get('/api/frame/:code', (req, res) => {
  const session = sessions.get(normalizeCode(req.params.code) || '');
  if (!session) return res.status(404).send('Sessão não encontrada');
  const frame = session.frames[req.query.ratio === '4:3' ? '4:3' : '3:4'];
  if (!frame) return res.status(404).send('Sem moldura');
  res.set('Content-Type', frame.mime || 'image/png');
  res.send(Buffer.from(frame.data, 'base64'));
});

app.get('/api/photos/:code', (req, res) => {
  const session = sessions.get(normalizeCode(req.params.code) || '');
  res.json({ photos: session?.photos || [] });
});

app.get('/api/session/:code', (req, res) => {
  const session = sessions.get(normalizeCode(req.params.code) || '');
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  res.json({
    code: session.code,
    settings: session.settings,
    hasDisplay: !!session.displaySocket,
    hasCamera: !!session.cameraSocket,
    hasControl: !!session.controlSocket,
    photoCount: session.photos.length,
  });
});

app.get('/photo/:filename', (req, res) => {
  const filename = safeBasename(req.params.filename, '');
  if (!filename || !fs.existsSync(path.join(PHOTO_DIRS.final, filename))) {
    return res.status(404).send('Foto não encontrada');
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDownloadPage(filename));
});

app.get('/download/:filename', (req, res) => {
  const filename = safeBasename(req.params.filename, '');
  const finalPath = path.join(PHOTO_DIRS.final, filename);
  if (!filename || !fs.existsSync(finalPath)) return res.status(404).send('Foto não encontrada');
  res.download(finalPath, `globo_foto_${Date.now()}.jpg`);
});

// Erros do multer (arquivo grande demais, campo errado) viram JSON legível
// em vez de um stack de 500 na cara do operador.
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Arquivo maior que ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` });
  }
  console.error('Erro na requisição:', err.message);
  res.status(500).json({ error: err.message || 'Erro interno' });
});

/* ═══════════════════════════════════════════════════════════
   SOCKET.IO

   Três papéis por sessão:
     display — a tela grande (preview + contagem + QR)
     camera  — o celular que captura e transmite o preview via WebRTC
     control — o disparo remoto (pode ser um segundo aparelho)

   A sessão sobrevive a qualquer desconexão; só morre após 24h parada.
   ═══════════════════════════════════════════════════════════ */

const io = new Server(server, {
  maxHttpBufferSize: 12e6,
  pingTimeout: 25000,
});

function sessionSnapshot(session) {
  return {
    code: session.code,
    settings: session.settings,
    hasDisplay: !!session.displaySocket,
    hasCamera: !!session.cameraSocket,
    hasControl: !!session.controlSocket,
    cameraInfo: session.cameraInfo,
    hasFrame3x4: !!session.frames['3:4'],
    hasFrame4x3: !!session.frames['4:3'],
    photoCount: session.photos.length,
  };
}

function broadcastPresence(session) {
  io.to(session.code).emit('presence', sessionSnapshot(session));
}

io.on('connection', socket => {
  /* ── Display: cria ou reassume a sessão ── */
  socket.on('create-session', ({ requestedCode } = {}, cb = () => {}) => {
    const requested = normalizeCode(requestedCode);
    let session = requested ? sessions.get(requested) : null;

    if (!session) {
      const code = requested && !sessions.has(requested) ? requested : generateCode();
      session = {
        code,
        displaySocket: null,
        controlSocket: null,
        cameraSocket: null,
        cameraInfo: null,
        photos: [],
        settings: { timer: 3, aspectRatio: '3:4', shutterLeadMs: 250, flashMode: 'off' },
        frames: { '3:4': null, '4:3': null },
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };
      sessions.set(code, session);
      console.log('Sessão criada:', code);
    } else {
      console.log('Display reassumiu a sessão:', session.code);
    }

    session.displaySocket = socket.id;
    session.lastActivity = Date.now();
    socket.join(session.code);
    socket.sessionCode = session.code;
    socket.role = 'display';

    cb({ code: session.code, rejoined: !!requested && !!sessions.get(requested), ...sessionSnapshot(session) });
    broadcastPresence(session);

    // Se o celular já estava transmitindo, refaz a negociação com o novo display.
    if (session.cameraSocket) io.to(session.cameraSocket).emit('display-ready');
  });

  /* ── Control / Camera: entra numa sessão existente ── */
  socket.on('join-session', (payload, cb = () => {}) => {
    const raw = typeof payload === 'string' ? { code: payload, role: 'control' } : payload || {};
    const session = getSession(raw.code);
    if (!session) return cb({ error: 'Código inválido' });

    const role = raw.role === 'camera' ? 'camera' : 'control';
    socket.join(session.code);
    socket.sessionCode = session.code;
    socket.role = role;

    if (role === 'camera') {
      session.cameraSocket = socket.id;
      session.cameraInfo = raw.info || null;
      console.log('Câmera conectada:', session.code, raw.info?.label || '');
      if (session.displaySocket) io.to(session.displaySocket).emit('camera-connected', { info: session.cameraInfo });
    } else {
      session.controlSocket = socket.id;
      console.log('Controle conectado:', session.code);
      if (session.displaySocket) io.to(session.displaySocket).emit('controller-connected');
    }

    cb({ success: true, ...sessionSnapshot(session) });
    if (session.photos.length) socket.emit('session-photos', { photos: session.photos });
    broadcastPresence(session);

    if (role === 'camera' && session.displaySocket) socket.emit('display-ready');
  });

  /* ── Sinalização WebRTC (celular ⇄ tela do totem) ── */
  socket.on('webrtc-signal', ({ code, to, data } = {}) => {
    const session = getSession(code);
    if (!session || !data) return;
    const target = to === 'camera' ? session.cameraSocket : session.displaySocket;
    if (!target) return;
    io.to(target).emit('webrtc-signal', { from: socket.role || (to === 'camera' ? 'display' : 'camera'), data });
  });

  /* ── Disparo: controle/display pede, display faz a contagem ── */
  socket.on('trigger-capture', ({ code, timer } = {}) => {
    const session = getSession(code);
    if (!session?.displaySocket) return;
    // Vai para a sala inteira: o display conduz a contagem e o celular
    // acompanha, acendendo a lanterna a tempo da exposição estabilizar.
    io.to(session.code).emit('start-countdown', { timer: timer || session.settings.timer });
  });

  /* ── Fim da contagem: o display manda o celular bater a foto ── */
  socket.on('camera-shoot', ({ code, aspectRatio, flashMode } = {}) => {
    const session = getSession(code);
    if (!session?.cameraSocket) return;
    io.to(session.cameraSocket).emit('camera-shoot', {
      aspectRatio: aspectRatio || session.settings.aspectRatio,
      flashMode: flashMode || session.settings.flashMode,
    });
  });

  /* ── Estado da captura no celular (para display e controle acompanharem) ── */
  socket.on('camera-status', ({ code, status, detail } = {}) => {
    const session = getSession(code);
    if (session) io.to(session.code).emit('camera-status', { status, detail });
  });

  /* ── Capacidades/telemetria do celular (resolução, bateria, torch…) ── */
  socket.on('camera-state', ({ code, state } = {}) => {
    const session = getSession(code);
    if (!session) return;
    session.cameraInfo = { ...(session.cameraInfo || {}), ...state };
    io.to(session.code).emit('camera-state', { state: session.cameraInfo });
  });

  /* ── Controles do celular vindos do controle remoto (torch, zoom, foco…) ── */
  socket.on('camera-control', ({ code, cmd } = {}) => {
    const session = getSession(code);
    if (session?.cameraSocket) io.to(session.cameraSocket).emit('camera-control', { cmd });
  });

  socket.on('update-settings', ({ code, settings } = {}) => {
    const session = getSession(code);
    if (!session || !settings) return;
    Object.assign(session.settings, settings);
    io.to(session.code).emit('settings-updated', session.settings);
  });

  socket.on('show-photo', ({ code, url } = {}) => {
    const session = getSession(code);
    if (session?.displaySocket) io.to(session.displaySocket).emit('show-photo', { url });
  });

  socket.on('reset-to-preview', ({ code } = {}) => {
    const session = getSession(code);
    if (session?.displaySocket) io.to(session.displaySocket).emit('reset-to-preview');
  });

  /* ── Filtros/ajustes visuais do preview do totem ── */
  socket.on('cam-control', ({ code, cmd } = {}) => {
    const session = getSession(code);
    if (!session || !cmd) return;
    socket.to(session.code).emit('cam-control', { cmd });
  });

  /* ── Desconexão: nunca apaga a sessão ── */
  socket.on('disconnect', () => {
    const session = sessions.get(socket.sessionCode || '');
    if (!session) return;

    if (session.displaySocket === socket.id) {
      session.displaySocket = null;
      if (session.controlSocket) io.to(session.controlSocket).emit('display-disconnected');
      if (session.cameraSocket) io.to(session.cameraSocket).emit('display-disconnected');
    } else if (session.controlSocket === socket.id) {
      session.controlSocket = null;
      if (session.displaySocket) io.to(session.displaySocket).emit('controller-disconnected');
    } else if (session.cameraSocket === socket.id) {
      session.cameraSocket = null;
      session.cameraInfo = null;
      if (session.displaySocket) io.to(session.displaySocket).emit('camera-disconnected');
    }
    broadcastPresence(session);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (now - (session.lastActivity || session.createdAt) > SESSION_TTL_MS) {
      sessions.delete(code);
      console.log('Sessão expirada:', code);
    }
  }
}, 30 * 60 * 1000);

/* ═══════════════════════════════════════════════════════════
   BOOT — HTTP + HTTPS

   O celular só libera getUserMedia em contexto seguro. Em rede local
   isso significa HTTPS, então geramos um certificado autoassinado na
   primeira execução (o Chrome pede "Avançar" uma vez e depois trata a
   origem como segura).
   ═══════════════════════════════════════════════════════════ */

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

function loadOrCreateCert() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch {
    return null;
  }

  const hosts = ['localhost', '127.0.0.1', ...lanAddresses()];
  const pems = selfsigned.generate([{ name: 'commonName', value: hosts[2] || 'localhost' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: hosts.map(h => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h })),
      },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('Certificado autoassinado gerado em certs/');
  return { key: pems.private, cert: pems.cert };
}

ensurePhotoDirs();

server.listen(PORT, () => {
  const lan = lanAddresses();
  console.log('\n🎬  Globo Photo Booth');
  console.log(`   HTTP   http://localhost:${PORT}`);
  lan.forEach(ip => console.log(`          http://${ip}:${PORT}`));

  if (!ENABLE_HTTPS) {
    console.log('\n   HTTPS desativado (ENABLE_HTTPS=false).\n');
    return;
  }

  const creds = loadOrCreateCert();
  if (!creds) {
    console.log('\n   HTTPS indisponível: rode `npm install` para instalar "selfsigned".');
    console.log('   Sem HTTPS o celular não libera a câmera pela rede local.\n');
    return;
  }

  const secure = https.createServer(creds, app);
  io.attach(secure);
  secure.listen(HTTPS_PORT, () => {
    console.log(`\n   HTTPS  https://localhost:${HTTPS_PORT}`);
    lan.forEach(ip => console.log(`          https://${ip}:${HTTPS_PORT}   ← use esta no celular`));
    console.log('\n   Totem:   /display.html      Celular-câmera: /camera.html');
    console.log('   Controle: /control.html\n');
  });
});
