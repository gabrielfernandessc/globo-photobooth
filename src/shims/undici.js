/* Shim de undici para o bundle do navegador.

   O @vercel/blob depende de undici para ter fetch no Node. No navegador
   isso é ~500 KB de cliente HTTP para reimplementar o que já existe
   nativo, então mapeamos para as APIs do próprio browser.

   Ver o campo "browser" no package.json. */

export const fetch = globalThis.fetch.bind(globalThis);
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
export const File = globalThis.File;
export const Blob = globalThis.Blob;

// O @vercel/blob só usa o Agent para configurar keep-alive no Node;
// no navegador não há o que configurar.
export class Agent {}
export class ProxyAgent {}
export function setGlobalDispatcher() {}
export function getGlobalDispatcher() { return undefined; }

export default { fetch, Headers, Request, Response, FormData, Agent };
