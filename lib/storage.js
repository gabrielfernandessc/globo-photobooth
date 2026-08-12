/* ══════════════════════════════════════════════════════════
   STORAGE — onde as fotos ficam

   local  public/uploads/, servido pelo express.static do próprio app
   blob   Vercel Blob; o filesystem da Vercel é read-only e /tmp não
          sobrevive à instância, então o disco não é opção lá

   Os dois drivers devolvem { key, url }, e o resto do app não sabe a
   diferença.
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

/* ── Driver: filesystem local ───────────────────────────── */

function localDriver() {
  const dirs = {
    original: path.join(config.uploadsDir, 'original'),
    final: path.join(config.uploadsDir, 'final'),
    web: path.join(config.uploadsDir, 'web'),
    thumb: path.join(config.uploadsDir, 'thumb'),
    frame: path.join(config.uploadsDir, 'frame'),
  };

  function ensure() {
    Object.values(dirs).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
    if (config.saveToDownloads) fs.mkdirSync(config.downloadsDir, { recursive: true });
  }
  ensure();

  return {
    kind: 'local',
    async put(folder, filename, buffer) {
      const dir = dirs[folder] || path.join(config.uploadsDir, folder);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, filename), buffer);
      // URL relativa: o host correto é resolvido pelo navegador, o que
      // mantém o app funcionando em http, https e via túnel sem ajuste.
      return { key: `${folder}/${filename}`, url: `/uploads/${folder}/${encodeURIComponent(filename)}` };
    },
    async get(key) {
      return fs.promises.readFile(path.join(config.uploadsDir, key));
    },
    async exists(key) {
      return fs.existsSync(path.join(config.uploadsDir, key));
    },
    async urlFor(key) {
      return fs.existsSync(path.join(config.uploadsDir, key)) ? `/uploads/${key}` : null;
    },
    localPath(key) {
      return path.join(config.uploadsDir, key);
    },
  };
}

/* ── Driver: Vercel Blob ────────────────────────────────── */

function blobDriver() {
  const { put, head } = require('@vercel/blob');
  const token = config.blobToken || undefined;

  return {
    kind: 'blob',
    async put(folder, filename, buffer, contentType = 'image/jpeg') {
      const key = `${folder}/${filename}`;
      const result = await put(key, buffer, {
        access: 'public',
        contentType,
        // O nome já carrega timestamp; sufixo aleatório quebraria as
        // URLs derivadas (web/thumb a partir do nome do master).
        addRandomSuffix: false,
        cacheControlMaxAge: 31536000,
        token,
      });
      return { key, url: result.url };
    },
    async get(keyOrUrl) {
      const url = keyOrUrl.startsWith('http') ? keyOrUrl : (await head(keyOrUrl, { token })).url;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Falha ao ler do Blob: HTTP ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer());
    },
    async exists(key) {
      try { await head(key, { token }); return true; } catch { return false; }
    },
    /** URL pública a partir da chave, sem depender de estado local. */
    async urlFor(key) {
      try { return (await head(key, { token })).url; } catch { return null; }
    },
    localPath() { return null; },
  };
}

let storage = null;

function getStorage() {
  if (storage) return storage;
  storage = config.storageDriver === 'blob' ? blobDriver() : localDriver();
  return storage;
}

/** Baixa uma imagem que o celular já enviou direto para o Blob. */
async function fetchRemote(url, maxBytes) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Não foi possível baixar a foto (HTTP ${resp.status})`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (maxBytes && buffer.length > maxBytes) throw new Error('Foto acima do tamanho permitido');
  return buffer;
}

module.exports = { getStorage, fetchRemote };
