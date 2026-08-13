param(
    [int]$BackendPort = 8001,
    [int]$FrontendPort = 5173,
    [int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $projectRoot "web"
$nodeServerRoot = Join-Path $projectRoot "node-server"

if (-not (Test-Path (Join-Path $webRoot "node_modules"))) {
    throw "Frontend dependencies are missing. Run npm install in $webRoot first."
}
if (-not (Test-Path (Join-Path $nodeServerRoot "node_modules"))) {
    throw "Node backend dependencies are missing. Run npm install in $nodeServerRoot first."
}

if (Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Node backend port $BackendPort is already in use. Stop the existing process first, or use -BackendPort with another port."
}

$backendJob = Start-Job -ArgumentList $nodeServerRoot, $BackendPort -ScriptBlock {
    param($jobRoot, $jobPort)
    Set-Location $jobRoot
    $env:PI_NODE_SERVER_PORT = "$jobPort"
    & npm run dev
}

try {
    # Do not start Vite until the background Node process really accepts requests.
    # Otherwise Vite keeps running alone and makes an unavailable backend look like
    # an empty session history.
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $backendReady = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 1
            if ($health.status -eq "ok") {
                $backendReady = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 400
        }
    }
    if (-not $backendReady) {
        $backendOutput = (Receive-Job -Job $backendJob -Keep -ErrorAction SilentlyContinue 2>&1 | Out-String).Trim()
        if (-not $backendOutput) { $backendOutput = "No backend output was captured." }
        throw "Node backend did not become ready on port $BackendPort within $StartupTimeoutSeconds seconds.`n$backendOutput"
    }

    Write-Host "Node Pi backend ready: http://127.0.0.1:$BackendPort"
    Set-Location $webRoot
    $env:VITE_BACKEND_URL = "http://127.0.0.1:$BackendPort"
    & npm run dev -- --host 127.0.0.1 --port $FrontendPort
}
finally {
    Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
    Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $backendJob -Force -ErrorAction SilentlyContinue
}
