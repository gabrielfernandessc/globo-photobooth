#!/bin/bash
# ══════════════════════════════════════════════════════════
#  Monta o "Globo Photo Booth.app" — o duplo clique do operador.
#
#  Gerado por script, e não versionado pronto, porque um .app é uma
#  pasta com dezenas de arquivos: no Git ele viraria ruído e ninguém
#  revisaria o que mudou dentro.
#
#  Uso:  bash scripts/build-mac-app.sh [destino]
#        (padrão: a raiz do repositório)
# ══════════════════════════════════════════════════════════
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="${1:-$RAIZ}"
APP="$DESTINO/Globo Photo Booth.app"

echo "  Montando $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ── Info.plist ────────────────────────────────────────────
# LSUIElement=false: queremos o ícone no Dock, porque é por ele que o
# operador encerra o totem no fim da noite.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>Globo Photo Booth</string>
  <key>CFBundleDisplayName</key>       <string>Globo Photo Booth</string>
  <key>CFBundleIdentifier</key>        <string>com.globo.photobooth.totem</string>
  <key>CFBundleVersion</key>           <string>3.0</string>
  <key>CFBundleShortVersionString</key><string>3.0</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleExecutable</key>        <string>totem</string>
  <key>CFBundleIconFile</key>          <string>icone</string>
  <key>LSMinimumSystemVersion</key>    <string>12.0</string>
  <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

# ── O executável ──────────────────────────────────────────
cat > "$APP/Contents/MacOS/totem" <<'LANCADOR'
#!/bin/bash
# O totem, do jeito que o operador vê: duplo clique e pronto.
set -uo pipefail

REPO="__REPO__"
PORTA="${PHOTOBOOTH_PORT:-3000}"
LOGS="$REPO/logs"
mkdir -p "$LOGS"
LOG="$LOGS/totem-$(date +%Y-%m-%d).log"

diz() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# Diálogo nativo: um app aberto pelo Finder não tem terminal para onde
# gritar, e um erro invisível é um erro que ninguém conserta.
alerta() {
  diz "ERRO: $1 — $2"
  osascript -e "display alert \"Photo Booth não abriu\" message \"$1\n\n$2\" as critical" >/dev/null 2>&1
  exit 1
}

# ── PATH ──
# Um app aberto pelo Finder recebe só /usr/bin:/bin:/usr/sbin:/sbin.
# O node do Homebrew não está lá, e é por isso que tanto lançador de
# .app "funciona no terminal e não funciona no duplo clique".
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:$PATH"

NODE="$(command -v node || true)"
[ -z "$NODE" ] && for c in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$c" ] && NODE="$c" && break
done
[ -z "$NODE" ] && alerta "O Node.js não foi encontrado." "Instale a versão 22 ou maior em nodejs.org e abra o Photo Booth de novo."

MAIOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAIOR" -lt 22 ] && alerta "O Node.js instalado é a versão $MAIOR." "O totem precisa da 22 ou maior. Atualize em nodejs.org."

cd "$REPO" || alerta "A pasta do projeto sumiu." "Esperava encontrar: $REPO"

diz "===== Photo Booth iniciando ====="
diz "node $("$NODE" -v) em $NODE"

# ── Uma instância só ──
# Duas instâncias na mesma porta significam dois bancos sobre o mesmo
# arquivo e fotos indo para o lugar errado.
if lsof -ti :"$PORTA" -sTCP:LISTEN >/dev/null 2>&1; then
  DONO="$(lsof -ti :"$PORTA" -sTCP:LISTEN | head -1)"
  alerta "A porta $PORTA já está ocupada (PID $DONO)." "O Photo Booth provavelmente já está aberto. Encerre-o pelo Dock antes de abrir de novo."
fi

[ ! -d node_modules ] && { diz "Instalando dependências (primeira vez, demora)…"; npm ci --no-audit --no-fund >>"$LOG" 2>&1 || alerta "A instalação das dependências falhou." "Confira a internet e veja $LOG"; }

# ── A câmera ──
# O macOS assume a câmera PTP assim que ela conecta, e o gphoto2 recebe
# "could not claim the USB device". Derrubar o PTPCamera é obrigatório.
pkill -x PTPCamera >/dev/null 2>&1 && diz "PTPCamera do macOS derrubado (ele disputa a câmera)"

# ── Não deixar a máquina dormir no meio do evento ──
caffeinate -dimsu -w $$ >/dev/null 2>&1 &
diz "Suspensão automática desativada enquanto o totem estiver aberto"

# ── Servidor ──
# PORT precisa ser exportado: sem isto o servidor sobe na porta padrão
# enquanto o lançador confere outra, e um totem saudável é declarado
# quebrado.
export PORT="$PORTA"
"$NODE" server.js >>"$LOG" 2>&1 &
SERVIDOR=$!
diz "Servidor subindo (PID $SERVIDOR)"

