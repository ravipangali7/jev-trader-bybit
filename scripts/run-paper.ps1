# Keep the paper bot running on Windows. Restarts the process if it exits.
# Logs: data\bot.log
# Usage, from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\run-paper.ps1 -Port 3100

param(
  [int]$Port = 3100
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null

$env:PORT = "$Port"
if (-not $env:DRY_RUN) { $env:DRY_RUN = "true" }
if (-not $env:MODEL) { $env:MODEL = "mock" }

$log = Join-Path $root "data\bot.log"
Write-Host "paper bot on port $Port, log $log (Ctrl+C stops the supervisor)"

while ($true) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $log -Value "`n===== $stamp starting bot on port $Port ====="
  & bun run src/index.ts *>> $log
  $code = $LASTEXITCODE
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $log -Value "===== $stamp exited $code, restarting in 5s ====="
  Start-Sleep -Seconds 5
}
