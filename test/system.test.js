/* ══════════════════════════════════════════════════════════
   TESTE DE SISTEMA — o roteiro do evento, com processo de verdade

   Sobe o servidor como o operador sobe (node server.js), fala com ele
   por HTTP e o mata no meio para ver o que sobrevive. Nada aqui é
   mock: é o binário do evento.

   Cobre a pergunta central do produto:
     "se a internet cair agora, ainda consigo tirar e salvar a foto?"
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const fixtures = require('./helpers/fixtures');

const RAIZ = path.join(__dirname, '..');
const PORTA = 3987;
const BASE = `http://127.0.0.1:${PORTA}`;

let dataDir;
let servidor;

/** Sobe o servidor como um processo separado e espera ele responder. */
async function subirServidor(extraEnv = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      PORT: String(PORTA),
      ENABLE_HTTPS: 'false',
      SAVE_TO_DOWNLOADS: 'false',
      CAMERA_SOURCE: 'nenhum',
      DEFAULT_FRAME: '/inexistente/sem-moldura.png',
      DATA_DIR: dataDir,
      UPLOADS_DIR: path.join(dataDir, 'uploads'),
      DATABASE_FILE: path.join(dataDir, 'booth.sqlite'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.saida = '';
  proc.stdout.on('data', d => { proc.saida += d; });
  proc.stderr.on('data', d => { proc.saida += d; });

  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    if (proc.exitCode !== null) throw new Error(`o servidor morreu no boot:\n${proc.saida}`);
    try {
      const resp = await fetch(`${BASE}/api/health`);
      if (resp.ok) return proc;
    } catch { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 250));
  }

  proc.kill('SIGKILL');
  throw new Error(`o servidor não respondeu a tempo:\n${proc.saida}`);
}

async function derrubarServidor(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise(resolve => {
    const forca = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 4000);
    proc.on('exit', () => { clearTimeout(forca); resolve(); });
  });
}

async function novaSessao() {
  const resp = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return resp.json();
}

async function fotografar(code, jpeg, aspectRatio = '3:4') {
  const form = new FormData();
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'capture.jpg');
  form.append('code', code);
  form.append('aspectRatio', aspectRatio);
  form.append('mirror', 'false');
  form.append('source', 'android');

  const resp = await fetch(`${BASE}/api/photo/capture`, { method: 'POST', body: form });
  return { status: resp.status, body: await resp.json() };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-sistema-'));
  servidor = await subirServidor();
});

