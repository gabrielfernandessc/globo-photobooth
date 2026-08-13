---
name: photobooth
description: Procedimentos operacionais do totem Globo Photo Booth — subir o servidor, testar o pipeline de foto, validar o QR, medir a resolução real da câmera, construir o APK, checar publicação na nuvem e rodar o checklist de evento. Use ao trabalhar neste repositório em qualquer tarefa de operação, diagnóstico ou release.
---

# Operar o Globo Photo Booth

Procedimentos verificados neste repositório. A arquitetura e os
invariantes estão em `AGENTS.md` — aqui ficam os passos.

## Subir o servidor

```bash
npm ci          # só na primeira vez; exige Node 22+
npm start
```

Sobe HTTP em 3000 e HTTPS em 3443. O HTTPS existe porque o Chrome do
Android só libera `getUserMedia` em contexto seguro — sem ele o celular
não abre a câmera pela LAN. O certificado autoassinado é gerado no
primeiro boot em `certs/`.

Para desenvolvimento sem TLS e com dados descartáveis:

```bash
ENABLE_HTTPS=false PORT=3999 DATA_DIR=/tmp/booth-dev npm start
```

Confirme que subiu de verdade (processo vivo com porta muda é o pior
dos mundos):

```bash
curl -s http://localhost:3000/api/health
```

`ok: true` com `cloud: "not-configured"` é um totem saudável — a nuvem
não entra na conta da saúde local.

## Descobrir o IP da LAN

O celular precisa deste endereço.

```bash
# macOS / Linux
ipconfig getifaddr en0 2>/dev/null || hostname -I
```

```powershell
# Windows — o launcher já imprime, mas para conferir à mão:
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.InterfaceAlias -notmatch 'Loopback|VPN|VMware' } |
  Select-Object IPAddress, InterfaceAlias
```

Ignore interfaces de VPN e de virtualização: elas aparecem primeiro e
não são alcançáveis pelo celular.

## Modo totem (evento)

Windows, o caminho do operador:

```
start-totem.cmd
```

Confere Node e dependências, valida espaço em disco, sobe o servidor,
espera `/api/health` responder, imprime o endereço da LAN e abre o telão
em quiosque com perfil próprio de navegador. Encerrar:
`scripts/Stop-PhotoBooth.ps1` (encerra pela porta, não por nome de
processo).

Telas: `/display.html` (telão), `/control.html` (operador),
`/camera.html` (celular como câmera via navegador, fallback).

## Testar o pipeline de foto

```bash
npm test
```

Inclui o teste de sistema, que sobe `node server.js` num processo
separado, mata com SIGKILL no meio e mede uma sequência de capturas.
Demora ~15 s. Para rodar só uma parte:

```bash
node --test test/photo-pipeline.test.js
node --test --test-timeout=180000 test/system.test.js
```

Para exercitar uma captura à mão contra um servidor de pé:

```bash
CODE=$(curl -s -X POST localhost:3999/api/session -H 'content-type: application/json' -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')

curl -s -X POST localhost:3999/api/photo/capture \
  -F photo=@/caminho/para/foto.jpg \
  -F code=$CODE -F aspectRatio=3:4 -F mirror=false -F source=manual |
  node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).data.meta, null, 2)'
```

`meta` traz `finalWidth`, `finalHeight`, `finalBytes`, `frameApplied` e
`resampled`. `resampled: true` significa que houve reamostragem — só
deve acontecer com `MAX_FINAL_LONG_SIDE` configurado.

## Testar o QR de ponta a ponta

QR não é prova de nada se a URL dentro dele estiver quebrada. Siga o
caminho inteiro:

```bash
# 1. a página que o QR abre
curl -si localhost:3999/photo/<id> | head -1

# 2. o PNG do QR
curl -s "localhost:3999/api/qr?size=400&data=$(printf %s 'http://192.168.0.10:3000/photo/<id>' | jq -sRr @uri)" \
  --output /tmp/qr.png && file /tmp/qr.png

# 3. o download do master, com as dimensões esperadas
curl -s localhost:3999/download/<id> --output /tmp/master.jpg
node -e "require('sharp')('/tmp/master.jpg').metadata().then(m=>console.log(m.width,'x',m.height,m.format))"
```

Com um segundo aparelho na mesma rede, aponte a câmera para o QR do
telão e confirme que a página abre e o botão baixa.

## Verificar a publicação na nuvem

O totem funciona sem nuvem. Para ligar:

```bash
PUBLIC_BASE_URL=https://globo-photobooth.vercel.app \
BLOB_READ_WRITE_TOKEN=<token> \
npm start
```

Acompanhar a fila:

```bash
curl -s localhost:3000/api/health | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).share, null, 2)'
```

