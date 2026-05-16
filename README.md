# 🎬 Globo Photo Booth

Totem de foto para eventos corporativos com controle remoto, moldura customizada e compartilhamento via QR Code.

## Funcionalidades

- 📸 **Preview em tempo real** — Câmera pelo navegador, compatível com webcam, câmera virtual ou placa/capture device
- 📱 **Controle remoto** — Opere a distância pelo celular
- 🔗 **Pareamento por código** — Conecte o celular ao totem com um código de 4 caracteres
- 🖼️ **Moldura customizada** — Upload de frame PNG (4:5 Instagram e 16:9)
- ⏱️ **Countdown ajustável** — 3, 5 ou 10 segundos
- 📲 **QR Code** — Pessoa escaneia e acessa uma página de download em alta qualidade
- 🧩 **Composição no servidor** — Foto final com moldura gerada via Sharp, sem ImgBB

## Setup rápido

### 1. Pré-requisitos
- Node.js 18+
- Navegador com acesso à câmera
- URL HTTPS em produção, necessária para `getUserMedia`

### 2. Configuração
```bash
# Clone ou copie o projeto
cd globo-photobooth

# Instale as dependências
npm install

# Sem ImgBB: as fotos finais são salvas em public/uploads/final no servidor
```

### 3. Executar localmente para desenvolvimento
```bash
npm start
# Acesse http://localhost:3000
```

### 4. No evento
1. **Computador/totem**: Abra `https://SUA-URL/display.html` e permita o acesso à câmera
2. **Celular**: Acesse `https://SUA-URL/control.html`
3. Digite o código de 4 caracteres exibido na tela
4. Configure a moldura e comece a tirar fotos!

## Deploy no Render.com (grátis)

1. Suba o código para um repositório GitHub
2. Acesse [render.com](https://render.com) e crie uma conta
3. New → Web Service → conecte o repositório
4. Build Command: `npm install`
5. Start Command: `node server.js`
6. Deploy!

> O app roda em modo web: a câmera vem do navegador da tela do totem. Para usar uma Sony A7III, ela precisa aparecer para o navegador como webcam/capture device.

> O filesystem do Render pode ser efêmero em alguns planos. Para retenção permanente das fotos após reinícios/deploys, use Render Disk ou um storage externo.

> **Dica**: Use o [UptimeRobot](https://uptimerobot.com) (grátis) para pingar sua URL a cada 5 minutos e evitar cold starts.

## Estrutura

```
globo-photobooth/
├── server.js           # Express + Socket.IO
├── package.json
├── .env.example
└── public/
    ├── index.html      # Landing page
    ├── display.html    # Tela do totem
    ├── control.html    # Controle remoto (celular)
    ├── css/
    │   ├── design-system.css  # Design system Globo
    │   ├── display.css
    │   └── control.css
    └── js/
        ├── display.js  # Câmera, captura, QR
        └── control.js  # Pareamento, controle
```

## Tecnologias

| Stack | Uso |
|:---|:---|
| Node.js + Express | Servidor web |
| Socket.IO | Comunicação em tempo real |
| Canvas API | Captura web em alta resolução |
| Sharp | Composição da foto final com moldura |
| QR Server API | Geração da imagem do QR Code |

## Design

Baseado no **Guia de Marca Globo 2025 v2.0**:
- Cores: Azul `#05A6FF`, Roxo `#8800F8`, Vermelho `#FF0C1F`, Amarelo `#FFD006`
- Gradiente Globo horizontal
- Tipografia: Inter (fallback para Globotipo)
- Border radius: 15px
- Espaçamento: Grid scale (4, 8, 16, 24, 32, 48, 64, 96, 128px)

---

## Apoio Missão (novo painel)

Foi adicionada uma área separada com dashboard de candidatos:

- URL: `http://localhost:3000/apoio-missao`
- API local: `GET /api/apoio-missao/candidatos`
- Filtros: estado (UF), cargo e busca textual
- Exibe link de doação por candidato (quando disponível)
- Aviso de transparência: site não oficial, feito por apoiadores

### Variáveis de ambiente

Defina no `.env`:

```bash
QA_API_KEY=sua_chave_da_api_queroapoiar
QA_API_BASE=https://api.queroapoiar.com.br
```

### Deploy Cloudflare Pages (recomendado)

Esse deploy fica sem o "sleep" de 15 minutos do Render Free.

#### Estrutura usada no Cloudflare
- Estático: pasta `public`
- API serverless: `functions/api/apoio-missao/candidatos.js`

#### Passo a passo no painel
1. Suba este repositório no GitHub.
2. Cloudflare Dashboard -> `Workers & Pages` -> `Create` -> `Pages` -> `Connect to Git`.
3. Selecione o repositório.
4. Build settings:
- Framework preset: `None`
- Build command: (deixe vazio)
- Build output directory: `public`
5. Deploy.
6. No projeto criado, vá em `Settings` -> `Variables and Secrets` e adicione:
- `QA_API_KEY` = sua chave da API do QueroApoiar
- `QA_API_BASE` = `https://api.queroapoiar.com.br`
7. Vá em `Deployments` e clique `Retry deployment` para aplicar variáveis.

#### Aplicar domínio apoiomissao.com.br
1. Em `Custom domains`, clique `Set up a custom domain`.
2. Adicione:
- `apoiomissao.com.br`
- `www.apoiomissao.com.br`
3. Siga os DNS records sugeridos pelo Cloudflare (tipo `CNAME`/`A` conforme instrução da tela).
4. Após verificado, acesse:
- `https://apoiomissao.com.br/apoio-missao`

#### Teste local com runtime do Cloudflare
```bash
npm run cf:dev
```
Abra `http://localhost:8788/apoio-missao/`.

### Deploy simples (Node tradicional)

Para hospedar em Render/Railway/Fly com `server.js`:

1. Build command: `npm install`
2. Start command: `node server.js`
3. Configurar `QA_API_KEY` no painel de variáveis do provedor

### Deploy Oracle Always Free (sem dormir)

Use o passo a passo completo em:

- `DEPLOY_ORACLE_ALWAYS_FREE.md`

Script automatico de bootstrap na VM:

- `scripts/bootstrap-oracle.sh`
