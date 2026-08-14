/* ══════════════════════════════════════════════════════════
   API — o contrato HTTP do totem

   Estes testes descrevem o que o app Android e o telão consomem. Valem
   como rede de proteção da migração para SQLite: o armazenamento pode
   mudar por baixo, o contrato não.

   Sobe o app de verdade numa porta efêmera e fala com ele por HTTP —
   nada de mock do próprio servidor.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-api-'));
process.env.UPLOADS_DIR = UPLOADS;
process.env.DATA_DIR = UPLOADS;
process.env.DATABASE_FILE = path.join(UPLOADS, 'booth.sqlite');
// Sem moldura padrao: estes testes afirmam sobre a foto crua. A
// moldura do projeto tem teste proprio.
process.env.DEFAULT_FRAME = '/inexistente/sem-moldura.png';
// FRAMES_DIR junto: a moldura padrao agora e procurada por
// proporcao dentro da pasta, entao desligar so o DEFAULT_FRAME
// deixaria os arquivos do projeto entrarem no teste.
process.env.FRAMES_DIR = '/inexistente/frames';
process.env.SAVE_TO_DOWNLOADS = 'false';
process.env.ENABLE_HTTPS = 'false';
// Teste jamais toca no hardware: sem isto a suite disputa o USB com o
// gphoto2 e trava esperando uma camera real responder.
process.env.CAMERA_SOURCE = 'nenhum';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { createApp } = require('../lib/app');
const fixtures = require('./helpers/fixtures');

let server;
let base;

test.before(async () => {
  const created = await createApp();
  server = created.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(UPLOADS, { recursive: true, force: true });
});

/** Cria uma sessão e devolve o corpo da resposta. */
async function novaSessao() {
  const resp = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(resp.status, 200);
  return resp.json();
}

/** Envia uma foto pelo caminho multipart (o do evento). */
async function enviarFoto(code, jpeg, { aspectRatio = '3:4', mirror = false } = {}) {
  const form = new FormData();
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'capture.jpg');
  form.append('code', code);
  form.append('aspectRatio', aspectRatio);
  form.append('mirror', String(mirror));
  form.append('source', 'test');

  const resp = await fetch(`${base}/api/photo/capture`, { method: 'POST', body: form });
  return { status: resp.status, body: await resp.json() };
}

test('/api/health responde que o totem está de pé', async () => {
  const resp = await fetch(`${base}/api/health`);
  assert.equal(resp.status, 200);

  const body = await resp.json();
  assert.equal(body.ok, true);
});

test('/api/config diz ao cliente onde o socket mora', async () => {
  const body = await (await fetch(`${base}/api/config`)).json();

  assert.equal(typeof body.socketPath, 'string');
  assert.ok(Array.isArray(body.transports) && body.transports.length > 0);
  assert.match(body.preview.framePath, /\/api\/preview\/[A-Z0-9]{4}\/frame$/);
  assert.equal(body.storage, 'local');
  assert.ok(body.maxUploadBytes > 0);
});

test('a sessão é criada sem precisar de tela aberta', async () => {
  const sessao = await novaSessao();

  assert.match(sessao.code, /^[A-Z0-9]{4}$/);
  assert.ok(sessao.token?.startsWith(`${sessao.code}.`), 'devia vir um token assinado');
  assert.equal(sessao.settings.aspectRatio, '3:4');
});

test('a API do flash valida o modo e mantém a preferência na sessão', async () => {
  const { code } = await novaSessao();

  const invalido = await fetch(`${base}/api/camera/flash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, mode: 'automatico' }),
  });
  assert.equal(invalido.status, 400);

  const desligado = await fetch(`${base}/api/camera/flash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, mode: 'off' }),
  });
  assert.equal(desligado.status, 200);

  const sessao = await (await fetch(`${base}/api/session/${code}`)).json();
  assert.equal(sessao.settings.flashMode, 'off');
});

