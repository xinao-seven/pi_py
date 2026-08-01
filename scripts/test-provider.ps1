$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
& python scripts/smoke-provider.py
exit $LASTEXITCODE