encerrar() {
  diz "Encerrando…"
  # SIGTERM para o server.js fechar o WAL do SQLite e derrubar os
  # streams de preview; só depois se força.
  kill -TERM "$SERVIDOR" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$SERVIDOR" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$SERVIDOR" 2>/dev/null
  diz "===== Photo Booth encerrado ====="
}
trap encerrar EXIT INT TERM

# Espera o servidor RESPONDER, não apenas existir: processo vivo com
# porta muda é o pior estado possível para quem está operando.
PRONTO=""
for _ in $(seq 1 60); do
  kill -0 "$SERVIDOR" 2>/dev/null || alerta "O servidor fechou sozinho durante o boot." "As últimas linhas estão em $LOG"
  if curl -sf -m 2 "http://localhost:$PORTA/api/health" >/dev/null 2>&1; then PRONTO=1; break; fi
  sleep 0.5
done
[ -z "$PRONTO" ] && alerta "O servidor não respondeu em 30 segundos." "Veja $LOG"

diz "Servidor no ar em http://localhost:$PORTA"

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"
[ -n "$IP" ] && diz "Endereço na rede local: http://$IP:$PORTA"

# ── Telão ──
# Perfil próprio: o totem não herda abas, extensões nem sessão do
# navegador pessoal de quem estiver usando o Mac.
PERFIL="$HOME/Library/Application Support/GloboPhotoBooth/chrome"
mkdir -p "$PERFIL"
ALVO="http://localhost:$PORTA/totem.html"

if [ -n "${PHOTOBOOTH_SEM_TELAO:-}" ]; then
  # Diagnóstico: sobe o servidor sem tomar a tela.
  diz "Modo sem telão: abra manualmente $ALVO"
elif [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args \
    --kiosk "$ALVO" --user-data-dir="$PERFIL" \
    --autoplay-policy=no-user-gesture-required \
    --disable-session-crashed-bubble --noerrdialogs --disable-infobars
  diz "Telão aberto no Chrome (ESC ou CMD+Q para sair da tela cheia)"
else
  open "$ALVO"
  diz "Chrome não encontrado; o telão abriu no navegador padrão"
fi

osascript -e 'display notification "Telão aberto. Encerre pelo Dock ao fim do evento." with title "Globo Photo Booth" subtitle "Totem pronto"' >/dev/null 2>&1

# Segura o app vivo. Encerrar pelo Dock manda TERM e cai no trap.
wait "$SERVIDOR"
LANCADOR

# O caminho do repositório é fixado na montagem: o .app pode ser movido
# para /Applications sem perder de vista onde o projeto mora.
/usr/bin/sed -i '' "s|__REPO__|$RAIZ|g" "$APP/Contents/MacOS/totem"
chmod +x "$APP/Contents/MacOS/totem"

# ── Ícone ─────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [ -d "$RAIZ/node_modules/sharp" ]; then
  TMP="$(mktemp -d)"
  node -e "
    const sharp = require('$RAIZ/node_modules/sharp');
    const svg = Buffer.from(\`<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1024'>
      <rect width='1024' height='1024' rx='230' fill='#003B71'/>
      <circle cx='512' cy='545' r='200' fill='none' stroke='#fff' stroke-width='54'/>
      <circle cx='512' cy='545' r='96' fill='#fff'/>
      <rect x='170' y='330' width='684' height='96' rx='40' fill='#fff'/>
      <rect x='386' y='250' width='252' height='110' rx='34' fill='#fff'/>
      <circle cx='760' cy='390' r='30' fill='#003B71'/>
    </svg>\`);
    (async () => {
      const iconset = '$TMP/icone.iconset';
      require('fs').mkdirSync(iconset, { recursive: true });
      for (const t of [16, 32, 64, 128, 256, 512, 1024]) {
        await sharp(svg).resize(t, t).png().toFile(\`\${iconset}/icon_\${t}x\${t}.png\`);
      }
      // O iconutil exige nomes canônicos; estes cobrem o essencial.
      const fs = require('fs');
      for (const [de, para] of [[32,'16x16@2x'],[64,'32x32@2x'],[256,'128x128@2x'],[512,'256x256@2x'],[1024,'512x512@2x']]) {
        fs.copyFileSync(\`\${iconset}/icon_\${de}x\${de}.png\`, \`\${iconset}/icon_\${para}.png\`);
      }
    })();
  " 2>/dev/null && iconutil -c icns "$TMP/icone.iconset" -o "$APP/Contents/Resources/icone.icns" 2>/dev/null \
    && echo "  Ícone gerado" || echo "  (sem ícone — o app funciona igual)"
  rm -rf "$TMP"
fi

# Sem quarentena: o .app é montado aqui, não baixado. Sem isto o
# Gatekeeper pode barrar o primeiro duplo clique.
xattr -cr "$APP" 2>/dev/null || true
touch "$APP"

echo "  Pronto: $APP"
echo "  Arraste para o Dock ou para /Applications."
