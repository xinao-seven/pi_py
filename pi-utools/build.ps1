# 重新构建 uTools 插件：构建 web 的 uTools 变体并拷贝产物到本目录
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # pi_py/
$web = Join-Path $root "web"
$dest = $PSScriptRoot

Push-Location $web
$env:UTOOLS_BUILD = "1"
$env:VITE_BACKEND_URL = "http://127.0.0.1:8001"
try {
  npm run build
} finally {
  Pop-Location
}

Copy-Item (Join-Path $web "dist-utools\index.html") (Join-Path $dest "index.html") -Force
if (Test-Path (Join-Path $dest "assets")) { Remove-Item (Join-Path $dest "assets") -Recurse -Force }
Copy-Item (Join-Path $web "dist-utools\assets") (Join-Path $dest "assets") -Recurse -Force

Write-Host "uTools 插件已更新: $dest"
