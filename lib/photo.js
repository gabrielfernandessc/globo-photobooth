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

/**
 * failOn: 'none' não é frouxidão — é requisito.
 *
 * O libvips trata avisos do libjpeg como erro fatal por padrão, e os
 * JPEGs que saem do Galaxy disparam "Invalid SOS parameters for
 * sequential JPEG": o arquivo carrega metadados proprietários da
 * Samsung depois dos dados de imagem. A foto é perfeitamente decodável;
 * quem recusava era a política padrão.
 *
 * limitInputPixels: false porque 50 MP passa do teto embutido.
 */
const SHARP_INPUT = { failOn: 'none', limitInputPixels: false };

/**
 * Quanto a arte da moldura pode ser ampliada antes de a foto ceder.
 *
 * Acima disso o texto da moldura começa a ficar visivelmente mole, e
 * letra borrada é um defeito que todo convidado enxerga — enquanto
 * alguns pixels a menos na foto ninguém percebe. Se a arte for exportada
 * em resolução maior, este limite deixa de ser alcançado sozinho.
 */
const MAX_AMPLIACAO_MOLDURA = 3;

/** Diferença de proporção a partir da qual a janela deixa de ser "a moldura inteira". */
const TOLERANCIA_PROPORCAO = 0.02;

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

/**
 * Onde a foto aparece dentro da moldura.
 *
 * Uma moldura de evento raramente é uma borda uniforme: ela tem título,
 * logo, hashtag, e uma JANELA recortada onde a foto entra. Essa janela
 * quase nunca tem a proporção da moldura inteira — a deste evento é
 * 16:9 dentro de uma arte 4:3.
 *
 * Esticar a foto sobre a moldura toda e torcer para o recorte coincidir
 * é como o rosto do convidado acaba cortado. Então a janela é medida:
 * varre o canal alpha e devolve o retângulo transparente.
 *
 * Devolve null quando não há transparência nenhuma — e isso é um erro
 * do arquivo, não do sistema: uma moldura opaca cobriria a foto inteira.
 */
async function detectarJanela(frameBuffer, { limiteAlpha = 16 } = {}) {
  const imagem = sharp(frameBuffer, SHARP_INPUT).ensureAlpha();
  const { data, info } = await imagem.raw().toBuffer({ resolveWithObject: true });

  const canais = info.channels;
  let esquerda = info.width;
  let topo = info.height;
  let direita = -1;
  let base = -1;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * canais + (canais - 1)];
      if (alpha > limiteAlpha) continue; // opaco: é moldura, não janela

      if (x < esquerda) esquerda = x;
      if (x > direita) direita = x;
      if (y < topo) topo = y;
      if (y > base) base = y;
    }
  }

  if (direita < 0 || base < 0) return null;

  return {
    left: esquerda,
    top: topo,
    width: direita - esquerda + 1,
    height: base - topo + 1,
    frameWidth: info.width,
    frameHeight: info.height,
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

/**
 * Compõe quando a moldura tem uma janela recortada.
 *
 * A resolução final é uma disputa entre duas coisas boas:
 *
 *   - a foto quer o canvas GRANDE, para caber os 24 MP do sensor
 *   - a moldura quer o canvas do TAMANHO DELA, porque ampliar arte com
 *     texto deixa as letras moles
 *
 * O empate se resolve limitando a ampliação da moldura: acima disso a
 * foto é reduzida em vez de a arte ser esticada. Letra borrada é um
 * defeito que todo convidado vê; alguns pixels a menos na foto, não.
 */
async function comporComJanela(pipelineFoto, frameBuffer, janela, ratioAlvo) {
  const escalaParaFoto = ratioAlvo.width / janela.width;
  const escala = Math.min(escalaParaFoto, MAX_AMPLIACAO_MOLDURA);

  const canvasWidth = Math.round(janela.frameWidth * escala);
  const canvasHeight = Math.round(janela.frameHeight * escala);
  const janelaWidth = Math.round(janela.width * escala);
  const janelaHeight = Math.round(janela.height * escala);

  const foto = await pipelineFoto
    .resize(janelaWidth, janelaHeight, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
    .toBuffer();

  const moldura = await sharp(frameBuffer, SHARP_INPUT)
    .resize(canvasWidth, canvasHeight, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const composto = sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 3, background: '#ffffff' },
  }).composite([
    { input: foto, left: Math.round(janela.left * escala), top: Math.round(janela.top * escala) },
    { input: moldura, left: 0, top: 0 },
  ]);

  return {
    pipeline: composto,
    width: canvasWidth,
    height: canvasHeight,
    janela: { width: janelaWidth, height: janelaHeight },
    ampliacaoMoldura: +escala.toFixed(2),
    limitadaPelaMoldura: escalaParaFoto > MAX_AMPLIACAO_MOLDURA,
  };
}

