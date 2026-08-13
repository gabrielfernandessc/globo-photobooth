/* ══════════════════════════════════════════════════════════
   CÂMERA DSLR — o ciclo live view → disparo → live view

   A câmera é exclusiva: um processo por vez segura o USB. Todo o valor
   deste arquivo está em provar que a troca de mãos acontece sem perder
   o preview, sem perder a foto e sem deixar processo órfão.

   Roda contra um gphoto2 falso. O que se testa é o nosso código; o
   libgphoto2 é verificado com câmera real pelo scripts/diagnose-camera.js.
   ══════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createGphotoCamera, ESTADO, tempoAssentamento } = require('../lib/camera-gphoto');
const { createPreviewHub } = require('../lib/preview');

const FAKE = path.join(__dirname, 'helpers', 'fake-gphoto2.js');

/** Envolve o fake num executável, já que o bridge chama um binário. */
function prepararFake(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-fake-'));
  const bin = path.join(dir, 'gphoto2');

  const linhas = Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join('\n');
  fs.writeFileSync(bin, `#!/bin/bash\n${linhas}\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  fs.chmodSync(bin, 0o755);

  return { bin, dir, limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function ambiente(env = {}, opcoes = {}) {
  const fake = prepararFake(env);
  const preview = createPreviewHub();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cap-'));

  const camera = createGphotoCamera({
    preview,
    sessionCode: 'AB3D',
    binario: fake.bin,
    sondarUsb: async () => false,
    pastaTemp: temp,
    ...opcoes,
  });

  return {
    camera,
    preview,
    temp,
    async limpar() {
      await camera.stop();
      fake.limpar();
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

/** Aguarda uma condição, para o teste não depender de sleep fixo. */
async function ate(condicao, { prazoMs = 5000, intervalo = 50 } = {}) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    if (await condicao()) return true;
    await esperar(intervalo);
  }
  return false;
}

test('a câmera é detectada e começa a transmitir', async () => {
  const a = ambiente();
  try {
    assert.equal(await a.camera.start(), true);

    const transmitindo = await ate(() => a.camera.status().transmitindo);
    assert.ok(transmitindo, 'a câmera não começou a transmitir');

    const s = a.camera.status();
    assert.equal(s.estado, ESTADO.LIVE_VIEW);
    assert.equal(s.modelo, 'Canon EOS Rebel T6');
    assert.ok(s.quadros > 0);
  } finally {
    await a.limpar();
  }
});

test('a Canon tem prioridade sobre Sony e celular MTP', async () => {
  const cameras = JSON.stringify([
    { modelo: 'Samsung Galaxy models (MTP)', porta: 'usb:001,001' },
    { modelo: 'Sony Alpha-A7 III (PC Control)', porta: 'usb:001,002' },
    { modelo: 'Canon EOS 750D', porta: 'usb:001,003' },
  ]);
  const a = ambiente({ FAKE_CAMERAS: cameras });
  try {
    await a.camera.start();
    assert.ok(await ate(() => a.camera.status().transmitindo));
    assert.equal(a.camera.status().modelo, 'Canon EOS 750D');
  } finally {
    await a.limpar();
  }
});

test('o app troca da Sony para a Canon quando ela é ligada depois', async () => {
  const arquivo = path.join(os.tmpdir(), `booth-cameras-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(arquivo, JSON.stringify([
    { modelo: 'Sony Alpha-A7 III (PC Control)', porta: 'usb:001,002' },
  ]));
  const a = ambiente(
    { FAKE_CAMERAS_FILE: arquivo },
    { intervaloPreferenciaMs: 80 },
  );
  try {
    await a.camera.start();
    assert.ok(await ate(() => a.camera.status().transmitindo));
    assert.equal(a.camera.status().modelo, 'Sony Alpha-A7 III (PC Control)');

    fs.writeFileSync(arquivo, JSON.stringify([
      { modelo: 'Sony Alpha-A7 III (PC Control)', porta: 'usb:001,002' },
      { modelo: 'Canon EOS 750D', porta: 'usb:001,003' },
    ]));

    assert.ok(await ate(
      () => a.camera.status().modelo === 'Canon EOS 750D' && a.camera.status().transmitindo,
      { prazoMs: 3000 },
    ));
  } finally {
    await a.limpar();
    fs.rmSync(arquivo, { force: true });
  }
});

