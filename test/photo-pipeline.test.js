/* ══════════════════════════════════════════════════════════
   PIPELINE — da foto que chega ao arquivo que o convidado leva

   Cobre o que quebra de verdade num evento: orientação por EXIF,
   espelhamento, moldura com transparência, arquivo corrompido e o
   vazamento de metadados do celular para a versão publicada.
   ══════════════════════════════════════════════════════════ */

// Antes de qualquer require do app: config e storage leem o ambiente
// no momento em que são carregados.
const os = require('os');
const fs = require('fs');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pipeline-'));
process.env.UPLOADS_DIR = UPLOADS;
process.env.SAVE_TO_DOWNLOADS = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { composeFinalPhoto, centerCrop, ratioValue } = require('../lib/photo');
const { newSession } = require('../lib/store');
const fixtures = require('./helpers/fixtures');

test.after(() => fs.rmSync(UPLOADS, { recursive: true, force: true }));

/** Lê o master que o pipeline acabou de gravar. */
function readFinal(refs) {
  return fs.readFileSync(path.join(UPLOADS, refs.final.key));
}

test('fonte paisagem em 3:4 corta sem reamostrar', async () => {
  const input = await fixtures.quadrantJpeg({ width: 4000, height: 3000 });
  const { refs, meta } = await composeFinalPhoto(input, { aspectRatio: '3:4' });

  const esperado = centerCrop(4000, 3000, ratioValue('3:4'));
  assert.equal(meta.finalWidth, esperado.width);
  assert.equal(meta.finalHeight, esperado.height);
  assert.equal(meta.finalHeight, 3000, 'a altura devia encostar na borda da fonte');
  assert.equal(meta.resampled, false, 'não deveria haver reamostragem sem teto configurado');

  const saida = await sharp(readFinal(refs)).metadata();
  assert.equal(saida.width, meta.finalWidth);
  assert.equal(saida.height, meta.finalHeight);
});

test('fonte retrato em 4:3 corta na horizontal', async () => {
  const input = await fixtures.quadrantJpeg({ width: 3000, height: 4000 });
  const { meta } = await composeFinalPhoto(input, { aspectRatio: '4:3' });

  assert.equal(meta.finalWidth, 3000);
  assert.equal(meta.finalHeight, 2250);
});

test('EXIF de rotação é aplicado antes do corte', async () => {
  // Orientação 6 = girar 90° no sentido horário. O arquivo tem 4000x3000
  // gravados, mas a imagem que o usuário vê é 3000x4000. O corte precisa
  // acontecer sobre o que se vê, não sobre o que está no cabeçalho.
  const input = await fixtures.quadrantJpeg({ width: 4000, height: 3000, orientation: 6 });
  const { refs, meta } = await composeFinalPhoto(input, { aspectRatio: '3:4' });

  assert.equal(meta.sourceWidth, 3000, 'largura efetiva deveria ser a pós-rotação');
  assert.equal(meta.sourceHeight, 4000, 'altura efetiva deveria ser a pós-rotação');
  assert.equal(meta.finalWidth, 3000);
  assert.equal(meta.finalHeight, 4000);

  const saida = await sharp(readFinal(refs)).metadata();
  assert.equal(saida.width, 3000);
  assert.equal(saida.height, 4000);
});

test('imagem sem EXIF nenhum passa pelo pipeline', async () => {
  const input = await fixtures.solidJpeg({ width: 2000, height: 2000 });
  const { meta } = await composeFinalPhoto(input, { aspectRatio: '1:1' });

  assert.equal(meta.finalWidth, 2000);
  assert.equal(meta.finalHeight, 2000);
});

