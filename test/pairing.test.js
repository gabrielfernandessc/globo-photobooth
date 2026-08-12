/* ══════════════════════════════════════════════════════════
   PAREAMENTO — o celular acha o totem sem ninguém digitar IP
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pair-'));
process.env.UPLOADS_DIR = UPLOADS;
process.env.DATA_DIR = UPLOADS;
process.env.DATABASE_FILE = path.join(UPLOADS, 'booth.sqlite');
process.env.SAVE_TO_DOWNLOADS = 'false';
process.env.ENABLE_HTTPS = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../lib/app');
const { verifySignedCode } = require('../lib/store');
const { lanAddresses, primaryLanAddress, ehRedePrivada } = require('../lib/network');

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

test('reconhece faixas privadas e recusa as públicas', () => {
  for (const ip of ['10.0.0.5', '192.168.0.34', '172.16.4.1', '172.31.255.254']) {
    assert.equal(ehRedePrivada(ip), true, `${ip} deveria ser privada`);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '200.1.2.3']) {
    assert.equal(ehRedePrivada(ip), false, `${ip} não é privada`);
  }
});

test('a lista de endereços não traz loopback nem auto-atribuído', () => {
  for (const ip of lanAddresses()) {
    assert.doesNotMatch(ip, /^127\./, 'loopback não serve para o celular');
    assert.doesNotMatch(ip, /^169\.254\./, 'auto-atribuído significa DHCP falhado');
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  }
});

test('o endereço principal é privado quando existe algum', () => {
  const principal = primaryLanAddress();
  const privados = lanAddresses().filter(ehRedePrivada);

  if (privados.length) {
    assert.ok(ehRedePrivada(principal), `o QR apontaria para ${principal}, que não é da LAN`);
  }
});

test('o pareamento devolve deep link, QR e sessão utilizável', async t => {
  const resp = await fetch(`${base}/api/pair`);

  if (resp.status === 503) {
    // Máquina sem rede local: o endpoint diz isso com clareza em vez de
    // devolver um endereço que não responde.
    assert.match((await resp.json()).error, /sem rede local/i);
    return t.skip('máquina sem interface de LAN');
  }

  assert.equal(resp.status, 200);
  const par = await resp.json();

  assert.match(par.code, /^[A-Z0-9]{4}$/);
  assert.equal(verifySignedCode(par.token), par.code, 'o token precisa provar a sessão');
  assert.ok(par.addresses.includes(par.host));

  // O deep link é o que o app lê do QR.
  const url = new URL(par.deepLink);
  assert.equal(url.protocol, 'photobooth:');
  assert.equal(url.searchParams.get('session'), par.code);
  assert.equal(url.searchParams.get('token'), par.token);
  assert.equal(url.searchParams.get('host'), `${par.host}:${par.port}`);

  // O QR sai do próprio servidor — pareamento não pode depender de
  // internet nem de serviço de terceiro.
  const qr = await fetch(`${base}${par.qrUrl}`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');

  // E a sessão anunciada existe de verdade.
  assert.equal((await fetch(`${base}/api/session/${par.code}`)).status, 200);
});

test('parear de novo com o mesmo código reaproveita a sessão', async t => {
  const primeiro = await fetch(`${base}/api/pair`);
  if (primeiro.status === 503) return t.skip('máquina sem interface de LAN');

  const { code } = await primeiro.json();
  const segundo = await (await fetch(`${base}/api/pair?code=${code}`)).json();

  assert.equal(segundo.code, code, 'o evento em andamento não pode trocar de código');
  assert.equal(verifySignedCode(segundo.token), code);
});

test('o token do pareamento não vale para outra sessão', async t => {
  const resp = await fetch(`${base}/api/pair`);
  if (resp.status === 503) return t.skip('máquina sem interface de LAN');

  const { token, code } = await resp.json();
  const outro = code === 'AAAA' ? 'BBBB' : 'AAAA';
  const forjado = `${outro}.${token.split('.')[1]}`;

  assert.equal(verifySignedCode(forjado), null);
});
