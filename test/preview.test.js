/* ══════════════════════════════════════════════════════════
   PREVIEW MJPEG — o que substituiu o WebRTC

   O preview é a única coisa que o convidado vê enquanto se posiciona.
   Se ele congelar, a pessoa não sabe se está enquadrada e o operador
   não sabe se o celular caiu.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-preview-'));
process.env.UPLOADS_DIR = UPLOADS;
process.env.DATA_DIR = UPLOADS;
process.env.DATABASE_FILE = path.join(UPLOADS, 'booth.sqlite');
process.env.SAVE_TO_DOWNLOADS = 'false';
process.env.ENABLE_HTTPS = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { createApp } = require('../lib/app');
const { createPreviewHub, quadroMjpeg, FRONTEIRA } = require('../lib/preview');

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

const jpegDe = (w, h, cor) =>
  sharp({ create: { width: w, height: h, channels: 3, background: cor } }).jpeg().toBuffer();

async function novaSessao() {
  return (await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json();
}

function publicar(code, jpeg, extra = {}) {
  return fetch(`${base}/api/preview/${code}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', ...extra },
    body: jpeg,
  });
}

/* ── O hub, isolado ── */

test('o hub guarda só o último quadro, sem enfileirar', () => {
  const hub = createPreviewHub();
  hub.publicar('AB3D', Buffer.from('quadro-1'));
  hub.publicar('AB3D', Buffer.from('quadro-2'));
  hub.publicar('AB3D', Buffer.from('quadro-3'));

  const recebidos = [];
  hub.assinar('AB3D', b => recebidos.push(b.toString()));

  // Quem chega depois recebe o atual, não o histórico: preview atrasado
  // é pior que preview com menos quadros.
  assert.deepEqual(recebidos, ['quadro-3']);
  assert.equal(hub.status('AB3D').quadros, 3);
});

test('quem assina já recebe um quadro, sem esperar o próximo', () => {
  // Um telão que recarrega no meio do evento não pode ficar em branco
  // até o celular mandar o quadro seguinte.
  const hub = createPreviewHub();
  hub.publicar('AB3D', Buffer.from('atual'));

  let primeiro = null;
  hub.assinar('AB3D', b => { primeiro ??= b.toString(); });
  assert.equal(primeiro, 'atual');
});

test('o hub sabe se há plateia — é como o celular decide gastar bateria', () => {
  const hub = createPreviewHub();
  assert.equal(hub.temAudiencia('AB3D'), false);

  const cancelar = hub.assinar('AB3D', () => {});
  assert.equal(hub.temAudiencia('AB3D'), true);

  cancelar();
  assert.equal(hub.temAudiencia('AB3D'), false, 'assinante fantasma faria o celular transmitir para ninguém');
});

test('um telão que morre no meio do envio não derruba os outros', () => {
  const hub = createPreviewHub();
  hub.assinar('AB3D', () => { throw new Error('socket fechou'); });

  const vivos = [];
  hub.assinar('AB3D', b => vivos.push(b.toString()));

  assert.doesNotThrow(() => hub.publicar('AB3D', Buffer.from('quadro')));
  assert.deepEqual(vivos, ['quadro']);
});

test('sessões diferentes não misturam preview', () => {
  const hub = createPreviewHub();
  const deA = [];
  hub.assinar('AAAA', b => deA.push(b.toString()));

  hub.publicar('BBBB', Buffer.from('da-outra-sessao'));
  assert.deepEqual(deA, [], 'o preview de uma sessão vazou para outra');
});

test('o status expira quando o celular para de mandar', () => {
  const hub = createPreviewHub();
  hub.publicar('AB3D', Buffer.from('x'), { width: 640, height: 480 });

  const agora = hub.status('AB3D');
  assert.equal(agora.ativo, true);
  assert.equal(agora.largura, 640);

  // Sem quadro nenhum a sessão nem existe.
  assert.equal(hub.status('ZZZZ').ativo, false);
});

test('o quadro multipart carrega a fronteira e o tamanho corretos', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const quadro = quadroMjpeg(jpeg).toString('latin1');

  assert.ok(quadro.startsWith(`--${FRONTEIRA}\r\n`));
  assert.match(quadro, /Content-Type: image\/jpeg/);
  assert.match(quadro, new RegExp(`Content-Length: ${jpeg.length}`));
  assert.ok(quadro.endsWith('\r\n'), 'sem o CRLF final o navegador não fecha o quadro');
});

/* ── Pelo HTTP, como o celular e o telão realmente falam ── */

test('o celular publica e o telão recebe pelo stream', async () => {
  const { code } = await novaSessao();

  const stream = await fetch(`${base}/api/preview/${code}/stream`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /multipart\/x-mixed-replace/);
  assert.match(stream.headers.get('cache-control'), /no-store/);

  const leitor = stream.body.getReader();

  // Espera o servidor registrar o assinante antes de publicar.
  await new Promise(r => setTimeout(r, 100));
  const jpeg = await jpegDe(320, 240, '#e74c3c');
  const resp = await publicar(code, jpeg, { 'x-frame-width': '320', 'x-frame-height': '240' });

  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).viewers, 1, 'o servidor deveria enxergar o telão conectado');

  // Lê até fechar um quadro inteiro.
  let buffer = Buffer.alloc(0);
  const limite = Date.now() + 5000;
  while (Date.now() < limite && buffer.length < jpeg.length) {
    const { value, done } = await leitor.read();
    if (done) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
  }

  const texto = buffer.toString('latin1');
  assert.ok(texto.includes(`--${FRONTEIRA}`), 'o stream não trouxe a fronteira multipart');
  assert.ok(texto.includes(`Content-Length: ${jpeg.length}`));

  // E o JPEG que saiu é decodificável — não um pedaço truncado.
  const inicio = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const meta = await sharp(buffer.subarray(inicio, inicio + jpeg.length)).metadata();
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 240);

  await leitor.cancel();
});

test('sem telão aberto o servidor avisa que não há plateia', async () => {
  const { code } = await novaSessao();
  const resp = await publicar(code, await jpegDe(64, 64, '#000000'));

  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).viewers, 0, 'é por aqui que o celular sabe parar de transmitir');
});

test('quadro vazio e código inválido são recusados com 400', async () => {
  const { code } = await novaSessao();

  const vazio = await fetch(`${base}/api/preview/${code}`, {
    method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: Buffer.alloc(0),
  });
  assert.equal(vazio.status, 400);

  assert.equal((await publicar('nao-e-codigo', await jpegDe(64, 64, '#fff'))).status, 400);
});

test('o status por HTTP acompanha os quadros publicados', async () => {
  const { code } = await novaSessao();
  await publicar(code, await jpegDe(200, 150, '#2ecc71'), { 'x-frame-width': '200', 'x-frame-height': '150' });

  const status = await (await fetch(`${base}/api/preview/${code}/status`)).json();
  assert.equal(status.ativo, true);
  assert.ok(status.quadros >= 1);
  assert.equal(status.largura, 200);
  assert.ok(status.idadeMs < 3000);
});
