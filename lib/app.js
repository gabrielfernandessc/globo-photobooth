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
const {
  initStore, getStore, getRepo, getRedisClients, generateCode, normalizeCode, newSession,
  signCode, verifySignedCode,
} = require('./store');
const { getStorage, fetchRemote } = require('./storage');
const { composeFinalPhoto } = require('./photo');
const { getPublisher } = require('./publisher');
const { createShareQueue } = require('./share-queue');
const { lanAddresses, primaryLanAddress } = require('./network');
const { createPreviewHub, cabecalhosMjpeg, quadroMjpeg } = require('./preview');
const { createGphotoCamera } = require('./camera-gphoto');
const pkg = require('../package.json');

const APP_STARTED_AT = new Date().toISOString();
const ROLES = ['display', 'camera', 'control'];
const roomFor = (code, role) => `${code}:${role}`;

/**
 * Log estruturado com captureId.
 *
 * Uma foto atravessa celular, upload, pipeline, disco, telão e fila. Sem
 * um id comum, investigar "a foto da moça de vermelho não saiu" vira
 * arqueologia. Com ele, um grep conta a história inteira.
 */
/** Espaço livre onde as fotos são gravadas — o operador precisa saber. */
async function freeDiskBytes() {
  const stats = await fs.promises.statfs(config.dataDir).catch(() => fs.promises.statfs(process.cwd()));
  return stats.bavail * stats.bsize;
}

function logStructured(level, message, fields = {}) {
  const line = { ts: new Date().toISOString(), level, msg: message, ...fields };
  const destino = level === 'error' ? console.error : console.log;
  destino(JSON.stringify(line));
}

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
    iceServers: config.ice.servers,
    hasTurn: config.ice.hasTurn,
    relay: config.relay,

    /* De onde o telão tira o preview. A foto vem sempre da câmera; isto
       diz apenas o que mostrar ENQUANTO o convidado se posiciona.
       'nenhum' é modo de primeira classe, não degradação. */
    preview: {
      fonte: config.camera.preview,
      // Só o modo 'gphoto' usa o stream do servidor; 'capturadora' lê
      // direto do dispositivo pelo navegador.
      streamPath: config.camera.preview === 'gphoto'
        ? `/api/preview/${config.camera.previewCode}/stream`
        : null,
    },
  };
}

