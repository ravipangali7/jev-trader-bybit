# Dashboard against the paper bot. Restarts Next if it exits.
# Usage, from the repo root (web dependencies already installed):
#   powershell -ExecutionPolicy Bypass -File scripts\run-dashboard.ps1 -ApiPort 3100 -Port 3101

param(
  [int]$Port = 3101,
  [int]$ApiPort = 3100
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root "web"
Set-Location $web
New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null

$env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:$ApiPort"
$log = Join-Path $root "data\dashboard.log"
Write-Host "dashboard on port $Port, API http://127.0.0.1:$ApiPort, log $log"

while ($true) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $log -Value "`n===== $stamp starting dashboard on port $Port ====="
  & bun run dev -- --port $Port --hostname 127.0.0.1 *>> $log
  $code = $LASTEXITCODE
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $log -Value "===== $stamp exited $code, restarting in 5s ====="
  Start-Sleep -Seconds 5
}
