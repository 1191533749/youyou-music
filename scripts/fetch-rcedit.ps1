# 下载 rcedit（打包时写 exe 图标与版本信息用）。
#
# 为什么需要它：electron-builder 自带的 exe 资源编辑路径要解压含 macOS 符号链接的
# winCodeSign 包，在未开启开发者模式的 Windows 上会失败；scripts/after-pack.cjs
# 改用 rcedit 直接改 PE 资源。仓库不提交二进制，构建前跑一次即可。
param(
    [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $root 'vendor\rcedit' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$target = Join-Path $Destination 'rcedit-x64.exe'
if (Test-Path $target) {
    Write-Host "已存在: $target"
    exit 0
}

# 优先复用 electron-builder 缓存里已经解压出来的那份，省一次下载。
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
if (Test-Path $cache) {
    $found = Get-ChildItem $cache -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) {
        Copy-Item $found.FullName $target -Force
        Write-Host "从 electron-builder 缓存复制: $target"
        exit 0
    }
}

$url = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe'
Write-Host "下载 $url"
Invoke-WebRequest -Uri $url -OutFile $target -TimeoutSec 300
Write-Host "完成: $target ($([math]::Round((Get-Item $target).Length / 1KB, 0)) KB)"
