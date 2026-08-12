<#
    ══════════════════════════════════════════════════════════
    START-PHOTOBOOTH — duplo clique e o totem está de pé

    O operador de evento não abre terminal. Este script confere as
    dependências, sobe o servidor, espera ele responder de verdade,
    mostra o endereço da LAN e abre o telão em tela cheia.

    Falhar cedo e com mensagem em português é parte do trabalho: às
    22h de um sábado ninguém vai ler stack trace.
    ══════════════════════════════════════════════════════════
#>

[CmdletBinding()]
param(
    [int]    $Port    = 3000,
    [string] $DataDir = '',
    # Só o servidor, sem abrir navegador — útil para diagnóstico.
    [switch] $NoDisplay
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

$logDir = Join-Path $raiz 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("totem-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Escreve($texto, $cor = 'Gray') {
    Write-Host $texto -ForegroundColor $cor
    Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $texto)
}

function Falha($texto, $comoResolver) {
    Escreve ''
    Escreve "  PROBLEMA: $texto" 'Red'
    Escreve "  O QUE FAZER: $comoResolver" 'Yellow'
    Escreve ''
    Read-Host '  Pressione ENTER para fechar'
    exit 1
}

Escreve ''
Escreve '  ================================' 'Cyan'
Escreve '     GLOBO PHOTO BOOTH' 'Cyan'
Escreve '  ================================' 'Cyan'
Escreve ''

# ── Uma instância só ─────────────────────────────────────
# Duas instâncias na mesma porta viram "endereço em uso" e, pior, dois
# bancos abertos sobre o mesmo arquivo.
$emUso = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($emUso) {
    $pidDono = ($emUso | Select-Object -First 1).OwningProcess
    $dono = Get-Process -Id $pidDono -ErrorAction SilentlyContinue
    Falha "a porta $Port já está ocupada pelo processo '$($dono.ProcessName)' (PID $pidDono)." `
          "Se for um totem antigo, rode Stop-PhotoBooth.ps1 antes. Se for outro programa, use -Port com outro número."
}

# ── Dependências ─────────────────────────────────────────
try {
    $nodeVersao = (& node --version) 2>$null
} catch {
    $nodeVersao = $null
}
if (-not $nodeVersao) {
    Falha 'o Node.js não está instalado (ou não está no PATH).' `
          'Instale a versão LTS em https://nodejs.org e abra este atalho de novo.'
}

$maior = [int]($nodeVersao -replace '^v(\d+)\..*$', '$1')
if ($maior -lt 22) {
    Falha "o Node.js instalado é $nodeVersao, e o totem precisa da versão 22 ou maior." `
          'O banco do evento usa o SQLite embutido, que só existe a partir da 22. Atualize em https://nodejs.org.'
}
Escreve "  Node.js $nodeVersao" 'Green'

if (-not (Test-Path (Join-Path $raiz 'node_modules'))) {
    Escreve '  Primeira execução: instalando dependências (isso demora alguns minutos)...' 'Yellow'
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Falha 'a instalação das dependências falhou.' `
              'Confira a conexão com a internet e rode novamente. A instalação só é necessária uma vez.'
    }
}
Escreve '  Dependências prontas' 'Green'

# ── Onde as fotos vão ────────────────────────────────────
if (-not $DataDir) { $DataDir = Join-Path $raiz 'data' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$discoLivre = (Get-PSDrive -Name (Split-Path -Qualifier $DataDir).TrimEnd(':')).Free
$gigasLivres = [math]::Round($discoLivre / 1GB, 1)
if ($gigasLivres -lt 2) {
    Falha "só restam $gigasLivres GB livres em disco." `
          'Um evento gera vários GB de fotos. Libere espaço antes de começar.'
}
Escreve "  Fotos em: $DataDir  ($gigasLivres GB livres)" 'Green'

# ── Sobe o servidor ──────────────────────────────────────
$env:PORT = $Port
$env:DATA_DIR = $DataDir

$saidaLog = Join-Path $logDir 'servidor.log'
$erroLog  = Join-Path $logDir 'servidor-erro.log'

$servidor = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
    -WorkingDirectory $raiz -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $saidaLog -RedirectStandardError $erroLog

Escreve ''
Escreve "  Servidor subindo (PID $($servidor.Id))..." 'Gray'

# Espera o servidor RESPONDER, e não apenas o processo existir: processo
# vivo com porta muda é o pior dos mundos para quem está operando.
$pronto = $false
$limite = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $limite) {
    if ($servidor.HasExited) {
        $erro = if (Test-Path $erroLog) { Get-Content $erroLog -Tail 15 | Out-String } else { '(sem detalhes)' }
        Falha "o servidor fechou sozinho durante o boot.`n$erro" `
              "O log completo está em $erroLog"
    }
    try {
        $saude = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 2
        if ($saude.ok) { $pronto = $true; break }
    } catch { Start-Sleep -Milliseconds 400 }
}

if (-not $pronto) {
    Stop-Process -Id $servidor.Id -Force -ErrorAction SilentlyContinue
    Falha 'o servidor não respondeu em 45 segundos.' "Veja o log em $erroLog"
}

Escreve '  Servidor no ar' 'Green'
Escreve "  Banco: $($saude.database)   Fotos do evento: $($saude.photos)" 'Gray'
if ($saude.cloud -ne 'ready') {
    # Não é erro: o totem foi feito para funcionar sem internet.
    Escreve "  Publicacao na internet: $($saude.cloud) — as fotos ficam salvas e sobem quando houver rede" 'Yellow'
}

# ── Endereço da LAN, para o celular ──────────────────────
$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.InterfaceAlias -notmatch 'Loopback|VPN|VirtualBox|VMware|Hyper-V'
    } |
    Select-Object -ExpandProperty IPAddress

Escreve ''
Escreve '  ---- ENDERECO PARA O CELULAR ----' 'Cyan'
foreach ($ip in $ips) { Escreve "     http://${ip}:$Port" 'White' }
Escreve ''

# ── Telão ────────────────────────────────────────────────
if (-not $NoDisplay) {
    $urlTelao = "http://localhost:$Port/display.html"
    $navegador = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($navegador) {
        # Perfil próprio: o totem não herda abas, extensões nem sessão do
        # navegador pessoal de quem estiver usando o PC.
        $perfil = Join-Path $env:TEMP 'globo-photobooth-perfil'
        Start-Process $navegador -ArgumentList @(
            "--kiosk=$urlTelao",
            "--user-data-dir=$perfil",
            '--start-fullscreen',
            '--noerrdialogs',
            '--disable-session-crashed-bubble',
            '--disable-infobars',
            '--autoplay-policy=no-user-gesture-required'
        )
        Escreve "  Telao aberto em tela cheia ($(Split-Path -Leaf $navegador))" 'Green'
        Escreve '  Para sair da tela cheia: ALT+F4' 'Gray'
    } else {
        Escreve '  Chrome/Edge nao encontrado — abra manualmente:' 'Yellow'
        Escreve "     $urlTelao" 'White'
    }
}

Escreve ''
Escreve '  ================================' 'Green'
Escreve '     TOTEM PRONTO' 'Green'
Escreve '  ================================' 'Green'
Escreve ''
Escreve '  Para encerrar: feche esta janela ou rode Stop-PhotoBooth.ps1' 'Gray'
Escreve ''

# Segura a janela aberta: fechá-la é como o operador desliga o totem.
try {
    Wait-Process -Id $servidor.Id
} finally {
    Escreve 'Servidor encerrado.' 'Yellow'
}