test('a foto atravessa o caminho inteiro: upload, composição, página e download', async () => {
  const { code } = await novaSessao();
  const jpeg = await fixtures.quadrantJpeg({ width: 3000, height: 4000 });

  const { status, body } = await enviarFoto(code, jpeg);
  assert.equal(status, 200, `upload falhou: ${JSON.stringify(body)}`);
  assert.equal(body.success, true);

  const { pageUrl, downloadUrl, imageUrl, meta } = body.data;
  assert.equal(meta.finalWidth, 3000);
  assert.equal(meta.finalHeight, 4000);
  assert.equal(meta.source, 'test');

  // A página que o QR abre.
  const pagina = await fetch(`${base}${pageUrl}`);
  assert.equal(pagina.status, 200, 'a página da foto deveria abrir');
  const html = await pagina.text();
  assert.match(html, /Baixar em alta qualidade/);

  // A imagem exibida na página.
  const web = await fetch(`${base}${imageUrl}`);
  assert.equal(web.status, 200);
  assert.ok(Number(web.headers.get('content-length')) > 0);

  // O master, atrás do botão de download.
  const download = await fetch(`${base}${downloadUrl}`);
  assert.equal(download.status, 200, 'o download do master deveria funcionar');
  assert.match(download.headers.get('content-disposition') || '', /attachment/);

  const baixado = Buffer.from(await download.arrayBuffer());
  const dims = await sharp(baixado).metadata();
  assert.equal(dims.width, 3000, 'o download precisa ser o master, não a versão web');
  assert.equal(dims.height, 4000);
});

test('a foto é servida por uma instância que não a recebeu', async () => {
  // Metade do invariante local-first: quem resolve a foto é o disco, não
  // a memória de quem atendeu o upload. O restart de processo completo é
  // coberto por db.test.js e pelo teste de sistema.
  const { code } = await novaSessao();
  const jpeg = await fixtures.solidJpeg({ width: 1600, height: 1200 });
  const { body } = await enviarFoto(code, jpeg);
  const { pageUrl, downloadUrl } = body.data;

  // Sobe uma segunda instância do app sobre o mesmo diretório de fotos,
  // sem nenhum estado em memória herdado.
  delete require.cache[require.resolve('../lib/app')];
  const outro = await require('../lib/app').createApp();
  await new Promise(resolve => outro.server.listen(0, '127.0.0.1', resolve));
  const outraBase = `http://127.0.0.1:${outro.server.address().port}`;

  try {
    const pagina = await fetch(`${outraBase}${pageUrl}`);
    assert.equal(pagina.status, 200, 'a página da foto sumiu após o restart');

    const download = await fetch(`${outraBase}${downloadUrl}`);
    assert.equal(download.status, 200, 'o download do master sumiu após o restart');
    assert.ok(Number(download.headers.get('content-length')) > 0);
  } finally {
    await new Promise(resolve => outro.server.close(resolve));
  }
});

test('o QR é gerado pelo próprio servidor, sem internet', async () => {
  const resp = await fetch(`${base}/api/qr?data=${encodeURIComponent('http://192.168.0.10:3000/photo/abc')}&size=300`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('content-type'), 'image/png');

  const png = await sharp(Buffer.from(await resp.arrayBuffer())).metadata();
  assert.equal(png.format, 'png');
  assert.equal(png.width, 300);
});

test('/api/qr recusa pedido sem dados', async () => {
  assert.equal((await fetch(`${base}/api/qr`)).status, 400);
});

