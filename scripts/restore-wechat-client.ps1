# restore-wechat-client.ps1 —— 从备份安装包恢复固定版微信客户端（4.1.10.27）
#
# 用途：固定版客户端被微信强制升级（Hook 失效）后，用本地备份安装包还原，并阻止后续自动更新。
#
# 前置：
#   state\backups\weixin_4.1.10.27.exe  （可用 scripts\dev\download-wx-4.1.10.27.ps1 下载）
#   state\tools\7zr.exe                  （7-Zip 精简版，用于解包安装器）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-wechat-client.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-wechat-client.ps1 -Installer D:\path\weixin_4.1.10.27.exe

param(
    [string]$Installer = '',
    [string]$ExpectedVersion = '4.1.10.27',
    [string]$ExpectedSha256 = '54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Installer) { $Installer = Join-Path $root 'state\backups\weixin_4.1.10.27.exe' }
$seven = Join-Path $root 'state\tools\7zr.exe'
$client = Join-Path $root 'state\wechat-hook-client'
$hookDll = Join-Path $root 'state\hook\native\version.dll'
$hookToken = Join-Path $root 'state\tokens\hook.txt'

if (-not (Test-Path -LiteralPath $Installer)) { throw "缺少安装包：$Installer（先运行 scripts/dev/download-wx-4.1.10.27.ps1 或指定 -Installer）" }
if (-not (Test-Path -LiteralPath $seven)) { throw "缺少 7zr：$seven" }
if (-not (Test-Path -LiteralPath $hookDll)) { throw "缺少 Hook DLL：$hookDll" }
if (-not (Test-Path -LiteralPath $hookToken)) { throw "缺少 hook token：$hookToken" }

Write-Host "[1/5] 校验安装包"
$hash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "      sha256=$hash"
if ($ExpectedSha256 -and $hash -ne $ExpectedSha256.ToLowerInvariant()) { throw "安装包 SHA256 不匹配（期望 $ExpectedSha256）" }

Write-Host "[2/5] 解包"
$extract = Join-Path $root 'state\backups\extract'
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extract | Out-Null
& $seven x $Installer "-o$extract" -y 2>&1 | Out-Null
if ($LASTEXITCODE -ge 2) { throw "7zr 解包失败（exit=$LASTEXITCODE）" }

# 有些安装器是套娃：解出一层后再找 7z/zip
$candidates = @()
for ($round = 0; $round -lt 2 -and $candidates.Count -eq 0; $round++) {
    $candidates = @(Get-ChildItem -LiteralPath $extract -Recurse -File -Filter 'Weixin.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 1MB })
    if ($candidates.Count -eq 0) {
        $archives = @(Get-ChildItem -LiteralPath $extract -Recurse -File -Include '*.7z', '*.zip', '*.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -ne $Installer -and $_.Length -gt 10MB })
        foreach ($archive in $archives) {
            $nested = Join-Path $extract ('nested-' + [IO.Path]::GetFileNameWithoutExtension($archive.Name))
            New-Item -ItemType Directory -Force -Path $nested | Out-Null
            & $seven x $archive.FullName "-o$nested" -y 2>&1 | Out-Null
        }
    }
}

if ($candidates.Count -eq 0) {
    throw "解包后找不到 Weixin.exe（$extract）；请检查安装包格式或手动解包后指定客户端目录"
}

$target = $null
foreach ($candidate in $candidates) {
    $version = $candidate.VersionInfo.FileVersion
    Write-Host "      候选：$($candidate.FullName)  version=$version"
    if ($version -eq $ExpectedVersion) { $target = $candidate; break }
}
if (-not $target) { throw "解包结果中没有 $ExpectedVersion 的 Weixin.exe" }
$payloadDir = $target.Directory.FullName
Write-Host "      使用：$payloadDir"

Write-Host "[3/5] 替换客户端目录（保留 Hook DLL/token）"
if (-not (Test-Path -LiteralPath $client)) { New-Item -ItemType Directory -Force -Path $client | Out-Null }
Get-ChildItem -LiteralPath $client -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $payloadDir '*') -Destination $client -Recurse -Force
Copy-Item -LiteralPath $hookDll -Destination (Join-Path $client 'version.dll') -Force
Copy-Item -LiteralPath $hookToken -Destination (Join-Path $client 'wechatagent-hook.token') -Force
Get-ChildItem -LiteralPath $client -Recurse -File -Filter '*Update*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '\.disabled$' } |
    ForEach-Object { try { Rename-Item -LiteralPath $_.FullName -NewName ($_.Name + '.disabled') -Force } catch { } }

Write-Host "[4/5] 校验"
$exe = Join-Path $client 'Weixin.exe'
$version = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
Write-Host "      Weixin.exe version=$version"
if ($version -ne $ExpectedVersion) { throw "恢复失败：版本仍为 $version（期望 $ExpectedVersion）" }
try {
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') {
        Write-Warning "签名校验异常：Status=$($signature.Status) Subject=$($signature.SignerCertificate.Subject)"
    } else {
        Write-Host "      签名：$($signature.SignerCertificate.Subject)"
    }
} catch { Write-Warning "签名读取失败：$($_.Exception.Message)" }

Write-Host "[5/5] 阻止微信自动更新"
$block = Join-Path $root 'scripts\block-wechat-update.ps1'
if (Test-Path -LiteralPath $block) { & $block }

# [6/6] 若启用了双微信共存，恢复后自动重打共存补丁
try {
    $configPath = Join-Path $root 'config\app.json'
    $allowCoexist = $false
    if (Test-Path -LiteralPath $configPath) {
        $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $allowCoexist = ($cfg.hook.allowCoexist -eq $true)
    }
    if ($allowCoexist) {
        $py = Join-Path $root '.venv\Scripts\python.exe'
        $patcher = Join-Path $root 'scripts\dev\patch-wechat-coexist.py'
        if ((Test-Path -LiteralPath $py) -and (Test-Path -LiteralPath $patcher)) {
            Write-Host '[6/6] 重新应用双微信共存补丁…'
            & $py $patcher
            if ($LASTEXITCODE -ne 0) { throw "共存补丁失败（exit=$LASTEXITCODE）" }
        }
    }
} catch {
    Write-Warning "共存补丁未应用：$($_.Exception.Message)"
}

Write-Host ''
Write-Host "固定版客户端已恢复：$client（$version）"
Write-Host '请重新打开 WXBOT.exe → 点「启动微信并登录」。'
