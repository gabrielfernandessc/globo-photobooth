/* ══════════════════════════════════════════════════════════
   PUBLISHER — levar a foto para a internet, e só isso

   O núcleo não sabe o que é Vercel. Ele conhece um contrato:

     publish({ id, master, web }) -> { publicUrl }

   Trocar Blob por R2 ou S3 é escrever outra implementação deste
   contrato, sem tocar em captura, pipeline, telão ou fila.

   Nenhuma implementação aqui pode ser chamada no caminho crítico da
   foto: quem chama é o worker da fila, depois de a foto já estar salva.
   ══════════════════════════════════════════════════════════ */

const { config } = require('./config');

/** Falha em publicar que ainda vale retentar (rede, 5xx, timeout). */
class TransientPublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransientPublishError';
    this.transient = true;
  }
}

/** Falha que não melhora com retentativa (credencial, payload inválido). */
class PermanentPublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentPublishError';
    this.transient = false;
  }
}

/**
 * Sem nuvem configurada.
 *
 * Não é um erro: é o modo padrão de um totem que roda só na LAN. A foto
 * existe, o telão mostra, o QR local funciona. Dizer "falhou" aqui seria
 * mentir sobre o estado do sistema.
 */
function nullPublisher() {
  return {
    kind: 'none',
    configured: false,
    async check() {
      return { ok: true, detail: 'nenhuma nuvem configurada' };
    },
    async publish() {
      return { skipped: true, reason: 'nenhuma nuvem configurada' };
    },
  };
}

/**
 * Vercel Blob + a página pública que já existe no deploy.
 *
 * As chaves são as mesmas que o totem usa em disco. Isso é intencional:
 * a página pública resolve a foto pelo id, reconstruindo as chaves, sem
 * precisar de banco nenhum do lado da nuvem. O deploy vira o que devia
 * ter sido desde o começo — um visualizador sem estado.
 */
function vercelBlobPublisher() {
  const { put } = require('@vercel/blob');
  const token = config.blobToken;
  const base = String(config.publicBaseUrl || '').replace(/\/+$/, '');

  async function upload(key, body, contentType) {
    const result = await put(key, body, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      cacheControlMaxAge: 31536000,
      token,
      // Sem isto uma rede ruim segura o worker indefinidamente.
      abortSignal: AbortSignal.timeout(config.cloud.timeoutMs),
    });
    return result.url;
  }

  return {
    kind: 'vercel-blob',
    configured: true,

    async check() {
      if (!token) return { ok: false, detail: 'BLOB_READ_WRITE_TOKEN ausente' };
      if (!base) return { ok: false, detail: 'PUBLIC_BASE_URL ausente' };
      return { ok: true, detail: base };
    },

    async publish({ id, master, web }) {
      if (!token) throw new PermanentPublishError('BLOB_READ_WRITE_TOKEN ausente');
      if (!base) throw new PermanentPublishError('PUBLIC_BASE_URL ausente');

      try {
        // O master primeiro: é o que o botão de download entrega, e é o
        // que não pode faltar se a segunda subida falhar.
        await upload(`final/globo_${id}.jpg`, master, 'image/jpeg');
        if (web) await upload(`web/globo_${id}_web.jpg`, web, 'image/jpeg');
      } catch (err) {
        throw classify(err);
      }

      return { publicUrl: `${base}/photo/${id}` };
    },
  };
}

/**
 * Rede caiu, DNS falhou, servidor devolveu 5xx: tudo isso melhora
 * sozinho e merece retentativa. Credencial errada, não.
 */
function classify(err) {
  const message = err?.message || String(err);
  const status = err?.status || err?.statusCode;

  if (status === 401 || status === 403) {
    return new PermanentPublishError(`credencial recusada pela nuvem (HTTP ${status})`);
  }
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new PermanentPublishError(`nuvem recusou o envio (HTTP ${status}): ${message}`);
  }
  return new TransientPublishError(message);
}

let publisher = null;

function getPublisher() {
  if (publisher) return publisher;
  publisher = config.cloud.driver === 'vercel-blob' ? vercelBlobPublisher() : nullPublisher();
  return publisher;
}

/** Só para teste: injeta uma implementação e devolve a anterior. */
function setPublisher(custom) {
  const previous = publisher;
  publisher = custom;
  return previous;
}

module.exports = {
  getPublisher,
  setPublisher,
  nullPublisher,
  vercelBlobPublisher,
  TransientPublishError,
  PermanentPublishError,
};
