/* ══════════════════════════════════════════════════════════
   DISPARO DSLR PELO SOCKET — o caminho usado pelo WKWebView

   Um POST novo pode ficar esperando atrás do MJPEG no WebKit. Este teste
   prova o caminho que não abre outra conexão: contagem e disparo usam o
   mesmo Socket.IO, com requestId idempotente.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const RAIZ = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'helpers', 'fake-gphoto2.js');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-socket-capture-'));
const BIN = path.join(TEMP, 'gphoto2');
const FOTO_FAKE = path.join(TEMP, 'captura-valida.jpg');
const FLASH_MARKER = path.join(TEMP, 'flash-levantado');
const FLASH_COUNT_FILE = path.join(TEMP, 'flash-contagem');

fs.writeFileSync(BIN, `#!/bin/bash\nexport FAKE_CAPTURA_MS=100\nexport FAKE_CAPTURA_ARQUIVO="${FOTO_FAKE}"\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
fs.chmodSync(BIN, 0o755);

process.env.UPLOADS_DIR = path.join(TEMP, 'uploads');
process.env.DATA_DIR = TEMP;
process.env.DATABASE_FILE = path.join(TEMP, 'booth.sqlite');
process.env.DEFAULT_FRAME = '/inexistente/sem-moldura.png';
// FRAMES_DIR junto: a moldura padrao agora e procurada por
// proporcao dentro da pasta, entao desligar so o DEFAULT_FRAME
// deixaria os arquivos do projeto entrarem no teste.
process.env.FRAMES_DIR = '/inexistente/frames';
process.env.SAVE_TO_DOWNLOADS = 'false';
process.env.ENABLE_HTTPS = 'false';
process.env.CAMERA_SOURCE = 'gphoto';
process.env.GPHOTO_BIN = BIN;
process.env.FAKE_FLASH_MARKER = FLASH_MARKER;
process.env.FAKE_FLASH_COUNT_FILE = FLASH_COUNT_FILE;
process.env.CLOUD_DRIVER = 'none';
process.env.PUBLIC_BASE_URL = '';

const { createApp } = require('../lib/app');

function carregarClienteSocket() {
  const arquivo = path.join(
    path.dirname(require.resolve('socket.io/package.json')),
    'client-dist',
    'socket.io.js',
  );
  const modulo = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(arquivo, 'utf8'))(modulo, modulo.exports);
  return modulo.exports.io;
}

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ate(condicao, prazoMs = 8_000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    if (await condicao()) return true;
    await esperar(50);
  }
  return false;
}

function emitir(socket, evento, payload) {
  return new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`${evento} não confirmou`)), 12_000);
    socket.emit(evento, payload, resposta => {
      clearTimeout(limite);
      resolve(resposta);
    });
  });
}

function quantidadeDeAcionamentosDoFlash() {
  if (!fs.existsSync(FLASH_COUNT_FILE)) return 0;
  return fs.readFileSync(FLASH_COUNT_FILE, 'utf8').trim().split('\n').filter(Boolean).length;
}

test('o socket dispara uma única foto e confirma o resultado ao telão', async () => {
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#05a6ff' } })
    .jpeg({ quality: 90 })
    .toFile(FOTO_FAKE);
  const app = await createApp();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const io = carregarClienteSocket();
  const socket = io(base, { transports: ['websocket'] });
  const controle = io(base, { transports: ['websocket'] });

  try {
    assert.ok(await ate(async () => (await (await fetch(`${base}/api/camera/status`)).json()).transmitindo));
    const sessao = await emitir(socket, 'create-session', { requestedCode: 'TOTM' });
    assert.equal(sessao.code, 'TOTM');
    assert.equal((await emitir(controle, 'join-session', { code: 'TOTM', role: 'control' })).success, true);

    const proibido = await emitir(socket, 'camera-flash', { code: 'TOTM', mode: 'flash' });
    assert.equal(proibido.success, false);

    const flash = await emitir(controle, 'camera-flash', { code: 'TOTM', mode: 'flash' });
    assert.equal(flash.success, true);
    assert.equal(flash.mode, 'flash');
    assert.equal(fs.existsSync(FLASH_MARKER), true);
    assert.equal(quantidadeDeAcionamentosDoFlash(), 1);
    assert.ok(await ate(async () => (await (await fetch(`${base}/api/camera/status`)).json()).transmitindo));

    const repetido = await emitir(controle, 'camera-flash', { code: 'TOTM', mode: 'flash' });
    assert.equal(repetido.success, true, 'repetir o modo atual deve rearmar o flash');
    assert.equal(quantidadeDeAcionamentosDoFlash(), 2);
    assert.equal((await (await fetch(`${base}/api/session/TOTM`)).json()).settings.flashMode, 'flash');

    const requestId = randomUUID();
    const payload = { code: 'TOTM', aspectRatio: '3:4', requestId };
    const [primeira, duplicada] = await Promise.all([
      emitir(socket, 'dslr-capture', payload),
      emitir(socket, 'dslr-capture', payload),
    ]);

    assert.equal(primeira.success, true);
    assert.equal(duplicada.success, true);
    assert.equal(primeira.data.pageUrl, duplicada.data.pageUrl);
    assert.equal(fs.readdirSync(path.join(TEMP, 'uploads', 'final')).length, 1);
    assert.equal(quantidadeDeAcionamentosDoFlash(), 3, 'o disparo deve rearmar o flash na mesma sessão PTP');
    assert.ok(await ate(async () => (await (await fetch(`${base}/api/camera/status`)).json()).transmitindo));
  } finally {
    socket.close();
    controle.close();
    await app.shutdown();
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
});
