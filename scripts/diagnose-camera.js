#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   DIAGNÓSTICO DE CÂMERA — medir, não prometer

   Conecte UMA câmera por USB, ligada, e rode:

     node scripts/diagnose-camera.js

   Ele responde as três perguntas que decidem a arquitetura:

     1. o gphoto2 enxerga e assume esta câmera?
     2. ela entrega LIVE VIEW, e a quantos quadros por segundo?
     3. ela entrega a foto em RESOLUÇÃO PLENA, e em quanto tempo?

   Nada aqui é opinião: o que sair na tela é o que a câmera fez.
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-camera-'));

const cor = {
  ok: t => `\x1b[32m${t}\x1b[0m`,
  erro: t => `\x1b[31m${t}\x1b[0m`,
  aviso: t => `\x1b[33m${t}\x1b[0m`,
  forte: t => `\x1b[1m${t}\x1b[0m`,
  fraco: t => `\x1b[90m${t}\x1b[0m`,
};

const log = (...a) => console.log(...a);
const titulo = t => log(`\n${cor.forte(t)}\n${'─'.repeat(t.length)}`);

function rodar(cmd, args, { timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LANG: 'C' } },
      (err, stdout, stderr) => resolve({ ok: !err, err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

/**
 * No macOS o próprio sistema assume a câmera PTP assim que ela conecta,
 * e o gphoto2 recebe "Could not claim the USB device". Derrubar o
 * PTPCamera é o passo que quase todo tutorial esquece de mencionar.
 */
async function liberarCameraNoMac() {
  if (process.platform !== 'darwin') return false;
  const { stdout } = await rodar('pgrep', ['-x', 'PTPCamera']);
  if (!stdout.trim()) return false;

  await rodar('killall', ['PTPCamera']);
  log(cor.aviso('  PTPCamera do macOS derrubado (ele disputa a câmera com o gphoto2)'));
  await new Promise(r => setTimeout(r, 800));
  return true;
}

async function medirImagem(arquivo) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(arquivo).metadata();
    return { largura: meta.width, altura: meta.height, formato: meta.format };
  } catch {
    return null;
  }
}

/* ── 1. A câmera está aí? ───────────────────────────────── */

async function detectar() {
  titulo('1. DETECÇÃO');

  const versao = await rodar('gphoto2', ['--version']);
  if (!versao.ok) {
    log(cor.erro('  gphoto2 não está instalado.'));
    log('  macOS:  brew install gphoto2');
    log('  Linux:  sudo apt install gphoto2');
    process.exit(1);
  }
  log(`  gphoto2 ${cor.fraco(versao.stdout.split('\n')[0].replace('gphoto2', '').trim())}`);

  await liberarCameraNoMac();

  const det = await rodar('gphoto2', ['--auto-detect']);
  const linhas = det.stdout.split('\n').slice(2).filter(l => l.trim() && !/^-+$/.test(l));

  if (!linhas.length) {
    log(cor.erro('\n  Nenhuma câmera detectada.'));
    log('\n  Confira:');
    log('    • a câmera está LIGADA e conectada por USB (cabo de dados, não só de carga)');
    log('    • Sony: menu → USB → "Conexão USB" = ' + cor.forte('PC Remoto'));
    log('      (em "Armaz. em massa" ou MTP o gphoto2 vê a câmera mas NÃO consegue fotografar)');
    log('    • Canon: normalmente funciona sem ajuste nenhum');
    process.exit(1);
  }

  log(cor.ok(`\n  ${linhas.length} câmera(s):`));
  linhas.forEach(l => log(`    ${l.trim()}`));

  const modelo = linhas[0].trim().replace(/\s{2,}usb:.*$/, '').trim();

  // O modo importa mais que o modelo: a mesma câmera em MTP não fotografa.
  if (/MTP|Mass Storage/i.test(modelo)) {
    log(cor.erro(`\n  ATENÇÃO: "${modelo}" está em modo MTP/armazenamento.`));
    log('  Nesse modo o driver NÃO suporta captura. Troque o USB da câmera para PC Remoto.');
  }

  return modelo;
}

/* ── 2. O que o driver diz que sabe fazer? ──────────────── */

