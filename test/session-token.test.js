/* ══════════════════════════════════════════════════════════
   TOKEN DE SESSÃO — a prova que autoriza publicar uma foto

   O código de 4 caracteres é curto de propósito, para o operador
   conseguir ditar. Ele não pode ser o segredo: 32^4 é força bruta de
   segundos. Quem autoriza é o HMAC.
   ══════════════════════════════════════════════════════════ */

process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
// generateCode consulta o store; sem isto o teste criaria um banco no
// diretório do projeto.
process.env.DATABASE_FILE = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const { signCode, verifySignedCode, normalizeCode, generateCode, initStore } = require('../lib/store');

test('um token recém-assinado é aceito e devolve o código', () => {
  const token = signCode('AB3D');
  assert.equal(verifySignedCode(token), 'AB3D');
});

test('assinatura adulterada é recusada', () => {
  const token = signCode('AB3D');
  const [code, sig] = token.split('.');

  // Troca um caractere da assinatura.
  const alterada = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(verifySignedCode(`${code}.${alterada}`), null);
});

test('assinatura de outro código não vale para este', () => {
  const outro = signCode('WXYZ').split('.')[1];
  assert.equal(verifySignedCode(`AB3D.${outro}`), null);
});

test('token malformado é recusado sem lançar exceção', () => {
  for (const entrada of ['', 'AB3D', 'AB3D.', '.abc', 'abc', null, undefined, 'AB3D.a.b', '....']) {
    assert.equal(verifySignedCode(entrada), null, `"${entrada}" deveria ser recusado`);
  }
});

test('assinatura truncada é recusada', () => {
  const token = signCode('AB3D');
  assert.equal(verifySignedCode(token.slice(0, -4)), null);
});

test('o código é normalizado e validado', () => {
  assert.equal(normalizeCode('ab3d'), 'AB3D');
  assert.equal(normalizeCode(' AB3D '), 'AB3D');

  for (const invalido of ['ABC', 'ABCDE', 'AB-D', '', null, undefined, 'AB 3D', '../..']) {
    assert.equal(normalizeCode(invalido), null, `"${invalido}" não deveria virar código`);
  }
});

test('os códigos gerados evitam caracteres ambíguos', async () => {
  await initStore();

  for (let i = 0; i < 200; i++) {
    const code = await generateCode();
    assert.match(code, /^[A-Z0-9]{4}$/);
    // I/O/0/1 saem do alfabeto: ditar o código por voz num evento
    // barulhento não pode virar adivinhação.
    assert.doesNotMatch(code, /[IO01]/, `código ambíguo gerado: ${code}`);
  }
});
