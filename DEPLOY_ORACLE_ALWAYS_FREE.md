# Deploy Oracle Always Free - Apoio Missao

Este guia coloca o site no ar em `apoiomissao.com.br` com:
- Node.js 20
- PM2 (processo sempre ativo)
- Nginx (proxy reverso)
- HTTPS Let's Encrypt

## 1) Criar a VM no Oracle Cloud

1. Acesse Oracle Cloud Console.
2. Menu `Compute` -> `Instances` -> `Create instance`.
3. Nome: `apoio-missao-vm`.
4. Image and shape:
- Image: `Canonical Ubuntu 22.04` (ou 24.04)
- Shape: `VM.Standard.E2.1.Micro` (Always Free)
5. Networking:
- VCN padrão pode ser criada automaticamente.
- Marque para atribuir `Public IPv4 address`.
6. SSH Keys:
- Escolha `Generate a key pair for me` (mais simples).
- Baixe o `.key` (privada) e `.pub`.
7. Clique `Create`.

## 2) Pegar IP, usuario e chave (as 3 infos que eu te pedi)

1. Na tela da instância:
- Campo `Public IP address` = seu IP público.
2. Usuário SSH:
- Ubuntu usa `ubuntu` ou `opc` (na própria tela normalmente mostra exemplo de SSH).
3. Chave privada:
- Arquivo `.key` baixado no passo de criação.
- Renomeie para `oracle-apoio.pem` (opcional).

Exemplo de comando SSH:
```bash
chmod 600 ~/Downloads/oracle-apoio.pem
ssh -i ~/Downloads/oracle-apoio.pem ubuntu@SEU_IP_PUBLICO
```

Se `ubuntu` falhar, tente:
```bash
ssh -i ~/Downloads/oracle-apoio.pem opc@SEU_IP_PUBLICO
```

## 3) Liberar portas 80 e 443 no Oracle

1. Abra a instância -> seção de rede -> clique na `Subnet` ou `Security List`.
2. Em `Ingress Rules`, adicione:
- TCP 80, source `0.0.0.0/0`
- TCP 443, source `0.0.0.0/0`

## 4) Apontar dominio apoiomissao.com.br

No seu DNS (Registro.br ou provedor DNS):
- Registro `A` para `@` -> `SEU_IP_PUBLICO`
- Registro `A` para `www` -> `SEU_IP_PUBLICO`

Espere propagacao (5 a 30 min tipico, podendo levar mais).

## 5) Enviar projeto para a VM

Opcao A (recomendada): GitHub
```bash
# na VM
git clone URL_DO_REPO apoio-missao
cd apoio-missao
```

Opcao B: copiar pasta local com scp
```bash
scp -i ~/Downloads/oracle-apoio.pem -r /Users/SEU_USUARIO/caminho/do/projeto ubuntu@SEU_IP_PUBLICO:~/apoio-missao
```

## 6) Configurar variaveis

Na VM, dentro da pasta do projeto:
```bash
cp .env.example .env
nano .env
```

Preencha:
```env
PORT=3000
QA_API_KEY=SUA_CHAVE_API_QUEROAPOIAR
QA_API_BASE=https://api.queroapoiar.com.br
```

## 7) Rodar bootstrap automatico

Na VM:
```bash
cd ~/apoio-missao
bash scripts/bootstrap-oracle.sh apoiomissao.com.br
```

Esse script instala Node, PM2, Nginx, Certbot e publica o app.

## 8) Validar

Abra:
- `https://apoiomissao.com.br/apoio-missao`
- `https://www.apoiomissao.com.br/apoio-missao`

Logs:
```bash
pm2 logs apoio-missao
sudo nginx -t
sudo systemctl status nginx
```

## 9) Atualizar o site depois

```bash
cd ~/apoio-missao
git pull
npm install
pm2 restart apoio-missao
```

