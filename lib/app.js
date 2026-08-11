/* ══════════════════════════════════════════════════════════
   APP — Express + Socket.IO, sem listen()

   O mesmo app serve os dois destinos: server.js (local, persistente)
   e api/server.js (Vercel, serverless). Só o boot muda.

   Presença por SALAS, não por id de socket: numa função serverless a
   instância recicla e ids guardados viram lixo. `code:display`,
   `code:camera` e `code:control` são salas, e o adapter do Redis as
   sincroniza entre instâncias — então `io.to(sala)` funciona mesmo
   quando o celular e o totem estão em funções diferentes.
   ══════════════════════════════════════════════════════════ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const { config, clamp, int } = require('./config');
const { initStore, getStore, getRedisClients, generateCode, normalizeCode, newSession } = require('./store');
const { getStorage, fetchRemote } = require('./storage');
const { composeFinalPhoto } = require('./photo');
const pkg = require('../package.json');

const APP_STARTED_AT = new Date().toISOString();
const ROLES = ['display', 'camera', 'control'];
const roomFor = (code, role) => `${code}:${role}`;

/** O que o navegador precisa saber para se conectar e enviar fotos. */
function clientConfig() {
  return {
    socketPath: config.socketPath,
    transports: config.isVercel ? ['websocket'] : ['polling', 'websocket'],
    directUpload: config.directUpload,
    maxUploadBytes: config.maxUploadBytes,
    platform: config.isVercel ? 'vercel' : 'self-hosted',
    storage: config.storageDriver,
    state: config.stateDriver,
  };
}