async function habilidades(modelo) {
  titulo('2. CAPACIDADES DECLARADAS PELO DRIVER');

  const { stdout } = await rodar('gphoto2', ['--camera', modelo, '--port', 'usb:', '--abilities']);
  const capturas = [];
  let dentro = false;

  for (const linha of stdout.split('\n')) {
    if (/Capture choices/i.test(linha)) { dentro = true; continue; }
    if (dentro) {
      const m = /^\s*:\s*(.+?)\s*$/.exec(linha);
      if (m) { capturas.push(m[1]); continue; }
      if (linha.trim()) dentro = false;
    }
  }

  const temPreview = capturas.some(c => /Preview/i.test(c));
  const temImagem = capturas.some(c => /^Image$/i.test(c));

  log(`  Captura de imagem : ${temImagem ? cor.ok('sim') : cor.erro('NÃO')}`);
  log(`  Live view         : ${temPreview ? cor.ok('sim') : cor.erro('NÃO')}`);
  log(`  Configuração      : ${/Configuration support\s*:\s*yes/i.test(stdout) ? cor.ok('sim') : cor.aviso('não')}`);

  return { temPreview, temImagem };
}

/* ── 3. Live view de verdade ────────────────────────────── */

/**
 * `--capture-movie --stdout` entrega um MJPEG contínuo. Contar os
 * marcadores de início de JPEG (FFD8) no que sair é a medição direta de
 * quantos quadros por segundo a câmera realmente entrega — que é o
 * número que decide se o preview do totem vai ser fluido ou travado.
 */
async function medirLiveView(modelo, segundos = 6) {
  titulo(`3. LIVE VIEW (${segundos}s de medição)`);

  return new Promise(resolve => {
    const proc = spawn('gphoto2', ['--camera', modelo, '--port', 'usb:', '--capture-movie', '--stdout'], {
      env: { ...process.env, LANG: 'C' },
    });

    let bytes = 0;
    let quadros = 0;
    let primeiroQuadroEm = null;
    let ultimoJpeg = Buffer.alloc(0);
    let buffer = Buffer.alloc(0);
    let stderr = '';
    const inicio = Date.now();

    proc.stdout.on('data', pedaco => {
      bytes += pedaco.length;
      buffer = Buffer.concat([buffer, pedaco]);

      // Conta marcadores SOI (FFD8FF) e guarda o último quadro completo.
      let idx = 0;
      while ((idx = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), idx)) !== -1) {
        const fim = buffer.indexOf(Buffer.from([0xff, 0xd9]), idx + 3);
        if (fim === -1) break;
        quadros++;
        primeiroQuadroEm ??= Date.now();
        ultimoJpeg = buffer.subarray(idx, fim + 2);
        idx = fim + 2;
      }
      if (idx > 0) buffer = buffer.subarray(idx);
    });

    proc.stderr.on('data', d => { stderr += d; });

    const parar = setTimeout(() => proc.kill('SIGTERM'), segundos * 1000);

    proc.on('close', async () => {
      clearTimeout(parar);
      const duracao = (Date.now() - inicio) / 1000;

      if (!quadros) {
        log(cor.erro('  Nenhum quadro de live view recebido.'));
        const motivo = stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n    ');
        if (motivo) log(cor.fraco(`    ${motivo}`));
        log(cor.aviso('\n  Sem live view esta câmera não serve para o preview do telão,'));
        log(cor.aviso('  mas ainda pode servir para a captura (ver etapa 4).'));
        return resolve({ ok: false, quadros: 0 });
      }

      const fps = quadros / duracao;
      const arquivo = path.join(TRABALHO, 'liveview.jpg');
      fs.writeFileSync(arquivo, ultimoJpeg);
      const dim = await medirImagem(arquivo);

      log(cor.ok(`  ${quadros} quadros em ${duracao.toFixed(1)}s`));
      log(`  Taxa            : ${cor.forte(fps.toFixed(1) + ' fps')}`);
      log(`  Resolução       : ${dim ? cor.forte(`${dim.largura}×${dim.altura}`) : '?'}`);
      log(`  Tamanho médio   : ${Math.round(bytes / quadros / 1024)} KB/quadro`);
      log(`  Banda           : ${(bytes / duracao / 1024 / 1024).toFixed(1)} MB/s`);
      log(cor.fraco(`  Amostra salva em ${arquivo}`));

      if (fps < 10) log(cor.aviso('\n  Abaixo de 10 fps o preview fica perceptivelmente travado.'));

      resolve({ ok: true, quadros, fps, dim, arquivo });
    });

    proc.on('error', err => {
      clearTimeout(parar);
      log(cor.erro(`  Falha ao iniciar o live view: ${err.message}`));
      resolve({ ok: false, quadros: 0 });
    });
  });
}