test('espelho inverte os lados da foto', async () => {
  const input = await fixtures.quadrantJpeg({ width: 4000, height: 3000 });

  const normal = await composeFinalPhoto(input, { aspectRatio: '1:1', mirror: false });
  const espelhada = await composeFinalPhoto(input, { aspectRatio: '1:1', mirror: true });

  const w = normal.meta.finalWidth;
  const y = Math.round(normal.meta.finalHeight * 0.1);
  const xEsq = Math.round(w * 0.1);
  const xDir = Math.round(w * 0.9);

  const normalEsq = await fixtures.pixelAt(readFinal(normal.refs), xEsq, y);
  const normalDir = await fixtures.pixelAt(readFinal(normal.refs), xDir, y);
  const espEsq = await fixtures.pixelAt(readFinal(espelhada.refs), xEsq, y);
  const espDir = await fixtures.pixelAt(readFinal(espelhada.refs), xDir, y);

  // O quadrante superior esquerdo é vermelho e o direito é verde.
  assert.ok(normalEsq.r > 200 && normalEsq.g < 60, `esquerda normal deveria ser vermelha: ${JSON.stringify(normalEsq)}`);
  assert.ok(normalDir.g > 200 && normalDir.r < 60, `direita normal deveria ser verde: ${JSON.stringify(normalDir)}`);
  assert.ok(espEsq.g > 200 && espEsq.r < 60, `esquerda espelhada deveria ser verde: ${JSON.stringify(espEsq)}`);
  assert.ok(espDir.r > 200 && espDir.g < 60, `direita espelhada deveria ser vermelha: ${JSON.stringify(espDir)}`);
});

test('a moldura cobre a borda e preserva o miolo da foto', async () => {
  const input = await fixtures.quadrantJpeg({ width: 3000, height: 4000 });
  const session = newSession('TEST');
  const frame = await fixtures.framePng({ width: 1500, height: 2000, border: 0.1 });
  session.frames['3:4'] = { data: frame.toString('base64'), mime: 'image/png' };

  const { refs, meta } = await composeFinalPhoto(input, { session, aspectRatio: '3:4' });
  assert.equal(meta.frameApplied, true);

  const master = readFinal(refs);
  // Canto: é moldura, na cor da borda (#003B71).
  const canto = await fixtures.pixelAt(master, 10, 10);
  assert.ok(
    canto.b > 80 && canto.r < 60,
    `o canto deveria estar coberto pela moldura azul, veio ${JSON.stringify(canto)}`
  );

  // Um pouco para dentro do miolo transparente: continua sendo a foto.
  const dentro = await fixtures.pixelAt(master, Math.round(meta.finalWidth * 0.25), Math.round(meta.finalHeight * 0.2));
  assert.ok(
    dentro.r > 180 && dentro.g < 80,
    `o miolo deveria mostrar a foto (vermelho), veio ${JSON.stringify(dentro)}`
  );
});

test('moldura com proporção diferente é esticada até o master, sem deslocar', async () => {
  // O operador sobe o PNG que tiver. A composição não pode deixar faixa
  // vazia nem empurrar a moldura para fora do quadro.
  const input = await fixtures.quadrantJpeg({ width: 3000, height: 4000 });
  const session = newSession('TEST');
  session.frames['3:4'] = {
    data: (await fixtures.framePng({ width: 800, height: 800, border: 0.1 })).toString('base64'),
    mime: 'image/png',
  };

  const { refs, meta } = await composeFinalPhoto(input, { session, aspectRatio: '3:4' });
  const master = readFinal(refs);

  for (const [x, y] of [
    [5, 5],
    [meta.finalWidth - 6, 5],
    [5, meta.finalHeight - 6],
    [meta.finalWidth - 6, meta.finalHeight - 6],
  ]) {
    const px = await fixtures.pixelAt(master, x, y);
    assert.ok(px.b > 80 && px.r < 60, `canto (${x},${y}) sem moldura: ${JSON.stringify(px)}`);
  }
});

test('moldura ilegível não derruba a captura', async () => {
  // Perder a moldura é ruim; perder a foto é inaceitável.
  const input = await fixtures.solidJpeg({ width: 1200, height: 1600 });
  const session = newSession('TEST');
  session.frames['3:4'] = { data: fixtures.corruptJpeg().toString('base64'), mime: 'image/png' };

  const { meta } = await composeFinalPhoto(input, { session, aspectRatio: '3:4' });
  assert.equal(meta.frameApplied, false, 'a moldura ilegível deveria ser reportada como não aplicada');
  assert.equal(meta.finalWidth, 1200, 'a foto precisa sair mesmo assim');
  assert.equal(meta.finalHeight, 1600);
});

