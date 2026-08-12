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

const crypto = require('crypto');
const { config } = require('./config');

const CODE_RE = /^[A-Z0-9]{4}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0, 1

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function newSession(code, eventId = 'efemero') {
  return {
    code,
    eventId,
    settings: { timer: 3, aspectRatio: '3:4', shutterLeadMs: 250, flashMode: 'off' },
    // Só usados pelo driver em memória: no SQLite moldura e fotos têm
    // tabela própria, e a sessão guarda apenas os settings.
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

/* ── Driver: SQLite ─────────────────────────────────────
   O do evento. A sessão vira uma linha em disco, então reiniciar o
   servidor no meio da festa não apaga settings, moldura nem histórico.

   Presença continua em memória de propósito: quem está conectado agora é
   efêmero por definição e morre junto com o socket. Num servidor local
   único não há segunda instância para sincronizar. */

function sqliteStore(repo) {
  const presence = new Map(); // `${code}:${role}` -> Set<socketId>

  return {
    kind: 'sqlite',
    repo,
    async has(code) { return repo.hasSession(code); },
    async get(code) { return repo.getSession(code); },
    async put(session) {
      return repo.putSession(session);
    },
    async touch(code) { repo.touchSession(code); },

    /* O registro por foto virou a tabela photos, e quem a consulta é o
       app através do repo — as chaves de arquivo viram URL lá, que é
       onde essa tradução pertence. Estes dois ficam inertes de propósito
       para o driver continuar cumprindo a mesma interface. */
    async putRecord() {},
    async getRecord() { return null; },

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
    async close() { repo.close(); },
  };
}

/* ── Fábrica ────────────────────────────────────────────── */

let store = null;
let redisClients = null;
let repository = null;

async function initStore() {
  if (store) return store;

  if (config.stateDriver === 'sqlite') {
    const { createRepository } = require('./db');
    repository = createRepository(config.databaseFile);
    store = sqliteStore(repository);
    return store;
  }

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

/** O banco do evento, ou null nos modos sem persistência local. */
function getRepo() {
  return repository;
}

/** Fecha tudo — usado pelos testes e pelo desligamento limpo. */
async function closeStore() {
  await store?.close();
  store = null;
  repository = null;
  redisClients = null;
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

/* ══════════════════════════════════════════════════════════
   TOKEN DE SESSÃO ASSINADO

   Numa função serverless sem Redis, a sessão criada numa instância não
   existe na que atende o upload — e a autorização por consulta ao store
   falha com "sessão não encontrada". Um HMAC resolve isso sem estado:
   qualquer instância verifica a assinatura, porque a chave vem de uma
   variável de ambiente que todas compartilham.

   Isso cobre o caminho crítico (capturar e publicar a foto). Salas,
   moldura e telão continuam precisando do Redis — mas o app autônomo
   não depende de nada disso.
   ══════════════════════════════════════════════════════════ */

let cachedKey = null;

function sessionKey() {
  if (cachedKey) return cachedKey;
  // O token do Blob já é secreto e existe em toda instância; derivar
  // dele evita exigir mais uma variável de ambiente na configuração.
  const material = process.env.SESSION_SECRET || config.blobToken || 'globo-photobooth-local';
  cachedKey = crypto.createHmac('sha256', material).update('session-token-v1').digest();
  return cachedKey;
}

function signCode(code) {
  const sig = crypto.createHmac('sha256', sessionKey()).update(code).digest('base64url').slice(0, 24);
  return `${code}.${sig}`;
}

/** Devolve o código quando a assinatura confere; null caso contrário. */
function verifySignedCode(token) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot < 0) return null;

  const code = normalizeCode(raw.slice(0, dot));
  if (!code) return null;

  const provided = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(signCode(code).slice(code.length + 1));
  if (provided.length !== expected.length) return null;
  return crypto.timingSafeEqual(provided, expected) ? code : null;
}

module.exports = {
  initStore, getStore, getRepo, closeStore, getRedisClients, generateCode, normalizeCode, newSession,
  signCode, verifySignedCode, CODE_RE,
};
