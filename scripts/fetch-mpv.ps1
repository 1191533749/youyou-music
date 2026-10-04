# 下载 mpv（shinchiro 官方 Windows 构建）并解压到 vendor/mpv。
#
# mpv 是 Kumone Windows 版的音频后端：应用只通过 JSON IPC 驱动它，音频解码与
# 输出（WASAPI）都由 mpv 完成。仓库不提交二进制，构建/打包前跑一次即可。
param(
    [string]$Tag = 'latest',
    [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $root 'vendor\mpv' }
$cache = Join-Path $root 'vendor\cache'
New-Item -ItemType Directory -Force -Path $Destination, $cache | Out-Null

$api = if ($Tag -eq 'latest') {
    'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest'
} else {
    "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/tags/$Tag"
}

Write-Host "查询 mpv 版本: $api"
$headers = @{ 'User-Agent' = 'kumone-windows-setup' }
$release = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 60
$asset = $release.assets |
    Where-Object { $_.name -match '^mpv-x86_64-\d+-git-[0-9a-f]+\.7z$' } |
    Select-Object -First 1
if (-not $asset) { throw "在 $($release.tag_name) 中找不到 x86_64 mpv 资产" }

$archive = Join-Path $cache $asset.name
if (Test-Path $archive) {
    Write-Host "使用已缓存的压缩包: $archive"
} else {
    Write-Host "下载 $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)"
    Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $archive -TimeoutSec 900
}

# 7za 由 7zip-bin 提供（devDependency），免去系统安装 7-Zip。
$sevenZip = Join-Path $root 'node_modules\7zip-bin\win\x64\7za.exe'
if (-not (Test-Path $sevenZip)) {
    throw "找不到 7za.exe（$sevenZip）。请先在项目根目录执行 npm install。"
}

Write-Host "解压到 $Destination"
& $sevenZip x $archive "-o$Destination" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7za 解压失败，退出码 $LASTEXITCODE" }

$mpv = Join-Path $Destination 'mpv.exe'
if (-not (Test-Path $mpv)) { throw "解压后未找到 mpv.exe" }

$version = (& $mpv --version 2>&1 | Select-Object -First 1)
Write-Host "mpv 就绪: $mpv"
Write-Host "版本: $version"
