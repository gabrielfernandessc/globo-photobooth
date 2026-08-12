#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   GPHOTO2 FALSO — para testar o bridge sem câmera na mesa

   Imita a interface de linha de comando do gphoto2 real: os mesmos
   argumentos, o mesmo formato de saída do --auto-detect, MJPEG no
   stdout do --capture-movie e um arquivo gravado no
   --capture-image-and-download.

   O que se testa aqui é o NOSSO código: remontagem de quadros picotados
   pelo pipe, exclusividade do USB, religação, limpeza de processo. O
   libgphoto2 em si é testado pelo projeto dele — e pela câmera de
   verdade, no diagnóstico.

   O comportamento é dirigido por variáveis de ambiente, para cada teste
   pedir o cenário que quer:

     FAKE_SEM_CAMERA=1      --auto-detect não acha nada
     FAKE_LIVE_FALHA=1      o live view morre sozinho após ~300ms
     FAKE_CAPTURA_FALHA=1   o disparo falha como se o USB estivesse preso
     FAKE_FPS=n             quadros por segundo (padrão 20)
     FAKE_CAPTURA_MS=n      quanto o disparo demora (padrão 400)
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const tem = flag => args.includes(flag);
const valor = flag => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const MODELO = 'Canon EOS Rebel T6';

/* ── --auto-detect ── */
if (tem('--auto-detect')) {
  if (process.env.FAKE_SEM_CAMERA) {
    process.stdout.write('Model                          Port\n----------------------------------------------------------\n');
    process.exit(0);
  }
  process.stdout.write(
    'Model                          Port\n' +
    '----------------------------------------------------------\n' +
    `${MODELO}                usb:001,010\n`
  );
  process.exit(0);
}

/* ── --abilities ── */
if (tem('--abilities')) {
  process.stdout.write(
    `Abilities for camera             : ${MODELO}\n` +
    'Serial port support              : no\n' +
    'USB support                      : yes\n' +
    'Capture choices                  :\n' +
    '                                 : Image\n' +
    '                                 : Preview\n' +
    'Configuration support            : yes\n'
  );
  process.exit(0);
}

/**
 * Um JPEG mínimo mas válido, com um byte variável para os testes
 * distinguirem um quadro do outro. Não usa sharp de propósito: este
 * processo precisa iniciar rápido e ser previsível.
 */
function jpegFalso(marca = 0) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00, marca & 0xff]),
    Buffer.alloc(64, marca & 0xff),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/* ── --capture-movie --stdout ── */
if (tem('--capture-movie')) {
  const fps = Number(process.env.FAKE_FPS || 20);
  let n = 0;

  // Sai limpo no SIGTERM: é assim que o bridge solta o USB para poder
  // disparar, e um fake que ignorasse o sinal esconderia um vazamento.
  const sair = () => process.exit(0);
  process.on('SIGTERM', sair);
  process.on('SIGINT', sair);

  if (process.env.FAKE_LIVE_FALHA) {
    setTimeout(() => {
      process.stderr.write('\n*** Error ***\nCould not claim the USB device\n');
      process.exit(1);
    }, 300);
  }

  const timer = setInterval(() => {
    const quadro = jpegFalso(n++);
    // Escreve em dois pedaços de propósito: no pipe real um quadro chega
    // picotado, e remontar isso é justamente o que o bridge precisa
    // acertar.
    const corte = Math.floor(quadro.length / 2);
    process.stdout.write(quadro.subarray(0, corte));
    process.stdout.write(quadro.subarray(corte));
  }, Math.round(1000 / fps));

  timer.unref?.();
  setInterval(() => {}, 1 << 30); // segura o processo vivo
}

/* ── --capture-image-and-download ── */
else if (tem('--capture-image-and-download')) {
  const demora = Number(process.env.FAKE_CAPTURA_MS || 400);

  setTimeout(() => {
    if (process.env.FAKE_CAPTURA_FALHA) {
      process.stderr.write('\n*** Error ***\nCould not claim the USB device\nERROR: Could not capture image.\n');
      process.exit(1);
    }

    const alvo = (valor('--filename') || 'captura.%C').replace('%C', 'jpg');
    fs.mkdirSync(path.dirname(alvo), { recursive: true });

    // Um "arquivo grande" plausível, para o teste conferir bytes.
    fs.writeFileSync(alvo, Buffer.concat([jpegFalso(255), Buffer.alloc(200_000, 0x7f)]));
    process.stdout.write(`New file is in location ${alvo} on the camera\n`);
    process.exit(0);
  }, demora);
}

else {
  process.stderr.write(`fake-gphoto2: argumentos não reconhecidos: ${args.join(' ')}\n`);
  process.exit(2);
}