async function createApp() {
  await initStore();
  const store = getStore();
  const storage = getStorage();

  const app = express();
  const server = http.createServer(app);

  const io = new Server(server, {
    maxHttpBufferSize: 8e6,
    pingTimeout: 25000,
    path: config.socketPath,
    // Na Vercel o long-polling do Socket.IO quebra: cada requisição pode
    // cair numa instância diferente. WebSocket puro evita isso.
    transports: config.isVercel ? ['websocket'] : ['polling', 'websocket'],
    cors: { origin: true, credentials: true },
  });

  const redis = getRedisClients();
  if (redis) {
    const { createAdapter } = require('@socket.io/redis-adapter');
    io.adapter(createAdapter(redis.pub, redis.sub));
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes },
  });

  app.use(express.json({ limit: config.isVercel ? '4mb' : '80mb' }));
  app.use(express.urlencoded({ extended: true, limit: config.isVercel ? '4mb' : '80mb' }));
  app.use(express.static(config.publicDir));
  if (storage.kind === 'local') {
    app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1h', immutable: true }));
  }

  // O cliente do Socket.IO sai daqui, e não de <socketPath>/socket.io.js:
  // assim o <script> no HTML não muda quando o caminho do socket muda
  // entre o modo local e a Vercel.
  app.use(
    '/js/vendor',
    express.static(path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist'), {
      maxAge: '1d',
    })
  );

  /* ═══════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════ */

  async function loadSession(value) {
    const code = normalizeCode(value);
    if (!code) return null;
    const session = await store.get(code);
    if (session) await store.touch(code);
    return session;
  }

  const presence = code => store.getPresence(code);

  async function snapshot(session) {
    return {
      code: session.code,
      settings: session.settings,
      cameraInfo: session.cameraInfo || null,
      hasFrame3x4: !!session.frames['3:4'],
      hasFrame4x3: !!session.frames['4:3'],
      photoCount: session.photos.length,
      ...(await presence(session.code)),
    };
  }

  async function broadcastPresence(session) {
    io.to(session.code).emit('presence', await snapshot(session));
  }

  function safeBasename(value, fallback = '') {
    return path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /** Id estável da foto, usado nas URLs públicas (/photo/:id). */
  function photoIdFromName(finalName) {
    const match = /^globo_(\d+_\d+x\d+)\.jpg$/.exec(finalName);
    return match ? match[1] : null;
  }

  async function persistPhoto(refs, meta) {
    const id = photoIdFromName(path.basename(refs.final.key));
    const record = {
      id,
      final: refs.final.url,
      web: refs.web.url,
      thumb: refs.thumb.url,
      original: refs.original?.url || null,
      meta,
      ts: Date.now(),
    };
    if (id) await store.putRecord(id, record);
    return record;
  }

  function urlsFor(record) {
    return {
      imageUrl: record.web,
      fullUrl: record.final,
      thumbUrl: record.thumb,
      originalUrl: record.original,
      pageUrl: `/photo/${record.id}`,
      downloadUrl: `/download/${record.id}`,
    };
  }

  /** Compõe, guarda, avisa a sessão. Caminho único das três origens. */
  async function processCapture(buffer, { code, aspectRatio, mirror, source }) {
    const session = await loadSession(code);
    const { refs, meta } = await composeFinalPhoto(buffer, { session, aspectRatio, mirror, source });
    const record = await persistPhoto(refs, meta);
    const urls = urlsFor(record);

    if (session) {
      session.photos.push({ ...urls, url: urls.imageUrl, thumbnail: urls.thumbUrl, page: urls.pageUrl, ts: record.ts });
      await store.put(session);
      io.to(session.code).emit('photo-ready', {
        ...urls, url: urls.imageUrl, thumbnail: urls.thumbUrl, page: urls.pageUrl,
        total: session.photos.length,
      });
      io.to(roomFor(session.code, 'display')).emit('capture-result', { ...urls, meta });
    }

    return { ...urls, meta };
  }

  /* ═══════════════════════════════════════════════════════
     REST
     ═══════════════════════════════════════════════════════ */

  // O cliente precisa saber onde o Socket.IO mora e se o upload da foto
  // vai direto para o Blob (limite de 4,5 MB por request na Vercel).
  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(clientConfig());
  });

  // A mesma config como script clássico: carregado antes das páginas,
  // garante window.__BOOTH__ preenchido sem nenhum await no cliente.
  app.get('/api/config.js', (req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(`window.__BOOTH__=${JSON.stringify(clientConfig())};`);
  });

  app.get('/api/version', (req, res) => {
    const date = new Date(APP_STARTED_AT);
    res.json({
      version: pkg.version,
      updatedAt: APP_STARTED_AT,
      label: `v${pkg.version} • ${date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`,
    });
  });

  app.get('/api/health', async (req, res) => {
    try {
      await store.has('ZZZZ');
      res.json({ ok: true, state: config.stateDriver, storage: config.storageDriver });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // QR gerado localmente — o evento não depende de internet.
  app.get('/api/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data) return res.status(400).send('missing data');
    try {
      const png = await QRCode.toBuffer(data, {
        type: 'png',
        width: clamp(int(req.query.size, 420), 120, 1200),
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: `#${String(req.query.color || '003B71').replace('#', '')}`, light: '#FFFFFFFF' },
      });
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(png);
    } catch (err) {
      res.status(500).send('qr failed');
    }
  });

  /* ── Upload direto para o Blob ──
     O celular pede um token, manda a foto do navegador direto para o
     Blob e depois só avisa a URL. Nada de 6 MB passando pela função. */
  app.post('/api/blob/upload', express.json({ limit: '1mb' }), async (req, res) => {
    if (config.storageDriver !== 'blob') {
      return res.status(400).json({ error: 'Upload direto indisponível neste modo' });
    }
    try {
      const { handleUpload } = require('@vercel/blob/client');
      const result = await handleUpload({
        body: req.body,
        request: req,
        token: config.blobToken,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          // A sessão é a autorização: sem um código válido e vivo,
          // ninguém consegue token para escrever no store.
          const code = normalizeCode(clientPayload);
          if (!code || !(await store.has(code))) throw new Error('Sessão inválida');
          return {
            allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
            addRandomSuffix: true,
            maximumSizeInBytes: 64 * 1024 * 1024,
            tokenPayload: code,
          };
        },
        // Sem onUploadCompleted de propósito: o webhook não alcança
        // localhost e o celular já avisa a URL em /api/photo/capture-url.
        onUploadCompleted: async () => {},
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Foto já no Blob: recebe só a URL (payload minúsculo). */
  app.post('/api/photo/capture-url', async (req, res) => {
    try {
      const { sourceUrl, code, aspectRatio = '3:4', mirror = false, source = 'phone' } = req.body || {};
      if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl ausente' });
      if (!/^https:\/\/[\w.-]+\.public\.blob\.vercel-storage\.com\//.test(sourceUrl)) {
        return res.status(400).json({ error: 'sourceUrl não é um blob deste projeto' });
      }
      const buffer = await fetchRemote(sourceUrl, 64 * 1024 * 1024);
      const data = await processCapture(buffer, { code, aspectRatio, mirror: !!mirror, source });
      res.json({ success: true, data });
    } catch (err) {
      console.error('capture-url:', err);
      res.status(500).json({ error: err.message || 'Falha ao processar a foto' });
    }
  });

  /** Foto vinda por multipart (modo local, sem limite de 4,5 MB). */
  app.post('/api/photo/capture', upload.single('photo'), async (req, res) => {
    try {
      if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Arquivo ausente' });
      const data = await processCapture(req.file.buffer, {
        code: req.body.code,
        aspectRatio: req.body.aspectRatio || '3:4',
        mirror: String(req.body.mirror) === 'true',
        source: req.body.source || 'phone',
      });
      res.json({ success: true, data });
    } catch (err) {
      console.error('capture:', err);
      res.status(500).json({ error: err.message || 'Falha ao processar a foto' });
    }
  });

  /** Webcam do próprio totem (data URL) — caminho legado. */
  app.post('/api/photo/finalize', async (req, res) => {
    try {
      const { image, code, aspectRatio = '3:4', mirror = true } = req.body || {};
      if (!image) return res.status(400).json({ error: 'Sem imagem' });
      const buffer = Buffer.from(String(image).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const data = await processCapture(buffer, { code, aspectRatio, mirror: !!mirror, source: 'webcam' });
      res.json({ success: true, data });
    } catch (err) {
      console.error('finalize:', err);
      res.status(500).json({ error: err.message || 'Falha ao finalizar' });
    }
  });

  /* ── Moldura ── */

  app.post('/api/frame/:code', upload.single('frame'), async (req, res) => {
    const session = await loadSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Arquivo ausente' });

    const ratio = req.body.aspectRatio === '4:3' ? '4:3' : '3:4';
    const mime = req.file.mimetype || 'image/png';

    if (storage.kind === 'blob') {
      const ref = await storage.put('frame', `frame_${session.code}_${ratio.replace(':', 'x')}_${Date.now()}.png`, req.file.buffer, mime);
      session.frames[ratio] = { key: ref.key, url: ref.url, mime };
    } else {
      session.frames[ratio] = { data: req.file.buffer.toString('base64'), mime };
    }
    await store.put(session);

    io.to(session.code).emit('frame-updated', {
      aspectRatio: ratio,
      frameUrl: `/api/frame/${session.code}?ratio=${encodeURIComponent(ratio)}&t=${Date.now()}`,
    });
    res.json({ success: true });
  });

  app.delete('/api/frame/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    const ratio = req.query.ratio === '4:3' ? '4:3' : '3:4';
    session.frames[ratio] = null;
    await store.put(session);
    io.to(session.code).emit('frame-updated', { aspectRatio: ratio, frameUrl: null });
    res.json({ success: true });
  });

  app.get('/api/frame/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    if (!session) return res.status(404).send('Sessão não encontrada');
    const frame = session.frames[req.query.ratio === '4:3' ? '4:3' : '3:4'];
    if (!frame) return res.status(404).send('Sem moldura');
    if (frame.url) return res.redirect(302, frame.url);
    res.set('Content-Type', frame.mime || 'image/png');
    res.send(Buffer.from(frame.data, 'base64'));
  });

  /* ── Sessão ── */

  app.get('/api/photos/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    res.json({ photos: session?.photos || [] });
  });

  app.get('/api/session/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json(await snapshot(session));
  });

  /* ── Página da foto (aberta pelo QR) ── */

  async function resolvePhoto(idOrName) {
    const raw = safeBasename(idOrName);
    const id = photoIdFromName(raw) || raw.replace(/\.jpg$/i, '');
    const record = await store.getRecord(id);
    if (record) return record;

    // Fallback do modo local: o arquivo pode existir mesmo que o
    // registro tenha expirado (ex.: servidor reiniciado).
    if (storage.kind === 'local') {
      const finalName = `globo_${id}.jpg`;
      if (await storage.exists(`final/${finalName}`)) {
        return {
          id,
          final: `/uploads/final/${encodeURIComponent(finalName)}`,
          web: (await storage.exists(`web/globo_${id}_web.jpg`))
            ? `/uploads/web/${encodeURIComponent(`globo_${id}_web.jpg`)}`
            : `/uploads/final/${encodeURIComponent(finalName)}`,
        };
      }
    }
    return null;
  }

  app.get('/photo/:id', async (req, res) => {
    const record = await resolvePhoto(req.params.id);
    if (!record) return res.status(404).send('Foto não encontrada');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDownloadPage(record));
  });

  app.get('/download/:id', async (req, res) => {
    const record = await resolvePhoto(req.params.id);
    if (!record) return res.status(404).send('Foto não encontrada');

    if (storage.kind === 'local') {
      const localPath = storage.localPath(`final/globo_${record.id}.jpg`);
      if (localPath && fs.existsSync(localPath)) {
        return res.download(localPath, `globo_foto_${record.id}.jpg`);
      }
      return res.redirect(302, record.final);
    }
    // O Blob força o download com ?download=1, sem proxiar 6 MB pela função.
    res.redirect(302, `${record.final}${record.final.includes('?') ? '&' : '?'}download=1`);
  });

  /* ═══════════════════════════════════════════════════════
     SOCKET.IO
     ═══════════════════════════════════════════════════════ */

  io.on('connection', socket => {
    /* ── Display: cria ou reassume a sessão ── */
    socket.on('create-session', async ({ requestedCode } = {}, cb = () => {}) => {
      try {
        const requested = normalizeCode(requestedCode);
        let session = requested ? await store.get(requested) : null;
        const rejoined = !!session;

        if (!session) {
          const code = requested && !(await store.has(requested)) ? requested : await generateCode();
          session = newSession(code);
        }
        await store.put(session);

        socket.join(session.code);
        socket.join(roomFor(session.code, 'display'));
        socket.data.code = session.code;
        socket.data.role = 'display';
        await store.addPresence(session.code, 'display', socket.id);

        cb({ code: session.code, rejoined, ...(await snapshot(session)) });
        await broadcastPresence(session);
        // Se um celular já estava transmitindo, refaz a negociação.
        io.to(roomFor(session.code, 'camera')).emit('display-ready');
      } catch (err) {
        console.error('create-session:', err);
        cb({ error: 'Falha ao criar a sessão' });
      }
    });

    /* ── Controle / Câmera entram numa sessão existente ── */
    socket.on('join-session', async (payload, cb = () => {}) => {
      try {
        const raw = typeof payload === 'string' ? { code: payload, role: 'control' } : payload || {};
        const session = await loadSession(raw.code);
        if (!session) return cb({ error: 'Código inválido' });

        const role = raw.role === 'camera' ? 'camera' : 'control';
        socket.join(session.code);
        socket.join(roomFor(session.code, role));
        socket.data.code = session.code;
        socket.data.role = role;
        await store.addPresence(session.code, role, socket.id);

        if (role === 'camera') {
          session.cameraInfo = raw.info || null;
          await store.put(session);
          io.to(roomFor(session.code, 'display')).emit('camera-connected', { info: session.cameraInfo });
        } else {
          io.to(roomFor(session.code, 'display')).emit('controller-connected');
        }

        cb({ success: true, ...(await snapshot(session)) });
        if (session.photos.length) socket.emit('session-photos', { photos: session.photos });
        await broadcastPresence(session);

        if (role === 'camera' && (await presence(session.code)).hasDisplay) {
          socket.emit('display-ready');
        }
      } catch (err) {
        console.error('join-session:', err);
        cb({ error: 'Falha ao entrar na sessão' });
      }
    });

    /* ── Sinalização WebRTC (celular ⇄ totem) ── */
    socket.on('webrtc-signal', ({ code, to, data } = {}) => {
      const session = normalizeCode(code);
      if (!session || !data || !['camera', 'display'].includes(to)) return;
      io.to(roomFor(session, to)).emit('webrtc-signal', { from: socket.data.role, data });
    });

    /* ── Disparo ── */
    socket.on('trigger-capture', async ({ code, timer } = {}) => {
      const session = await loadSession(code);
      if (!session) return;
      // Sala inteira: o totem conduz a contagem e o celular acompanha,
      // acendendo a lanterna a tempo da exposição estabilizar.
      io.to(session.code).emit('start-countdown', { timer: timer || session.settings.timer });
    });

    socket.on('camera-shoot', async ({ code, aspectRatio, flashMode } = {}) => {
      const session = await loadSession(code);
      if (!session) return;
      io.to(roomFor(session.code, 'camera')).emit('camera-shoot', {
        aspectRatio: aspectRatio || session.settings.aspectRatio,
        flashMode: flashMode || session.settings.flashMode,
      });
    });

    socket.on('camera-status', ({ code, status, detail } = {}) => {
      const session = normalizeCode(code);
      if (session) io.to(session).emit('camera-status', { status, detail });
    });

    socket.on('camera-state', async ({ code, state } = {}) => {
      const session = await loadSession(code);
      if (!session) return;
      session.cameraInfo = { ...(session.cameraInfo || {}), ...state };
      await store.put(session);
      io.to(session.code).emit('camera-state', { state: session.cameraInfo });
    });

    socket.on('camera-control', ({ code, cmd } = {}) => {
      const session = normalizeCode(code);
      if (session && cmd) io.to(roomFor(session, 'camera')).emit('camera-control', { cmd });
    });

    socket.on('update-settings', async ({ code, settings } = {}) => {
      const session = await loadSession(code);
      if (!session || !settings) return;
      Object.assign(session.settings, settings);
      await store.put(session);
      io.to(session.code).emit('settings-updated', session.settings);
    });

    socket.on('show-photo', ({ code, url } = {}) => {
      const session = normalizeCode(code);
      if (session) io.to(roomFor(session, 'display')).emit('show-photo', { url });
    });

    socket.on('reset-to-preview', ({ code } = {}) => {
      const session = normalizeCode(code);
      if (session) io.to(roomFor(session, 'display')).emit('reset-to-preview');
    });

    socket.on('cam-control', ({ code, cmd } = {}) => {
      const session = normalizeCode(code);
      if (session && cmd) socket.to(session).emit('cam-control', { cmd });
    });

    /* ── Saída: a sessão nunca é apagada, só a presença muda ── */
    socket.on('disconnect', async () => {
      const code = socket.data.code;
      const role = socket.data.role;
      if (!code || !role) return;

      await store.removePresence(code, role, socket.id);

      // Só avisa se o papel ficou realmente vazio: numa reconexão o
      // aparelho já pode ter voltado por outra conexão.
      const here = await presence(code);
      if (role === 'display' && !here.hasDisplay) {
        io.to(code).emit('display-disconnected');
      } else if (role === 'camera' && !here.hasCamera) {
        io.to(roomFor(code, 'display')).emit('camera-disconnected');
      } else if (role === 'control' && !here.hasControl) {
        io.to(roomFor(code, 'display')).emit('controller-disconnected');
      }

      const session = await store.get(code);
      if (session) io.to(code).emit('presence', await snapshot(session));
    });
  });

  /* ── Erros de upload viram JSON legível ── */
  app.use((err, req, res, next) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Arquivo maior que ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`,
      });
    }
    console.error('Erro na requisição:', err.message);
    res.status(500).json({ error: err.message || 'Erro interno' });
  });

  return { app, server, io, store, storage };
}

function renderDownloadPage(record) {
  const web = record.web || record.final;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sua foto — Globo</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; background: #06121f; color: #fff; display: flex; align-items: center; justify-content: center; padding: 20px; }
    main { width: min(100%, 520px); display: flex; flex-direction: column; gap: 18px; align-items: center; }
    img { width: 100%; height: auto; border: 10px solid #fff; border-radius: 8px; box-shadow: 0 24px 80px rgba(0,0,0,.45); background: #fff; }
    h1 { font-size: 24px; line-height: 1.15; margin: 4px 0 0; text-align: center; }
    p { color: rgba(255,255,255,.72); font-size: 14px; line-height: 1.5; margin: 0; text-align: center; }
    a.dl { width: 100%; display: inline-flex; align-items: center; justify-content: center; min-height: 52px; border-radius: 999px; background: #fff; color: #003B71; text-decoration: none; font-weight: 800; font-size: 16px; }
  </style>
</head>
<body>
  <main>
    <img src="${web}" alt="Sua foto">
    <h1>Sua foto está pronta</h1>
    <p>Toque no botão para baixar o arquivo em resolução máxima, com a moldura.</p>
    <a class="dl" href="/download/${encodeURIComponent(record.id)}">Baixar em alta qualidade</a>
  </main>
</body>
</html>`;
}

module.exports = { createApp };
