require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { ServerManager } = require('@alpha-sdk/api');
const { AlphaSDKClient } = require('@alpha-sdk/client');
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

/* ── SONY CAMERA REMOTE API INTEGRATION ────────────────── */

const sonyServer = new ServerManager({ port: 8080 });
const sonyClient = new AlphaSDKClient({ environment: 'http://localhost:8080' });
let sonyCameraId = null;
let sonyCapturing = false;

// Initialize Sony API Server in the background
sonyServer.start().catch(err => console.error('Error starting Sony SDK server:', err));

app.get('/api/sony/status', async (req, res) => {
  try {
    const { cameras } = await sonyClient.cameras.list();
    const camera = cameras.find(c => c.connected !== true) ?? cameras[0];
    
    if (!camera) return res.json({ available: false });
    
    sonyCameraId = camera.id;
    if (!camera.connected) {
      await sonyClient.cameras.connect({
        cameraId: sonyCameraId,
        mode: "remote-transfer", // full control + download
        reconnecting: "on"
      });
      await sonyClient.properties.setPriorityKey({ cameraId: sonyCameraId, setting: "pc-remote" });
    }
    res.json({ available: true, camera: camera.model });
  } catch (err) {
    console.error('Sony status error:', err);
    res.json({ available: false });
  }
});

// Proxy for live view polling
app.get('/api/sony/preview', async (req, res) => {
  if (!sonyCameraId) return res.status(404).end();
  
  try {
    const status = await sonyClient.liveView.getStatus({ cameraId: sonyCameraId });
    if (!status.data.enabled) {
      await sonyClient.liveView.enable({ cameraId: sonyCameraId });
    }
    if (!status.data.streaming) {
      await sonyClient.liveView.start({ cameraId: sonyCameraId });
    }

    const frameResponse = await sonyClient.liveView.getFrame({ cameraId: sonyCameraId });
    const buffer = Buffer.from(await frameResponse.arrayBuffer());
    
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (err) {
    res.status(500).end();
  }
});

app.post('/api/sony/capture', async (req, res) => {
  if (sonyCapturing || !sonyCameraId) return res.status(429).json({ error: 'Capture unavailable' });

  sonyCapturing = true;

  try {
    // Fire the shutter
    await sonyClient.actions.shutter({ cameraId: sonyCameraId });

    // Wait briefly for the camera to write the file
    await new Promise(r => setTimeout(r, 1500));
    
    // Get latest file from SD card
    const { files } = await sonyClient.sdCard.list({ cameraId: sonyCameraId, slotNumber: 1 });
    if (!files || files.length === 0) throw new Error('No files found on SD card');
    
    const latest = files[files.length - 1];

    // Download photo using Alpha SDK ServerManager direct HTTP endpoint
    // We fetch it from the server since the client download() is meant for direct disk write
    const downloadRes = await fetch(`http://localhost:8080/api/cameras/${sonyCameraId}/sd-card/slots/1/files/${latest.fileId}/content`);
    const buffer = await downloadRes.arrayBuffer();
    const imageData = Buffer.from(buffer).toString('base64');

    // Upload to ImgBB
    const params = new URLSearchParams();
    params.append('image', imageData);
    params.append('key', process.env.IMGBB_API_KEY);

    const response = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: params });
    const data = await response.json();

    sonyCapturing = false;
    res.json(data);
  } catch (err) {
    sonyCapturing = false;
    console.error('Sony capture error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const SONY_PROPERTIES = ['iso', 'f-number', 'shutter-speed', 'white-balance', 'exposure-compensation'];
const SONY_LABELS = {
  'iso': 'ISO', 
  'f-number': 'Abertura (f/)', 
  'shutter-speed': 'Velocidade', 
  'white-balance': 'Bal. Branco',
  'exposure-compensation': 'Compensação EV'
};

app.get('/api/sony/all-configs', async (req, res) => {
  if (!sonyCameraId) return res.json({});
  
  const results = {};
  try {
    for (const key of SONY_PROPERTIES) {
      try {
        const propData = await sonyClient.properties.get({ cameraId: sonyCameraId, propertyName: key });
        if (propData.data && propData.data.supportedValues) {
          results[key] = { 
            current: propData.data.value, 
            choices: propData.data.supportedValues, 
            label: SONY_LABELS[key] || key 
          };
        }
      } catch (e) {
        // Ignorar propriedades não suportadas
      }
    }
  } catch (err) {
    console.error('Error fetching properties:', err);
  }
  res.json(results);
});

app.post('/api/sony/config/:key', async (req, res) => {
  if (!sonyCameraId) return res.status(400).json({ error: 'No camera' });
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'No value' });

  try {
    await sonyClient.properties.set({
      cameraId: sonyCameraId,
      propertyName: req.params.key,
      value: value.toString()
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Sony set property error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Autofocus & manual focus actions
app.post('/api/sony/autofocus', async (req, res) => {
  if (!sonyCameraId) return res.status(400).json({ error: 'No camera' });
  try {
    await sonyClient.actions.startHalfPress({ cameraId: sonyCameraId });
    await new Promise(r => setTimeout(r, 500));
    await sonyClient.actions.stopHalfPress({ cameraId: sonyCameraId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sony/manual-focus', async (req, res) => {
  if (!sonyCameraId) return res.status(400).json({ error: 'No camera' });
  const { direction } = req.body;
  
  // Mapping 'near'/'far' from control.js to Sony API Focus actions
  let action;
  if (direction.startsWith('near')) action = 'focus-near';
  else if (direction.startsWith('far')) action = 'focus-far';
  else return res.status(400).json({ error: 'Invalid direction' });

  try {
    await sonyClient.actions[action]({ cameraId: sonyCameraId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
