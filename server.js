/* ══════════════════════════════════════════════════════════
   SERVER.JS — boot local (o PC do totem no evento)

   Sobe HTTP e HTTPS. O HTTPS existe porque o Chrome do Android só
   libera getUserMedia em contexto seguro: sem ele o celular não abre a
   câmera na rede local. O certificado autoassinado é gerado no primeiro
   boot, cobrindo o IP da máquina.

   Na Vercel o entrypoint é api/server.js — este arquivo não roda lá.
   ══════════════════════════════════════════════════════════ */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');

const { config } = require('./lib/config');
const { createApp } = require('./lib/app');
// A escolha do endereço mora em lib/network: o QR de pareamento e este
// boot precisam concordar sobre qual IP o celular alcança.
const { lanAddresses } = require('./lib/network');

function loadOrCreateCert() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch {
    return null;
  }

  const hosts = ['localhost', '127.0.0.1', ...lanAddresses()];
  const pems = selfsigned.generate([{ name: 'commonName', value: hosts[2] || 'localhost' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: hosts.map(h => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h })),
      },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('Certificado autoassinado gerado em certs/');
  return { key: pems.private, cert: pems.cert };
}

async function main() {
  const { app, server, io } = await createApp();

  server.listen(config.port, () => {
    const lan = lanAddresses();
    console.log('\n🎬  Globo Photo Booth');
    console.log(`   estado: ${config.stateDriver}   fotos: ${config.storageDriver}`);
    console.log(`\n   HTTP   http://localhost:${config.port}`);
    lan.forEach(ip => console.log(`          http://${ip}:${config.port}`));

    if (!config.enableHttps) {
      console.log('\n   HTTPS desativado (ENABLE_HTTPS=false).\n');
      return;
    }

    const creds = loadOrCreateCert();
    if (!creds) {
      console.log('\n   HTTPS indisponível: rode `npm install` para instalar "selfsigned".');
      console.log('   Sem HTTPS o celular não libera a câmera pela rede local.\n');
      return;
    }

    const secure = https.createServer(creds, app);
    io.attach(secure, { path: config.socketPath });
    secure.listen(config.httpsPort, () => {
      console.log(`\n   HTTPS  https://localhost:${config.httpsPort}`);
      lan.forEach(ip => console.log(`          https://${ip}:${config.httpsPort}   ← use esta no celular`));
      console.log('\n   Totem:    /display.html      Celular-câmera: /camera.html');
      console.log('   Controle: /control.html\n');
    });
  });
}

main().catch(err => {
  console.error('\nFalha ao subir o servidor:', err.message, '\n');
  process.exit(1);
});
