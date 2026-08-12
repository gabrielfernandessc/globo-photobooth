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

/**
 * STUN só descobre o endereço público; quando não existe rota direta
 * entre os dois aparelhos, quem fecha a conexão é um TURN, que relaya a
 * mídia. Sem TURN, celular no 4G contra totem no Wi-Fi simplesmente não
 * conecta — e Wi-Fi de convidado costuma ter isolamento de cliente, que
 * bloqueia P2P mesmo na mesma rede.
 */
function buildIceServers() {
  const list = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map(s => s.trim()).filter(Boolean);

  const servers = list.length ? [{ urls: list }] : [];

  const turnUrls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }

  return { servers, hasTurn: turnUrls.length > 0 };
}

/**
 * No totem o estado vai para SQLite: um arquivo em disco ao lado das
 * fotos, que sobrevive a restart e a queda de energia. Redis continua
 * existindo só para a Vercel, onde não há filesystem durável — e lá ele
 * não está no caminho crítico da captura.
 */
function pickStateDriver() {
  if (process.env.STATE_DRIVER) return process.env.STATE_DRIVER;
  if (!isVercel) return 'sqlite';
  return process.env.REDIS_URL ? 'redis' : 'memory';
}

const stateDriver = pickStateDriver();
const storageDriver = process.env.STORAGE_DRIVER || (isVercel ? 'blob' : 'local');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

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

  // Onde a página pública da foto mora. Sem isto o totem funciona
  // igual, só que o QR aponta para o próprio servidor na LAN.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,

  /* Publicação na internet — fora do caminho crítico da foto.
     Nada aqui pode fazer uma captura falhar. */
  cloud: {
    driver: process.env.CLOUD_DRIVER
      || (process.env.BLOB_READ_WRITE_TOKEN && process.env.PUBLIC_BASE_URL ? 'vercel-blob' : 'none'),
    timeoutMs: int(process.env.CLOUD_TIMEOUT_MS, 30_000),
    pollMs: int(process.env.CLOUD_POLL_MS, 5_000),
    batchSize: clamp(int(process.env.CLOUD_BATCH, 2), 1, 10),
    retryBaseMs: int(process.env.CLOUD_RETRY_BASE_MS, 5_000),
    // Teto para a fila continuar batendo de minuto em minuto enquanto a
    // internet não volta, em vez de dormir por horas.
    retryMaxMs: int(process.env.CLOUD_RETRY_MAX_MS, 60_000),
    maxAttempts: int(process.env.CLOUD_MAX_ATTEMPTS, 12),
  },

  ice: buildIceServers(),

  /* Preview relayado pelo servidor: o plano B quando o WebRTC não fecha
     conexão (4G do celular contra Wi-Fi do totem, ou rede de convidado
     com isolamento de cliente). Passa por onde os dois já conversam, o
     que o torna independente da topologia da rede — ao custo de banda.
     Não afeta a foto: aquela sobe por HTTPS, em resolução máxima. */
  relay: {
    width: int(process.env.RELAY_WIDTH, 640),
    fps: clamp(int(process.env.RELAY_FPS, 8), 1, 20),
    quality: clamp(int(process.env.RELAY_QUALITY, 50), 20, 90) / 100,
    // Quanto esperar o WebRTC antes de assumir que não vai fechar.
    fallbackAfterMs: int(process.env.RELAY_FALLBACK_MS, 8000),
  },

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
  // Sobrescrevível para que os testes escrevam num diretório temporário
  // em vez de sujarem as fotos do evento.
  uploadsDir: process.env.UPLOADS_DIR || path.join(PUBLIC_DIR, 'uploads'),

  dataDir: DATA_DIR,
  // O banco mora junto das fotos: copiar a pasta do evento leva tudo.
  databaseFile: process.env.DATABASE_FILE || path.join(DATA_DIR, 'booth.sqlite'),
};

module.exports = { config, int, clamp, bool };
