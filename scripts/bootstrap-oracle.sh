#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -eq 0 ]; then
  echo "Execute como usuario normal (nao root). O script usa sudo quando necessario."
  exit 1
fi

DOMAIN="${1:-}"
if [ -z "${DOMAIN}" ]; then
  echo "Uso: bash scripts/bootstrap-oracle.sh apoiomissao.com.br"
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="apoio-missao"
NODE_PORT="3000"

echo "==> Atualizando pacotes"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "==> Instalando dependencias base"
sudo apt-get install -y curl git nginx certbot python3-certbot-nginx

echo "==> Instalando Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

echo "==> Instalando PM2"
sudo npm install -g pm2

echo "==> Instalando dependencias do app"
cd "${APP_DIR}"
npm install

echo "==> Subindo app com PM2"
pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true
pm2 start server.js --name "${APP_NAME}"
pm2 save
pm2 startup systemd -u "${USER}" --hp "${HOME}" | tail -n 1 | bash || true

echo "==> Configurando Nginx"
sudo tee /etc/nginx/sites-available/"${APP_NAME}" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/"${APP_NAME}" /etc/nginx/sites-enabled/"${APP_NAME}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

echo "==> Emitindo HTTPS Let's Encrypt"
sudo certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect

echo "==> Deploy concluido"
echo "URL: https://${DOMAIN}/apoio-missao"
echo "Comandos uteis:"
echo "  pm2 status"
echo "  pm2 logs ${APP_NAME}"
echo "  sudo systemctl status nginx"

