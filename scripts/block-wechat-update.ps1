# block-wechat-update.ps1 —— 用文件 ACL 阻止微信 4.x 自动升级（参考 WeChat-Hook 官方做法并加固）
#
# 背景：固定版本客户端被强制升级后，Hook DLL（targetVersion 4.1.10.27）会失效。
# 做法：对 %APPDATA%\Tencent\xwechat\update 下的 update.data / patch / download 收紧 ACL，
# 拒绝当前用户写入；同时清空已缓存的 patch。微信更新组件无法写入后无法完成升级。
#
# 注意：这是"阻止升级"的防护，不是绕过服务端强制更新；若腾讯服务端强制旧版登录，仍需匹配新版本 Hook。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\block-wechat-update.ps1
#       -Quiet 只做事不打印摘要

param([switch]$Quiet)

$ErrorActionPreference = 'SilentlyContinue'
$user = $env:USERNAME
$updateRoot = Join-Path $env:APPDATA 'Tencent\xwechat\update'
$patchDir = Join-Path $updateRoot 'patch'
$downloadDir = Join-Path $updateRoot 'download'
$updateData = Join-Path $updateRoot 'update.data'

if (-not (Test-Path -LiteralPath $updateRoot)) {
    if (-not $Quiet) { Write-Host "未找到微信更新目录（$updateRoot），跳过。" }
    exit 0
}

# 1) 清空 patch 暂存目录并重建
if (Test-Path -LiteralPath $patchDir) {
    Get-ChildItem -LiteralPath $patchDir -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Force -Path $patchDir | Out-Null
}

# 2) 收紧 ACL：拒绝当前用户写入/删除（保留读取，避免影响非更新逻辑）
function Deny-Write([string]$path, [switch]$Directory) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $acl = if ($Directory) { "$($user):(OI)(CI)(W,D)" } else { "$($user):(W,D)" }
    & icacls.exe $path /inheritance:r /deny $acl 2>$null | Out-Null
}

Deny-Write $patchDir -Directory
if (Test-Path -LiteralPath $downloadDir) { Deny-Write $downloadDir -Directory }

# 3) update.data 作为升级开关文件：不存在时创建空文件，并拒绝写入
if (-not (Test-Path -LiteralPath $updateData)) {
    New-Item -ItemType File -Force -Path $updateData | Out-Null
}
Deny-Write $updateData

# 4) 顺手把固定版客户端里的更新器改名（若存在）
$clientDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'state\wechat-hook-client'
if (Test-Path -LiteralPath $clientDir) {
    Get-ChildItem -LiteralPath $clientDir -Recurse -Filter '*Update*.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '\.disabled$' } |
        ForEach-Object {
            try { Rename-Item -LiteralPath $_.FullName -NewName ($_.Name + '.disabled') -Force } catch { }
        }
}

# 5) 验证：尝试写入 patch 目录，预期失败
$probe = Join-Path $patchDir 'wxbot-acl-probe.txt'
$blocked = $false
try {
    Set-Content -LiteralPath $probe -Value 'probe' -Force -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
} catch {
    $blocked = $true
}

if (-not $Quiet) {
    $stateText = if ($blocked) { '已生效（patch 目录写入被拒绝）' } else { 'ACL 可能未生效，请检查权限' }
    Write-Host "微信自动更新防护：$stateText"
    Write-Host "  update.data : $updateData"
    Write-Host "  patch       : $patchDir"
    Write-Host "  download    : $downloadDir"
}
