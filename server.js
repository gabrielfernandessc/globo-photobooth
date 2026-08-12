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

/**
 * Porta ocupada é o erro mais comum de quem opera, e o Node responde a
 * ele com um dump de stack — ilegível às 22h de um sábado. Pior: quando
 * um totem antigo continua vivo na porta, tudo parece funcionar e as
 * fotos vão para o banco errado, que foi exatamente o que aconteceu aqui.
 */
function explicaFalhaDeBoot(err, porta, rotulo) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n   A porta ${porta} (${rotulo}) já está ocupada.`);
    console.error('   Provavelmente há outro totem rodando. Encerre-o antes:');
    console.error(`     macOS/Linux   lsof -ti :${porta} | xargs kill`);
    console.error('     Windows       scripts\\Stop-PhotoBooth.ps1');
    console.error(`   Ou use outra porta:  PORT=3001 npm start\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n   Sem permissão para usar a porta ${porta}.`);
    console.error('   Portas abaixo de 1024 exigem privilégio; use PORT=3000 ou maior.\n');
  } else {
    console.error(`\n   Falha ao abrir a porta ${porta} (${rotulo}): ${err.message}\n`);
  }
  process.exit(1);
}

async function main() {
  const { app, server, io, shutdown } = await createApp();

  server.on('error', err => explicaFalhaDeBoot(err, config.port, 'HTTP'));

  /* Ctrl+C e o encerramento do launcher precisam sair limpo: derrubar
     os streams de preview, parar a fila e fechar o WAL do SQLite. Sem
     isso o processo fica pendurado e o próximo boot acha que houve
     queda de energia. */
  let encerrando = false;
  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, async () => {
      if (encerrando) return process.exit(1); // segundo Ctrl+C: força
      encerrando = true;
      console.log('\n   Encerrando o totem...');
      try {
        await shutdown();
        console.log('   Fotos e fila preservadas em disco.\n');
        process.exit(0);
      } catch (err) {
        console.error(`   Falha no encerramento: ${err.message}\n`);
        process.exit(1);
      }
    });
  }

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
    // HTTPS ocupado não derruba o totem: o telão continua no HTTP. Só o
    // celular-câmera fica indisponível, e o operador precisa saber disso.
    secure.on('error', err => {
      console.error(`\n   HTTPS indisponível na porta ${config.httpsPort}: ${err.message}`);
      console.error('   O telão segue funcionando, mas o celular não vai liberar a câmera.\n');
    });
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
