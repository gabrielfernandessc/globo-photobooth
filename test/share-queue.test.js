/* ══════════════════════════════════════════════════════════
   FILA DE PUBLICAÇÃO — o teste que decide se o produto é local-first

   Se a internet cair, a foto tem que existir, aparecer e continuar
   pendente. Quando a internet voltar, tem que publicar sozinha. É isso
   que estes testes provam.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_FILE = ':memory:';
process.env.CLOUD_RETRY_BASE_MS = '10';
process.env.CLOUD_RETRY_MAX_MS = '40';
process.env.CLOUD_MAX_ATTEMPTS = '4';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepository, SHARE } = require('../lib/db');
const { createShareQueue, backoffMs } = require('../lib/share-queue');
const { TransientPublishError, PermanentPublishError, nullPublisher } = require('../lib/publisher');

function ambiente(publisher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-queue-'));
  const repo = createRepository(path.join(dir, 'booth.sqlite'));
  const evento = repo.currentEvent();

  const storage = {
    async get(key) {
      if (key.startsWith('final/')) return Buffer.from('bytes-do-master');
      if (key.startsWith('web/')) return Buffer.from('bytes-da-web');
      throw new Error(`chave desconhecida: ${key}`);
    },
  };

  const fila = createShareQueue({ repo, storage, publisher });

  let n = 0;
  function novaFoto() {
    const id = `1700000000_3x4_${(n++).toString(16).padStart(8, '0')}`;
    repo.insertPhoto({
      id,
      eventId: evento.id,
      sessionCode: 'AB3D',
      capturedAt: Date.now(),
      keys: { final: `final/globo_${id}.jpg`, web: `web/globo_${id}_web.jpg`, thumb: null, original: null },
      meta: { finalWidth: 3000, finalHeight: 4000 },
    });
    repo.enqueueShare(id);
    return id;
  }

  return { repo, fila, novaFoto, dir, limpar: () => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Publisher de mentira, com roteiro controlado pelo teste. */
function publisherFalso() {
  const chamadas = [];
  let comportamento = async ({ id }) => ({ publicUrl: `https://exemplo.com/photo/${id}` });

  return {
    kind: 'falso',
    configured: true,
    chamadas,
    define(fn) { comportamento = fn; },
    async check() { return { ok: true }; },
    async publish(args) {
      chamadas.push(args);
      return comportamento(args);
    },
  };
}

test('o backoff cresce e respeita o teto', () => {
  assert.equal(backoffMs(1), 10);
  assert.equal(backoffMs(2), 20);
  assert.equal(backoffMs(3), 40);
  assert.equal(backoffMs(9), 40, 'o teto impede a fila de dormir por horas');
});

test('foto publicada sai da fila e ganha URL pública', async () => {
  const publisher = publisherFalso();
  const { repo, fila, novaFoto, limpar } = ambiente(publisher);
  try {
    const id = novaFoto();

    const { processed } = await fila.tick();
    assert.equal(processed, 1);

    assert.equal(repo.getShareJob(id).status, SHARE.PUBLISHED);
    assert.equal(repo.getPhoto(id).publicUrl, `https://exemplo.com/photo/${id}`);
    assert.equal(repo.shareStats().pending_sync, 0);

    // O master é o que precisa chegar à nuvem.
    assert.equal(publisher.chamadas[0].master.toString(), 'bytes-do-master');
    assert.equal(publisher.chamadas[0].web.toString(), 'bytes-da-web');
  } finally {
    limpar();
  }
});

test('sem internet a foto fica pendente e a próxima captura não é afetada', async () => {
  const publisher = publisherFalso();
  const { repo, fila, novaFoto, limpar } = ambiente(publisher);
  try {
    publisher.define(async () => { throw new TransientPublishError('getaddrinfo ENOTFOUND'); });

    const primeira = novaFoto();
    await fila.tick();

    const job = repo.getShareJob(primeira);
    assert.equal(job.status, SHARE.PENDING, 'a foto deveria continuar aguardando internet');
    assert.equal(job.attempts, 1);
    assert.match(job.lastError, /ENOTFOUND/);

    // O que importa: a foto continua existindo e registrada.
    assert.ok(repo.getPhoto(primeira), 'a foto sumiu porque a nuvem falhou');
    assert.equal(repo.getPhoto(primeira).publicUrl, null);

    // E o totem continua fotografando.
    const segunda = novaFoto();
    assert.ok(repo.getPhoto(segunda));
    assert.equal(repo.shareStats().pending_sync, 2);
  } finally {
    limpar();
  }
});

test('quando a internet volta, a fila publica sozinha o que ficou para trás', async () => {
  const publisher = publisherFalso();
  const { repo, fila, novaFoto, limpar } = ambiente(publisher);
  try {
    publisher.define(async () => { throw new TransientPublishError('rede fora'); });

    const ids = [novaFoto(), novaFoto(), novaFoto()];
    // batchSize padrão é 2, então são precisos dois ticks.
    await fila.tick();
    await fila.tick();
    assert.equal(repo.shareStats().pending_sync, 3, 'nada deveria ter publicado offline');

    // A internet volta.
    publisher.define(async ({ id }) => ({ publicUrl: `https://exemplo.com/photo/${id}` }));
    await new Promise(r => setTimeout(r, 60)); // deixa o backoff vencer

    await fila.tick();
    await fila.tick();

    const stats = repo.shareStats();
    assert.equal(stats.published, 3, `nem tudo publicou: ${JSON.stringify(stats)}`);
    for (const id of ids) {
      assert.ok(repo.getPhoto(id).publicUrl, `foto ${id} ficou sem URL pública`);
    }
  } finally {
    limpar();
  }
});