/**
 * Moldura pronta para composição, ou null se ela não puder ser usada.
 *
 * Tanto a leitura quanto a decodificação ficam protegidas: o arquivo é
 * escolhido pelo operador e um PNG inválido não pode derrubar a captura.
 */
async function renderFrame(session, aspectRatio, width, height) {
  const buffer = await loadFrame(session, aspectRatio);
  if (!buffer) return null;
  try {
    return await sharp(buffer, SHARP_INPUT)
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer();
  } catch (err) {
    console.error('Moldura não pôde ser decodificada, seguindo sem ela:', err.message);
    return null;
  }
}

async function composeFinalPhoto(input, options = {}) {
  const { session, aspectRatio = '3:4', mirror = false, source = 'web' } = options;
  const storage = getStorage();

  const meta = await sharp(input, SHARP_INPUT).metadata();
  if (!meta.width || !meta.height) throw new Error('Imagem inválida (sem dimensões)');

  // Nas orientações EXIF 5–8 o auto-rotate troca largura e altura.
  const rotates = (meta.orientation || 1) >= 5;
  const srcWidth = rotates ? meta.height : meta.width;
  const srcHeight = rotates ? meta.width : meta.height;

  /* A moldura manda no enquadramento.
     Se ela tem uma janela recortada, é a proporção DA JANELA que define
     o corte — não a pedida pelo cliente. Cortar em 3:4 e depois encaixar
     numa janela 16:9 é como o rosto do convidado acaba fora. */
  const frameBuffer = await loadFrame(session, aspectRatio);
  const janela = frameBuffer ? await detectarJanela(frameBuffer).catch(() => null) : null;

  const proporcaoJanela = janela ? janela.width / janela.height : null;
  const proporcaoMoldura = janela ? janela.frameWidth / janela.frameHeight : null;
  const usarJanela = !!janela
    && Math.abs(proporcaoJanela - proporcaoMoldura) > TOLERANCIA_PROPORCAO;

  const crop = centerCrop(srcWidth, srcHeight, usarJanela ? proporcaoJanela : ratioValue(aspectRatio));

  let finalWidth = crop.width;
  let finalHeight = crop.height;
  const longSide = Math.max(finalWidth, finalHeight);
  const capped = config.quality.maxFinalLongSide > 0 && longSide > config.quality.maxFinalLongSide;
  if (capped) {
    const scale = config.quality.maxFinalLongSide / longSide;
    finalWidth = Math.round(finalWidth * scale);
    finalHeight = Math.round(finalHeight * scale);
  }

  let pipeline = sharp(input, SHARP_INPUT).rotate().extract(crop);
  if (mirror) pipeline = pipeline.flop();
  if (capped) pipeline = pipeline.resize(finalWidth, finalHeight, { fit: 'fill', kernel: 'lanczos3' });

  /* A moldura vem de upload do operador: pode ser qualquer arquivo, e um
     PNG que o libvips recusa não pode custar a foto do convidado. Perder
     a moldura é um defeito visual; perder a captura é perder o momento. */
  let janelaAplicada = null;
  let frame = null;

  if (usarJanela) {
    try {
      const composto = await comporComJanela(pipeline, frameBuffer, janela, { width: finalWidth });
      pipeline = composto.pipeline;
      finalWidth = composto.width;
      finalHeight = composto.height;
      janelaAplicada = composto;
      frame = true;
    } catch (err) {
      console.error('Composição com janela falhou, seguindo sem moldura:', err.message);
    }
  } else {
    frame = await renderFrame(session, aspectRatio, finalWidth, finalHeight);
    if (frame) pipeline = pipeline.composite([{ input: frame, left: 0, top: 0 }]);
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
      frameApplied: !!frame,
      // Diagnóstico do enquadramento: é o que permite conferir depois
      // por que uma foto saiu com o corte que saiu.
      janela: janelaAplicada && {
        largura: janelaAplicada.janela.width,
        altura: janelaAplicada.janela.height,
        proporcao: +(proporcaoJanela).toFixed(3),
        ampliacaoMoldura: janelaAplicada.ampliacaoMoldura,
        limitadaPelaMoldura: janelaAplicada.limitadaPelaMoldura,
      },
      resampled: capped,
    },
  };
}

module.exports = { composeFinalPhoto, centerCrop, ratioValue };
