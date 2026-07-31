param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $projectRoot "web"

if (-not (Test-Path (Join-Path $webRoot "node_modules"))) {
    throw "Frontend dependencies are missing. Run npm install in $webRoot first."
}

$backendJob = Start-Job -ArgumentList $projectRoot, $BackendPort -ScriptBlock {
    param($jobRoot, $jobPort)
    Set-Location $jobRoot
    & python -m uvicorn server.main:app --host 127.0.0.1 --port $jobPort --reload
}

try {
    Set-Location $webRoot
    $env:VITE_BACKEND_URL = "http://127.0.0.1:$BackendPort"
    & npm run dev -- --host 127.0.0.1 --port $FrontendPort
}
finally {
    Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
    Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $backendJob -Force -ErrorAction SilentlyContinue
}