test('a Canon EOS Rebel T6i é reconhecida pelo nome internacional 750D', async () => {
  const a = ambiente({ FAKE_MODELO: 'Canon EOS 750D' });
  try {
    await a.camera.start();
    assert.ok(await ate(() => a.camera.status().transmitindo));
    assert.equal(a.camera.status().modelo, 'Canon EOS 750D');
    assert.equal(tempoAssentamento(a.camera.status().modelo), 120);

    const perfil = await a.camera.lerPerfil();
    assert.equal(perfil.imageformat, 'Large Fine JPEG');
    assert.equal(perfil.aperture, '8');
  } finally {
    await a.limpar();
  }
});

test('o app levanta o flash interno da T6i e devolve o live view', async () => {
  const marcador = path.join(os.tmpdir(), `booth-flash-${process.pid}-${Date.now()}`);
  const modoP = path.join(os.tmpdir(), `booth-flash-modo-p-${process.pid}-${Date.now()}`);
  const a = ambiente({
    FAKE_MODELO: 'Canon EOS 750D',
    FAKE_FLASH_MARKER: marcador,
    FAKE_EXPOSURE_MARKER: modoP,
  });
  try {
    await a.camera.start();
    assert.ok(await ate(() => a.camera.status().transmitindo));

    const inicial = await a.camera.lerFlash();
    assert.equal(inicial.suportado, true);
    assert.equal(inicial.podeLevantar, true);
    assert.equal(inicial.podeRecolher, false);
    assert.equal(inicial.carregado, false);
    assert.ok(await ate(() => a.camera.status().transmitindo), 'consultar o flash deixou o preview parado');

    const levantado = await a.camera.levantarFlash();
    assert.equal(levantado.comandoEnviado, true);
    assert.equal(levantado.carregado, true);
    assert.ok(fs.existsSync(marcador), 'o comando de levantar flash não chegou à câmera');
    assert.equal(fs.readFileSync(modoP, 'utf8'), 'P', 'a T6i precisa sair do Auto para forçar o flash');
    assert.ok(await ate(() => a.camera.status().transmitindo), 'levantar o flash deixou o preview parado');
  } finally {
    await a.limpar();
    fs.rmSync(marcador, { force: true });
    fs.rmSync(modoP, { force: true });
  }
});

test('câmera sem popup remoto recusa o flash sem derrubar o preview', async () => {
  const a = ambiente({ FAKE_MODELO: 'Sony Alpha-A7 III (PC Control)', FAKE_SEM_FLASH: 1 });
  try {
    await a.camera.start();
    assert.ok(await ate(() => a.camera.status().transmitindo));

    const info = await a.camera.lerFlash();
    assert.equal(info.suportado, false);
    await assert.rejects(() => a.camera.levantarFlash(), /não permite levantar o flash/i);
    assert.ok(await ate(() => a.camera.status().transmitindo), 'erro no flash deixou o preview parado');
  } finally {
    await a.limpar();
  }
});

test('a Sony conserva a margem PTP maior que a Canon', () => {
  assert.equal(tempoAssentamento('Sony Alpha-A7 III (PC Control)'), 600);
  assert.equal(tempoAssentamento('Canon EOS 750D'), 120);
  assert.equal(tempoAssentamento('câmera genérica'), 300);
});

test('os quadros remontados chegam íntegros ao telão', async () => {
  // O pipe entrega JPEG picotado; o bridge precisa remontar procurando
  // início e fim de imagem. Um quadro cortado no meio apareceria como
  // faixa cinza no telão.
  const a = ambiente();
  try {
    await a.camera.start();

    const recebidos = [];
    a.preview.assinar('AB3D', jpeg => recebidos.push(jpeg));

    await ate(() => recebidos.length >= 3);
    assert.ok(recebidos.length >= 3, `só chegaram ${recebidos.length} quadros`);

    for (const jpeg of recebidos) {
      assert.equal(jpeg[0], 0xff, 'quadro não começa com marcador JPEG');
      assert.equal(jpeg[1], 0xd8);
      assert.equal(jpeg[jpeg.length - 2], 0xff, 'quadro não termina com marcador JPEG');
      assert.equal(jpeg[jpeg.length - 1], 0xd9);
    }
  } finally {
    await a.limpar();
  }
});

