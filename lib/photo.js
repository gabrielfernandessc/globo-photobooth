/* ══════════════════════════════════════════════════════════
   PHOTO — composição da foto final

   Pipeline: auto-rotate por EXIF → corte central na proporção →
   espelho opcional → teto opcional de resolução → moldura → JPEG.
   Uma única reamostragem, uma única codificação.

   Metadados (incluindo GPS do celular) são removidos das versões
   públicas; o original com EXIF fica guardado à parte.
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { config } = require('./config');
const { getStorage } = require('./storage');

sharp.cache(false);
sharp.concurrency(config.sharpConcurrency);

function ratioValue(aspectRatio) {
  const [a, b] = String(aspectRatio || '3:4').split(':').map(Number);
  return a > 0 && b > 0 ? a / b : 3 / 4;
}

/**
 * Maior retângulo centralizado com a proporção alvo que cabe na imagem.
 * Corte puro, sem reamostrar — nenhum pixel do sensor é inventado.
 */
function centerCrop(width, height, ratio) {
  let w = width;
  let h = Math.round(width / ratio);
  if (h > height) {
    h = height;
    w = Math.round(height * ratio);
  }
  return {
    left: Math.max(0, Math.floor((width - w) / 2)),
    top: Math.max(0, Math.floor((height - h) / 2)),
    width: Math.min(w, width),
    height: Math.min(h, height),
  };
}

async function loadFrame(session, aspectRatio) {
  const frame = session?.frames?.[aspectRatio === '4:3' ? '4:3' : '3:4'];
  if (!frame) return null;
  try {
    // Driver local guarda base64 inline; Blob guarda a chave.
    if (frame.data) return Buffer.from(frame.data, 'base64');
    if (frame.key) return await getStorage().get(frame.key);
  } catch (err) {
    console.error('Moldura ilegível, seguindo sem ela:', err.message);
  }
  return null;
}

async function composeFinalPhoto(input, options = {}) {
  const { session, aspectRatio = '3:4', mirror = false, source = 'web' } = options;
  const storage = getStorage();

  const meta = await sharp(input, { limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height) throw new Error('Imagem inválida (sem dimensões)');

  // Nas orientações EXIF 5–8 o auto-rotate troca largura e altura.
  const rotates = (meta.orientation || 1) >= 5;
  const srcWidth = rotates ? meta.height : meta.width;
  const srcHeight = rotates ? meta.width : meta.height;

  const crop = centerCrop(srcWidth, srcHeight, ratioValue(aspectRatio));

  let finalWidth = crop.width;
  let finalHeight = crop.height;
  const longSide = Math.max(finalWidth, finalHeight);
  const capped = config.quality.maxFinalLongSide > 0 && longSide > config.quality.maxFinalLongSide;
  if (capped) {
    const scale = config.quality.maxFinalLongSide / longSide;
    finalWidth = Math.round(finalWidth * scale);
    finalHeight = Math.round(finalHeight * scale);
  }

  let pipeline = sharp(input, { limitInputPixels: false }).rotate().extract(crop);
  if (mirror) pipeline = pipeline.flop();
  if (capped) pipeline = pipeline.resize(finalWidth, finalHeight, { fit: 'fill', kernel: 'lanczos3' });

  const frameBuffer = await loadFrame(session, aspectRatio);
  if (frameBuffer) {
    const frame = await sharp(frameBuffer)
      .resize(finalWidth, finalHeight, { fit: 'fill' })
      .png()
      .toBuffer();
    pipeline = pipeline.composite([{ input: frame, left: 0, top: 0 }]);
  }

  const finalBuffer = await pipeline
    .jpeg({ quality: config.quality.final, chromaSubsampling: '4:4:4', mozjpeg: false })
    .toBuffer();

  // Derivadas de rede: o convidado abre a versão web no 4G; o master
  // fica atrás do botão de download.
  const [webBuffer, thumbBuffer] = await Promise.all([
    sharp(finalBuffer)
      .resize(config.quality.webLongSide, config.quality.webLongSide, {
        fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3',
      })
      .jpeg({ quality: config.quality.web, mozjpeg: true })
      .toBuffer(),
    sharp(finalBuffer)
      .resize(config.quality.thumbLongSide, config.quality.thumbLongSide, {
        fit: 'inside', withoutEnlargement: true,
      })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer(),
  ]);

  // O sufixo aleatório existe por privacidade: sem ele o nome do arquivo
  // é só um timestamp, e as fotos ficariam num Blob público com URLs
  // adivinháveis por força bruta. O id continua determinístico, então a
  // página do QR ainda reconstrói tudo sem consultar estado.
  const salt = crypto.randomBytes(4).toString('hex');
  const stamp = `${Date.now()}_${String(aspectRatio).replace(':', 'x')}_${salt}`;
  const names = {
    final: `globo_${stamp}.jpg`,
    web: `globo_${stamp}_web.jpg`,
    thumb: `globo_${stamp}_thumb.jpg`,
  };

  const [finalRef, webRef, thumbRef] = await Promise.all([
    storage.put('final', names.final, finalBuffer),
    storage.put('web', names.web, webBuffer),
    storage.put('thumb', names.thumb, thumbBuffer),
  ]);

  let originalRef = null;
  if (config.saveOriginal) {
    originalRef = await storage
      .put('original', `globo_${stamp}_original.jpg`, input)
      .catch(err => { console.error('Falha ao guardar o original:', err.message); return null; });
  }

  if (config.saveToDownloads) {
    // Cópia de cortesia no PC do totem, sem segurar a resposta.
    fs.promises
      .writeFile(path.join(config.downloadsDir, names.final), finalBuffer)
      .catch(err => console.error('Falha ao copiar para Downloads:', err.message));
  }

  return {
    names,
    refs: { final: finalRef, web: webRef, thumb: thumbRef, original: originalRef },
    meta: {
      source,
      sourceWidth: srcWidth,
      sourceHeight: srcHeight,
      sourceMegapixels: +((srcWidth * srcHeight) / 1e6).toFixed(1),
      cropWidth: crop.width,
      cropHeight: crop.height,
      finalWidth,
      finalHeight,
      finalBytes: finalBuffer.length,
      webBytes: webBuffer.length,
      inputBytes: input.length,
      format: 'jpeg',
      quality: config.quality.final,
      aspectRatio,
      mirror,
      frameApplied: !!frameBuffer,
      resampled: capped,
    },
  };
}

module.exports = { composeFinalPhoto, centerCrop, ratioValue };