async function createApp() {
  await initStore();
  const store = getStore();
  const storage = getStorage();

  /* O banco do evento. É null nos modos sem filesystem durável (Vercel),
     e nesse caso o app cai no comportamento antigo: estado na sessão em
     memória. O totem do evento sempre tem repo. */
  const repo = getRepo();
  const event = repo ? repo.currentEvent() : { id: 'efemero' };
  if (repo) {
    console.log(`Evento ${event.id} — ${repo.countPhotos(event.id)} fotos já registradas`);
  }

  /* Publicação na internet: fora do caminho crítico, sempre. A fila só
     existe quando há banco para torná-la durável. */
  const publisher = getPublisher();
  const shareQueue = repo
    ? createShareQueue({ repo, storage, publisher, log: logStructured })
    : null;

  /* Preview. Vive só em memória e é descartável por definição: a
     fotografia vem por outro caminho, em resolução plena. */
  const preview = createPreviewHub({ log: logStructured });

  /* A sessão do totem existe desde o boot, com código fixo.
     É nela que o operador carrega a moldura do evento e é a que o telão
     usa ao disparar — sem ela, a primeira foto sairia sem moldura e
     ninguém perceberia até olhar o resultado. */
  if (!(await store.has(config.camera.previewCode))) {
    await store.put(newSession(config.camera.previewCode, event.id));
    logStructured('info', 'sessão do totem criada', { code: config.camera.previewCode });
  }

  /* Câmera DSLR cabeada. Fica no mesmo computador que o telão, então
     não há rede entre disparo e resultado — o que remove a maior fonte
     de latência e de falha do desenho anterior. */
  const camera = config.camera.fonte === 'gphoto'
    ? createGphotoCamera({
        preview,
        sessionCode: config.camera.previewCode,
        binario: config.camera.binario,
        log: logStructured,
        pastaTemp: path.join(config.dataDir, 'capturas'),
      })
    : null;

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

  // O cliente do Socket.IO é versionado em public/js/vendor (ver
  // scripts/build-vendor.js): o <script> no HTML fica fixo, mesmo com o
  // caminho do socket mudando entre o modo local e a Vercel.
  //
  // Este mount é só rede de segurança para quem clonou e ainda não rodou
  // `npm run build:vendor`. Na Vercel ele não vale nada — lá o estático
  // sai do CDN a partir de public/.
  app.use(
    '/js/vendor',
    express.static(path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist'), {
      maxAge: '1d',
      fallthrough: true,
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

  /* ── Moldura e fotos: banco quando existe, sessão em memória quando
     não. Concentrar as duas formas aqui mantém o resto do arquivo sem
     saber qual driver está ativo. ── */

  function frameFor(session, ratio) {
    if (repo) {
      const row = repo.getFrame(session.code, ratio);
      return row && { bytes: row.bytes, mime: row.mime };
    }
    const frame = session.frames?.[ratio];
    if (!frame) return null;
    return {
      bytes: frame.data ? Buffer.from(frame.data, 'base64') : null,
      key: frame.key,
      mime: frame.mime,
    };
  }

  /** Sessão enriquecida com a moldura, do jeito que o pipeline espera. */
  function withFrames(session, aspectRatio) {
    if (!session) return null;
    if (!repo) return session;

    const ratio = aspectRatio === '4:3' ? '4:3' : '3:4';
    const frame = repo.getFrame(session.code, ratio);
    return {
      ...session,
      frames: { [ratio]: frame ? { data: frame.bytes.toString('base64'), mime: frame.mime } : null },
    };
  }

  function photoUrlsFromRecord(photo) {
    const urls = urlsFor({
      id: photo.id,
      final: keyToUrl(photo.keys.final),
      web: keyToUrl(photo.keys.web || photo.keys.final),
      thumb: keyToUrl(photo.keys.thumb),
    });
    return { ...urls, url: urls.imageUrl, thumbnail: urls.thumbUrl, page: urls.pageUrl, ts: photo.capturedAt };
  }

  function keyToUrl(key) {
    if (!key) return null;
    return key.startsWith('http') ? key : `/uploads/${key}`;
  }

  function listPhotos(session) {
    if (!session) return [];
    if (repo) return repo.photosOfSession(session.code).map(photoUrlsFromRecord);
    return session.photos || [];
  }

  function countPhotos(session) {
    if (repo) return repo.photosOfSession(session.code).length;
    return session.photos?.length || 0;
  }

  async function snapshot(session) {
    return {
      code: session.code,
      settings: session.settings,
      cameraInfo: session.cameraInfo || null,
      hasFrame3x4: !!frameFor(session, '3:4'),
      hasFrame4x3: !!frameFor(session, '4:3'),
      photoCount: countPhotos(session),
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
    const match = /^globo_(\d+_\d+x\d+_[0-9a-f]{8})\.jpg$/.exec(finalName);
    return match ? match[1] : null;
  }

  async function persistPhoto(refs, meta, session) {
    const id = photoIdFromName(path.basename(refs.final.key));
    const record = {
      id,
      final: refs.final.url,
      web: refs.web.url,
      thumb: refs.thumb.url,
      meta,
      ts: Date.now(),
    };

    if (!id) return record;

    if (repo) {
      repo.insertPhoto({
        id,
        eventId: event.id,
        sessionCode: session?.code || null,
        capturedAt: record.ts,
        keys: {
          final: refs.final.key,
          web: refs.web.key,
          thumb: refs.thumb.key,
          original: refs.original?.key || null,
        },
        meta,
      });
      // A foto já está salva e visível. A publicação na internet é
      // assunto da fila, e falhar nela não desfaz nada do que veio antes.
      repo.enqueueShare(id);
    } else {
      await store.putRecord(id, record);
    }

    return record;
  }

  /**
   * O original guarda o EXIF do celular — inclusive GPS — e por isso
   * NÃO entra aqui: estas URLs são transmitidas para todo mundo na
   * sessão e acabam no telão e no aparelho do convidado.
   */
  function urlsFor(record) {
    return {
      imageUrl: record.web,
      fullUrl: record.final,
      thumbUrl: record.thumb,
      pageUrl: `/photo/${record.id}`,
      downloadUrl: `/download/${record.id}`,
    };
  }

  /** Compõe, guarda, avisa a sessão. Caminho único das três origens. */
  async function processCapture(buffer, { code, aspectRatio, mirror, source }) {
    const session = await loadSession(code);
    const { refs, meta } = await composeFinalPhoto(buffer, {
      session: withFrames(session, aspectRatio),
      aspectRatio,
      mirror,
      source,
    });
    const record = await persistPhoto(refs, meta, session);
    const urls = urlsFor(record);

    if (session) {
      if (!repo) {
        session.photos.push({ ...urls, url: urls.imageUrl, thumbnail: urls.thumbUrl, page: urls.pageUrl, ts: record.ts });
        await store.put(session);
      } else {
        await store.touch(session.code);
      }

      const total = countPhotos(session);
      const share = shareStateOf(record.id);

      io.to(session.code).emit('photo-ready', {
        ...urls, url: urls.imageUrl, thumbnail: urls.thumbUrl, page: urls.pageUrl, total, share,
      });
      io.to(roomFor(session.code, 'display')).emit('capture-result', { ...urls, meta, share });
    }

    logStructured('info', 'master_saved', {
      captureId: record.id,
      code: session?.code || null,
      width: meta.finalWidth,
      height: meta.finalHeight,
      bytes: meta.finalBytes,
      source: meta.source,
      frameApplied: meta.frameApplied,
    });

    return { ...urls, meta, share: shareStateOf(record.id) };
  }

  /**
   * O que dizer ao convidado sobre a foto dele.
   *
   * "salva" não é o mesmo que "publicada", e o telão precisa distinguir:
   * uma nunca vira erro, a outra pode demorar.
   */
  function shareStateOf(photoId) {
    if (!repo || !photoId) return { status: 'local', publicUrl: null };

    const job = repo.getShareJob(photoId);
    const photo = repo.getPhoto(photoId);
    if (!job) return { status: 'local', publicUrl: photo?.publicUrl || null };

    return {
      status: job.status,
      publicUrl: photo?.publicUrl || null,
      attempts: job.attempts,
    };
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

  /**
   * Última versão do app Android publicada.
   *
   * Como o app é distribuído por sideload, não há loja para empurrar
   * atualização. O CI publica o APK numa release do GitHub e este
   * endpoint diz ao app onde está — assim atualizar vira um toque, sem
   * caçar artefato e transferir arquivo.
   */
  let releaseCache = { at: 0, data: null };

  app.get('/api/app/latest', async (req, res) => {
    const TTL = 5 * 60 * 1000;
    if (releaseCache.data && Date.now() - releaseCache.at < TTL) {
      return res.json(releaseCache.data);
    }

    try {
      const repo = process.env.APP_RELEASE_REPO || 'gabrielfernandessc/globo-photobooth';
      const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'globo-photobooth' },
      });
      if (!resp.ok) throw new Error(`GitHub respondeu ${resp.status}`);

      const release = await resp.json();
      const apk = (release.assets || []).find(a => a.name.endsWith('.apk'));
      // A tag carrega o versionCode: v2-<code>. É o que o app compara.
      const versionCode = parseInt(/-(\d+)$/.exec(release.tag_name || '')?.[1] || '0', 10);

      const data = {
        versionCode,
        versionName: release.name || release.tag_name || '',
        downloadUrl: apk?.browser_download_url || '',
        notes: (release.body || '').slice(0, 500),
        publishedAt: release.published_at || null,
      };

      releaseCache = { at: Date.now(), data };
      res.json(data);
    } catch (err) {
      // Sem release publicada ainda, ou GitHub fora: o app só não
      // oferece atualização, e segue funcionando.
      res.json({ versionCode: 0, versionName: '', downloadUrl: '', notes: '', error: err.message });
    }
  });

  /**
   * Saúde por componente, e não um booleano só.
   *
   * A regra que importa: nuvem fora NÃO deixa o totem doente. Um totem
   * que fotografa, salva e mostra no telão está operacional mesmo sem
   * internet — dizer o contrário faria o operador procurar defeito onde
   * não há.
   */
  app.get('/api/health', async (req, res) => {
    const health = {
      ok: true,
      version: pkg.version,
      startedAt: APP_STARTED_AT,
      local: 'ready',
      database: 'not-configured',
      storage: 'unknown',
      cloud: 'offline',
    };

    try {
      await store.has('ZZZZ');
      health.database = repo ? 'ready' : `ephemeral (${config.stateDriver})`;
    } catch (err) {
      health.database = 'error';
      health.databaseError = err.message;
      health.ok = false;
    }

    try {
      const probe = await storage.exists('final');
      health.storage = probe === undefined ? 'ready' : 'ready';
      health.storageDriver = config.storageDriver;
    } catch (err) {
      health.storage = 'error';
      health.storageError = err.message;
      health.ok = false;
    }

    if (repo) {
      health.diskFree = await freeDiskBytes().catch(() => null);
      health.photos = repo.countPhotos(event.id);
      health.eventId = event.id;
    }

    if (shareQueue) {
      const status = shareQueue.status();
      health.share = status;
      // Nuvem indisponível é informação, não doença.
      health.cloud = !status.configured ? 'not-configured'
        : status.lastError ? 'degraded'
        : 'ready';
    }

    res.status(health.ok ? 200 : 503).json(health);
  });

  /**
   * Pareamento do celular com ESTE servidor.
   *
   * O operador não deveria digitar IP. O totem sabe onde está, cria a
   * sessão e devolve tudo num deep link — o app abre a câmera, lê o QR
   * da tela e já está conectado.
   *
   * O código de 4 caracteres continua existindo para ditar por voz, mas
   * quem autoriza é o token assinado: 32^4 é força bruta de segundos.
   */
  app.get('/api/pair', async (req, res) => {
    try {
      const host = primaryLanAddress();
      if (!host) {
        return res.status(503).json({
          error: 'O totem está sem rede local. Conecte o PC ao Wi-Fi do evento.',
        });
      }

      const requested = normalizeCode(req.query.code);
      let session = requested ? await store.get(requested) : null;
      if (!session) {
        const code = requested && !(await store.has(requested)) ? requested : await generateCode();
        session = newSession(code, event.id);
        await store.put(session);
      }

      const origem = `http://${host}:${config.port}`;
      const token = signCode(session.code);
      const deepLink = `photobooth://pair?host=${encodeURIComponent(`${host}:${config.port}`)}`
        + `&session=${session.code}&token=${encodeURIComponent(token)}`;

      /* A página da câmera PRECISA de contexto seguro: sem HTTPS o
         navegador do celular não libera getUserMedia, e o operador vê
         uma tela preta sem explicação. Por isso ela aponta para a porta
         TLS, e não para a mesma origem do telão. */
      const cameraUrl = config.enableHttps
        ? `https://${host}:${config.httpsPort}/camera.html?code=${session.code}`
        : `http://${host}:${config.port}/camera.html?code=${session.code}`;

      res.set('Cache-Control', 'no-store');
      res.json({
        code: session.code,
        token,
        host,
        port: config.port,
        httpsPort: config.enableHttps ? config.httpsPort : null,
        serverUrl: origem,
        cameraUrl,
        deepLink,
        // O QR sai do próprio servidor: pareamento não pode depender de
        // internet nem de serviço de terceiro.
        qrUrl: `/api/qr?size=520&data=${encodeURIComponent(deepLink)}`,
        addresses: lanAddresses(),
      });
    } catch (err) {
      logStructured('error', 'falha ao montar o pareamento', { error: err.message });
      res.status(500).json({ error: 'Não foi possível preparar o pareamento' });
    }
  });

  /* ═══════════════════════════════════════════════════════
     PREVIEW — celular publica quadros, telão consome MJPEG
     ═══════════════════════════════════════════════════════ */

  /**
   * O celular entrega um quadro.
   *
   * Corpo binário cru: um JPEG de preview em base64 dentro de JSON
   * cresceria um terço à toa, e são vários por segundo.
   *
   * A resposta diz se ALGUÉM está olhando. É assim que o celular sabe
   * quando parar de gastar bateria e rede — sem comando do servidor,
   * sem estado para dessincronizar.
   */
  app.post(
    '/api/preview/:code',
    express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '4mb' }),
    (req, res) => {
      const code = normalizeCode(req.params.code);
      if (!code) return res.status(400).json({ error: 'Código inválido' });
      if (!req.body?.length) return res.status(400).json({ error: 'Quadro vazio' });

      const assinantes = preview.publicar(code, req.body, {
        width: int(req.get('x-frame-width'), 0),
        height: int(req.get('x-frame-height'), 0),
      });

      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, viewers: assinantes });
    }
  );

  /**
   * O telão consome. É uma <img src="…/stream"> e nada mais: o
   * navegador decodifica multipart/x-mixed-replace sozinho, sem
   * JavaScript de mídia e sem negociação nenhuma.
   */
  app.get('/api/preview/:code/stream', (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).end();

    res.writeHead(200, cabecalhosMjpeg());

    /* Manda os cabeçalhos AGORA, sem esperar o primeiro quadro.
       Sem isto a resposta só começa quando a câmera transmite algo, e o
       telão fica com uma <img> pendurada — sem imagem e sem erro — em
       todo o intervalo entre abrir o totem e a câmera conectar. Que é
       justamente o momento em que o operador está tentando entender se
       alguma coisa funciona. */
    res.flushHeaders();

    // Quadro de preview atrasado não tem valor: melhor descartar do que
    // acumular latência num buffer.
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);

    const cancelar = preview.assinar(
      code,
      jpeg => res.write(quadroMjpeg(jpeg)),
      () => res.destroy()
    );

    // Sem isto o telão que recarrega deixa um assinante fantasma, e o
    // celular acha que ainda tem plateia.
    req.on('close', () => { cancelar(); res.end(); });
    req.on('error', cancelar);
  });

  app.get('/api/preview/:code/status', (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Código inválido' });
    res.set('Cache-Control', 'no-store');
    res.json(preview.status(code));
  });

  /* ═══════════════════════════════════════════════════════
     CÂMERA — disparo e estado
     ═══════════════════════════════════════════════════════ */

  app.get('/api/camera/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!camera) return res.json({ fonte: config.camera.fonte, disponivel: false });
    res.json({ fonte: 'gphoto', disponivel: true, ...camera.status() });
  });

  /* ── Perfil da câmera ──
     A Sony perde a configuração sozinha: um erro de cartão que peça
     recuperação reseta tudo. Guardar um perfil transforma "reconfigurar
     de cabeça às 22h" em um clique. */

  const CHAVE_PERFIL = 'camera.perfil';

  app.get('/api/camera/profile', (req, res) => {
    if (!repo) return res.status(400).json({ error: 'Sem banco para guardar o perfil' });
    res.set('Cache-Control', 'no-store');
    res.json({ perfil: repo.getSetting(CHAVE_PERFIL), salvoEm: repo.getSetting(`${CHAVE_PERFIL}.em`) });
  });

  /** Fotografa a configuração atual da câmera e a guarda. */
  app.post('/api/camera/profile', async (req, res) => {
    if (!camera) return res.status(400).json({ error: 'Nenhuma câmera configurada' });
    if (!repo) return res.status(400).json({ error: 'Sem banco para guardar o perfil' });

    try {
      const perfil = await camera.lerPerfil();
      if (!Object.keys(perfil).length) {
        return res.status(422).json({ error: 'A câmera não expôs nenhum ajuste conhecido' });
      }

      repo.putSetting(CHAVE_PERFIL, perfil);
      repo.putSetting(`${CHAVE_PERFIL}.em`, new Date().toISOString());
      logStructured('info', 'perfil da câmera salvo', { ajustes: Object.keys(perfil) });
      res.json({ success: true, perfil });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Devolve à câmera o perfil guardado. */
  app.post('/api/camera/profile/apply', async (req, res) => {
    if (!camera) return res.status(400).json({ error: 'Nenhuma câmera configurada' });

    const perfil = repo?.getSetting(CHAVE_PERFIL);
    if (!perfil) return res.status(404).json({ error: 'Nenhum perfil guardado ainda' });

    try {
      res.json({ success: true, ...(await camera.aplicarPerfil(perfil)) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * O disparo, do obturador ao QR.
   *
   * É síncrono de propósito: o telão precisa saber quando a foto está
   * pronta para trocar de tela, e uma DSLR leva segundos. Fingir que
   * terminou antes da hora faria o resultado aparecer vazio.
   */
  app.post('/api/capture', async (req, res) => {
    if (!camera) return res.status(400).json({ error: 'Nenhuma câmera configurada' });

    const inicio = Date.now();
    let arquivo = null;

    try {
      const disparo = await camera.capturar({ timeoutMs: config.camera.capturaTimeoutMs });
      arquivo = disparo.arquivo;

      const bytes = await fs.promises.readFile(arquivo);
      const dados = await processCapture(bytes, {
        /* Sem código explícito, a captura pertence à sessão do totem.
           O telão dispara sem informar sessão nenhuma — e sem este
           padrão a moldura do evento simplesmente não seria aplicada,
           o que só se descobriria olhando a primeira foto impressa. */
        code: req.body?.code || config.camera.previewCode,
        aspectRatio: req.body?.aspectRatio || '3:4',
        mirror: !!req.body?.mirror,
        source: 'dslr',
      });

      const alvo = `${req.protocol}://${req.get('host')}${dados.pageUrl}`;

      logStructured('info', 'captura_completa', {
        captureId: dados.pageUrl.split('/').pop(),
        disparoMs: disparo.ms,
        totalMs: Date.now() - inicio,
      });

      res.json({
        success: true,
        data: {
          ...dados,
          // O QR já vem pronto: o telão não precisa saber montar a URL.
          qrUrl: `/api/qr?size=520&data=${encodeURIComponent(alvo)}`,
          publicPageUrl: alvo,
          timings: { disparoMs: disparo.ms, totalMs: Date.now() - inicio },
        },
      });
    } catch (err) {
      logStructured('error', 'captura_falhou', { error: err.message, ms: Date.now() - inicio });
      res.status(500).json({ error: err.message });
    } finally {
      // O arquivo temporário sai só depois de a master estar gravada:
      // apagar antes transformaria uma falha de processamento em foto
      // perdida.
      if (arquivo) fs.promises.unlink(arquivo).catch(() => {});
    }
  });

  /** O "tentar de novo" do painel do operador. */
  app.post('/api/share/retry', async (req, res) => {
    if (!shareQueue) return res.status(400).json({ error: 'Fila indisponível neste modo' });
    const result = await shareQueue.retryFailed();
    res.json({ success: true, ...result, status: shareQueue.status() });
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
          // Duas formas de provar que a sessão é legítima:
          //
          // 1. token assinado — não consulta estado, então funciona
          //    mesmo quando esta instância nunca viu a sessão
          // 2. código simples — vale quando o store realmente a conhece
          //    (servidor próprio, ou Vercel com Redis)
          const signed = verifySignedCode(clientPayload);
          const plain = signed ? null : normalizeCode(clientPayload);

          if (!signed && !plain) {
            throw new Error(`Sessão ausente ou malformada (recebido: ${clientPayload ?? 'nada'})`);
          }
          if (!signed && !(await store.has(plain))) {
            const hint = config.stateDriver === 'memory' && config.isVercel
              ? ' — sem Redis nesta instância; use o token assinado devolvido por POST /api/session'
              : '';
            throw new Error(`Sessão ${plain} não encontrada${hint}`);
          }

          return {
            allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
            addRandomSuffix: true,
            maximumSizeInBytes: 128 * 1024 * 1024, // 50 MP sem compressão
            tokenPayload: signed || plain,
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

    // Recusa aqui o que só falharia na hora da foto: melhor o operador
    // descobrir agora, com tempo de trocar o arquivo.
    if (!/^image\/(png|webp|jpeg)$/.test(mime)) {
      return res.status(415).json({ error: `Formato de moldura não suportado: ${mime}` });
    }

    if (repo) {
      repo.putFrame(session.code, ratio, mime, req.file.buffer);
    } else if (storage.kind === 'blob') {
      const ref = await storage.put('frame', `frame_${session.code}_${ratio.replace(':', 'x')}_${Date.now()}.png`, req.file.buffer, mime);
      session.frames[ratio] = { key: ref.key, url: ref.url, mime };
      await store.put(session);
    } else {
      session.frames[ratio] = { data: req.file.buffer.toString('base64'), mime };
      await store.put(session);
    }

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
    if (repo) {
      repo.deleteFrame(session.code, ratio);
    } else {
      session.frames[ratio] = null;
      await store.put(session);
    }
    io.to(session.code).emit('frame-updated', { aspectRatio: ratio, frameUrl: null });
    res.json({ success: true });
  });

  app.get('/api/frame/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    if (!session) return res.status(404).send('Sessão não encontrada');

    const frame = frameFor(session, req.query.ratio === '4:3' ? '4:3' : '3:4');
    if (!frame) return res.status(404).send('Sem moldura');

    // Driver Blob guarda a chave e devolve a URL pública; os demais têm
    // os bytes em mãos.
    if (!frame.bytes && frame.key) {
      const url = await storage.urlFor(frame.key);
      if (!url) return res.status(404).send('Sem moldura');
      return res.redirect(302, url);
    }

    res.set('Content-Type', frame.mime || 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(frame.bytes);
  });

  /* ── Sessão ── */

  app.get('/api/photos/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    res.json({ photos: listPhotos(session) });
  });

  app.get('/api/session/:code', async (req, res) => {
    const session = await loadSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json(await snapshot(session));
  });

  /**
   * Cria uma sessão sem precisar de uma tela aberta.
   *
   * O app Android é a peça principal: ele abre a sessão, tira a foto e
   * mostra o QR. O /display.html vira opcional — entra depois, com o
   * mesmo código, quando o evento tiver um telão.
   */
  app.post('/api/session', async (req, res) => {
    try {
      const requested = normalizeCode(req.body?.code);
      let session = requested ? await store.get(requested) : null;

      if (!session) {
        const code = requested && !(await store.has(requested)) ? requested : await generateCode();
        session = newSession(code, event.id);
        await store.put(session);
        console.log('Sessão criada por API:', code);
      }

      res.json({
        code: session.code,
        // Prova de sessão que não depende de estado compartilhado: é
        // o que permite publicar a foto numa Vercel sem Redis.
        token: signCode(session.code),
        settings: session.settings,
        displayPath: `/display.html?code=${session.code}`,
        state: config.stateDriver,
      });
    } catch (err) {
      console.error('create session:', err);
      res.status(500).json({ error: err.message || 'Falha ao criar a sessão' });
    }
  });

  /* ── Página da foto (aberta pelo QR) ── */

  /**
   * Três caminhos, do mais confiável ao mais tolerante:
   *
   * 1. banco do evento — a verdade no totem
   * 2. registro em memória — o modo serverless, sem disco durável
   * 3. o próprio filesystem — rede de segurança: como o nome do arquivo
   *    é determinístico a partir do id, uma foto continua acessível
   *    mesmo se o banco for perdido
   */
  async function resolvePhoto(idOrName) {
    const raw = safeBasename(idOrName);
    const id = photoIdFromName(raw) || raw.replace(/\.jpg$/i, '');
    if (!id) return null;

    if (repo) {
      const photo = repo.getPhoto(id);
      if (photo) {
        return {
          id,
          final: keyToUrl(photo.keys.final),
          web: keyToUrl(photo.keys.web || photo.keys.final),
          publicUrl: photo.publicUrl,
        };
      }
    } else {
      const record = await store.getRecord(id);
      if (record) return record;
    }

    const finalKey = `final/globo_${id}.jpg`;
    const webKey = `web/globo_${id}_web.jpg`;

    if (storage.kind === 'local') {
      if (!(await storage.exists(finalKey))) return null;
      return {
        id,
        final: `/uploads/${finalKey}`,
        web: (await storage.exists(webKey)) ? `/uploads/${webKey}` : `/uploads/${finalKey}`,
      };
    }

    // Blob: head() consulta a API e funciona de qualquer instância.
    const [finalUrl, webUrl] = await Promise.all([
      storage.urlFor(finalKey),
      storage.urlFor(webKey),
    ]);
    if (!finalUrl) return null;
    return { id, final: finalUrl, web: webUrl || finalUrl };
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
          session = newSession(code, event.id);
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
        const anteriores = listPhotos(session);
        if (anteriores.length) socket.emit('session-photos', { photos: anteriores });
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

    /* ── Preview relayado (plano B do WebRTC) ──
       O totem liga e desliga; o celular só gasta banda quando alguém
       está de fato olhando. Frames não são guardados em lugar nenhum. */
    socket.on('preview-relay', ({ code, enabled } = {}) => {
      const session = normalizeCode(code);
      if (!session || socket.data.role !== 'display') return;
      io.to(roomFor(session, 'camera')).emit('preview-relay', { enabled: !!enabled });
    });

    socket.on('preview-frame', ({ code, data, width, height } = {}) => {
      const session = normalizeCode(code);
      if (!session || socket.data.role !== 'camera' || !data) return;
      io.to(roomFor(session, 'display')).emit('preview-frame', { data, width, height });
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

  /* ── Fila de publicação ──
     Sobe depois das rotas para que uma pendência retomada já encontre o
     app inteiro de pé. O telão acompanha o estado pelo mesmo socket que
     já usa, sem precisar ficar consultando. */
  if (shareQueue) {
    shareQueue.onChange(({ photoId, status, publicUrl, error }) => {
      io.emit('share-status', { photoId, status, publicUrl, error: error || null });
    });
    shareQueue.start();
  }

  /* A câmera sobe junto com o app, mas sem bloquear o boot: um cabo
     solto não pode impedir o totem de abrir. Ele abre dizendo que está
     sem câmera, e religa sozinho quando ela aparecer. */
  if (camera) {
    camera.onChange(estado => io.emit('camera-estado', estado));
    camera.start().then(ok => {
      if (!ok) logStructured('warn', 'totem subiu sem câmera', { acao: 'confira o cabo USB e o modo PC Remoto' });
    });
  }

  /**
   * Desligamento limpo, na ordem que importa.
   *
   * Os streams de preview vêm primeiro: são respostas HTTP eternas e
   * seguram o `server.close()` para sempre se não forem derrubadas. Só
   * depois se fecha a fila e o banco — o SQLite precisa fechar o WAL
   * direito para o próximo boot não achar que houve queda de energia.
   */
  async function shutdown() {
    const streams = preview.encerrarTodos();
    shareQueue?.stop();

    // A câmera antes de tudo o mais: um gphoto2 que sobrevive ao
    // desligamento segura o USB e faz o PRÓXIMO boot subir sem imagem,
    // sem dizer o motivo. Foi assim que o preview quebrou uma vez.
    await camera?.stop();

    // Desconecta os sockets sem fechar o servidor por dentro: o
    // io.close() do Socket.IO fecha o HTTP junto e deixa o close()
    // seguinte sem callback, pendurado.
    io.disconnectSockets(true);

    // A rede de segurança que resolve o caso real. Um telão consumindo
    // preview é uma conexão keep-alive com resposta eterna; sem derrubar
    // o socket na marra, server.close() espera indefinidamente.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();

    await new Promise(resolve => server.close(() => resolve()));
    await store.close?.();
    return { streams };
  }

  return { app, server, io, store, storage, repo, shareQueue, event, preview, shutdown };
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
