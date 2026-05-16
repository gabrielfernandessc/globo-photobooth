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

const os = require('os');

const sessions = new Map();
const APP_UPDATED_AT = '2026-05-13T23:03:56-03:00';
const FINAL_JPEG_QUALITY = 100;
const QA_API_BASE = (process.env.QA_API_BASE || 'https://api.queroapoiar.com.br').replace(/\/+$/, '');
const APOIO_MISSAO_KEYWORDS = ['missao', 'missão'];
const QA_PUBLIC_BASE = 'https://queroapoiar.com.br';

const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'Globo-Photobooth');

const PHOTO_DIRS = {
  uploads: path.join(__dirname, 'public', 'uploads'),
  original: path.join(__dirname, 'public', 'uploads', 'original'),
  final: path.join(__dirname, 'public', 'uploads', 'final'),
  downloads: DOWNLOADS_DIR,
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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function pickFirst(source, keys, fallback = null) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== '') return source[key];
  }
  return fallback;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return 0;
    const normalized = raw
      .replace(/[R$\s]/gi, '')
      .replace(/\.(?=\d{3}(\D|$))/g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function ensureHttpUrl(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${QA_PUBLIC_BASE}${text}`;
  if (/^[a-z0-9-]+$/i.test(text)) return `${QA_PUBLIC_BASE}/${text}`;
  return null;
}

function listFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.items,
    payload.data,
    payload.results,
    payload.rows,
    payload.candidatos,
    payload.campaigns,
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function isMissaoParty(candidate) {
  const label = [
    pickFirst(candidate, ['partido', 'siglaPartido', 'partidoSigla', 'party']),
    pickFirst(candidate?.campanha || {}, ['partido', 'siglaPartido', 'partidoSigla', 'party']),
  ].filter(Boolean).join(' ');
  const party = normalizeText(label);
  return APOIO_MISSAO_KEYWORDS.some(keyword => party.includes(normalizeText(keyword)));
}

function resolveDonationUrl(candidate) {
  const campaign = candidate?.campanha || {};
  const rawUrl = pickFirst(candidate, [
    'linkDoacao',
    'link_doacao',
    'urlDoacao',
    'url_doacao',
    'campanhaUrl',
    'campaignUrl',
    'publicUrl',
    'urlPublica',
    'url',
  ]) || pickFirst(campaign, ['linkDoacao', 'url', 'publicUrl']);
  if (rawUrl) return ensureHttpUrl(rawUrl);
  const slug = pickFirst(candidate, ['slug', 'campanhaSlug']) || pickFirst(campaign, ['slug']);
  return slug ? `${QA_PUBLIC_BASE}/${slug}` : null;
}

function normalizeCandidate(candidate) {
  const campaign = candidate?.campanha || {};
  const metrics = candidate?.metricas || candidate?.metrics || candidate?.resumo || {};
  const donation = candidate?.doacoes || candidate?.donations || {};

  const nome = pickFirst(candidate, ['nomeUrna', 'nome_urna', 'nome', 'name']) || 'Sem nome';
  const totalArrecadado = toNumber(
    pickFirst(candidate, ['totalArrecadado', 'arrecadado', 'valorArrecadado']) ??
    pickFirst(metrics, ['totalArrecadado', 'arrecadado', 'valorArrecadado']) ??
    pickFirst(campaign, ['totalArrecadado', 'arrecadado'])
  );
  const totalDoacoes = toNumber(
    pickFirst(candidate, ['totalDoacoes', 'quantidadeDoacoes', 'qtdDoacoes']) ??
    pickFirst(metrics, ['totalDoacoes', 'quantidadeDoacoes']) ??
    pickFirst(donation, ['total', 'quantidade'])
  );
  const metaArrecadacao = toNumber(
    pickFirst(candidate, ['metaArrecadacao', 'meta', 'goal']) ??
    pickFirst(metrics, ['metaArrecadacao', 'meta']) ??
    pickFirst(campaign, ['metaArrecadacao', 'meta'])
  );

  const percentualMeta = metaArrecadacao > 0
    ? (totalArrecadado / metaArrecadacao) * 100
    : toNumber(pickFirst(candidate, ['percentualMeta']) ?? pickFirst(metrics, ['percentualMeta']));

  return {
    id: pickFirst(candidate, ['cpf', 'id', '_id', 'uuid']) || `cand-${Math.random().toString(36).slice(2, 10)}`,
    cpf: pickFirst(candidate, ['cpf', 'documento', 'document']),
    nome,
    nomeUrna: pickFirst(candidate, ['nomeUrna', 'nome_urna']) || nome,
    partido: pickFirst(candidate, ['partido', 'siglaPartido', 'partidoSigla', 'party']) ||
      pickFirst(campaign, ['partido', 'siglaPartido', 'partidoSigla', 'party']) || null,
    uf: pickFirst(candidate, ['uf', 'estado', 'state']) || pickFirst(campaign, ['uf', 'estado', 'state']) || null,
    cargo: pickFirst(candidate, ['cargoLabel', 'cargo', 'office', 'tituloCargo']) ||
      pickFirst(campaign, ['cargoLabel', 'cargo', 'office']) || null,
    cidade: pickFirst(candidate, ['cidade', 'municipio', 'city']) ||
      pickFirst(campaign, ['cidade', 'municipio', 'city']) || null,
    fotoUrl: ensureHttpUrl(
      pickFirst(candidate, ['fotoUrl', 'foto', 'imagemUrl', 'avatar', 'image']) ||
      pickFirst(campaign, ['fotoUrl', 'imagemUrl', 'avatar'])
    ),
    slug: pickFirst(candidate, ['slug', 'campanhaSlug']) || pickFirst(campaign, ['slug']),
    donationUrl: resolveDonationUrl(candidate),
    totalArrecadado,
    totalDoacoes,
    metaArrecadacao,
    ticketMedio: totalDoacoes > 0 ? totalArrecadado / totalDoacoes : 0,
    percentualMeta: Number.isFinite(percentualMeta) ? percentualMeta : 0,
    status: pickFirst(candidate, ['status', 'situacao']) || pickFirst(campaign, ['status', 'situacao']) || null,
  };
}

async function fetchPartnerJson(url, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`QueroApoiar ${response.status}: ${text.slice(0, 180)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
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

  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Invalid image metadata');

  const width = metadata.width;
  const height = metadata.height;

  const source = sharp(input).rotate().flop();
  const frameBuffer = getSessionFrame(code, aspectRatio);

  let pipeline = source;

  if (frameBuffer) {
    const frame = await sharp(frameBuffer)
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer();
    pipeline = pipeline.composite([{ input: frame, left: 0, top: 0 }]);
  }

  const finalFilename = `globo_final_${Date.now()}_${aspectRatio.replace(':', 'x')}.jpg`;
  const finalPath = path.join(PHOTO_DIRS.final, finalFilename);
  const downloadPath = path.join(PHOTO_DIRS.downloads, finalFilename);

  // Salva no servidor (para o QR Code) de forma assíncrona para não travar
  await pipeline
    .jpeg({ quality: FINAL_JPEG_QUALITY, chromaSubsampling: '4:4:4' })
    .withMetadata()
    .toFile(finalPath);

  // Salva na pasta Downloads em background (sem dar await para não atrasar a resposta da API)
  fs.mkdir(PHOTO_DIRS.downloads, { recursive: true }, () => {
    fs.copyFile(finalPath, downloadPath, (err) => {
      if (err) console.error('Erro ao copiar para Downloads:', err);
    });
  });

  const stat = fs.statSync(finalPath);
  return {
    finalFilename,
    finalPath,
    meta: {
      sourceWidth: width,
      sourceHeight: height,
      finalWidth: width,
      finalHeight: height,
      finalBytes: stat.size,
      format: 'jpeg',
      quality: FINAL_JPEG_QUALITY,
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

app.get('/api/apoio-missao/candidatos', async (req, res) => {
  const apiKey = process.env.QA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'QA_API_KEY não configurada no servidor',
      hint: 'Defina QA_API_KEY no .env antes de usar o painel Apoio Missão',
    });
  }

  try {
    const { uf, cargo, busca, limite = '500' } = req.query;
    const query = new URLSearchParams();
    query.set('limite', String(limite));

    const endpoint = `${QA_API_BASE}/api/parceiros/candidatos?${query.toString()}`;
    const payload = await fetchPartnerJson(endpoint, apiKey);

    const normalized = listFromPayload(payload).map(normalizeCandidate);
    const missaoOnly = normalized.filter(isMissaoParty);
    const hasAnyPartyInfo = normalized.some(candidate => !!candidate.partido);
    const scopedCandidates = missaoOnly.length > 0
      ? missaoOnly
      : (hasAnyPartyInfo ? [] : normalized);

    const ufFilter = normalizeText(uf);
    const cargoFilter = normalizeText(cargo);
    const searchFilter = normalizeText(busca);

    const filtered = scopedCandidates.filter(candidate => {
      if (ufFilter && normalizeText(candidate.uf) !== ufFilter) return false;
      if (cargoFilter && normalizeText(candidate.cargo) !== cargoFilter) return false;
      if (searchFilter) {
        const haystack = normalizeText([
          candidate.nome,
          candidate.nomeUrna,
          candidate.uf,
          candidate.cargo,
          candidate.cidade,
          candidate.slug,
        ].filter(Boolean).join(' '));
        if (!haystack.includes(searchFilter)) return false;
      }
      return true;
    });

    const totals = filtered.reduce((acc, item) => {
      acc.totalArrecadado += item.totalArrecadado;
      acc.totalDoacoes += item.totalDoacoes;
      acc.totalMeta += item.metaArrecadacao;
      return acc;
    }, { totalArrecadado: 0, totalDoacoes: 0, totalMeta: 0 });

    const ufs = [...new Set(scopedCandidates.map(c => c.uf).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
    const cargos = [...new Set(scopedCandidates.map(c => c.cargo).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));

    res.json({
      source: endpoint,
      total: filtered.length,
      filters: {
        uf: uf || null,
        cargo: cargo || null,
        busca: busca || null,
      },
      aggregate: {
        totalArrecadado: totals.totalArrecadado,
        totalDoacoes: totals.totalDoacoes,
        totalMeta: totals.totalMeta,
        percentualMeta: totals.totalMeta > 0 ? (totals.totalArrecadado / totals.totalMeta) * 100 : 0,
      },
      facets: { ufs, cargos },
      items: filtered,
    });
  } catch (error) {
    console.error('Apoio Missão API error:', error.message);
    res.status(502).json({
      error: 'Falha ao buscar dados da API do QueroApoiar',
      detail: error.message,
    });
  }
});

app.get('/apoio-missao', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'apoio-missao', 'index.html'));
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