test('a fila desiste depois do limite, sem tentar para sempre', async () => {
  const publisher = publisherFalso();
  const { repo, fila, novaFoto, limpar } = ambiente(publisher);
  try {
    publisher.define(async () => { throw new TransientPublishError('502 bad gateway'); });
    const id = novaFoto();

    for (let i = 0; i < 8; i++) {
      await fila.tick();
      await new Promise(r => setTimeout(r, 45));
    }

    const job = repo.getShareJob(id);
    assert.equal(job.status, SHARE.FAILED);
    assert.equal(job.attempts, 4, 'deveria parar no limite configurado');

    // Mas a foto continua lá, e o operador pode mandar tentar de novo.
    assert.ok(repo.getPhoto(id));

    publisher.define(async ({ id: photoId }) => ({ publicUrl: `https://exemplo.com/photo/${photoId}` }));
    await fila.retryFailed();
    assert.equal(repo.getShareJob(id).status, SHARE.PUBLISHED);
  } finally {
    limpar();
  }
});

test('credencial recusada não fica em loop de retentativa', async () => {
  const publisher = publisherFalso();
  const { repo, fila, novaFoto, limpar } = ambiente(publisher);
  try {
    publisher.define(async () => { throw new PermanentPublishError('credencial recusada pela nuvem (HTTP 403)'); });
    const id = novaFoto();

    await fila.tick();

    const job = repo.getShareJob(id);
    assert.equal(job.status, SHARE.FAILED, 'erro permanente deveria parar na primeira tentativa');
    assert.equal(job.attempts, 1);
    assert.equal(publisher.chamadas.length, 1);
  } finally {
    limpar();
  }
});

test('sem nuvem configurada o trabalho é dispensado, não marcado como falha', async () => {
  const { repo, fila, novaFoto, limpar } = ambiente(nullPublisher());
  try {
    const id = novaFoto();
    await fila.tick();

    assert.equal(repo.getShareJob(id).status, SHARE.SKIPPED);
    assert.equal(repo.shareStats().failed, 0, 'um totem de LAN não está em estado de falha');
    assert.ok(repo.getPhoto(id), 'a foto continua existindo');
  } finally {
    limpar();
  }
});

test('configurar a nuvem depois publica fotos que tinham sido ignoradas', async () => {
  const { repo, fila, novaFoto, limpar } = ambiente(nullPublisher());
  try {
    const id = novaFoto();
    await fila.tick();
    assert.equal(repo.getShareJob(id).status, SHARE.SKIPPED);

    const publisher = publisherFalso();
    const filaOnline = createShareQueue({
      repo,
      storage: { async get() { return Buffer.from('bytes'); } },
      publisher,
    });

    await filaOnline.tick();
    assert.equal(repo.getShareJob(id).status, SHARE.PUBLISHED);
    assert.equal(repo.getPhoto(id).publicUrl, `https://exemplo.com/photo/${id}`);
  } finally {
    limpar();
  }
});

test('a fila retoma pendências depois de o servidor reiniciar', async () => {
  const publisher = publisherFalso();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-queue-restart-'));
  const arquivo = path.join(dir, 'booth.sqlite');
  const storage = { async get() { return Buffer.from('bytes'); } };

  try {
    // Evento em andamento, internet fora.
    const antes = createRepository(arquivo);
    const evento = antes.currentEvent();
    const id = '1700000000_3x4_deadbeef';
    antes.insertPhoto({
      id, eventId: evento.id, sessionCode: 'AB3D', capturedAt: Date.now(),
      keys: { final: `final/globo_${id}.jpg`, web: null, thumb: null, original: null },
      meta: {},
    });
    antes.enqueueShare(id);
    antes.close();

    // O servidor reinicia.
    const depois = createRepository(arquivo);
    const fila = createShareQueue({ repo: depois, storage, publisher });

    assert.equal(depois.shareStats().pending_sync, 1, 'a pendência não sobreviveu ao restart');

    await fila.tick();
    assert.equal(depois.getShareJob(id).status, SHARE.PUBLISHED);
    assert.ok(depois.getPhoto(id).publicUrl);
    depois.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uma foto ilegível em disco não trava a fila inteira', async () => {
  const publisher = publisherFalso();
  const { repo, fila, novaFoto, limpar } = ambiente(publisher);
  try {
    // Foto cujo arquivo sumiu do disco.
    const evento = repo.currentEvent();
    const quebrada = '1700000000_3x4_ffffffff';
    repo.insertPhoto({
      id: quebrada, eventId: evento.id, sessionCode: 'AB3D', capturedAt: Date.now(),
      keys: { final: 'sumiu/arquivo.jpg', web: null, thumb: null, original: null },
      meta: {},
    });
    repo.enqueueShare(quebrada);

    const boa = novaFoto();
    await fila.tick();
    await fila.tick();

    assert.equal(repo.getShareJob(boa).status, SHARE.PUBLISHED, 'a foto boa deveria ter publicado mesmo assim');
    assert.notEqual(repo.getShareJob(quebrada).status, SHARE.PUBLISHED);
  } finally {
    limpar();
  }
});
