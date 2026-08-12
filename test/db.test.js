/* ══════════════════════════════════════════════════════════
   DB — o que precisa sobreviver a um restart no meio do evento
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepository, SHARE } = require('../lib/db');

function repoTemporario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-db-'));
  const file = path.join(dir, 'booth.sqlite');
  return { file, dir, repo: createRepository(file), limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function fotoDeTeste(overrides = {}) {
  return {
    id: `123_3x4_${Math.random().toString(16).slice(2, 10)}`,
    eventId: 'evt-1',
    sessionCode: 'AB3D',
    capturedAt: Date.now(),
    keys: { final: 'final/a.jpg', web: 'web/a.jpg', thumb: 'thumb/a.jpg', original: 'original/a.jpg' },
    meta: { finalWidth: 3000, finalHeight: 4000 },
    ...overrides,
  };
}

test('o esquema é criado do zero e a migração é idempotente', () => {
  const { file, repo, limpar } = repoTemporario();
  try {
    repo.close();
    // Reabrir não deve tentar migrar de novo.
    const outra = createRepository(file);
    assert.equal(outra.kind, 'sqlite');
    outra.close();
  } finally {
    limpar();
  }
});

test('o evento em aberto é reaproveitado, não duplicado', () => {
  const { repo, limpar } = repoTemporario();
  try {
    const primeiro = repo.currentEvent();
    const segundo = repo.currentEvent();
    assert.equal(primeiro.id, segundo.id, 'duas chamadas deveriam devolver o mesmo evento');

    repo.endEvent(primeiro.id);
    assert.notEqual(repo.currentEvent().id, primeiro.id, 'encerrado o evento, o próximo é novo');
  } finally {
    limpar();
  }
});

test('sessão, moldura e fotos sobrevivem ao fechamento do banco', () => {
  const { file, repo, limpar } = repoTemporario();
  try {
    const evento = repo.currentEvent();
    repo.putSession({ code: 'AB3D', eventId: evento.id, settings: { timer: 5, aspectRatio: '4:3' } });
    repo.putFrame('AB3D', '3:4', 'image/png', Buffer.from([137, 80, 78, 71]));

    const foto = fotoDeTeste({ eventId: evento.id });
    repo.insertPhoto(foto);
    repo.enqueueShare(foto.id);
    repo.close();

    // Isto é o restart do servidor no meio do evento.
    const depois = createRepository(file);

    const sessao = depois.getSession('AB3D');
    assert.equal(sessao.settings.timer, 5);
    assert.equal(sessao.settings.aspectRatio, '4:3');

    const moldura = depois.getFrame('AB3D', '3:4');
    assert.ok(moldura, 'a moldura do evento sumiu');
    assert.deepEqual([...moldura.bytes], [137, 80, 78, 71]);

    const recuperada = depois.getPhoto(foto.id);
    assert.equal(recuperada.keys.final, 'final/a.jpg');
    assert.equal(recuperada.meta.finalWidth, 3000);

    assert.equal(depois.photosOfSession('AB3D').length, 1);
    assert.equal(depois.countPhotos(evento.id), 1);

    // E a publicação pendente continua na fila.
    assert.equal(depois.dueShareJobs().length, 1, 'a fila de publicação foi perdida no restart');
    depois.close();
  } finally {
    limpar();
  }
});

test('a fila só entrega trabalho que já venceu', () => {
  const { repo, limpar } = repoTemporario();
  try {
    const evento = repo.currentEvent();
    const agora = fotoDeTeste({ eventId: evento.id });
    const depois = fotoDeTeste({ eventId: evento.id });

    repo.insertPhoto(agora);
    repo.insertPhoto(depois);
    repo.enqueueShare(agora.id);
    repo.enqueueShare(depois.id, { delayMs: 60_000 });

    const vencidos = repo.dueShareJobs(10);
    assert.equal(vencidos.length, 1);
    assert.equal(vencidos[0].photoId, agora.id);

    // Adiantando o relógio, o segundo aparece.
    assert.equal(repo.dueShareJobs(10, Date.now() + 61_000).length, 2);
  } finally {
    limpar();
  }
});

test('enfileirar a mesma foto duas vezes não cria trabalho duplicado', () => {
  const { repo, limpar } = repoTemporario();
  try {
    const evento = repo.currentEvent();
    const foto = fotoDeTeste({ eventId: evento.id });
    repo.insertPhoto(foto);

    repo.enqueueShare(foto.id);
    repo.enqueueShare(foto.id);

    assert.equal(repo.dueShareJobs(10).length, 1);
  } finally {
    limpar();
  }
});

test('publicar marca a foto e tira da fila; falhar reagenda', () => {
  const { repo, limpar } = repoTemporario();
  try {
    const evento = repo.currentEvent();
    const foto = fotoDeTeste({ eventId: evento.id });
    repo.insertPhoto(foto);
    repo.enqueueShare(foto.id);

    repo.markShare(foto.id, SHARE.FAILED, { attempts: 3, error: 'timeout' });
    assert.equal(repo.dueShareJobs(10).length, 0, 'trabalho falho não deveria voltar sozinho');
    assert.equal(repo.getShareJob(foto.id).lastError, 'timeout');

    // O operador manda tentar de novo.
    repo.retryFailedShares();
    assert.equal(repo.dueShareJobs(10).length, 1);
    assert.equal(repo.getShareJob(foto.id).lastError, null);

    repo.markShare(foto.id, SHARE.PUBLISHED, { attempts: 4 });
    repo.setPublicUrl(foto.id, 'https://exemplo.com/foto.jpg');

    assert.equal(repo.dueShareJobs(10).length, 0);
    assert.equal(repo.getPhoto(foto.id).publicUrl, 'https://exemplo.com/foto.jpg');
    assert.deepEqual(repo.shareStats(), { pending_sync: 0, published: 1, failed: 0, skipped: 0 });
  } finally {
    limpar();
  }
});

test('as configurações do totem persistem entre execuções', () => {
  const { file, repo, limpar } = repoTemporario();
  try {
    repo.putSetting('aspectRatio', '4:3');
    repo.putSetting('timer', 5);
    repo.close();

    const depois = createRepository(file);
    assert.equal(depois.getSetting('aspectRatio'), '4:3');
    assert.equal(depois.getSetting('timer'), 5);
    assert.equal(depois.getSetting('inexistente', 'padrão'), 'padrão');
    depois.close();
  } finally {
    limpar();
  }
});

test('as fotos de um evento saem da mais recente para a mais antiga', () => {
  const { repo, limpar } = repoTemporario();
  try {
    const evento = repo.currentEvent();
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      repo.insertPhoto(fotoDeTeste({ eventId: evento.id, capturedAt: base + i * 1000 }));
    }

    const fotos = repo.photosOfEvent(evento.id, 3);
    assert.equal(fotos.length, 3);
    assert.ok(fotos[0].capturedAt > fotos[1].capturedAt);
  } finally {
    limpar();
  }
});
