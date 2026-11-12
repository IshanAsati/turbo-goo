# Builds TurboGoo (web app + Electron shell) and opens the desktop app.
# The desktop shortcut runs this script, so each launch picks up the latest code.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

try {
    Write-Host "Building TurboGoo..." -ForegroundColor Cyan
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed (npm run build)." }

    & npm run build:electron
    if ($LASTEXITCODE -ne 0) { throw "Electron build failed (npm run build:electron)." }

    $electron = Join-Path $root "node_modules\electron\dist\electron.exe"
    if (-not (Test-Path $electron)) { throw "Electron is not installed. Run 'npm install' in $root first." }

    Write-Host "Opening TurboGoo..." -ForegroundColor Green
    Start-Process -FilePath $electron -ArgumentList "." -WorkingDirectory $root
}
catch {
    Write-Host ""
    Write-Host "TurboGoo could not start: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
