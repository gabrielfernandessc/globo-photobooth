@echo off
REM ══════════════════════════════════════════════════════════
REM  Duplo clique aqui sobe o totem.
REM
REM  Só existe para dar um alvo clicável ao PowerShell: o Windows
REM  não executa .ps1 com duplo clique por padrão, e -ExecutionPolicy
REM  Bypass vale apenas para este processo, sem alterar a política
REM  da máquina.
REM ══════════════════════════════════════════════════════════

title Globo Photo Booth
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-PhotoBooth.ps1" %*

REM Se o PowerShell falhar antes de mostrar a mensagem dele, a janela
REM não pode sumir levando o motivo junto.
if errorlevel 1 (
  echo.
  echo  O totem nao subiu. Veja a mensagem acima e os logs em logs\.
  pause
)
