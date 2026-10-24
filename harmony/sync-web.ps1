# Build the Baton web frontend and copy it into the HarmonyOS rawfile bundle.
# Windows PowerShell equivalent of sync-web.sh. Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File harmony\sync-web.ps1
$ErrorActionPreference = 'Stop'

$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $Here
$Rawfile   = Join-Path $Here 'entry\src\main\resources\rawfile'

Push-Location $RepoRoot
try {
  if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Host '==> installing deps (npm install)'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  }

  Write-Host '==> vite build (repo root)'
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
} finally {
  Pop-Location
}

$Dist = Join-Path $RepoRoot 'dist'
if (-not (Test-Path (Join-Path $Dist 'landing.html'))) { throw "build did not produce $Dist\landing.html" }

Write-Host "==> clearing $Rawfile"
Get-ChildItem -Path $Rawfile -Force | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force

Write-Host '==> copying dist\ -> rawfile\'
Copy-Item -Path (Join-Path $Dist '*') -Destination $Rawfile -Recurse -Force

Write-Host '==> done. Entry page: rawfile\landing.html'
