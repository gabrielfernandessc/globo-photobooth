/* ══════════════════════════════════════════════════════════
   DB — o disco é a autoridade durante o evento

   Antes disso o estado vivia num Map: fechar o servidor apagava as
   sessões, a lista de fotos do telão e qualquer publicação pendente. Num
   evento de quatro horas, um restart custava o histórico inteiro.

   SQLite embutido no Node (node:sqlite) — sem módulo nativo para
   compilar, sem serviço para subir, sem Redis. Um arquivo ao lado das
   fotos, que sobrevive a queda de energia com WAL.

   O que é durável mora aqui: evento, sessão, moldura, foto e fila de
   publicação. Presença (quem está conectado agora) continua fora: é
   efêmera por natureza e morre junto com o socket.
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/* ── Esquema ─────────────────────────────────────────────
   Migrações por user_version: cada passo roda uma vez e o número
   avança. Nunca reescreva um passo já publicado — acrescente outro. */

const MIGRATIONS = [
  // 1
  `
  CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    ended_at    INTEGER
  );

  CREATE TABLE sessions (
    code          TEXT PRIMARY KEY,
    event_id      TEXT NOT NULL REFERENCES events(id),
    settings      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_activity INTEGER NOT NULL
  );

  CREATE TABLE frames (
    session_code  TEXT NOT NULL,
    aspect_ratio  TEXT NOT NULL,
    mime          TEXT NOT NULL,
    bytes         BLOB NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session_code, aspect_ratio)
  );

  CREATE TABLE photos (
    id            TEXT PRIMARY KEY,
    event_id      TEXT NOT NULL,
    session_code  TEXT,
    captured_at   INTEGER NOT NULL,
    final_key     TEXT NOT NULL,
    web_key       TEXT,
    thumb_key     TEXT,
    original_key  TEXT,
    meta          TEXT NOT NULL,
    public_url    TEXT
  );
  CREATE INDEX idx_photos_event ON photos(event_id, captured_at DESC);
  CREATE INDEX idx_photos_session ON photos(session_code, captured_at);

  -- Fila de publicação. Uma linha por foto; sobrevive a restart, que é
  -- justamente o caso em que a internet costuma ter caído.
  CREATE TABLE share_jobs (
    photo_id        TEXT PRIMARY KEY REFERENCES photos(id),
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_due ON share_jobs(status, next_attempt_at);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

/** Estados possíveis de uma publicação. */
const SHARE = {
  PENDING: 'pending_sync',
  PUBLISHED: 'published',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migração ${v + 1} falhou: ${err.message}`);
    }
  }
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // WAL: leitura não trava escrita, e um corte de energia no meio de uma
  // captura não corrompe o banco.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/* ── Repositório ─────────────────────────────────────────
   Métodos pequenos e explícitos em vez de um ORM: o esquema é curto e a
   clareza do SQL vale mais aqui do que a abstração. */