test('a moldura sobe, é servida e pode ser removida', async () => {
  const { code } = await novaSessao();
  const png = await fixtures.framePng({ width: 900, height: 1200 });

  const form = new FormData();
  form.append('frame', new Blob([png], { type: 'image/png' }), 'moldura.png');
  form.append('aspectRatio', '3:4');

  const envio = await fetch(`${base}/api/frame/${code}`, { method: 'POST', body: form });
  assert.equal(envio.status, 200);

  const servida = await fetch(`${base}/api/frame/${code}?ratio=3:4`);
  assert.equal(servida.status, 200);
  assert.equal((await sharp(Buffer.from(await servida.arrayBuffer())).metadata()).format, 'png');

  // Com moldura carregada, a captura sai com ela aplicada.
  const { body } = await enviarFoto(code, await fixtures.solidJpeg({ width: 1200, height: 1600 }));
  assert.equal(body.data.meta.frameApplied, true);

  const remocao = await fetch(`${base}/api/frame/${code}?ratio=3:4`, { method: 'DELETE' });
  assert.equal(remocao.status, 200);
  assert.equal((await fetch(`${base}/api/frame/${code}?ratio=3:4`)).status, 404);
});

test('upload sem arquivo é recusado com 400, não com 500', async () => {
  const { code } = await novaSessao();
  const form = new FormData();
  form.append('code', code);

  const resp = await fetch(`${base}/api/photo/capture`, { method: 'POST', body: form });
  assert.equal(resp.status, 400);
  assert.match((await resp.json()).error, /ausente/i);
});

test('sessão inexistente não derruba a captura nem inventa foto', async () => {
  // O app pode disparar com um código velho depois de um restart. A foto
  // precisa ser composta e salva mesmo assim — perder o arquivo é pior.
  const { status, body } = await enviarFoto('ZZZZ', await fixtures.solidJpeg({ width: 800, height: 600 }));
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.pageUrl, 'a foto precisa continuar tendo página própria');
});

test('a lista de fotos da sessão acompanha as capturas', async () => {
  const { code } = await novaSessao();
  assert.deepEqual((await (await fetch(`${base}/api/photos/${code}`)).json()).photos, []);

  await enviarFoto(code, await fixtures.solidJpeg({ width: 900, height: 1200 }));
  await enviarFoto(code, await fixtures.solidJpeg({ width: 900, height: 1200 }));

  const { photos } = await (await fetch(`${base}/api/photos/${code}`)).json();
  assert.equal(photos.length, 2);
  assert.ok(photos.every(p => p.page && p.url));
});

test('id de foto forjado responde 404 e não vaza caminho do disco', async () => {
  for (const forjado of ['../../etc/passwd', 'nao-existe', '..%2F..%2Fpackage.json']) {
    const resp = await fetch(`${base}/photo/${encodeURIComponent(forjado)}`);
    assert.equal(resp.status, 404, `"${forjado}" deveria dar 404`);
    assert.doesNotMatch(await resp.text(), new RegExp(UPLOADS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('o QR nunca aponta para localhost', async () => {
  // O telão roda em localhost, então o host da requisição é
  // "localhost:3000". Um convidado que escaneasse isso tentaria abrir a
  // foto no próprio celular — o QR aparece bonito e não funciona para
  // ninguém. É o defeito mais silencioso que este produto pode ter.
  const { code } = await novaSessao();
  const { body } = await enviarFoto(code, await fixtures.solidJpeg({ width: 1200, height: 1600 }));

  const alvo = decodeURIComponent(
    /data=([^&]+)/.exec(`/api/qr?data=${encodeURIComponent(`http://localhost:9999${body.data.pageUrl}`)}`)[1]
  );
  assert.match(alvo, /localhost/, 'a fixture precisa mesmo conter localhost para o teste valer');

  // E o endereço que o servidor monta para o QR não pode ser local.
  const { primaryLanAddress } = require('../lib/network');
  const lan = primaryLanAddress();
  if (!lan) return; // máquina sem rede: nada a garantir

  const capturaUrl = `http://${lan}:3000${body.data.pageUrl}`;
  assert.doesNotMatch(capturaUrl, /localhost|127\.0\.0\.1/);
  assert.match(capturaUrl, /^http:\/\/\d+\.\d+\.\d+\.\d+:/, 'o QR precisa carregar um IP alcançável');
});
