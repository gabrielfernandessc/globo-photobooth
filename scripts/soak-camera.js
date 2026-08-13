#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   SOAK — o teste que decide se a câmera vai ao evento

   Dispara N vezes seguidas contra o servidor de verdade e mede o que
   degrada. Um totem que faz 3 fotos não prova nada; o que quebra em
   evento aparece na trigésima — memória, descritores, sessão PTP
   cansada, cartão reclamando.

   Serve também como EXPERIMENTO CONTROLADO. A hipótese em aberto é que
   gravar no cartão durante o disparo remoto é o que corrompe a base de
   imagens da Sony. Para isolar, rode o mesmo comando duas vezes,
   mudando só "Dest. salv. img. est." na câmera:

     --rotulo pc-only        com PC Only
     --rotulo pc-mais-camera com PC+Câmera

   Se PC Only fechar limpo e PC+Câmera acusar recuperação de cartão, a
   causa está isolada. Se ambos falharem, a suspeita muda de lugar — e
   é por isso que o resultado é gravado em JSON, não só impresso.

   Uso:
     node scripts/soak-camera.js --n 30 --rotulo pc-only
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opcao = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? args[i + 1] : padrao;
};

const TOTAL = parseInt(opcao('n', '30'), 10);
const BASE = opcao('base', 'http://localhost:3000');
const ROTULO = opcao('rotulo', 'sem-rotulo');
const PAUSA_MS = parseInt(opcao('pausa', '2000'), 10);

const cor = { verde: s => `\x1b[32m${s}\x1b[0m`, vermelho: s => `\x1b[31m${s}\x1b[0m`, cinza: s => `\x1b[90m${s}\x1b[0m`, forte: s => `\x1b[1m${s}\x1b[0m` };

async function json(url, opcoes) {
  const resp = await fetch(url, opcoes);
  return { status: resp.status, corpo: await resp.json().catch(() => ({})) };
}

