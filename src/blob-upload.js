/* Fonte do bundle public/js/vendor/blob-client.js.
   Regerar com:  npm run build:vendor

   O upload direto para o Blob é a única forma de mandar uma foto de
   12 MP na Vercel: o corpo de uma request de função para em 4,5 MB. */

import { upload } from '@vercel/blob/client';

window.BoothBlob = { upload };
