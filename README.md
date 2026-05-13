# 🎬 Globo Photo Booth

Totem de foto para eventos corporativos com controle remoto, moldura customizada e compartilhamento via QR Code.

## Funcionalidades

- 📸 **Preview em tempo real** — Câmera Sony A7III via Imaging Edge Desktop
- 📱 **Controle remoto** — Opere a distância pelo celular
- 🔗 **Pareamento por código** — Conecte o celular ao totem com um código de 6 dígitos
- 🖼️ **Moldura customizada** — Upload de frame PNG (4:5 Instagram e 16:9)
- ⏱️ **Countdown ajustável** — 3, 5 ou 10 segundos
- 📲 **QR Code** — Pessoa escaneia e acessa a foto instantaneamente
- ☁️ **Upload gratuito** — Fotos hospedadas no ImgBB (100% grátis)

## Setup rápido

### 1. Pré-requisitos
- Node.js 18+
- Conta no [ImgBB](https://api.imgbb.com/) (grátis) para obter a API key

### 2. Configuração
```bash
# Clone ou copie o projeto
cd globo-photobooth

# Instale as dependências
npm install

# Configure a API key do ImgBB
cp .env.example .env
# Edite o .env e coloque sua IMGBB_API_KEY
```

### 3. Executar localmente
```bash
npm start
# Acesse http://localhost:3000
```

### 4. No evento
1. **Computador**: Abra `http://localhost:3000/display.html` (fullscreen F11)
2. **Celular**: Acesse `http://<IP-DO-COMPUTADOR>:3000/control.html`
3. Digite o código de 6 dígitos exibido na tela
4. Configure a moldura e comece a tirar fotos!

## Deploy no Render.com (grátis)

1. Suba o código para um repositório GitHub
2. Acesse [render.com](https://render.com) e crie uma conta
3. New → Web Service → conecte o repositório
4. Build Command: `npm install`
5. Start Command: `node server.js`
6. Adicione a variável de ambiente `IMGBB_API_KEY`
7. Deploy!

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
| Canvas API | Composição foto + moldura |
| ImgBB API | Hospedagem de imagens (grátis) |
| QRCode.js | Geração de QR Code |

## Design

Baseado no **Guia de Marca Globo 2025 v2.0**:
- Cores: Azul `#05A6FF`, Roxo `#8800F8`, Vermelho `#FF0C1F`, Amarelo `#FFD006`
- Gradiente Globo horizontal
- Tipografia: Inter (fallback para Globotipo)
- Border radius: 15px
- Espaçamento: Grid scale (4, 8, 16, 24, 32, 48, 64, 96, 128px)