async function principal() {
  console.log(cor.forte(`\n  SOAK — ${TOTAL} capturas · rótulo "${ROTULO}"\n`));

  const saude = await json(`${BASE}/api/health`).catch(() => null);
  if (!saude || !saude.corpo.ok) {
    console.error(cor.vermelho('  O servidor não respondeu. Suba o totem antes.'));
    process.exit(1);
  }

  const camera = (await json(`${BASE}/api/camera/status`)).corpo;
  if (!camera.transmitindo) {
    console.error(cor.vermelho(`  A câmera não está transmitindo (estado: ${camera.estado}).`));
    console.error(cor.cinza(`  ${camera.erro || 'acorde a câmera e confira o modo PC Remoto'}`));
    process.exit(1);
  }
  console.log(cor.cinza(`  ${camera.modelo}\n`));

  const capturas = [];
  const falhas = [];
  const memoriaInicial = process.memoryUsage().rss;

  for (let i = 1; i <= TOTAL; i++) {
    const inicio = Date.now();
    process.stdout.write(`  ${String(i).padStart(3)}/${TOTAL}  `);

    try {
      const preparo = await json(`${BASE}/api/camera/prepare`, { method: 'POST' });
      if (preparo.status !== 200) throw new Error(preparo.corpo.error || `preparo HTTP ${preparo.status}`);

      const { status, corpo } = await json(`${BASE}/api/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aspectRatio: '3:4' }),
      });

      const ms = Date.now() - inicio;

      if (status !== 200 || !corpo.success) {
        falhas.push({ n: i, erro: corpo.error || `HTTP ${status}`, ms });
        console.log(cor.vermelho(`✗ ${corpo.error || status}`));
      } else {
        const m = corpo.data.meta;
        capturas.push({ n: i, ms, disparoMs: corpo.data.timings?.disparoMs, largura: m.finalWidth, altura: m.finalHeight, bytes: m.finalBytes, moldura: m.frameApplied });
        console.log(cor.verde('✓') + cor.cinza(` ${ms} ms · ${m.finalWidth}x${m.finalHeight} · ${(m.finalBytes / 1048576).toFixed(1)} MB${m.frameApplied ? '' : ' · SEM MOLDURA'}`));
      }
    } catch (err) {
      falhas.push({ n: i, erro: err.message, ms: Date.now() - inicio });
      console.log(cor.vermelho(`✗ ${err.message}`));
    }

    // Ritmo de fila real: o convidado seguinte não chega no mesmo instante.
    if (i < TOTAL) await new Promise(r => setTimeout(r, PAUSA_MS));
  }

  /* ── Resultado ── */

  const tempos = capturas.map(c => c.ms).sort((a, b) => a - b);
  const pct = p => tempos[Math.min(tempos.length - 1, Math.floor(tempos.length * p))] || 0;

  // Degradação importa mais que valor absoluto: uma sessão PTP que
  // cansa aparece como as últimas capturas ficando mais lentas que as
  // primeiras, não como um número alto desde o começo.
  const metade = Math.floor(capturas.length / 2);
  const mediaDe = lista => lista.length ? Math.round(lista.reduce((s, c) => s + c.ms, 0) / lista.length) : 0;
  const primeiraMetade = mediaDe(capturas.slice(0, metade));
  const segundaMetade = mediaDe(capturas.slice(metade));

  const saudeFinal = (await json(`${BASE}/api/health`)).corpo;
  const cameraFinal = (await json(`${BASE}/api/camera/status`)).corpo;

  const relatorio = {
    rotulo: ROTULO,
    em: new Date().toISOString(),
    camera: camera.modelo,
    pedidas: TOTAL,
    concluidas: capturas.length,
    falhas,
    tempos: { mediana: pct(0.5), p95: pct(0.95), max: tempos.at(-1) || 0, primeiraMetade, segundaMetade },
    degradacaoPercentual: primeiraMetade ? +(((segundaMetade - primeiraMetade) / primeiraMetade) * 100).toFixed(1) : 0,
    memoriaMB: +((process.memoryUsage().rss - memoriaInicial) / 1048576).toFixed(1),
    semMoldura: capturas.filter(c => !c.moldura).length,
    cameraAoFinal: { estado: cameraFinal.estado, transmitindo: cameraFinal.transmitindo, erro: cameraFinal.erro },
    fotosNoEvento: saudeFinal.photos,
    capturas,
  };

  console.log(cor.forte('\n  RESULTADO'));
  console.log('  ─────────');
  console.log(`  concluídas    ${relatorio.concluidas}/${TOTAL}${falhas.length ? cor.vermelho(`  (${falhas.length} falhas)`) : ''}`);
  console.log(`  mediana       ${relatorio.tempos.mediana} ms`);
  console.log(`  P95           ${relatorio.tempos.p95} ms`);
  console.log(`  1ª vs 2ª      ${primeiraMetade} ms → ${segundaMetade} ms  (${relatorio.degradacaoPercentual > 0 ? '+' : ''}${relatorio.degradacaoPercentual}%)`);
  console.log(`  memória       +${relatorio.memoriaMB} MB`);
  console.log(`  câmera        ${cameraFinal.estado}${cameraFinal.transmitindo ? '' : cor.vermelho(' — parou de transmitir')}`);
  if (relatorio.semMoldura) console.log(cor.vermelho(`  sem moldura   ${relatorio.semMoldura} fotos`));

  const arquivo = path.join(process.cwd(), `soak-${ROTULO}-${Date.now()}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(relatorio, null, 2));
  console.log(cor.cinza(`\n  ${arquivo}`));

  console.log(cor.forte('\n  CONFIRA NA CÂMERA AGORA:'));
  console.log('  · ela pediu "Recuperar dados" ou "Recover Image DB"?');
  console.log('  · a configuração de USB continua em PC Remoto?');
  console.log(cor.cinza('  Anote a resposta junto do JSON — é ela que isola a causa.\n'));

  // Falhar em capturas é motivo para o CI/operador não seguir adiante.
  process.exit(falhas.length ? 1 : 0);
}

principal().catch(err => {
  console.error(cor.vermelho(`\n  soak quebrou: ${err.message}\n`));
  process.exit(1);
});
