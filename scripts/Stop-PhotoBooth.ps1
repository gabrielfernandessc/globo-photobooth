<#
    ══════════════════════════════════════════════════════════
    STOP-PHOTOBOOTH — encerra o totem sem deixar processo órfão

    Encerra pela PORTA, e não por nome de processo: matar todo "node"
    da máquina derrubaria qualquer outra coisa que o operador estivesse
    rodando.
    ══════════════════════════════════════════════════════════
#>

[CmdletBinding()]
param([int] $Port = 3000)

$ErrorActionPreference = 'Stop'

$conexoes = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conexoes) {
    Write-Host "  Nenhum totem escutando na porta $Port." -ForegroundColor Yellow
    exit 0
}

foreach ($pidDono in ($conexoes | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $proc = Get-Process -Id $pidDono -ErrorAction SilentlyContinue
    if (-not $proc) { continue }

    Write-Host "  Encerrando $($proc.ProcessName) (PID $pidDono)..." -ForegroundColor Gray

    # Encerramento normal primeiro: o SQLite fecha o WAL direito e a
    # fila de publicação para sem deixar trabalho pela metade.
    $proc.CloseMainWindow() | Out-Null
    if (-not $proc.WaitForExit(5000)) {
        Write-Host '  Nao respondeu; forcando.' -ForegroundColor Yellow
        Stop-Process -Id $pidDono -Force
    }
}

Write-Host '  Totem encerrado. As fotos continuam salvas em data\.' -ForegroundColor Green