test('arquivo corrompido é recusado com erro claro', async () => {
  await assert.rejects(
    () => composeFinalPhoto(fixtures.corruptJpeg(), { aspectRatio: '3:4' }),
    err => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

test('o master publicado não carrega EXIF do celular', async () => {
  // Foto de evento vai para a internet: localização e número de série do
  // aparelho não podem ir junto.
  const comExif = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#334455' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'Samsung', Model: 'SM-S901E' },
      IFD2: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'W' },
    })
    .toBuffer();

  const original = await sharp(comExif).metadata();
  assert.ok(original.exif, 'a fixture precisa mesmo ter EXIF para o teste valer');

  const { refs } = await composeFinalPhoto(comExif, { aspectRatio: '3:4' });
  const saida = await sharp(readFinal(refs)).metadata();

  assert.equal(saida.exif, undefined, 'o master não deveria carregar EXIF');
  assert.equal(saida.gps, undefined, 'o master não deveria carregar GPS');
});

test('as três derivadas são gravadas e a web é menor que o master', async () => {
  const input = await fixtures.quadrantJpeg({ width: 4000, height: 3000 });
  const { refs, meta } = await composeFinalPhoto(input, { aspectRatio: '3:4' });

  for (const tipo of ['final', 'web', 'thumb']) {
    const arquivo = path.join(UPLOADS, refs[tipo].key);
    assert.ok(fs.existsSync(arquivo), `${tipo} não foi gravado em ${arquivo}`);
    assert.ok(fs.statSync(arquivo).size > 0, `${tipo} ficou vazio`);
  }

  const web = await sharp(fs.readFileSync(path.join(UPLOADS, refs.web.key))).metadata();
  assert.ok(Math.max(web.width, web.height) <= 2048, 'a versão web deveria caber em 2048 px');
  assert.ok(meta.webBytes < meta.finalBytes, 'a versão web deveria ser mais leve que o master');
});

test('o original é preservado byte a byte', async () => {
  const input = await fixtures.quadrantJpeg({ width: 2400, height: 1800 });
  const { refs } = await composeFinalPhoto(input, { aspectRatio: '3:4' });

  assert.ok(refs.original, 'o original deveria ter sido guardado');
  const gravado = fs.readFileSync(path.join(UPLOADS, refs.original.key));
  assert.ok(gravado.equals(input), 'o original gravado difere do que chegou da câmera');
});

test('duas capturas seguidas nunca colidem de nome', async () => {
  const input = await fixtures.solidJpeg({ width: 800, height: 600 });
  const nomes = new Set();

  for (let i = 0; i < 12; i++) {
    const { refs } = await composeFinalPhoto(input, { aspectRatio: '1:1' });
    nomes.add(refs.final.key);
  }

  assert.equal(nomes.size, 12, 'houve colisão de nome entre capturas — uma foto sobrescreveria a outra');
});

test('a moldura padrão do projeto é usada quando a sessão não tem uma', async () => {
  // Carregar moldura não pode ser ritual de véspera: a arte é parte da
  // identidade do evento. Sem isto, esquecer o upload custa uma noite
  // inteira de fotos sem moldura, e ninguém percebe até ver o resultado.
  const arte = await fixtures.framePng({ width: 1440, height: 1080, border: 0.06 });
  const caminho = path.join(UPLOADS, 'padrao-de-teste.png');
  fs.writeFileSync(caminho, arte);

  // O módulo lê o caminho da config e guarda o arquivo em cache.
  const { config } = require('../lib/config');
  const anterior = config.defaultFramePath;
  config.defaultFramePath = caminho;
  delete require.cache[require.resolve('../lib/photo')];
  const { composeFinalPhoto: comPadrao } = require('../lib/photo');

  try {
    // Sessão SEM moldura própria.
    const input = await fixtures.quadrantJpeg({ width: 3000, height: 4000 });
    const { meta } = await comPadrao(input, { session: newSession('TEST'), aspectRatio: '3:4' });

    assert.equal(meta.frameApplied, true, 'a moldura padrão deveria ter entrado sozinha');
  } finally {
    config.defaultFramePath = anterior;
    delete require.cache[require.resolve('../lib/photo')];
  }
});
