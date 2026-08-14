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
  <!-- O macOS encerrava o totem sozinho depois de minutos parado, por
       julgá-lo ocioso. Um totem entre convidados não recebe evento
       nenhum e parece abandonado; declarar isso no plist é a primeira
       barreira, e beginActivity no código é a segunda. -->
  <key>NSSupportsAutomaticTermination</key> <false/>
  <key>NSSupportsSuddenTermination</key>    <false/>
</dict>
</plist>
PLIST

# ── O executável ────────────────────────────────────────
# Binário Swift de verdade, não script shell: o telão roda dentro de um
# WKWebView em tela cheia, sem Chrome instalado, sem barra e sem ESC
# para o convidado encontrar. O miolo continua sendo o servidor Node,
# que já está medido com a câmera real.
if ! command -v swiftc >/dev/null 2>&1; then
  echo "  swiftc não encontrado. Instale as Command Line Tools:"
  echo "    xcode-select --install"
  exit 1
fi

echo "  Compilando o app nativo…"
FONTE="$(mktemp -d)/PhotoBooth.swift"
# O caminho do repositório é fixado na compilação: o .app pode ir para
# /Applications sem perder de vista onde o projeto mora.
/usr/bin/sed "s|__REPO__|$RAIZ|g" "$RAIZ/mac/PhotoBooth.swift" > "$FONTE"

swiftc -O -o "$APP/Contents/MacOS/totem" "$FONTE" \
  -framework Cocoa -framework WebKit || {
    echo "  A compilação falhou."
    exit 1
  }
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
