# Globo Photo Booth

Totem de fotografia para eventos corporativos. Um celular Android é a
câmera, um PC é o servidor e o telão, e o convidado leva a foto por QR
Code.

O produto é o fluxo: **celular conecta → convidado se posiciona →
contagem → foto em alta → moldura → telão → QR → download**. Todo o
resto existe para tornar esse fluxo rápido e confiável.

## Arquitetura

**Local-first.** O servidor no PC do totem é a autoridade durante o
evento. A nuvem é destino de publicação, nunca cérebro.

```
CELULAR (câmera)  ──LAN──▶  SERVIDOR LOCAL  ──localhost──▶  TELÃO
                             sessão, fotos
                             moldura, SQLite
                             fila de publicação
                                   │
                             (só quando há internet)
                                   ▼
                             CLOUD PUBLISHER
                             Blob + página pública
```

| Camada | Arquivo | Papel |
|---|---|---|
| Boot local | `server.js` | HTTP + HTTPS com certificado autoassinado |
| Boot Vercel | `api/server.js` | função serverless (só publicação/visualização) |
| App | `lib/app.js` | Express + Socket.IO, rotas, eventos |
| Config | `lib/config.js` | um lugar só para ambiente e padrões |
| Banco | `lib/db.js` | SQLite: evento, sessão, moldura, foto, fila |
| Estado | `lib/store.js` | drivers sqlite / memory / redis + token HMAC |
| Arquivos | `lib/storage.js` | drivers local / blob |
| Imagem | `lib/photo.js` | corte, espelho, moldura, derivadas |
| Publicação | `lib/publisher.js` | contrato CloudPublisher |
| Fila | `lib/share-queue.js` | worker com backoff, durável |

## Invariantes — não quebre

1. **A captura nunca depende da internet.** Compor e salvar a foto em
   disco acontece antes de qualquer chamada de rede externa.
2. **Falha ao publicar não é falha ao fotografar.** São eventos
   distintos e a interface precisa distingui-los. Nunca mostre "falha ao
   tirar foto" quando a foto existe em disco.
3. **O original nunca é apagado automaticamente** e **nunca vai para o
   payload público** — ele carrega o EXIF do celular, inclusive GPS.
   Versões publicadas saem sem metadados.
4. **Uma moldura ruim não pode custar a foto.** Erro ao ler ou decodificar
   moldura degrada para "sem moldura", nunca para exceção.
5. **Preview e composição final usam a mesma matemática de
   enquadramento** (`centerCrop` / `ratioValue` em `lib/photo.js`). Se
   divergirem, o convidado enquadra o rosto num lugar e recebe outro.
6. **O nome do arquivo master é determinístico a partir do id**
   (`final/globo_<id>.jpg`). É o que permite resolver uma foto mesmo sem
   banco, e é o contrato com a página pública.
7. **Nuvem indisponível não deixa `/api/health` doente.** Um totem que
   fotografa, salva e mostra está operacional.
8. **Presença é efêmera**; sessão, moldura, foto e fila são duráveis.
9. **O código de 4 caracteres não é segredo.** Quem autoriza upload é o
   HMAC (`signCode` / `verifySignedCode`).

## Comandos

```bash
npm ci             # instalar (Node 22+ — node:sqlite é embutido)
npm start          # subir o servidor local
npm test           # suíte completa, inclui teste de sistema real
```

O operador não usa terminal. Ele abre o totem por duplo clique:

```bash
bash scripts/build-mac-app.sh    # monta "Globo Photo Booth.app"
```

O bundle é gerado, não versionado. O lançador dentro dele resolve o
`node` explicitamente — um app aberto pelo Finder recebe só
`/usr/bin:/bin:/usr/sbin:/sbin`, e é por isso que tanto lançador
"funciona no terminal e não funciona no duplo clique". Ele também
derruba o `PTPCamera` (que disputa a câmera com o gphoto2), impede a
máquina de dormir e espera `/api/health` responder antes de abrir o
telão. Encerrar pelo Dock manda SIGTERM e o servidor fecha o WAL direito.

`PHOTOBOOTH_SEM_TELAO=1` sobe o servidor sem tomar a tela — é o modo de
diagnóstico. No Windows existe o equivalente em `start-totem.cmd`.

## Testes

`node --test` embutido, sem framework. Fixtures são geradas por sharp em
`test/helpers/fixtures.js` — não versione binário de imagem.

- `photo-geometry` / `photo-pipeline` — enquadramento, EXIF, espelho,
  moldura, remoção de metadados
- `api` — contrato HTTP consumido pelo Android e pelo telão
- `db` / `share-queue` — persistência e publicação assíncrona
- `system` — sobe `node server.js` de verdade, mata o processo no meio,
  mede uma sequência de capturas

Testes escrevem em diretório temporário. Se um teste sujar `data/` ou
`public/uploads/`, ele está errado.

## Convenções

- Código e comentários em português; commits em português.
- Comentário explica **por quê**, não o que a linha faz. Se descreve o
  óbvio, apague.
- Sem `|| true` em CI. Teste crítico vermelho para o pipeline.
- Erro precisa dizer módulo, `captureId` e causa — nunca mensagem
  genérica para tudo.
- Log estruturado com `captureId` para seguir uma foto do disparo ao QR.

## Ambiente

Nada obrigatório para o modo evento. O totem sobe sem nenhuma variável.

| Variável | Efeito |
|---|---|
| `PORT` / `HTTPS_PORT` | portas (3000 / 3443) |
| `DATA_DIR` | onde ficam banco e fotos |
| `PUBLIC_BASE_URL` + `BLOB_READ_WRITE_TOKEN` | ligam a publicação na nuvem |
| `SESSION_SECRET` | chave do HMAC de sessão |
| `ENABLE_HTTPS=false` | desliga o TLS local (o celular precisa dele para a câmera web) |

Segredos só por ambiente. Nunca commitados, nunca logados.

## Estado atual

O app Android ainda tem `DEFAULT_SERVER_URL` apontando para a Vercel e
captura para `ByteArray` em memória. Os dois contrariam a arquitetura
local-first e estão pendentes — ver `.claude/skills/photobooth/SKILL.md`.