- `pending_sync` — aguardando internet, retentando com backoff
- `published` — no ar, com `publicUrl` gravada na foto
- `failed` — desistiu; devolva à fila com `POST /api/share/retry`
- `skipped` — sem nuvem configurada (não é erro)

Testar o modo offline de verdade: desligue o Wi-Fi do PC, tire fotos,
confirme que tudo funciona e que a fila acumula; religue e veja publicar
sozinha sem tocar em nada.

## Construir o APK

A máquina de desenvolvimento não tem JDK nem Android SDK — o build é no
CI, por isso.

```bash
gh workflow run android.yml --ref <branch>
gh run watch
gh run download <run-id> -n fotoboarding-apk
```

O workflow roda testes unitários, compila, confere a assinatura com
`apksigner` e publica a release cuja tag (`v<nome>-<versionCode>`) é o
que o app compara para se atualizar sozinho.

A chave de assinatura vem dos Secrets (`ANDROID_KEYSTORE_B64`,
`ANDROID_KEYSTORE_PASSWORD`). Sem ela o APK sai com chave de debug
efêmera e o Android **recusa a atualização** por conflito de pacote.
Nunca comprometa a estabilidade dessa chave.

Com JDK e SDK instalados, o build local é:

```bash
cd android && gradle assembleDebug
```

## Medir a resolução real da câmera

Não confie em número de marketing. "50 MP" no papel não significa 50 MP
entregues. O que vale é o que chegou ao servidor:

```bash
curl -s localhost:3000/api/photos/<CODE> | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).photos.at(-1),null,2)'
```

E no aparelho, `CameraController.readCapabilities()` registra em Logcat
a resolução efetiva do `ImageCapture`:

```bash
adb logcat -s CameraController PhotoUploader
```

`meta.sourceWidth` × `meta.sourceHeight` no servidor é a verdade
definitiva: é o que o arquivo tinha ao chegar.

## Deploy da nuvem

A Vercel serve apenas a página pública e o Blob. Ela não é o cérebro do
totem e não pode virar dependência do evento.

```bash
vercel deploy --prod
```

Depois valide que o essencial responde:

```bash
curl -si https://globo-photobooth.vercel.app/api/health | head -1
curl -si https://globo-photobooth.vercel.app/photo/<id-publicado> | head -1
```

## Checklist antes do evento

1. `npm test` verde, incluindo a suíte de sistema.
2. `start-totem.cmd` sobe e imprime o IP da LAN.
3. Celular na mesma rede abre o endereço e conecta.
4. Moldura carregada em `/control.html` e visível no telão.
5. Uma captura de teste: conferir enquadramento igual ao preview,
   moldura alinhada e dimensão do master.
6. QR lido por um segundo aparelho, página abre, download funciona.
7. **Desligar a internet e repetir os passos 5 e 6** — tudo deve
   funcionar, só a publicação fica pendente.
8. Religar a internet e confirmar que a fila publicou sozinha.
9. Espaço em disco: alguns GB por evento.
10. Celular no carregador e com a tela travada acesa.

## Diagnóstico

```bash
# saúde por componente
curl -s localhost:3000/api/health | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)),null,2)'

# seguir uma foto do disparo ao QR — os logs são JSON com captureId
grep '"captureId":"<id>"' logs/servidor.log

# inspecionar o banco do evento
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.DATABASE_FILE||'data/booth.sqlite');
console.table(db.prepare('SELECT status, COUNT(*) n FROM share_jobs GROUP BY status').all());
console.table(db.prepare('SELECT id, captured_at, public_url FROM photos ORDER BY captured_at DESC LIMIT 5').all());
"
```

Sintomas comuns:

- **Telão em "Conectando" para sempre** — servidor de pé mas socket
  mudo. Confira `/api/config` e o `socketPath`.
- **Celular não abre a câmera** — falta HTTPS. Use a porta 3443.
- **Foto sem moldura** — o log diz `Moldura não pôde ser decodificada`;
  o PNG do operador é inválido. A foto sai mesmo assim, por projeto.
- **`pending_sync` só crescendo** — sem internet ou credencial errada.
  A foto está salva; não é urgente durante o evento.

## Pendências conhecidas

- `android/app/build.gradle.kts` tem `DEFAULT_SERVER_URL` apontando para
  a Vercel. Contraria o local-first: o app deveria parear com o servidor
  da LAN por QR (`photobooth://pair?host=…&token=…`) e guardar o último
  servidor válido.
- `CameraController.capture()` devolve `ByteArray` em memória e o
  `PhotoUploader` copia de novo. Uma foto de 50 MP são dezenas de MB por
  captura; o caminho correto é capturar para arquivo e fazer streaming
  com OkHttp.
- Não há tela de diagnóstico no app mostrando a resolução real da última
  captura.
- O telão ainda usa booleanos espalhados em vez de máquina de estados
  explícita.
