# Builds dist\Promethea (the app) and dist\Promethea-<version>-Setup.exe (the installer).
# Needs: the .venv with Promethea and PyInstaller installed, Node.js, and Inno Setup 6.
#   powershell -ExecutionPolicy Bypass -File packaging\build.ps1 [-SkipUI]
param([switch]$SkipUI)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"
Push-Location $root
try {
    if (-not $SkipUI) {
        Push-Location ui
        npm ci
        if ($LASTEXITCODE) { throw "npm ci failed" }
        npm run build
        if ($LASTEXITCODE) { throw "the UI build failed" }
        Pop-Location
    }
    & $python -m PyInstaller packaging\promethea.spec --noconfirm --clean --distpath dist --workpath build
    if ($LASTEXITCODE) { throw "PyInstaller failed" }
    & $python packaging\notices.py
    if ($LASTEXITCODE) { throw "writing the notices failed" }

    $version = (& $python -c "import promethea; print(promethea.__version__)").Trim()
    $iscc = @(
        (Get-Command iscc -ErrorAction SilentlyContinue).Source,
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $iscc) { throw "Inno Setup 6 isn't installed (winget install JRSoftware.InnoSetup)" }
    & $iscc "/DAppVersion=$version" packaging\promethea.iss
    if ($LASTEXITCODE) { throw "Inno Setup failed" }
    Write-Host "Built dist\Promethea-$version-Setup.exe"
}
finally {
    Pop-Location
}