test.after(async () => {
  await derrubarServidor(servidor);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('sem internet nenhuma: o totem fotografa, salva e mostra', async () => {
  // Nenhuma variável de nuvem foi passada ao processo. Este é o evento
  // com o Wi-Fi do salão fora do ar.
  const saude = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(saude.ok, true, 'o totem deveria estar saudável sem nuvem');
  assert.equal(saude.cloud, 'not-configured');
  assert.equal(saude.database, 'ready');

  const { code } = await novaSessao();
  const jpeg = await fixtures.quadrantJpeg({ width: 4000, height: 3000 });

  const { status, body } = await fotografar(code, jpeg);
  assert.equal(status, 200, `a captura falhou: ${JSON.stringify(body)}`);

  const { meta, pageUrl, downloadUrl } = body.data;
  assert.equal(meta.finalWidth, 2250, 'o corte 3:4 de uma fonte 4000x3000');
  assert.equal(meta.finalHeight, 3000);
  assert.ok(meta.finalBytes > 100_000, 'o master saiu pequeno demais para ser alta qualidade');

  // O arquivo existe mesmo, em disco, no PC do totem.
  const masters = fs.readdirSync(path.join(dataDir, 'uploads', 'final'));
  assert.equal(masters.length, 1);
  assert.ok(fs.statSync(path.join(dataDir, 'uploads', 'final', masters[0])).size > 100_000);

  // E o convidado consegue abrir e baixar.
  assert.equal((await fetch(`${BASE}${pageUrl}`)).status, 200);
  const download = await fetch(`${BASE}${downloadUrl}`);
  assert.equal(download.status, 200);

  const baixado = await sharp(Buffer.from(await download.arrayBuffer())).metadata();
  assert.equal(baixado.width, 2250);
  assert.equal(baixado.height, 3000);
});

test('o original é preservado e não é exposto na resposta pública', async () => {
  const { code } = await novaSessao();
  await fotografar(code, await fixtures.quadrantJpeg({ width: 2400, height: 1800 }));

  const originais = fs.readdirSync(path.join(dataDir, 'uploads', 'original'));
  assert.ok(originais.length > 0, 'o original não foi guardado');

  const { body } = await fotografar(code, await fixtures.quadrantJpeg({ width: 2400, height: 1800 }));
  const payload = JSON.stringify(body);
  assert.doesNotMatch(payload, /original/i, 'a URL do original vazou para o cliente');
});

test('o QR aponta para uma URL que abre de verdade', async () => {
  const { code } = await novaSessao();
  const { body } = await fotografar(code, await fixtures.solidJpeg({ width: 1600, height: 1200 }));

  const alvo = `${BASE}${body.data.pageUrl}`;
  const qr = await fetch(`${BASE}/api/qr?size=400&data=${encodeURIComponent(alvo)}`);
  assert.equal(qr.status, 200);
  assert.equal((await sharp(Buffer.from(await qr.arrayBuffer())).metadata()).format, 'png');

  // O que o QR carrega precisa mesmo responder — QR não é prova de nada
  // se a URL dentro dele estiver quebrada.
  const pagina = await fetch(alvo);
  assert.equal(pagina.status, 200);
  const html = await pagina.text();

  const botao = /href="(\/download\/[^"]+)"/.exec(html);
  assert.ok(botao, 'a página não trouxe botão de download');

  const arquivo = await fetch(`${BASE}${botao[1]}`);
  assert.equal(arquivo.status, 200, 'o botão da página aponta para um download quebrado');

  // O que o botão entrega precisa ser o master, na resolução do corte —
  // e não a versão web nem uma página de erro disfarçada de imagem.
  const baixado = await sharp(Buffer.from(await arquivo.arrayBuffer())).metadata();
  assert.equal(baixado.format, 'jpeg');
  assert.equal(baixado.width, 900, 'o corte 3:4 de uma fonte 1600x1200');
  assert.equal(baixado.height, 1200);
});

test('matar e subir o servidor de novo não perde as fotos do evento', async () => {
  const { code } = await novaSessao();
  const antes = [];
  for (let i = 0; i < 3; i++) {
    const { body } = await fotografar(code, await fixtures.solidJpeg({ width: 1200, height: 1600 }));
    antes.push(body.data);
  }

  const saudeAntes = await (await fetch(`${BASE}/api/health`)).json();

  // Queda seca, sem desligamento gracioso — é o cabo de força saindo.
  servidor.kill('SIGKILL');
  await new Promise(resolve => servidor.on('exit', resolve));

  servidor = await subirServidor();

  const saudeDepois = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(saudeDepois.eventId, saudeAntes.eventId, 'o evento deveria ter sido retomado, não recriado');
  assert.equal(saudeDepois.photos, saudeAntes.photos, 'a contagem de fotos mudou depois do restart');

  for (const foto of antes) {
    assert.equal((await fetch(`${BASE}${foto.pageUrl}`)).status, 200, `foto ${foto.pageUrl} sumiu`);
    assert.equal((await fetch(`${BASE}${foto.downloadUrl}`)).status, 200);
  }

  // E o evento continua: dá para fotografar de novo imediatamente.
  const { status } = await fotografar(code, await fixtures.solidJpeg({ width: 1200, height: 1600 }));
  assert.equal(status, 200, 'não foi possível fotografar depois do restart');
});

