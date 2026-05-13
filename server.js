require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e6 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const sessions = new Map();

app.use(express.static('public'));
app.use(express.json({ limit: '20mb' }));

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O 1/I
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (sessions.has(code));
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

/* ── GPHOTO2 INTEGRATION ──────────────────────────────── */

// USB lock: prevent preview + capture at same time
let gphotoCapturing = false;
let previewRunning = false;

// Check gphoto2 + camera availability
app.get('/api/gphoto/status', async (req, res) => {
  try {
    const { stdout } = await execAsync('gphoto2 --auto-detect 2>&1');
    const lines = stdout.split('\n').filter(l => /usb:/i.test(l));
    if (lines.length === 0) return res.json({ available: false });
    const camera = lines[0].replace(/\s{2,}/g, ' — ').trim();
    res.json({ available: true, camera });
  } catch {
    res.json({ available: false });
  }
});

// MJPEG live preview stream (12fps, pauses during capture)
app.get('/api/gphoto/preview', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let active = true;
  previewRunning = true;

  const sendFrame = () => {
    if (!active) { previewRunning = false; return; }
    if (gphotoCapturing) { setTimeout(sendFrame, 300); return; }

    const proc = spawn('gphoto2', ['--capture-preview', '--stdout'], { timeout: 3000 });
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', () => {}); // silence

    proc.on('close', () => {
      if (!active) { previewRunning = false; return; }
      const frame = Buffer.concat(chunks);
      if (frame.length > 512) {
        try {
          res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
          res.write(frame);
          res.write('\r\n');
        } catch { active = false; previewRunning = false; return; }
      }
      setTimeout(sendFrame, 80); // ~12fps
    });

    proc.on('error', () => setTimeout(sendFrame, 500));
  };

  sendFrame();
  req.on('close', () => { active = false; });
});

// High-res capture via gphoto2 + auto-upload to ImgBB
app.post('/api/gphoto/capture', async (req, res) => {
  if (gphotoCapturing) return res.status(429).json({ error: 'Capture already in progress' });

  gphotoCapturing = true;
  // Wait for any in-flight preview frame to finish
  await new Promise(r => setTimeout(r, 150));

  try {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const tmpFile = path.join(tmpDir, `cap_${Date.now()}.jpg`);

    // Capture full-resolution image
    await execAsync(`gphoto2 --capture-image-and-download --filename="${tmpFile}" --force-overwrite`);

    if (!fs.existsSync(tmpFile)) throw new Error('Capture file not created');

    const imageData = fs.readFileSync(tmpFile).toString('base64');
    fs.unlinkSync(tmpFile);

    // Upload to ImgBB
    const params = new URLSearchParams();
    params.append('image', imageData);
    params.append('key', process.env.IMGBB_API_KEY);

    const response = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: params });
    const data = await response.json();

    gphotoCapturing = false;
    res.json(data);
  } catch (err) {
    gphotoCapturing = false;
    console.error('gphoto2 capture error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get camera config options (ISO, aperture, shutter, WB, EV)
app.get('/api/gphoto/config/:key', async (req, res) => {
  const allowed = {
    iso:      '/main/imgsettings/iso',
    aperture: '/main/capturesettings/f-number',
    shutter:  '/main/capturesettings/shutterspeed',
    wb:       '/main/imgsettings/whitebalance',
    ev:       '/main/capturesettings/exposurecompensation',
    focus:    '/main/capturesettings/focusmode',
  };
  const config = allowed[req.params.key];
  if (!config) return res.status(400).json({ error: 'Unknown config' });

  try {
    const { stdout } = await execAsync(`gphoto2 --get-config "${config}" 2>&1`);
    // Parse: Current / Choice lines
    const current = (stdout.match(/Current:\s*(.+)/) || [])[1]?.trim();
    const choices = [...stdout.matchAll(/Choice:\s*\d+\s+(.+)/g)].map(m => m[1].trim());
    res.json({ current, choices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set camera config
app.post('/api/gphoto/config/:key', async (req, res) => {
  const allowed = {
    iso:      '/main/imgsettings/iso',
    aperture: '/main/capturesettings/f-number',
    shutter:  '/main/capturesettings/shutterspeed',
    wb:       '/main/imgsettings/whitebalance',
    ev:       '/main/capturesettings/exposurecompensation',
    focus:    '/main/capturesettings/focusmode',
  };
  const config = allowed[req.params.key];
  if (!config) return res.status(400).json({ error: 'Unknown config' });

  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'No value' });

  try {
    await execAsync(`gphoto2 --set-config "${config}=${value}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



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
