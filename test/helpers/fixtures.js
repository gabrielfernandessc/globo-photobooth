/* ══════════════════════════════════════════════════════════
   FIXTURES — imagens sintéticas para os testes

   Nada de binário versionado: as imagens são geradas pelo próprio
   sharp, o que mantém o repositório limpo e deixa os casos explícitos
   (qual orientação, qual proporção, qual conteúdo).

   As imagens têm quadrantes de cores diferentes de propósito: é assim
   que um teste prova que o corte pegou o centro, que o espelho inverteu
   os lados e que a rotação por EXIF aconteceu.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/** Diretório temporário isolado, removido no fim do teste. */
function tempDir(prefix = 'booth-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Imagem com quatro quadrantes de cores sólidas e uma faixa central.
 * A faixa é a âncora do teste de corte: se o corte for centralizado,
 * ela continua no meio do resultado.
 */
async function quadrantJpeg({ width, height, orientation = 1, quality = 95 } = {}) {
  const half = { w: Math.floor(width / 2), h: Math.floor(height / 2) };

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${half.w}" height="${half.h}" fill="#ff0000"/>
    <rect x="${half.w}" y="0" width="${width - half.w}" height="${half.h}" fill="#00ff00"/>
    <rect x="0" y="${half.h}" width="${half.w}" height="${height - half.h}" fill="#0000ff"/>
    <rect x="${half.w}" y="${half.h}" width="${width - half.w}" height="${height - half.h}" fill="#ffff00"/>
    <rect x="${Math.floor(width * 0.45)}" y="0" width="${Math.ceil(width * 0.1)}" height="${height}" fill="#000000"/>
  </svg>`;

  let pipeline = sharp(Buffer.from(svg)).jpeg({ quality, chromaSubsampling: '4:4:4' });
  if (orientation !== 1) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

/** JPEG liso, quando o teste só precisa de dimensões. */
async function solidJpeg({ width, height, color = '#888888' } = {}) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Moldura PNG: borda opaca e miolo transparente.
 * É o formato real de uma moldura de evento — se a composição apagar a
 * transparência, a foto some atrás da moldura e o teste acusa.
 */
async function framePng({ width, height, border = 0.08, color = '#003B71' } = {}) {
  const bx = Math.round(width * border);
  const by = Math.round(height * border);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" fill="${color}"/>
    <rect x="${bx}" y="${by}" width="${width - bx * 2}" height="${height - by * 2}" fill="#000000" fill-opacity="0"/>
  </svg>`;
  // O SVG acima pinta a borda inteira; recortar o miolo exige compor com
  // um canal alpha, e é isso que dest-out faz.
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  const hole = await sharp({
    create: {
      width: width - bx * 2,
      height: height - by * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  return sharp(base)
    .composite([{ input: hole, left: bx, top: by, blend: 'dest-out' }])
    .png()
    .toBuffer();
}

/** Bytes que não são imagem nenhuma. */
function corruptJpeg() {
  return Buffer.from('não sou um jpeg, sou só texto disfarçado de foto', 'utf8');
}

/** JPEG truncado: cabeçalho válido, dados cortados no meio. */
async function truncatedJpeg({ width = 800, height = 600 } = {}) {
  const full = await solidJpeg({ width, height });
  return full.subarray(0, Math.floor(full.length / 2));
}

/** Cor de um pixel, para afirmar sobre geometria e espelhamento. */
async function pixelAt(buffer, x, y) {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

module.exports = {
  tempDir,
  removeDir,
  quadrantJpeg,
  solidJpeg,
  framePng,
  corruptJpeg,
  truncatedJpeg,
  pixelAt,
};