test('sem câmera conectada o erro é claro e o estado é falha', async () => {
  const a = ambiente({ FAKE_SEM_CAMERA: 1 });
  try {
    assert.equal(await a.camera.start(), false);

    const s = a.camera.status();
    assert.equal(s.estado, ESTADO.FALHA);
    assert.match(s.erro, /nenhuma câmera/i);
    assert.match(s.erro, /cabo/i, 'a mensagem precisa dizer o que conferir');
    assert.equal(s.transmitindo, false);

    await assert.rejects(() => a.camera.capturar(), /Nenhuma câmera conectada/);
  } finally {
    await a.limpar();
  }
});

test('câmera conectada depois do boot é detectada sem reiniciar o app', async () => {
  const marcador = path.join(os.tmpdir(), `booth-camera-presente-${process.pid}-${Date.now()}`);
  const a = ambiente(
    { FAKE_CAMERA_APOS: marcador },
    { intervaloReconexaoMs: 80 },
  );

  try {
    assert.equal(await a.camera.start(), false);
    assert.equal(a.camera.status().estado, ESTADO.FALHA);

    fs.writeFileSync(marcador, 'presente');

    const conectou = await ate(() => a.camera.status().transmitindo, { prazoMs: 3000 });
    assert.ok(conectou, 'a câmera não foi redetectada depois de aparecer');
    assert.equal(a.camera.status().estado, ESTADO.LIVE_VIEW);
  } finally {
    await a.limpar();
    fs.rmSync(marcador, { force: true });
  }
});

test('o disparo solta o live view, grava o arquivo e devolve o live view', async () => {
  const a = ambiente();
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    const resultado = await a.camera.capturar();

    assert.ok(fs.existsSync(resultado.arquivo), 'o arquivo da foto não foi gravado');
    assert.ok(fs.statSync(resultado.arquivo).size > 100_000, 'a foto saiu pequena demais');
    assert.match(resultado.arquivo, /\.jpg$/);
    assert.ok(resultado.ms > 0);

    // E o preview volta sozinho — o telão não pode ficar preto depois da
    // primeira foto do evento.
    const voltou = await ate(() => a.camera.status().transmitindo);
    assert.ok(voltou, 'o live view não voltou depois do disparo');
    assert.equal(a.camera.status().estado, ESTADO.LIVE_VIEW);
  } finally {
    await a.limpar();
  }
});

test('pré-armar durante o número 1 tira o assentamento do pós-contagem', async () => {
  const a = ambiente({ FAKE_MODELO: 'Canon EOS 750D', FAKE_CAPTURA_MS: 100 });
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    const preparo = await a.camera.prepararCaptura();
    assert.equal(preparo.pronta, true);
    assert.equal(preparo.assentamentoMs, 120);
    assert.equal(a.camera.status().estado, ESTADO.PREPARANDO);
    assert.equal(a.camera.status().preparada, true);

    const resultado = await a.camera.capturar();
    assert.equal(resultado.prearmada, true);
    assert.ok(resultado.comandoMs < 500, `o comando demorou ${resultado.comandoMs} ms`);

    assert.ok(await ate(() => a.camera.status().transmitindo));
  } finally {
    await a.limpar();
  }
});