test('a moldura do evento sobrevive ao restart', async () => {
  const { code } = await novaSessao();

  const form = new FormData();
  form.append('frame', new Blob([await fixtures.framePng({ width: 900, height: 1200 })], { type: 'image/png' }), 'm.png');
  form.append('aspectRatio', '3:4');
  assert.equal((await fetch(`${BASE}/api/frame/${code}`, { method: 'POST', body: form })).status, 200);

  servidor.kill('SIGKILL');
  await new Promise(resolve => servidor.on('exit', resolve));
  servidor = await subirServidor();

  assert.equal((await fetch(`${BASE}/api/frame/${code}?ratio=3:4`)).status, 200, 'a moldura sumiu no restart');

  const { body } = await fotografar(code, await fixtures.solidJpeg({ width: 1200, height: 1600 }));
  assert.equal(body.data.meta.frameApplied, true, 'a moldura não foi aplicada depois do restart');
});

test('nuvem inalcançável deixa a foto pendente, nunca perdida', async () => {
  // Reinicia apontando para uma nuvem que não existe. É o cenário do
  // salão com Wi-Fi que autentica mas não navega.
  await derrubarServidor(servidor);
  servidor = await subirServidor({
    CLOUD_DRIVER: 'vercel-blob',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_TESTE_invalido',
    PUBLIC_BASE_URL: 'https://exemplo-que-nao-existe.invalid',
    CLOUD_POLL_MS: '500',
    CLOUD_RETRY_BASE_MS: '200',
  });

  const { code } = await novaSessao();
  const { status, body } = await fotografar(code, await fixtures.solidJpeg({ width: 1600, height: 1200 }));

  // O ponto do teste: a captura NÃO falha porque a nuvem falhou.
  assert.equal(status, 200, 'a nuvem fora derrubou a captura');
  assert.equal(body.success, true);
  assert.equal((await fetch(`${BASE}${body.data.downloadUrl}`)).status, 200, 'o master local deveria estar acessível');

  // Deixa a fila tentar e falhar algumas vezes.
  await new Promise(r => setTimeout(r, 2500));

  const saude = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(saude.ok, true, 'nuvem fora não pode deixar o totem doente');
  assert.notEqual(saude.cloud, 'ready');

  const naFila = saude.share.pending_sync + saude.share.failed;
  assert.ok(naFila >= 1, `a foto deveria estar registrada como pendente: ${JSON.stringify(saude.share)}`);
  assert.equal(saude.share.published, 0);
});

test('capturas seguidas mantêm ritmo e não vazam memória', async () => {
  const { code } = await novaSessao();
  const jpeg = await fixtures.quadrantJpeg({ width: 3000, height: 4000 });

  const tempos = [];
  const CAPTURAS = 30;

  for (let i = 0; i < CAPTURAS; i++) {
    const inicio = Date.now();
    const { status } = await fotografar(code, jpeg);
    assert.equal(status, 200, `a captura ${i + 1} falhou`);
    tempos.push(Date.now() - inicio);
  }

  tempos.sort((a, b) => a - b);
  const mediana = tempos[Math.floor(tempos.length / 2)];
  const p95 = tempos[Math.floor(tempos.length * 0.95)];

  console.log(`    ${CAPTURAS} capturas — mediana ${mediana} ms, P95 ${p95} ms, máx ${tempos.at(-1)} ms`);

  // Sem número mágico apertado: o que interessa é não degradar. Uma
  // fuga de memória ou descritor aparece como P95 muito acima da
  // mediana, não como um valor absoluto alto.
  assert.ok(p95 < mediana * 4 + 1500, `a captura degradou ao longo da sequência (mediana ${mediana}, P95 ${p95})`);

  const saude = await (await fetch(`${BASE}/api/health`)).json();
  assert.ok(saude.photos >= CAPTURAS, 'nem todas as capturas foram registradas');

  const arquivos = fs.readdirSync(path.join(dataDir, 'uploads', 'final'));
  assert.ok(arquivos.length >= CAPTURAS, `faltam masters em disco: ${arquivos.length}`);
});