function createRepository(file) {
  const db = openDatabase(file);
  const json = value => JSON.stringify(value ?? null);
  const parse = raw => {
    try { return JSON.parse(raw); } catch { return null; }
  };

  const stmt = {
    insertEvent: db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)'),
    activeEvent: db.prepare('SELECT * FROM events WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1'),
    endEvent: db.prepare('UPDATE events SET ended_at = ? WHERE id = ?'),

    getSession: db.prepare('SELECT * FROM sessions WHERE code = ?'),
    upsertSession: db.prepare(`
      INSERT INTO sessions (code, event_id, settings, created_at, last_activity)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET settings = excluded.settings, last_activity = excluded.last_activity
    `),
    touchSession: db.prepare('UPDATE sessions SET last_activity = ? WHERE code = ?'),

    getFrame: db.prepare('SELECT * FROM frames WHERE session_code = ? AND aspect_ratio = ?'),
    putFrame: db.prepare(`
      INSERT INTO frames (session_code, aspect_ratio, mime, bytes, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_code, aspect_ratio) DO UPDATE SET
        mime = excluded.mime, bytes = excluded.bytes, updated_at = excluded.updated_at
    `),
    deleteFrame: db.prepare('DELETE FROM frames WHERE session_code = ? AND aspect_ratio = ?'),

    insertPhoto: db.prepare(`
      INSERT INTO photos (id, event_id, session_code, captured_at, final_key, web_key, thumb_key, original_key, meta, public_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `),
    getPhoto: db.prepare('SELECT * FROM photos WHERE id = ?'),
    photosOfSession: db.prepare('SELECT * FROM photos WHERE session_code = ? ORDER BY captured_at ASC'),
    photosOfEvent: db.prepare('SELECT * FROM photos WHERE event_id = ? ORDER BY captured_at DESC LIMIT ?'),
    countPhotos: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE event_id = ?'),
    setPublicUrl: db.prepare('UPDATE photos SET public_url = ? WHERE id = ?'),

    insertJob: db.prepare(`
      INSERT INTO share_jobs (photo_id, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)
      ON CONFLICT(photo_id) DO NOTHING
    `),
    dueJobs: db.prepare(`
      SELECT j.*, p.final_key, p.web_key, p.thumb_key, p.meta
      FROM share_jobs j JOIN photos p ON p.id = j.photo_id
      WHERE j.status = ? AND j.next_attempt_at <= ?
      ORDER BY j.next_attempt_at ASC LIMIT ?
    `),
    updateJob: db.prepare(`
      UPDATE share_jobs SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE photo_id = ?
    `),
    retryFailed: db.prepare(`
      UPDATE share_jobs SET status = ?, next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE status = ?
    `),
    retrySkipped: db.prepare(`
      UPDATE share_jobs SET status = ?, next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE status = ?
    `),
    jobStats: db.prepare('SELECT status, COUNT(*) AS n FROM share_jobs GROUP BY status'),
    getJob: db.prepare('SELECT * FROM share_jobs WHERE photo_id = ?'),

    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    putSetting: db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  };

  const rowToPhoto = row => row && {
    id: row.id,
    eventId: row.event_id,
    sessionCode: row.session_code,
    capturedAt: row.captured_at,
    keys: {
      final: row.final_key,
      web: row.web_key,
      thumb: row.thumb_key,
      original: row.original_key,
    },
    meta: parse(row.meta) || {},
    publicUrl: row.public_url,
  };

  return {
    kind: 'sqlite',
    file,

    /* ── Evento ── */

    /** O evento em aberto, criado na primeira chamada do dia. */
    currentEvent(name = null) {
      const existing = stmt.activeEvent.get();
      if (existing) return { id: existing.id, name: existing.name, createdAt: existing.created_at };

      const now = Date.now();
      const id = new Date(now).toISOString().slice(0, 10) + '-' + Math.random().toString(36).slice(2, 8);
      stmt.insertEvent.run(id, name || `Evento de ${new Date(now).toLocaleDateString('pt-BR')}`, now);
      return { id, name, createdAt: now };
    },

    endEvent(id) {
      stmt.endEvent.run(Date.now(), id);
    },

    /* ── Sessão ── */

    getSession(code) {
      const row = stmt.getSession.get(code);
      if (!row) return null;
      return {
        code: row.code,
        eventId: row.event_id,
        settings: parse(row.settings) || {},
        createdAt: row.created_at,
        lastActivity: row.last_activity,
      };
    },

    putSession(session) {
      const now = Date.now();
      stmt.upsertSession.run(
        session.code,
        session.eventId,
        json(session.settings),
        session.createdAt || now,
        now
      );
      return { ...session, lastActivity: now };
    },

    touchSession(code) {
      stmt.touchSession.run(Date.now(), code);
    },

    hasSession(code) {
      return !!stmt.getSession.get(code);
    },

    /* ── Moldura ── */

    getFrame(code, aspectRatio) {
      const row = stmt.getFrame.get(code, aspectRatio);
      return row && { mime: row.mime, bytes: Buffer.from(row.bytes), updatedAt: row.updated_at };
    },

    putFrame(code, aspectRatio, mime, bytes) {
      stmt.putFrame.run(code, aspectRatio, mime, bytes, Date.now());
    },

    deleteFrame(code, aspectRatio) {
      stmt.deleteFrame.run(code, aspectRatio);
    },

    /* ── Foto ── */

    insertPhoto(photo) {
      stmt.insertPhoto.run(
        photo.id,
        photo.eventId,
        photo.sessionCode || null,
        photo.capturedAt,
        photo.keys.final,
        photo.keys.web || null,
        photo.keys.thumb || null,
        photo.keys.original || null,
        json(photo.meta)
      );
      return photo;
    },

    getPhoto(id) {
      return rowToPhoto(stmt.getPhoto.get(id));
    },

    photosOfSession(code) {
      return stmt.photosOfSession.all(code).map(rowToPhoto);
    },

    photosOfEvent(eventId, limit = 200) {
      return stmt.photosOfEvent.all(eventId, limit).map(rowToPhoto);
    },

    countPhotos(eventId) {
      return stmt.countPhotos.get(eventId)?.n || 0;
    },

    setPublicUrl(id, url) {
      stmt.setPublicUrl.run(url, id);
    },

    /* ── Fila de publicação ── */

    enqueueShare(photoId, { delayMs = 0 } = {}) {
      const now = Date.now();
      stmt.insertJob.run(photoId, SHARE.PENDING, now + delayMs, now, now);
    },

    dueShareJobs(limit = 3, now = Date.now()) {
      return stmt.dueJobs.all(SHARE.PENDING, now, limit).map(row => ({
        photoId: row.photo_id,
        attempts: row.attempts,
        keys: { final: row.final_key, web: row.web_key, thumb: row.thumb_key },
        meta: parse(row.meta) || {},
      }));
    },

    markShare(photoId, status, { attempts = 0, nextAttemptAt = Date.now(), error = null } = {}) {
      stmt.updateJob.run(status, attempts, nextAttemptAt, error, Date.now(), photoId);
    },

    getShareJob(photoId) {
      const row = stmt.getJob.get(photoId);
      return row && {
        photoId: row.photo_id,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
      };
    },

    /** Devolve à fila tudo que desistiu — o botão "tentar de novo". */
    retryFailedShares() {
      stmt.retryFailed.run(SHARE.PENDING, Date.now(), Date.now(), SHARE.FAILED);
    },

    /** Publica o acervo local quando a nuvem é configurada depois. */
    retrySkippedShares() {
      stmt.retrySkipped.run(SHARE.PENDING, Date.now(), Date.now(), SHARE.SKIPPED);
    },

    shareStats() {
      const stats = { pending_sync: 0, published: 0, failed: 0, skipped: 0 };
      for (const row of stmt.jobStats.all()) stats[row.status] = row.n;
      return stats;
    },

    /* ── Configurações ── */

    getSetting(key, fallback = null) {
      const row = stmt.getSetting.get(key);
      return row ? parse(row.value) : fallback;
    },

    putSetting(key, value) {
      stmt.putSetting.run(key, json(value));
    },

    close() {
      db.close();
    },
  };
}

module.exports = { createRepository, openDatabase, SHARE, MIGRATIONS };
