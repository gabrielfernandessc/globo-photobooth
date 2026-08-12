/* ══════════════════════════════════════════════════════════
   API/SERVER.JS — entrypoint da Vercel

   A Vercel serve o servidor HTTP exportado aqui e faz o upgrade das
   conexões WebSocket para ele. Nada de listen(): a plataforma cuida
   disso.

   O app é assíncrono (conecta no Redis antes de aceitar tráfego), então
   as requisições ficam em fila até o boot terminar — o custo é só no
   cold start.
   ══════════════════════════════════════════════════════════ */

const http = require('http');
const { createApp } = require('../lib/app');

let ready = null;
let handler = null;
let upgradeHandler = null;

function boot() {
  if (!ready) {
    ready = createApp()
      .then(({ server }) => {
        // Reaproveita os listeners do servidor interno em vez de
        // exportá-lo direto: assim o boot pode ser aguardado.
        handler = server.listeners('request')[0];
        upgradeHandler = server.listeners('upgrade')[0];
        return server;
      })
      .catch(err => {
        ready = null; // permite nova tentativa no próximo cold start
        throw err;
      });
  }
  return ready;
}

const server = http.createServer(async (req, res) => {
  try {
    await boot();
    handler(req, res);
  } catch (err) {
    console.error('Boot falhou:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Serviço indisponível', detail: err.message }));
  }
});

server.on('upgrade', async (req, socket, head) => {
  try {
    await boot();
    if (upgradeHandler) upgradeHandler(req, socket, head);
    else socket.destroy();
  } catch (err) {
    console.error('Upgrade falhou:', err);
    socket.destroy();
  }
});

boot().catch(err => console.error('Boot inicial falhou:', err.message));

module.exports = server;