test('flash persistido é rearmado no mesmo comando do disparo', async () => {
  const marcador = path.join(os.tmpdir(), `booth-flash-preparo-${process.pid}-${Date.now()}`);
  const contador = path.join(os.tmpdir(), `booth-flash-contador-${process.pid}-${Date.now()}`);
  const modoP = path.join(os.tmpdir(), `booth-flash-preparo-p-${process.pid}-${Date.now()}`);
  const a = ambiente({
    FAKE_MODELO: 'Canon EOS 750D',
    FAKE_FLASH_MARKER: marcador,
    FAKE_FLASH_COUNT_FILE: contador,
    FAKE_EXPOSURE_MARKER: modoP,
    FAKE_CAPTURA_MS: 100,
  });
  try {
    await a.camera.start();
    assert.ok(await ate(() => a.camera.status().transmitindo));

    const preparo = await a.camera.prepararCaptura({ flash: true });
    assert.equal(preparo.flash.comandoEnviado, true);
    assert.ok(fs.existsSync(marcador), 'o preparo não levantou o flash');
    assert.equal(fs.readFileSync(contador, 'utf8').trim().split('\n').length, 1);

    const resultado = await a.camera.capturar({ flash: true });
    assert.equal(resultado.prearmada, true);
    assert.equal(resultado.flash, true);
    assert.equal(fs.readFileSync(contador, 'utf8').trim().split('\n').length, 2);
    assert.equal(fs.readFileSync(modoP, 'utf8'), 'P');
    assert.ok(await ate(() => a.camera.status().transmitindo));
  } finally {
    await a.limpar();
    fs.rmSync(marcador, { force: true });
    fs.rmSync(contador, { force: true });
    fs.rmSync(modoP, { force: true });
  }
});

test('preparo abandonado devolve o live view sozinho', async () => {
  const a = ambiente({ FAKE_MODELO: 'Canon EOS 750D' });
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    await a.camera.prepararCaptura({ validadeMs: 80 });
    assert.equal(a.camera.status().transmitindo, false);

    const voltou = await ate(() => a.camera.status().transmitindo, { prazoMs: 2500 });
    assert.ok(voltou, 'uma contagem cancelada deixou a Canon fora do live view');
  } finally {
    await a.limpar();
  }
});

test('capturas seguidas funcionam, uma depois da outra', async () => {
  // O caso do evento: fila de convidados, uma foto atrás da outra.
  const a = ambiente({ FAKE_CAPTURA_MS: 150 });
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    const arquivos = [];
    for (let i = 0; i < 4; i++) {
      const r = await a.camera.capturar();
      arquivos.push(r.arquivo);
      await ate(() => a.camera.status().transmitindo);
    }

    assert.equal(new Set(arquivos).size, 4, 'houve colisão de nome entre capturas');
    for (const f of arquivos) assert.ok(fs.existsSync(f), `${f} sumiu`);
  } finally {
    await a.limpar();
  }
});

test('disparo que falha não deixa o telão preto', async () => {
  // Perder uma foto é ruim; perder o preview pelo resto do evento é
  // muito pior — o totem inteiro pareceria quebrado.
  const a = ambiente({ FAKE_CAPTURA_FALHA: 1 });
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    await assert.rejects(() => a.camera.capturar(), /Disparo falhou/);

    const voltou = await ate(() => a.camera.status().transmitindo);
    assert.ok(voltou, 'o live view não voltou depois de um disparo falho');
  } finally {
    await a.limpar();
  }
});

test('dois disparos ao mesmo tempo são recusados', async () => {
  // A câmera é exclusiva: deixar dois disparos correrem juntos daria
  // "could not claim the USB device" e derrubaria os dois.
  const a = ambiente({ FAKE_CAPTURA_MS: 600 });
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    const primeiro = a.camera.capturar();
    await esperar(80);
    await assert.rejects(() => a.camera.capturar(), /Já existe um disparo/);

    assert.ok((await primeiro).arquivo, 'o primeiro disparo deveria ter concluído');
  } finally {
    await a.limpar();
  }
});

