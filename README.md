# 🎬 Globo Photo Booth

Totem de foto para eventos corporativos. **O celular é a câmera**, a foto sai na
resolução máxima do sensor e o preview aparece ao vivo em outra tela.

---

## Como funciona

```
  Galaxy S22                     Servidor                    Tela do totem
  /camera.html                   Node.js                     /display.html
  ───────────                    ───────                     ─────────────
  track de vídeo ──── WebRTC (P2P, direto na LAN) ─────────▶  preview ao vivo
                                                                   │
                       ◀───── camera-shoot (socket) ──────────  contagem chega a 0
  ImageCapture
  .takePhoto()
  4000×3000
        │
        └── POST /api/photo/capture (JPEG binário) ──▶ crop + moldura ──▶ QR na tela
```

O preview e a foto são **caminhos separados de propósito**:

| | Preview | Foto final |
|:--|:--|:--|
| Origem | track de vídeo (comprimido para streaming) | `ImageCapture.takePhoto()` |
| Resolução | 1080p / 1440p | máxima do sensor (12 MP no S22) |
| Processamento | encoder WebRTC | pipeline de still do Android: HDR, multiframe, redução de ruído |

É por isso que a foto sai muito melhor do que um "print" do preview — ela nunca
passa pelo vídeo.

---

## Setup

### 1. Instalar

```bash
npm install
```

### 2. Rodar

```bash
npm start
```

O servidor sobe em HTTP **e** HTTPS e imprime os endereços:

```
🎬  Globo Photo Booth
   HTTP   http://localhost:3000
          http://192.168.0.42:3000

   HTTPS  https://localhost:3443
          https://192.168.0.42:3443   ← use esta no celular
```

> **Por que HTTPS?** O Chrome do Android só libera `getUserMedia` em contexto
> seguro. Na primeira execução o servidor gera um certificado autoassinado em
> `certs/` cobrindo o IP da máquina. O celular mostra um aviso uma única vez —
> toque em **Avançado → Prosseguir** e o Chrome passa a tratar a origem como
> segura, liberando câmera e WebRTC.

### 3. No evento

1. **Tela do totem** — abra `https://SEU-IP:3443/display.html`. Aparece um código
   de 4 caracteres e um **QR Code de pareamento**.
2. **Galaxy S22** — escaneie o QR. A página `/camera.html` abre já com o código
   preenchido. Aceite a permissão de câmera.
3. O preview do celular aparece na tela do totem em segundos.
4. **Controle** (opcional, num segundo aparelho) — `https://SEU-IP:3443/control.html`,
   digite o mesmo código. Dá para disparar pelo próprio celular-câmera também.

> Totem e celular precisam estar **na mesma rede Wi-Fi**. O vídeo vai direto de um
> para o outro (P2P) — o servidor só faz a apresentação inicial.

---

## Qualidade da imagem

O que o app faz para não desperdiçar nada do sensor:

- **Sem upscale.** O recorte na proporção escolhida é um corte central em pixels
  nativos. Uma foto 4000×3000 vira 2250×3000 em 3:4 — nenhum pixel é inventado.
- **Uma única codificação JPEG.** Rotação por EXIF, corte, espelho e moldura
  acontecem numa só passagem do Sharp.
- **Croma 4:4:4** e qualidade 100 no arquivo master (configurável).
- **Foco, exposição e white balance contínuos** aplicados ao track.
- **Três derivadas** por foto:

| Arquivo | Onde | Para quê |
|:--|:--|:--|
| `uploads/final` | master, resolução do sensor | botão "Baixar em alta qualidade" |
| `uploads/web` | lado maior 2048px, q88 | preview da página do QR (rápido no 4G) |
| `uploads/thumb` | 480px | galeria do controle |
| `uploads/original` | JPEG cru do celular, EXIF intacto | arquivo do evento |

O master também é copiado para `Downloads/Globo-Photobooth` no computador do totem.

> **Privacidade:** os arquivos públicos (final, web, thumb) saem **sem EXIF** — o
> GPS do celular não vaza no arquivo que o convidado baixa. O EXIF completo fica
> só no original, no servidor.

### Antecipação do disparo

O obturador do Android tem latência. O totem dispara o celular alguns
milissegundos **antes** do "0" para a foto sair no momento certo. Ajuste em
**Controle → Câmera → Antecipar disparo** (padrão 250 ms).

