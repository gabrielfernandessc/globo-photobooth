/* ══════════════════════════════════════════════════════════
   BUILD:VENDOR — empacota o cliente do Vercel Blob para o navegador

   O @vercel/blob é um pacote isomórfico: o mesmo módulo carrega o
   caminho de servidor (OIDC, crypto, streams do Node) e o de cliente.
   Como o efeito colateral dos imports impede o tree-shaking, o bundle
   ingênuo passa de 600 KB — quase tudo código que o celular nunca
   executa.

   Aqui os módulos exclusivos de servidor são trocados por stubs. O que
   sobra é o upload() de verdade, que é o que a página da câmera usa.

   Rodar:  bun run build:vendor
   ══════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'public', 'js', 'vendor');
const OUT = path.join(VENDOR, 'blob-client.js');

/** Módulos que só existem para o caminho de servidor do @vercel/blob. */
const SERVER_ONLY = {
  'undici': `
    export const fetch = globalThis.fetch.bind(globalThis);
    export const Headers = globalThis.Headers;
    export const Request = globalThis.Request;
    export const Response = globalThis.Response;
    export const FormData = globalThis.FormData;
    export class Agent {}
    export class ProxyAgent {}
    export function setGlobalDispatcher() {}
    export function getGlobalDispatcher() {}
    export default { fetch, Headers, Request, Response, FormData, Agent };
  `,
  '@vercel/oidc': `
    export function getVercelOidcToken() {
      throw new Error('OIDC não existe no navegador — use handleUploadUrl');
    }
    export default { getVercelOidcToken };
  `,
  'crypto': `
    export function createHmac() { throw new Error('crypto indisponível no navegador'); }
    export function timingSafeEqual() { return false; }
    export default { createHmac, timingSafeEqual };
  `,
};
SERVER_ONLY['node:crypto'] = SERVER_ONLY.crypto;

const stubPlugin = {
  name: 'stub-server-only',
  setup(build) {
    const filter = new RegExp(`^(${Object.keys(SERVER_ONLY).map(m => m.replace(/[/@.]/g, '\\$&')).join('|')})$`);
    build.onResolve({ filter }, args => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: SERVER_ONLY[args.path],
      loader: 'js',
    }));
  },
};

/**
 * O cliente do Socket.IO precisa estar em public/, e não vir de
 * node_modules por express.static: sob o preset Express da Vercel o
 * express.static é ignorado e o arquivo daria 404. Copiar aqui também
 * mantém a versão do cliente colada na do servidor instalado.
 */
function copySocketIoClient() {
  const dist = path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist');
  const version = require('socket.io/package.json').version;

  // Sem o .map: são 190 KB versionados que só servem com o devtools
  // aberto num arquivo que não é nosso.
  fs.copyFileSync(path.join(dist, 'socket.io.min.js'), path.join(VENDOR, 'socket.io.min.js'));
  fs.rmSync(path.join(VENDOR, 'socket.io.min.js.map'), { force: true });

  const kb = (fs.statSync(path.join(VENDOR, 'socket.io.min.js')).size / 1024).toFixed(1);
  console.log(`public/js/vendor/socket.io.min.js  ${kb} KB  (socket.io ${version})`);
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  copySocketIoClient();

  const result = await Bun.build({
    entrypoints: [path.join(ROOT, 'src', 'blob-upload.js')],
    target: 'browser',
    format: 'iife',
    minify: true,
    plugins: [stubPlugin],
  });

  if (!result.success) {
    result.logs.forEach(log => console.error(log));
    process.exit(1);
  }

  const code = await result.outputs[0].text();
  fs.writeFileSync(OUT, code);

  const kb = (Buffer.byteLength(code) / 1024).toFixed(1);
  console.log(`public/js/vendor/blob-client.js  ${kb} KB`);

  if (!code.includes('BoothBlob')) {
    console.error('ERRO: o bundle não expõe window.BoothBlob');
    process.exit(1);
  }
}

main();
