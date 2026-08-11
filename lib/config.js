/* ══════════════════════════════════════════════════════════
   CONFIG — um app, dois destinos

   local   servidor persistente (o PC do totem no evento):
           WebSocket estável, sessões em memória, fotos em disco.

   vercel  funções serverless:
           instâncias não compartilham memória nem filesystem, então
           as sessões vão para o Redis e as fotos para o Blob.

   O driver é detectado pelo ambiente; VERCEL é setado pela própria
   plataforma. Nada precisa ser passado à mão num deploy normal.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const path = require('path');

function int(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

const isVercel = !!process.env.VERCEL;

const stateDriver = process.env.STATE_DRIVER || (process.env.REDIS_URL ? 'redis' : 'memory');
const storageDriver = process.env.STORAGE_DRIVER || (isVercel ? 'blob' : 'local');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const config = {
  isVercel,
  stateDriver,
  storageDriver,

  port: int(process.env.PORT, 3000),
  httpsPort: int(process.env.HTTPS_PORT, 3443),
  // Na Vercel o TLS é da plataforma; gerar certificado seria escrever
  // num filesystem read-only.
  enableHttps: !isVercel && bool(process.env.ENABLE_HTTPS, true),

  // Socket.IO na Vercel só funciona com transporte WebSocket puro e sob
  // um caminho dentro de /api. Ver lib/app.js e o /api/config.
  socketPath: process.env.SOCKET_PATH || (isVercel ? '/api/server/socket.io' : '/socket.io'),

  redisUrl: process.env.REDIS_URL || process.env.KV_URL || null,
  blobToken: process.env.BLOB_READ_WRITE_TOKEN || null,

  quality: {
    final: clamp(int(process.env.FINAL_JPEG_QUALITY, 100), 1, 100),
    web: clamp(int(process.env.WEB_JPEG_QUALITY, 88), 1, 100),
    maxFinalLongSide: int(process.env.MAX_FINAL_LONG_SIDE, 0),
    webLongSide: int(process.env.WEB_LONG_SIDE, 2048),
    thumbLongSide: 480,
  },

  saveOriginal: bool(process.env.SAVE_ORIGINAL, true),
  // Só faz sentido com filesystem de verdade.
  saveToDownloads: !isVercel && bool(process.env.SAVE_TO_DOWNLOADS, true),
  downloadsDir: process.env.DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads', 'Globo-Photobooth'),

  // O corpo de uma request na Vercel é limitado a 4,5 MB, então a foto
  // do celular sobe direto do navegador para o Blob e o servidor só
  // recebe a URL. Fora da Vercel o upload direto é mais simples.
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, isVercel ? 4 : 60) * 1024 * 1024,
  directUpload: isVercel || storageDriver === 'blob',

  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 24) * 60 * 60 * 1000,
  sharpConcurrency: clamp(int(process.env.SHARP_CONCURRENCY, 2), 1, 8),

  publicDir: PUBLIC_DIR,
  uploadsDir: path.join(PUBLIC_DIR, 'uploads'),
};

module.exports = { config, int, clamp, bool };