test('live view que cai sozinho é religado', async () => {
  // Cabo USB com mau contato, câmera que dorme: acontece em evento e o
  // operador não pode ter que reiniciar o totem por causa disso.
  const a = ambiente({ FAKE_LIVE_FALHA: 1 });
  try {
    const estados = [];
    a.camera.onChange(e => estados.push(e.estado));

    await a.camera.start();
    const transmitiu = await ate(() => a.camera.status().transmitindo, { prazoMs: 2500 });
    assert.ok(transmitiu, 'deveria ter transmitido antes de cair');
    estados.length = 0;
    await ate(() => estados.includes(ESTADO.RELIGANDO), { prazoMs: 4000 });

    assert.ok(estados.includes(ESTADO.RELIGANDO), `não tentou religar: ${estados.join(' → ')}`);
  } finally {
    await a.limpar();
  }
});

test('live view vivo sem nenhum quadro é encerrado e religado', async () => {
  const a = ambiente(
    { FAKE_LIVE_SEM_QUADROS: 1 },
    { timeoutPrimeiroQuadroMs: 180 },
  );

  try {
    const estados = [];
    a.camera.onChange(e => estados.push(e.estado));

    await a.camera.start();
    const tentouReligar = await ate(() => estados.includes(ESTADO.RELIGANDO), { prazoMs: 2500 });

    assert.ok(tentouReligar, `stream mudo não foi reiniciado: ${estados.join(' → ')}`);
    assert.equal(a.camera.status().transmitindo, false);
  } finally {
    await a.limpar();
  }
});

test('live view que congela depois de transmitir também é religado', async () => {
  const a = ambiente(
    { FAKE_LIVE_TRAVA_APOS: 3 },
    { timeoutEntreQuadrosMs: 180, intervaloReconexaoMs: 40 },
  );

  try {
    const estados = [];
    a.camera.onChange(e => estados.push(e.estado));

    await a.camera.start();
    const transmitiu = await ate(() => a.camera.status().quadros >= 3, { prazoMs: 2000 });
    assert.ok(transmitiu, 'o stream deveria transmitir antes de congelar');

    estados.length = 0;
    const religou = await ate(() => estados.includes(ESTADO.RELIGANDO), { prazoMs: 2500 });
    assert.ok(religou, `stream congelado não foi reiniciado: ${estados.join(' → ')}`);
  } finally {
    await a.limpar();
  }
});

test('dois streams mudos resetam a porta USB e recuperam o preview', async () => {
  const marcador = path.join(os.tmpdir(), `booth-camera-reset-${process.pid}-${Date.now()}`);
  const a = ambiente(
    { FAKE_LIVE_MUDO_ATE_RESET: marcador, FAKE_MODELO: 'Sony Alpha-A7 III (PC Control)' },
    {
      timeoutPrimeiroQuadroMs: 120,
      intervaloReconexaoMs: 40,
      streamsMudosAntesReset: 2,
      esperaAposResetMs: 20,
    },
  );

  try {
    await a.camera.start();
    assert.equal(a.camera.status().estado, ESTADO.RELIGANDO, 'não pode declarar live view antes do primeiro quadro');

    const recuperou = await ate(() => a.camera.status().transmitindo, { prazoMs: 6000 });
    assert.ok(recuperou, 'o preview não voltou depois do reset USB');
    assert.ok(fs.existsSync(marcador), 'o driver não executou o reset da porta');
    assert.equal(a.camera.status().estado, ESTADO.LIVE_VIEW);
  } finally {
    await a.limpar();
    fs.rmSync(marcador, { force: true });
  }
});

test('Canon que encerra com zero frames reseta já na primeira ocorrência', async () => {
  const marcador = path.join(os.tmpdir(), `booth-canon-reset-${process.pid}-${Date.now()}`);
  const a = ambiente(
    { FAKE_LIVE_ZERO_ATE_RESET: marcador, FAKE_MODELO: 'Canon EOS 750D' },
    { intervaloReconexaoMs: 30, esperaAposResetMs: 20 },
  );

  try {
    await a.camera.start();
    const recuperou = await ate(() => a.camera.status().transmitindo, { prazoMs: 3500 });

    assert.ok(recuperou, 'a T6i ficou repetindo streams de zero frames');
    assert.ok(fs.existsSync(marcador), 'a primeira queda sem quadros deveria resetar a Canon');
    assert.equal(a.camera.status().modelo, 'Canon EOS 750D');
  } finally {
    await a.limpar();
    fs.rmSync(marcador, { force: true });
  }
});

