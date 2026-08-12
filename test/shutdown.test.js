/* ══════════════════════════════════════════════════════════
   DESLIGAMENTO — o totem precisa conseguir parar

   Arquivo próprio de propósito: o store é um singleton de módulo, e
   fechá-lo aqui derrubaria as outras suítes se elas dividissem o mesmo
   processo. O node:test isola por arquivo.

   O caso que importa é o normal, não o excepcional: durante o evento
   SEMPRE há um telão conectado consumindo o preview.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-shutdown-'));
process.env.UPLOADS_DIR = UPLOADS;
process.env.DATA_DIR = UPLOADS;
process.env.DATABASE_FILE = path.join(UPLOADS, 'booth.sqlite');
process.env.SAVE_TO_DOWNLOADS = 'false';
process.env.ENABLE_HTTPS = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createApp } = require('../lib/app');

test.after(() => fs.rmSync(UPLOADS, { recursive: true, force: true }));

test('o servidor encerra mesmo com o telão consumindo o preview', async () => {
  // Um stream MJPEG é uma resposta HTTP que nunca termina. Sem derrubá-la
  // explicitamente, server.close() espera para sempre — e o totem não
  // reinicia enquanto o telão estiver aberto, que é a situação normal
  // num evento, não a exceção.
  const app = await createApp();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const { code } = await (await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json();

  // http.get e não fetch: o fetch do Node bufferiza a resposta multipart
  // e mantém a conexão no pool do undici, o que mascara o cenário real —
  // uma <img> do navegador segurando um socket com resposta eterna.
  const porta = app.server.address().port;
  const stream = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: `/api/preview/${code}/stream` }, res => {
      res.on('data', () => {});
      resolve({ req, status: res.statusCode });
    });
    req.on('error', reject);
  });

  assert.equal(stream.status, 200);
  await new Promise(r => setTimeout(r, 200));

  const inicio = Date.now();
  const resultado = await Promise.race([
    app.shutdown().then(r => ({ ok: true, ...r })),
    new Promise(r => setTimeout(() => r({ ok: false }), 6000)),
  ]);
  const decorrido = Date.now() - inicio;

  assert.ok(resultado.ok, `o servidor ficou preso no stream de preview (${decorrido} ms)`);
  assert.ok(resultado.streams >= 1, 'o desligamento deveria ter derrubado o stream aberto');
  assert.ok(decorrido < 3000, `desligamento demorou ${decorrido} ms`);

  stream.req.destroy();

  // E a porta fica realmente livre para o próximo boot.
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${porta}/api/health`),
    'a porta continuou aceitando conexão depois do desligamento'
  );
});
