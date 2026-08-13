/* ══════════════════════════════════════════════════════════
   MODO SERVERLESS — o app sem banco em disco

   Na Vercel não há filesystem durável, então o estado cai no driver em
   memória (ou no Redis) e `repo` é null. O app inteiro tem ramificações
   `if (repo)` por causa disso, e sem este arquivo elas quebrariam em
   silêncio: a suíte roda em SQLite e nunca passaria por aqui.

   O que se garante: o contrato HTTP é o mesmo nos dois modos. O que
   muda é a durabilidade — e isso é coberto por db.test.js e system.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-serverless-'));
// Sem sqlite: é isto que faz `repo` ser null e exercita os fallbacks.
process.env.STATE_DRIVER = 'memory';
process.env.STORAGE_DRIVER = 'local';
process.env.UPLOADS_DIR = UPLOADS;
process.env.DATA_DIR = UPLOADS;
process.env.SAVE_TO_DOWNLOADS = 'false';
process.env.ENABLE_HTTPS = 'false';
// Teste jamais toca no hardware: sem isto a suite disputa o USB com o
// gphoto2 e trava esperando uma camera real responder.
process.env.CAMERA_SOURCE = 'nenhum';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { createApp } = require('../lib/app');
const { getRepo } = require('../lib/store');
const fixtures = require('./helpers/fixtures');

let server;
let base;

test.before(async () => {
  const criado = await createApp();
  server = criado.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(UPLOADS, { recursive: true, force: true });
});

async function novaSessao() {
  return (await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })).json();
}

async function fotografar(code, jpeg) {
  const form = new FormData();
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'c.jpg');
  form.append('code', code);
  form.append('aspectRatio', '3:4');
  form.append('mirror', 'false');
  form.append('source', 'serverless');

  const resp = await fetch(`${base}/api/photo/capture`, { method: 'POST', body: form });
  return { status: resp.status, body: await resp.json() };
}

test('neste modo não existe banco em disco', () => {
  assert.equal(getRepo(), null, 'o teste não estaria exercitando o fallback');
});

test('a saúde diz que o estado é efêmero, sem fingir durabilidade', async () => {
  const saude = await (await fetch(`${base}/api/health`)).json();

  assert.equal(saude.ok, true);
  assert.match(saude.database, /ephemeral/, 'o modo serverless não deveria se declarar durável');
  assert.equal(saude.storage, 'ready');
});

test('a foto atravessa o caminho inteiro sem banco', async () => {
  const { code } = await novaSessao();
  const { status, body } = await fotografar(code, await fixtures.quadrantJpeg({ width: 2000, height: 1500 }));

  assert.equal(status, 200, `a captura falhou no modo serverless: ${JSON.stringify(body)}`);

  const { meta, pageUrl, downloadUrl } = body.data;
  assert.equal(meta.finalWidth, 1125);
  assert.equal(meta.finalHeight, 1500);

  assert.equal((await fetch(`${base}${pageUrl}`)).status, 200);

  const download = await fetch(`${base}${downloadUrl}`);
  assert.equal(download.status, 200);
  const dims = await sharp(Buffer.from(await download.arrayBuffer())).metadata();
  assert.equal(dims.width, 1125, 'o download precisa ser o master');
});

test('a moldura funciona pelo caminho da sessão em memória', async () => {
  const { code } = await novaSessao();

  const form = new FormData();
  form.append('frame', new Blob([await fixtures.framePng({ width: 900, height: 1200 })], { type: 'image/png' }), 'm.png');
  form.append('aspectRatio', '3:4');
  assert.equal((await fetch(`${base}/api/frame/${code}`, { method: 'POST', body: form })).status, 200);

  const servida = await fetch(`${base}/api/frame/${code}?ratio=3:4`);
  assert.equal(servida.status, 200);
  assert.equal(servida.headers.get('content-type'), 'image/png');

  const { body } = await fotografar(code, await fixtures.solidJpeg({ width: 1200, height: 1600 }));
  assert.equal(body.data.meta.frameApplied, true);

  assert.equal((await fetch(`${base}/api/frame/${code}?ratio=3:4`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/frame/${code}?ratio=3:4`)).status, 404);
});

test('a lista de fotos da sessão acompanha as capturas', async () => {
  const { code } = await novaSessao();
  await fotografar(code, await fixtures.solidJpeg({ width: 900, height: 1200 }));
  await fotografar(code, await fixtures.solidJpeg({ width: 900, height: 1200 }));

  const { photos } = await (await fetch(`${base}/api/photos/${code}`)).json();
  assert.equal(photos.length, 2);
});

test('a foto é resolvida pelo filesystem quando o estado se perde', async () => {
  // É o caso real da Vercel: o convidado escaneia o QR e a requisição
  // cai numa instância que nunca viu esta sessão. O nome determinístico
  // do arquivo é o que salva.
  const { code } = await novaSessao();
  const { body } = await fotografar(code, await fixtures.solidJpeg({ width: 1600, height: 1200 }));

  delete require.cache[require.resolve('../lib/app')];
  const outra = await require('../lib/app').createApp();
  await new Promise(resolve => outra.server.listen(0, '127.0.0.1', resolve));
  const outraBase = `http://127.0.0.1:${outra.server.address().port}`;

  try {
    assert.equal((await fetch(`${outraBase}${body.data.pageUrl}`)).status, 200);
    assert.equal((await fetch(`${outraBase}${body.data.downloadUrl}`)).status, 200);
  } finally {
    await new Promise(resolve => outra.server.close(resolve));
  }
});

test('a URL do original também não vaza neste modo', async () => {
  const { code } = await novaSessao();
  const { body } = await fotografar(code, await fixtures.quadrantJpeg({ width: 1600, height: 1200 }));
  assert.doesNotMatch(JSON.stringify(body), /original/i);
});

test('na nuvem as telas do totem não são servidas', async () => {
  // O convidado que abre a raiz não pode cair numa página pedindo webcam
  // e pareamento por QR: essas telas só fazem sentido no computador que
  // tem a câmera cabeada. Na nuvem o app entrega fotos, e mais nada.
  const anterior = require('../lib/config').config.isVercel;
  require('../lib/config').config.isVercel = true;

  delete require.cache[require.resolve('../lib/app')];
  const nuvem = await require('../lib/app').createApp();
  await new Promise(r => nuvem.server.listen(0, '127.0.0.1', r));
  const alvo = `http://127.0.0.1:${nuvem.server.address().port}`;

  try {
    for (const rota of ['/', '/totem.html', '/display.html', '/camera.html', '/control.html']) {
      const resp = await fetch(`${alvo}${rota}`);
      assert.equal(resp.status, 200, `${rota} deveria responder`);

      const html = await resp.text();
      assert.doesNotMatch(html, /getUserMedia|navigator\.mediaDevices/i, `${rota} ainda pede câmera do navegador`);
      assert.doesNotMatch(html, /pareamento|parear|escaneie o qr.*conectar/i, `${rota} ainda oferece pareamento`);
      assert.match(html, /Globo Photo Booth/);
    }
  } finally {
    await new Promise(r => nuvem.server.close(r));
    require('../lib/config').config.isVercel = anterior;
  }
});