test('parar encerra o processo do gphoto2 sem deixar órfão', async () => {
  const a = ambiente();
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);

    await a.camera.stop();

    assert.equal(a.camera.status().estado, ESTADO.PARADA);
    assert.equal(a.camera.status().transmitindo, false);

    // Depois de parar, nenhum quadro novo pode aparecer.
    const antes = a.camera.status().quadros;
    await esperar(300);
    assert.equal(a.camera.status().quadros, antes, 'ainda chegaram quadros depois do stop()');
  } finally {
    await a.limpar();
  }
});

test('o status distingue "transmitindo agora" de "já transmitiu um dia"', async () => {
  const a = ambiente();
  try {
    await a.camera.start();
    await ate(() => a.camera.status().transmitindo);
    assert.ok(a.camera.status().quadros > 0);

    await a.camera.stop();
    // O contador acumulado permanece, mas o totem precisa saber que a
    // imagem parou — senão o telão mostra um quadro congelado como se
    // fosse ao vivo.
    assert.ok(a.camera.status().quadros > 0);
    assert.equal(a.camera.status().transmitindo, false);
  } finally {
    await a.limpar();
  }
});

test('câmera visível no USB sem resposta de captura tem diagnóstico próprio', async () => {
  // O sintoma também ocorre quando a Sony está em PC Remoto mas a sessão
  // PTP travou. Mandar apenas trocar o modo deixa o operador sem saída
  // justamente quando a configuração já está certa.
  const fake = prepararFake({ FAKE_SEM_CAMERA: 1 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-modo-'));
  const camera = createGphotoCamera({
    preview: createPreviewHub(),
    sessionCode: 'AB3D',
    binario: fake.bin,
    // O sistema enxerga a câmera no USB, mas o gphoto2 não.
    sondarUsb: async () => true,
    pastaTemp: temp,
  });

  try {
    assert.equal(await camera.start(), false);

    const erro = camera.status().erro;
    assert.match(erro, /PC Remoto/i, 'a mensagem precisa dizer para onde mudar');
    assert.match(erro, /desligue e ligue/i, 'a mensagem precisa cobrir sessão PTP travada');
    assert.doesNotMatch(erro, /nenhuma câmera/i, 'não pode mandar procurar um cabo que está no lugar');
  } finally {
    await camera.stop();
    fake.limpar();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('o perfil da câmera é lido e reaplicado', async () => {
  // A Sony perde a configuração sozinha: um erro de cartão que peça
  // recuperação reseta tudo. Sem perfil guardado, o operador
  // reconfigura de cabeça no meio do evento.
  const a = ambiente();
  try {
    await a.camera.start();

    const perfil = await a.camera.lerPerfil();
    assert.equal(perfil.imagesize, 'Large');
    assert.equal(perfil.aspectratio, '3:2');
    assert.equal(perfil.iso, '800');

    // Ajustes que o corpo não expõe simplesmente não entram — não podem
    // abortar a leitura dos demais.
    assert.ok(!('capturetarget' in perfil), 'ajuste inexistente não deveria virar chave');

    const { aplicados, recusados } = await a.camera.aplicarPerfil(perfil);
    assert.equal(aplicados.length, Object.keys(perfil).length);
    assert.deepEqual(recusados, []);
  } finally {
    await a.limpar();
  }
});

test('um ajuste recusado não impede os outros de voltarem', async () => {
  // Nomes de ajuste mudam entre firmwares. Restaurar seis de oito e
  // dizer quais faltaram é melhor que não restaurar nada.
  const a = ambiente();
  try {
    await a.camera.start();

    const { aplicados, recusados } = await a.camera.aplicarPerfil({
      iso: '400',
      ajusteQueNaoExiste: 'x',
      aspectratio: '3:2',
    });

    assert.deepEqual(aplicados.sort(), ['aspectratio', 'iso']);
    assert.deepEqual(recusados, ['ajusteQueNaoExiste']);
  } finally {
    await a.limpar();
  }
});