---

## Telas

| Página | Onde abrir | O que faz |
|:--|:--|:--|
| `/display.html` | tela do totem | preview, contagem, moldura, resultado + QR |
| `/camera.html` | **Galaxy S22** | câmera: transmite o preview e tira a foto |
| `/control.html` | segundo aparelho | dispara, moldura, timer, controles do sensor |

### O que o controle comanda no celular de verdade

Lanterna, autofoco, zoom óptico/digital, compensação de exposição e espelhamento —
tudo aplicado ao sensor via `applyConstraints`, não como filtro. Os sliders de
brilho/contraste/saturação continuam existindo, mas afetam **só o preview do
totem**, nunca o arquivo final.

### Atalhos na tela do totem

| Tecla | Ação |
|:--|:--|
| `Espaço` | dispara a contagem |
| `Esc` | volta ao preview |

---

## Se a câmera do celular não abrir

| Sintoma | Causa | Solução |
|:--|:--|:--|
| "A câmera só abre em HTTPS" | acessou por `http://` | use a URL `https://` da lista do boot |
| "Permissão negada" | recusou o prompt | ícone do cadeado → Permissões → Câmera → Permitir |
| "Câmera em uso por outro app" | app de câmera aberto em segundo plano | feche-o e recarregue |
| Preview não chega ao totem | redes diferentes | ponha os dois no mesmo Wi-Fi |
| Foto sai na resolução do vídeo | `ImageCapture` indisponível | o chip abaixo do visor mostra o nível usado; use o Chrome |

O visor do celular mostra sempre a resolução do vídeo e a da foto. Depois de cada
captura, a linha abaixo do botão informa em qual nível a foto foi tirada
(`still 4000×3000`, `grabFrame …`, `vídeo …`).

---

## Fallback sem celular

Se nenhum celular estiver pareado, o totem usa a própria webcam — sem upscale,
com o mesmo pipeline de moldura e QR. É o modo de emergência, não o modo padrão:
uma webcam de 1080p entrega ~2 MP contra os 12 MP do S22.

---

## Configuração

Copie `.env.example` para `.env`. Os que importam:

| Variável | Padrão | Para quê |
|:--|:--|:--|
| `FINAL_JPEG_QUALITY` | `100` | qualidade do master (95 corta o tamanho pela metade sem diferença visível) |
| `MAX_FINAL_LONG_SIDE` | `0` | teto do lado maior; 0 = resolução do sensor |
| `WEB_LONG_SIDE` | `2048` | derivada servida na página do QR |
| `SAVE_ORIGINAL` | `true` | guarda o JPEG cru do celular com EXIF |
| `SAVE_TO_DOWNLOADS` | `true` | copia o master para a pasta Downloads |
| `ENABLE_HTTPS` | `true` | desligue só se já houver HTTPS na frente (proxy/túnel) |

---

## Acesso de fora da rede local

```bash
npm run share
```

Sobe um túnel Cloudflare com URL HTTPS pública. Útil para testar remotamente,
mas para o evento prefira a rede local: o WebRTC fica P2P e o preview não
depende da internet.

> Fora da mesma LAN, o WebRTC pode não fechar conexão sem um servidor TURN.

---

## Deploy na Vercel

O mesmo código roda nos dois lugares. O que muda é onde ficam o **estado** e as
**fotos** — numa função serverless não existe memória compartilhada nem disco.

| | Local | Vercel |
|:--|:--|:--|
| Sessões | memória | Redis (Marketplace) |
| Fotos | `public/uploads/` | Vercel Blob |
| Socket.IO | `/socket.io`, polling + ws | `/api/server/socket.io`, só ws |
| Upload da foto | multipart, 60 MB | direto do navegador pro Blob |
| HTTPS | certificado autoassinado | da plataforma |

Os drivers são escolhidos sozinhos: `VERCEL` e `REDIS_URL` já vêm da própria
plataforma. Não há nada para configurar à mão.

### Passo a passo

