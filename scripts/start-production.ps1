param(
    [int]$Port = 8000,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $projectRoot "web"

if (-not $SkipBuild) {
    if (-not (Test-Path (Join-Path $webRoot "node_modules"))) {
        throw "Frontend dependencies are missing. Run npm install in $webRoot first."
    }
    Push-Location $webRoot
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
    }
    finally {
        Pop-Location
    }
}

Set-Location $projectRoot
& python -m uvicorn server.main:app --host 127.0.0.1 --port $Port
