/* ══════════════════════════════════════════════════════════
   STORE — estado da sessão

   Guarda só o que é durável: código, settings, moldura e lista de
   fotos. Quem está conectado (totem, celular, controle) NÃO fica aqui:
   presença é derivada das salas do Socket.IO, que o adapter do Redis já
   sincroniza entre instâncias. Isso evita ids de socket obsoletos toda
   vez que uma função serverless recicla.

   memory  Map local, para o servidor persistente do evento
   redis   JSON por chave, para as funções da Vercel
   ══════════════════════════════════════════════════════════ */

const { config } = require('./config');

const CODE_RE = /^[A-Z0-9]{4}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0, 1

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function newSession(code) {
  return {
    code,
    settings: { timer: 3, aspectRatio: '3:4', shutterLeadMs: 250, flashMode: 'off' },
    frames: { '3:4': null, '4:3': null },
    photos: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

/* ── Driver: memória ────────────────────────────────────── */

function memoryStore() {
  const sessions = new Map();
  const records = new Map();
  const presence = new Map(); // `${code}:${role}` -> Set<socketId>

  setInterval(() => {
    const now = Date.now();
    for (const [code, session] of sessions) {
      if (now - session.lastActivity > config.sessionTtlMs) sessions.delete(code);
    }
    for (const [id, entry] of records) {
      if (now > entry.expiresAt) records.delete(id);
    }
  }, 30 * 60 * 1000).unref?.();

  return {
    kind: 'memory',
    async has(code) { return sessions.has(code); },
    async get(code) { return sessions.get(code) || null; },
    async put(session) {
      session.lastActivity = Date.now();
      sessions.set(session.code, session);
      return session;
    },
    async touch(code) {
      const session = sessions.get(code);
      if (session) session.lastActivity = Date.now();
    },
    async putRecord(id, value) {
      records.set(id, { value, expiresAt: Date.now() + config.sessionTtlMs });
    },
    async getRecord(id) {
      const entry = records.get(id);
      return entry && Date.now() <= entry.expiresAt ? entry.value : null;
    },
    async addPresence(code, role, id) {
      const key = `${code}:${role}`;
      if (!presence.has(key)) presence.set(key, new Set());
      presence.get(key).add(id);
    },
    async removePresence(code, role, id) {
      presence.get(`${code}:${role}`)?.delete(id);
    },
    async getPresence(code) {
      return {
        hasDisplay: (presence.get(`${code}:display`)?.size || 0) > 0,
        hasCamera: (presence.get(`${code}:camera`)?.size || 0) > 0,
        hasControl: (presence.get(`${code}:control`)?.size || 0) > 0,
      };
    },
    async close() {},
  };
}

/* ── Driver: Redis ──────────────────────────────────────── */

function redisStore(client) {
  const key = code => `booth:session:${code}`;
  const ttl = Math.ceil(config.sessionTtlMs / 1000);

  return {
    kind: 'redis',
    async has(code) { return (await client.exists(key(code))) === 1; },
    async get(code) {
      const raw = await client.get(key(code));
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async put(session) {
      session.lastActivity = Date.now();
      // O TTL do Redis substitui a varredura periódica: sessão parada
      // por 24h simplesmente expira.
      await client.set(key(session.code), JSON.stringify(session), { EX: ttl });
      return session;
    },
    async touch(code) {
      await client.expire(key(code), ttl);
    },
    // Registro por foto: a página do QR precisa das URLs mesmo depois
    // de a sessão do evento acabar.
    async putRecord(id, value) {
      await client.set(`booth:photo:${id}`, JSON.stringify(value), { EX: ttl });
    },
    async getRecord(id) {
      const raw = await client.get(`booth:photo:${id}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },

    /* Presença em conjuntos no Redis, e não via fetchSockets() do
       Socket.IO: aquilo é um broadcast com timeout para todas as
       instâncias, e uma instância lenta faz a presença inteira virar
       "ninguém aqui". Aqui são três SCARD, exatos e baratos. */
    async addPresence(code, role, id) {
      const key = `booth:presence:${code}:${role}`;
      await client.sAdd(key, id);
      await client.expire(key, ttl);
    },
    async removePresence(code, role, id) {
      await client.sRem(`booth:presence:${code}:${role}`, id);
    },
    async getPresence(code) {
      const [display, camera, control] = await Promise.all([
        client.sCard(`booth:presence:${code}:display`),
        client.sCard(`booth:presence:${code}:camera`),
        client.sCard(`booth:presence:${code}:control`),
      ]);
      return { hasDisplay: display > 0, hasCamera: camera > 0, hasControl: control > 0 };
    },
    async close() { await client.quit().catch(() => {}); },
  };
}

/* ── Fábrica ────────────────────────────────────────────── */

let store = null;
let redisClients = null;

async function initStore() {
  if (store) return store;

  if (config.stateDriver !== 'redis') {
    store = memoryStore();
    return store;
  }

  if (!config.redisUrl) {
    throw new Error(
      'STATE_DRIVER=redis mas REDIS_URL não está definida. ' +
      'Crie um Redis no Marketplace da Vercel e conecte-o ao projeto.'
    );
  }

  const { createClient } = require('redis');
  const base = createClient({ url: config.redisUrl });
  base.on('error', err => console.error('Redis:', err.message));
  await base.connect();

  // O adapter do Socket.IO precisa de duas conexões dedicadas: uma
  // inscrita em pub/sub não pode servir comandos comuns.
  const pub = base.duplicate();
  const sub = base.duplicate();
  pub.on('error', err => console.error('Redis pub:', err.message));
  sub.on('error', err => console.error('Redis sub:', err.message));
  await Promise.all([pub.connect(), sub.connect()]);

  redisClients = { pub, sub };
  store = redisStore(base);
  return store;
}

function getStore() {
  if (!store) throw new Error('Store não inicializada — chame initStore() antes.');
  return store;
}

function getRedisClients() {
  return redisClients;
}

/** Código único; com Redis, o SET NX evita colisão entre instâncias. */
async function generateCode() {
  const current = getStore();
  for (let attempt = 0; attempt < 40; attempt++) {
    const code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    if (!(await current.has(code))) return code;
  }
  throw new Error('Não foi possível gerar um código livre');
}

module.exports = { initStore, getStore, getRedisClients, generateCode, normalizeCode, newSession, CODE_RE };
