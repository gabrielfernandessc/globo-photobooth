/* ══════════════════════════════════════════════════════════
   GEOMETRIA — a matemática do enquadramento

   É o teste mais importante do produto depois da captura em si: o
   convidado posiciona o rosto olhando o telão, e a foto que ele leva
   precisa ter exatamente aquele recorte. Preview e composição final
   compartilham estas funções justamente para não divergirem.
   ══════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { centerCrop, ratioValue } = require('../lib/photo');

const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];

test('ratioValue converte a notação em número', () => {
  assert.equal(ratioValue('1:1'), 1);
  assert.equal(ratioValue('3:4'), 0.75);
  assert.equal(ratioValue('4:3'), 4 / 3);
  assert.equal(ratioValue('16:9'), 16 / 9);
});

test('ratioValue cai no padrão 3:4 diante de entrada inválida', () => {
  // O valor vem do cliente; um retrato é a escolha segura para um totem.
  assert.equal(ratioValue(undefined), 0.75);
  assert.equal(ratioValue(''), 0.75);
  assert.equal(ratioValue('abc'), 0.75);
  assert.equal(ratioValue('0:0'), 0.75);
  assert.equal(ratioValue('-3:4'), 0.75);
});

test('o corte respeita a proporção pedida em fonte retrato e paisagem', () => {
  const sources = [
    { w: 4000, h: 3000, nome: 'paisagem 4:3' },
    { w: 3000, h: 4000, nome: 'retrato 3:4' },
    { w: 8160, h: 6120, nome: '50 MP do sensor' },
    { w: 1080, h: 1920, nome: 'retrato 9:16' },
    { w: 2000, h: 2000, nome: 'quadrado' },
  ];

  for (const src of sources) {
    for (const ratio of RATIOS) {
      const target = ratioValue(ratio);
      const crop = centerCrop(src.w, src.h, target);
      const actual = crop.width / crop.height;

      // Tolerância de 1 px arredondado nas duas dimensões.
      const tolerance = Math.max(1 / crop.height, target / crop.width) * 1.5;
      assert.ok(
        Math.abs(actual - target) <= tolerance,
        `${src.nome} → ${ratio}: proporção saiu ${actual.toFixed(4)}, esperada ${target.toFixed(4)}`
      );
    }
  }
});

test('o corte nunca sai da imagem de origem', () => {
  for (const [w, h] of [[4000, 3000], [3000, 4000], [1920, 1080], [640, 640]]) {
    for (const ratio of RATIOS) {
      const crop = centerCrop(w, h, ratioValue(ratio));

      assert.ok(crop.left >= 0, `left negativo em ${w}x${h} ${ratio}`);
      assert.ok(crop.top >= 0, `top negativo em ${w}x${h} ${ratio}`);
      assert.ok(crop.width > 0 && crop.height > 0, `corte vazio em ${w}x${h} ${ratio}`);
      assert.ok(
        crop.left + crop.width <= w,
        `estoura à direita em ${w}x${h} ${ratio}: ${crop.left}+${crop.width} > ${w}`
      );
      assert.ok(
        crop.top + crop.height <= h,
        `estoura embaixo em ${w}x${h} ${ratio}: ${crop.top}+${crop.height} > ${h}`
      );
    }
  }
});

test('o corte é o maior possível: uma das dimensões encosta na borda', () => {
  // Se sobrasse margem nos dois eixos estaríamos jogando fora pixels do
  // sensor sem motivo — a foto sairia menor do que o aparelho consegue.
  for (const [w, h] of [[4000, 3000], [3000, 4000], [8160, 6120]]) {
    for (const ratio of RATIOS) {
      const crop = centerCrop(w, h, ratioValue(ratio));
      const encostaNaLargura = crop.width === w;
      const encostaNaAltura = crop.height === h;
      assert.ok(
        encostaNaLargura || encostaNaAltura,
        `${w}x${h} ${ratio}: corte ${crop.width}x${crop.height} deixou margem nos dois eixos`
      );
    }
  }
});

test('o corte é centralizado', () => {
  for (const [w, h] of [[4000, 3000], [3000, 4000]]) {
    for (const ratio of RATIOS) {
      const crop = centerCrop(w, h, ratioValue(ratio));
      const sobraEsquerda = crop.left;
      const sobraDireita = w - (crop.left + crop.width);
      const sobraTopo = crop.top;
      const sobraBase = h - (crop.top + crop.height);

      // Diferença de 1 px é o arredondamento de um resto ímpar.
      assert.ok(
        Math.abs(sobraEsquerda - sobraDireita) <= 1,
        `${w}x${h} ${ratio}: horizontal descentralizado (${sobraEsquerda} vs ${sobraDireita})`
      );
      assert.ok(
        Math.abs(sobraTopo - sobraBase) <= 1,
        `${w}x${h} ${ratio}: vertical descentralizado (${sobraTopo} vs ${sobraBase})`
      );
    }
  }
});

test('fonte já na proporção alvo não perde pixel nenhum', () => {
  const crop = centerCrop(3000, 4000, ratioValue('3:4'));
  assert.deepEqual(crop, { left: 0, top: 0, width: 3000, height: 4000 });
});
