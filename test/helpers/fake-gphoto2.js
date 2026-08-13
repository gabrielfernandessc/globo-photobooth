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
     FAKE_CAMERA_APOS=path  detecta só quando esse arquivo existir
     FAKE_CAMERAS=json      lista de {modelo, porta} para autodetecção
     FAKE_CAMERAS_FILE=path lê a lista de câmeras desse arquivo JSON
     FAKE_LIVE_FALHA=1      o live view morre sozinho após ~300ms
     FAKE_LIVE_SEM_QUADROS=1 mantém o processo vivo sem enviar imagem
     FAKE_LIVE_MUDO_ATE_RESET=path fica mudo até --reset criar o arquivo
     FAKE_LIVE_ZERO_ATE_RESET=path encerra com 0 frames até o reset
     FAKE_LIVE_TRAVA_APOS=n envia n quadros e congela sem sair
     FAKE_CAPTURA_FALHA=1   o disparo falha como se o USB estivesse preso
     FAKE_CAPTURA_ARQUIVO=path copia um JPEG válido fornecido pelo teste
     FAKE_SEM_FLASH=1       o corpo não expõe controle de flash interno
     FAKE_FLASH_MARKER=path marca quando o flash foi levantado
     FAKE_FLASH_COUNT_FILE=path conta cada comando de levantar o flash
     FAKE_EXPOSURE_MARKER=path marca quando o modo P foi selecionado
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

const MODELO = process.env.FAKE_MODELO || 'Canon EOS Rebel T6';

/* ── --auto-detect ── */
if (tem('--auto-detect')) {
  if (process.env.FAKE_SEM_CAMERA ||
      (process.env.FAKE_CAMERA_APOS && !fs.existsSync(process.env.FAKE_CAMERA_APOS))) {
    process.stdout.write('Model                          Port\n----------------------------------------------------------\n');
    process.exit(0);
  }
  const cameras = process.env.FAKE_CAMERAS_FILE
    ? JSON.parse(fs.readFileSync(process.env.FAKE_CAMERAS_FILE, 'utf8'))
    : process.env.FAKE_CAMERAS
      ? JSON.parse(process.env.FAKE_CAMERAS)
      : [{ modelo: MODELO, porta: 'usb:001,010' }];
  process.stdout.write(
    'Model                          Port\n' +
    '----------------------------------------------------------\n' +
    cameras.map(item => `${item.modelo}                ${item.porta}`).join('\n') + '\n'
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

/* ── --reset ── */
if (tem('--reset')) {
  const marcador = process.env.FAKE_LIVE_MUDO_ATE_RESET || process.env.FAKE_LIVE_ZERO_ATE_RESET;
  if (marcador) fs.writeFileSync(marcador, 'resetado');
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

/* ── --get-config / --set-config ──
   O formato de saída é o do gphoto2 real: bloco de propriedades com
   uma linha "Current:". Só alguns ajustes existem, de propósito — um
   corpo que não expõe determinada chave é o caso normal, e o bridge
   precisa seguir adiante em vez de abortar o perfil inteiro. */
const CONFIG = {
  imagesize: 'Large',
  imagequality: 'Extra Fine',
  imageformat: 'Large Fine JPEG',
  aspectratio: '3:2',
  iso: '800',
  'f-number': 'f/8',
  aperture: '8',
  shutterspeed: '1/125',
  whitebalance: 'Daylight',
  autoexposuremodedial: 'Auto',
};

const POPUP_FLASH = '/main/actions/popupflash';
const FLASH_CARREGADO = '/main/settings/flashcharged';
const flashSuportado = !process.env.FAKE_SEM_FLASH && /canon|eos/i.test(MODELO);

function flashCarregado() {
  if (process.env.FAKE_FLASH_MARKER) return fs.existsSync(process.env.FAKE_FLASH_MARKER) ? '1' : '0';
  return process.env.FAKE_FLASH_CARREGADO === '1' ? '1' : '0';
}

if (tem('--get-config')) {
  const chave = valor('--get-config');
  if (flashSuportado && chave === POPUP_FLASH) {
    process.stdout.write('Label: Popup Flash\nReadonly: 0\nType: TOGGLE\nCurrent: 2\nEND\n');
    process.exit(0);
  }
  if (flashSuportado && chave === FLASH_CARREGADO) {
    process.stdout.write(`Label: Flash Charging State\nReadonly: 1\nType: TEXT\nCurrent: ${flashCarregado()}\nEND\n`);
    process.exit(0);
  }
  if (!(chave in CONFIG)) {
    process.stderr.write(`*** Error ***\nUnknown config name ${chave}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Label: ${chave}\nReadonly: 0\nType: RADIO\nCurrent: ${CONFIG[chave]}\nEND\n`
  );
  process.exit(0);
}

if (tem('--set-config')) {
  const pares = args
    .map((arg, index) => arg === '--set-config' ? args[index + 1] : null)
    .filter(Boolean);

  for (const par of pares) {
    const [chave, valorNovo] = par.split('=');
    if (flashSuportado && chave === POPUP_FLASH) {
      if (process.env.FAKE_FLASH_MARKER) fs.writeFileSync(process.env.FAKE_FLASH_MARKER, 'levantado');
      if (process.env.FAKE_FLASH_COUNT_FILE) fs.appendFileSync(process.env.FAKE_FLASH_COUNT_FILE, '1\n');
      continue;
    }
    const nome = chave.split('/').pop();
    if (!(nome in CONFIG)) {
      process.stderr.write(`*** Error ***\nUnknown config name ${chave}\n`);
      process.exit(1);
    }
    if (nome === 'autoexposuremodedial' && valorNovo === 'P' && process.env.FAKE_EXPOSURE_MARKER) {
      fs.writeFileSync(process.env.FAKE_EXPOSURE_MARKER, 'P');
    }
  }

  if (!tem('--capture-image-and-download')) process.exit(0);
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

  if (process.env.FAKE_LIVE_ZERO_ATE_RESET && !fs.existsSync(process.env.FAKE_LIVE_ZERO_ATE_RESET)) {
    setTimeout(() => {
      process.stderr.write('Movie capture finished (0 frames)\n');
      process.exit(0);
    }, 100);
    setInterval(() => {}, 1 << 30);
    return;
  }

  if (process.env.FAKE_LIVE_SEM_QUADROS ||
      (process.env.FAKE_LIVE_MUDO_ATE_RESET && !fs.existsSync(process.env.FAKE_LIVE_MUDO_ATE_RESET))) {
    setInterval(() => {}, 1 << 30);
    return;
  }

  const timer = setInterval(() => {
    const travaApos = Number(process.env.FAKE_LIVE_TRAVA_APOS || 0);
    if (travaApos > 0 && n >= travaApos) return;
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

    if (process.env.FAKE_CAPTURA_ARQUIVO) {
      fs.copyFileSync(process.env.FAKE_CAPTURA_ARQUIVO, alvo);
    } else {
      // Um "arquivo grande" plausível, para o teste conferir bytes.
      fs.writeFileSync(alvo, Buffer.concat([jpegFalso(255), Buffer.alloc(200_000, 0x7f)]));
    }
    process.stdout.write(`New file is in location ${alvo} on the camera\n`);
    process.exit(0);
  }, demora);
}

else {
  process.stderr.write(`fake-gphoto2: argumentos não reconhecidos: ${args.join(' ')}\n`);
  process.exit(2);
}
