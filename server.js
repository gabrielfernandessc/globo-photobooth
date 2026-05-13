require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const sessions = new Map();

app.use(express.static('public'));
app.use(express.json({ limit: '20mb' }));

function generateCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (sessions.has(code));
  return code;
}

/* ── REST API ─────────────────────────────────────────── */

// Upload photo to ImgBB (proxy to hide API key)
app.post('/api/upload', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image data' });

    const params = new URLSearchParams();
    params.append('image', image);
    params.append('key', process.env.IMGBB_API_KEY);

    const response = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: params
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Upload frame PNG
app.post('/api/frame/:code', upload.single('frame'), (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const ratio = req.body.aspectRatio || '4:5';
  const key = ratio === '16:9' ? 'frame16x9' : 'frame4x5';

  session[key] = { data: req.file.buffer.toString('base64'), mime: req.file.mimetype };

  io.to(req.params.code).emit('frame-updated', {
    aspectRatio: ratio,
    frameUrl: `/api/frame/${req.params.code}?ratio=${ratio}&t=${Date.now()}`
  });
  res.json({ success: true });
});

// Get frame
app.get('/api/frame/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).send('Not found');
  const key = (req.query.ratio === '16:9') ? 'frame16x9' : 'frame4x5';
  const frame = session[key];
  if (!frame) return res.status(404).send('No frame');
  res.set('Content-Type', frame.mime);
  res.send(Buffer.from(frame.data, 'base64'));
});

// Get photos list
app.get('/api/photos/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.json({ photos: [] });
  res.json({ photos: session.photos || [] });
});

/* ── SOCKET.IO ────────────────────────────────────────── */

io.on('connection', (socket) => {
  console.log('+ connected', socket.id);

  socket.on('create-session', (cb) => {
    const code = generateCode();
    sessions.set(code, {
      displaySocket: socket.id,
      controlSocket: null,
      photos: [],
      settings: { timer: 3, aspectRatio: '4:5' },
      frame4x5: null,
      frame16x9: null,
      createdAt: Date.now()
    });
    socket.join(code);
    socket.sessionCode = code;
    cb({ code });
    console.log('Session created:', code);
  });

  socket.on('join-session', (code, cb) => {
    const s = sessions.get(code);
    if (!s) return cb({ error: 'Código inválido' });
    s.controlSocket = socket.id;
    socket.join(code);
    socket.sessionCode = code;
    io.to(s.displaySocket).emit('controller-connected');
    cb({
      success: true,
      settings: s.settings,
      hasFrame4x5: !!s.frame4x5,
      hasFrame16x9: !!s.frame16x9,
      photoCount: (s.photos || []).length
    });
    // Send existing photos to the joining controller
    if (s.photos && s.photos.length > 0) {
      socket.emit('session-photos', { photos: s.photos });
    }
    console.log('Controller joined:', code);
  });

  socket.on('trigger-capture', ({ code, timer }) => {
    const s = sessions.get(code);
    if (s) io.to(s.displaySocket).emit('start-countdown', { timer });
  });

  socket.on('photo-uploaded', ({ code, url, thumbnail }) => {
    const s = sessions.get(code);
    if (s) {
      s.photos.push({ url, thumbnail, ts: Date.now() });
      io.to(code).emit('photo-ready', { url, thumbnail, total: s.photos.length });
    }
  });

  socket.on('update-settings', ({ code, settings }) => {
    const s = sessions.get(code);
    if (s) {
      Object.assign(s.settings, settings);
      io.to(code).emit('settings-updated', s.settings);
    }
  });

  // Re-show a photo on the display (from gallery tap)
  socket.on('show-photo', ({ code, url }) => {
    const s = sessions.get(code);
    if (s) io.to(s.displaySocket).emit('show-photo', { url });
  });

  // Camera control relay: control → display
  socket.on('cam-control', ({ code, cmd }) => {
    const s = sessions.get(code);
    if (s) io.to(s.displaySocket).emit('cam-control', { cmd });
  });

  socket.on('disconnect', () => {
    const code = socket.sessionCode;
    if (!code) return;
    const s = sessions.get(code);
    if (!s) return;
    if (s.displaySocket === socket.id) {
      io.to(code).emit('display-disconnected');
      sessions.delete(code);
    } else if (s.controlSocket === socket.id) {
      s.controlSocket = null;
      io.to(s.displaySocket).emit('controller-disconnected');
    }
  });
});

// Cleanup sessions older than 24h
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (now - s.createdAt > 86400000) sessions.delete(code);
  }
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 Globo Photo Booth → http://localhost:${PORT}\n`);
});