/* ── 4. A foto em resolução plena ───────────────────────── */

async function medirCaptura(modelo) {
  titulo('4. CAPTURA EM RESOLUÇÃO PLENA');

  const destino = path.join(TRABALHO, 'captura.%C');
  const inicio = Date.now();

  const r = await rodar('gphoto2', [
    '--camera', modelo, '--port', 'usb:',
    '--capture-image-and-download',
    '--filename', destino,
    '--force-overwrite',
  ], { timeoutMs: 60_000 });

  const decorrido = Date.now() - inicio;

  if (!r.ok) {
    log(cor.erro('  A captura falhou.'));
    const motivo = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-4).join('\n    ');
    if (motivo) log(cor.fraco(`    ${motivo}`));
    if (/claim|busy/i.test(r.stderr)) {
      log(cor.aviso('\n  Outro programa está segurando a câmera.'));
      log('  macOS: killall PTPCamera   |   Feche Imaging Edge / EOS Utility / Lightroom.');
    }
    return { ok: false };
  }

  const arquivos = fs.readdirSync(TRABALHO).filter(f => f.startsWith('captura.'));
  if (!arquivos.length) {
    log(cor.erro('  A câmera disparou mas nenhum arquivo foi baixado.'));
    return { ok: false };
  }

  log(cor.ok(`  Disparo → arquivo em ${cor.forte(decorrido + ' ms')}`));

  for (const nome of arquivos) {
    const caminho = path.join(TRABALHO, nome);
    const tamanho = fs.statSync(caminho).size;
    const dim = await medirImagem(caminho);
    const mp = dim ? ((dim.largura * dim.altura) / 1e6).toFixed(1) : '?';

    log(`  ${nome.padEnd(16)} ${cor.forte(dim ? `${dim.largura}×${dim.altura}` : '(RAW)')}` +
        `  ${mp} MP  ${(tamanho / 1024 / 1024).toFixed(1)} MB  ${dim?.formato || path.extname(nome).slice(1)}`);
  }

  log(cor.fraco(`\n  Arquivos em ${TRABALHO}`));
  return { ok: true, decorrido, arquivos };
}

/* ── Veredito ───────────────────────────────────────────── */

async function principal() {
  log(cor.forte('\n  DIAGNÓSTICO DE CÂMERA — Globo Photo Booth'));
  log(cor.fraco(`  ${process.platform} · node ${process.version}`));

  const modelo = await detectar();
  const abil = await habilidades(modelo);

  const live = abil.temPreview ? await medirLiveView(modelo) : { ok: false, quadros: 0 };
  const captura = abil.temImagem ? await medirCaptura(modelo) : { ok: false };

  titulo('VEREDITO');
  log(`  Câmera     : ${cor.forte(modelo)}`);
  log(`  Live view  : ${live.ok ? cor.ok(`${live.fps.toFixed(1)} fps @ ${live.dim?.largura}×${live.dim?.altura}`) : cor.erro('indisponível')}`);
  log(`  Captura    : ${captura.ok ? cor.ok(`${captura.decorrido} ms`) : cor.erro('indisponível')}`);

  log('');
  if (live.ok && captura.ok) {
    log(cor.ok('  Esta câmera serve como fonte completa do totem:'));
    log(cor.ok('  preview no telão + foto em resolução plena.'));
  } else if (captura.ok) {
    log(cor.aviso('  Serve para a FOTO, mas não para o preview.'));
    log('  O telão precisaria de outra fonte de preview (webcam ou celular).');
  } else {
    log(cor.erro('  Esta câmera não está utilizável pelo gphoto2 agora.'));
    log('  Reveja o modo USB da câmera e os programas que possam estar segurando-a.');
  }
  log('');
}

principal().catch(err => {
  console.error(cor.erro(`\n  Erro inesperado: ${err.message}\n`));
  process.exit(1);
});
