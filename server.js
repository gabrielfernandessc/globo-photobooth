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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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

let gphotoCapturing = false;
let previewRunning = false;

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
    proc.stderr.on('data', () => {});

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
      setTimeout(sendFrame, 80);
    });

    proc.on('error', () => setTimeout(sendFrame, 500));
  };

  sendFrame();
  req.on('close', () => { active = false; });
});

app.post('/api/gphoto/capture', async (req, res) => {
  if (gphotoCapturing) return res.status(429).json({ error: 'Capture already in progress' });

  gphotoCapturing = true;
  await new Promise(r => setTimeout(r, 150));

  try {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const tmpFile = path.join(tmpDir, `cap_${Date.now()}.jpg`);

    await execAsync(`gphoto2 --capture-image-and-download --filename="${tmpFile}" --force-overwrite`);

    if (!fs.existsSync(tmpFile)) throw new Error('Capture file not created');

    const imageData = fs.readFileSync(tmpFile).toString('base64');
    fs.unlinkSync(tmpFile);

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

/* All allowed gphoto2 config keys for Sony A7III */
const GPHOTO_CONFIGS = {
  iso:       '/main/imgsettings/iso',
  aperture:  '/main/capturesettings/f-number',
  shutter:   '/main/capturesettings/shutterspeed',
  wb:        '/main/imgsettings/whitebalance',
  ev:        '/main/capturesettings/exposurecompensation',
  focus:     '/main/capturesettings/focusmode',
  flash:     '/main/capturesettings/flashmode',
  quality:   '/main/imgsettings/imagequality',
  drive:     '/main/capturesettings/drivemode',
  metering:  '/main/capturesettings/meteringmode',
  effect:    '/main/capturesettings/expprogram',
};

const GPHOTO_LABELS = {
  iso: 'ISO', aperture: 'Abertura (f/)', shutter: 'Velocidade', wb: 'Bal. Branco',
  ev: 'Compensação EV', focus: 'Modo de Foco', flash: 'Flash',
  quality: 'Qualidade', drive: 'Modo Disparo', metering: 'Medição', effect: 'Programa',
};

// Get single config
app.get('/api/gphoto/config/:key', async (req, res) => {
  const config = GPHOTO_CONFIGS[req.params.key];
  if (!config) return res.status(400).json({ error: 'Unknown config' });

  try {
    const { stdout } = await execAsync(`gphoto2 --get-config "${config}" 2>&1`);
    const current = (stdout.match(/Current:\s*(.+)/) || [])[1]?.trim();
    const choices = [...stdout.matchAll(/Choice:\s*\d+\s+(.+)/g)].map(m => m[1].trim());
    res.json({ current, choices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get ALL configs in one request (bulk loader for Camera tab)
app.get('/api/gphoto/all-configs', async (req, res) => {
  const results = {};
  for (const [key, configPath] of Object.entries(GPHOTO_CONFIGS)) {
    try {
      const { stdout } = await execAsync(`gphoto2 --get-config "${configPath}" 2>&1`, { timeout: 3000 });
      const current = (stdout.match(/Current:\s*(.+)/) || [])[1]?.trim();
      const choices = [...stdout.matchAll(/Choice:\s*\d+\s+(.+)/g)].map(m => m[1].trim());
      if (choices.length > 0) {
        results[key] = { current, choices, label: GPHOTO_LABELS[key] || key };
      }
    } catch { /* config not supported by this camera — skip */ }
  }
  res.json(results);
});


// Set config
app.post('/api/gphoto/config/:key', async (req, res) => {
  const config = GPHOTO_CONFIGS[req.params.key];
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

// Trigger autofocus (one-shot AF)
app.post('/api/gphoto/autofocus', async (req, res) => {
  try {
    await execAsync('gphoto2 --set-config /main/actions/autofocusdrive=1', { timeout: 5000 });
    res.json({ success: true });
  } catch (err) {
    // Some cameras use a different path
    try {
      await execAsync('gphoto2 --set-config autofocusdrive=1', { timeout: 5000 });
      res.json({ success: true });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});

// Manual focus step: near (-3 to -1) or far (1 to 3)
app.post('/api/gphoto/manual-focus', async (req, res) => {
  const { direction } = req.body; // 'near-fine', 'near', 'near-coarse', 'far-fine', 'far', 'far-coarse'
  const steps = {
    'near-fine': 1, 'near': 2, 'near-coarse': 3,
    'far-fine': 4,  'far': 5,  'far-coarse': 6,
    // Some cameras use negative values
    'near-1': -1, 'near-2': -2, 'near-3': -3,
    'far-1': 1,   'far-2': 2,   'far-3': 3,
  };
  const step = steps[direction];
  if (step === undefined) return res.status(400).json({ error: 'Invalid direction' });

  try {
    await execAsync(`gphoto2 --set-config /main/actions/manualfocusdrive=${step}`, { timeout: 3000 });
    res.json({ success: true });
  } catch (err) {
    try {
      await execAsync(`gphoto2 --set-config manualfocusdrive=${step}`, { timeout: 3000 });
      res.json({ success: true });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});



/* ═══════════════════════════════════════════════════════
   SOCKET.IO — Sessão Persistente
   
   Regras:
   1. create-session aceita code opcional → reutiliza sessão existente
   2. Disconnect do display NÃO deleta a sessão (só nullifica displaySocket)
   3. Disconnect do controle NÃO deleta a sessão (só nullifica controlSocket)
   4. Sessão só é deletada após 24h de inatividade
   5. Reconexão: display e controle podem re-join ao mesmo código
   ═══════════════════════════════════════════════════════ */

io.on('connection', (socket) => {
  console.log('+ connected', socket.id);

  /* ── Create or rejoin session (display side) ── */
  socket.on('create-session', ({ requestedCode } = {}, cb) => {
    // If a code was requested and the session exists, rejoin it
    if (requestedCode && sessions.has(requestedCode)) {
      const s = sessions.get(requestedCode);
      // Update display socket to new connection
      s.displaySocket = socket.id;
      s.lastActivity = Date.now();
      socket.join(requestedCode);
      socket.sessionCode = requestedCode;

      // Notify connected controller that display is back
      if (s.controlSocket) {
        io.to(s.controlSocket).emit('display-reconnected');
      }

      console.log('Display rejoined session:', requestedCode);
      cb({ code: requestedCode, rejoined: true, photoCount: (s.photos || []).length });
      return;
    }

    // Create new session (use requested code if unique, otherwise generate)
    const code = (requestedCode && !sessions.has(requestedCode)) ? requestedCode : generateCode();
    sessions.set(code, {
      displaySocket: socket.id,
      controlSocket: null,
      photos: [],
      settings: { timer: 3, aspectRatio: '4:5' },
      frame4x5: null,
      frame16x9: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
    socket.join(code);
    socket.sessionCode = code;
    cb({ code, rejoined: false, photoCount: 0 });
    console.log('Session created:', code);
  });

  /* ── Join session (controller side) ── */
  socket.on('join-session', (code, cb) => {
    const s = sessions.get(code);
    if (!s) return cb({ error: 'Código inválido' });

    s.controlSocket = socket.id;
    s.lastActivity = Date.now();
    socket.join(code);
    socket.sessionCode = code;

    // Notify display
    if (s.displaySocket) {
      io.to(s.displaySocket).emit('controller-connected');
    }

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

  /* ── Trigger capture ── */
  socket.on('trigger-capture', ({ code, timer }) => {
    const s = sessions.get(code);
    if (s) {
      s.lastActivity = Date.now();
      if (s.displaySocket) io.to(s.displaySocket).emit('start-countdown', { timer });
    }
  });

  /* ── Photo uploaded ── */
  socket.on('photo-uploaded', ({ code, url, thumbnail }) => {
    const s = sessions.get(code);
    if (s) {
      s.photos.push({ url, thumbnail, ts: Date.now() });
      s.lastActivity = Date.now();
      io.to(code).emit('photo-ready', { url, thumbnail, total: s.photos.length });
    }
  });

  /* ── Update settings ── */
  socket.on('update-settings', ({ code, settings }) => {
    const s = sessions.get(code);
    if (s) {
      Object.assign(s.settings, settings);
      s.lastActivity = Date.now();
      io.to(code).emit('settings-updated', s.settings);
    }
  });

  /* ── Re-show photo on display (gallery tap) ── */
  socket.on('show-photo', ({ code, url }) => {
    const s = sessions.get(code);
    if (s && s.displaySocket) io.to(s.displaySocket).emit('show-photo', { url });
  });

  /* ── Reset to preview (operator "Next" button) ── */
  socket.on('reset-to-preview', ({ code }) => {
    const s = sessions.get(code);
    if (s && s.displaySocket) io.to(s.displaySocket).emit('reset-to-preview');
  });

  /* ── Camera control relay ── */
  socket.on('cam-control', ({ code, cmd }) => {
    const s = sessions.get(code);
    if (s && s.displaySocket) io.to(s.displaySocket).emit('cam-control', { cmd });
  });

  /* ── Disconnect — DOES NOT DELETE SESSION ──
     Session survives both display and controller disconnects.
     Only cleaned up after 24h of inactivity. */
  socket.on('disconnect', () => {
    const code = socket.sessionCode;
    if (!code) return;
    const s = sessions.get(code);
    if (!s) return;

    if (s.displaySocket === socket.id) {
      s.displaySocket = null;
      // Notify controller that display went away (but session lives)
      if (s.controlSocket) {
        io.to(s.controlSocket).emit('display-disconnected');
      }
      console.log('Display disconnected (session preserved):', code);
    } else if (s.controlSocket === socket.id) {
      s.controlSocket = null;
      // Notify display that controller went away
      if (s.displaySocket) {
        io.to(s.displaySocket).emit('controller-disconnected');
      }
      console.log('Controller disconnected (session preserved):', code);
    }
  });
});

// Cleanup sessions older than 24h of inactivity
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (now - (s.lastActivity || s.createdAt) > 86400000) {
      sessions.delete(code);
      console.log('Session expired:', code);
    }
  }
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 Globo Photo Booth → http://localhost:${PORT}\n`);
});