- **1.** Importe o repositório em [vercel.com/new](https://vercel.com/new).
- **2.** Em **Storage → Create Database**, crie um **Blob** e conecte ao projeto.
- **3.** Em **Storage**, crie também um **Redis** (Marketplace) e conecte ao projeto.
  Isso define `REDIS_URL` e liga o modo distribuído.
- **4.** Confirme que **Fluid compute** está ligado em Settings → Functions
  (padrão em projetos novos). Sem ele não há WebSocket.
- **5.** Deploy.

Confira em `https://SEU-APP.vercel.app/api/health`:

```json
{ "ok": true, "state": "redis", "storage": "blob" }
```

Se aparecer `"state": "memory"`, o Redis não está conectado — o pareamento vai
funcionar de forma intermitente, porque cada aparelho pode cair numa instância
diferente.

### Por que cada peça existe

**Redis.** Uma conexão WebSocket é fixada numa instância, mas a próxima pode ir
para outra. Sem estado compartilhado, o celular numa instância e o totem em
outra simplesmente não se enxergam. O Redis guarda as sessões e leva o pub/sub
entre instâncias.

**Blob.** O corpo de uma request de função para em **4,5 MB**, e uma foto de
12 MP tem ~6 MB. Na Vercel o celular pede um token, manda a foto do navegador
direto para o Blob e o servidor recebe só a URL.

**Presença em conjuntos do Redis.** O `fetchSockets()` do Socket.IO faz um
broadcast com timeout para todas as instâncias — uma instância lenta faz a
presença inteira virar "ninguém aqui". Três `SCARD` resolvem isso de forma
exata e barata.

### Regerar o cliente do Blob

`public/js/vendor/blob-client.js` é versionado para o deploy não precisar de
build step. Se atualizar o `@vercel/blob`, regere:

```bash
npm run build:vendor
```

### O que pesar antes de usar num evento

A Vercel resolve domínio, HTTPS e CDN, mas para um totem em operação há três
coisas que não somem:

- **A conexão WebSocket cai no fim da duração máxima da função.** O cliente
  reconecta e reassume a sessão sozinho, mas um disparo enviado exatamente
  nesse intervalo se perde. Na fila de um evento isso é uma foto refeita.
- **Depende da internet do local.** Caiu o Wi-Fi, caiu o totem. Na versão local
  o servidor está na mesma sala e o WebRTC é P2P.
- **Wi-Fi de convidado costuma ter isolamento de cliente**, que bloqueia P2P
  entre o celular e o totem. Sem um servidor TURN, o preview não fecha conexão.

Para operar de verdade, o servidor local continua sendo a opção mais segura. A
Vercel é excelente para demo, homologação e para servir a página da foto.

---

## Estrutura

```
globo-photobooth/
├── server.js               # boot local: HTTP + HTTPS + certificado
├── api/server.js           # boot da Vercel: exporta o servidor
├── vercel.json
├── lib/
│   ├── app.js              # Express + Socket.IO (compartilhado)
│   ├── config.js           # detecta local vs Vercel
│   ├── store.js            # sessões: memória | Redis
│   ├── storage.js          # fotos: disco | Vercel Blob
│   └── photo.js            # pipeline do Sharp
├── scripts/build-vendor.js # empacota o cliente do Blob
├── certs/                  # certificado autoassinado (gerado no 1º boot)
└── public/
    ├── index.html          # landing
    ├── display.html        # tela do totem
    ├── camera.html         # celular como câmera
    ├── control.html        # controle remoto
    ├── css/
    │   ├── design-system.css
    │   ├── display.css
    │   ├── camera.css
    │   └── control.css
    ├── js/
    │   ├── display.js      # receptor WebRTC, contagem, resultado, QR
    │   ├── camera.js       # ImageCapture, WebRTC sender, controles do sensor
    │   ├── control.js      # disparo, moldura, controles do sensor
    │   └── vendor/         # socket.io + cliente do Blob
    └── uploads/            # original · final · web · thumb (modo local)
```

## Tecnologias

| Stack | Uso |
|:---|:---|
| Node.js + Express | servidor web e HTTPS |
| Socket.IO | sessões, sinalização WebRTC, relay de controles |
| WebRTC | preview do celular para o totem, P2P |
| MediaStream Image Capture | foto na resolução máxima do sensor |
| Sharp | rotação, recorte, moldura e derivadas |
| qrcode | QR Code gerado localmente (funciona sem internet) |
| Redis + Vercel Blob | estado e fotos quando roda serverless |

## Design

Guia de Marca Globo 2025 v2.0 — azul `#05A6FF`, roxo `#8800F8`, vermelho `#FF0C1F`,
amarelo `#FFD006`; tipografia Inter; raio 15px; grid de espaçamento 4/8/16/24/32/48/64.
