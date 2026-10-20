# launch-hook-wechat.ps1 —— 启动固定版本微信 + Hook DLL（手册 §4.2 / §6.2）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-hook-wechat.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-hook-wechat.ps1 -PrepareOnly
#
# 做的事：
#   1) 校验独立客户端版本 == config.hook.expectedVersion（默认 4.1.10.27）
#   2) 校验客户端签名 / Hook DLL 哈希
#   3) 要求先退出其它桌面微信（本脚本不杀未知进程）
#   4) 复制 version.dll 与 wechatagent-hook.token 到客户端目录
#   5) 禁用更新器（改名，尽力而为）
#   6) 启动：Weixin.exe StartPort=<hook 端口> CallBackURL="http://127.0.0.1:<adapter>/unused"
#   7) 等待 Hook 端口监听，提示登录后运行 sender-adapter --check

param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $root 'config\app.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hook = $config.hook
$hookPort = ([Uri]$hook.baseUrl).Port
$expectedVersion = $hook.expectedVersion
$adapterPort = [int]$config.ports.adapter

$exe = if ([IO.Path]::IsPathRooted([string]$hook.wechatExecutable)) {
    [IO.Path]::GetFullPath([string]$hook.wechatExecutable)
} else {
    [IO.Path]::GetFullPath((Join-Path $root ([string]$hook.wechatExecutable)))
}
if (-not (Test-Path -LiteralPath $exe)) { throw "找不到固定版本微信客户端：$exe（把脚本里的 hook.wechatExecutable 指向独立副本）" }
$directory = Split-Path -Parent $exe

# 0) 阻止微信自动更新（避免固定版被强制升级导致 Hook 失效）
$blockScript = Join-Path $root 'scripts\block-wechat-update.ps1'
if (Test-Path -LiteralPath $blockScript) {
    & $blockScript -Quiet
}

# 1) 版本三重锁之调用方期望值
$fileVersion = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
if ($fileVersion -ne $expectedVersion) {
    throw "客户端版本不匹配：实际=$fileVersion 期望=$expectedVersion（Hook DLL 只支持固定版本，禁止自动改版本号）"
}

# 2) 签名（尽力而为：独立副本若被裁切过会提示，不阻断 PrepareOnly）
try {
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') {
        Write-Warning "客户端签名校验未通过（Status=$($signature.Status) Subject=$($signature.SignerCertificate.Subject)）；请确认来源可信。"
    } else {
        Write-Host "客户端签名校验通过：$($signature.SignerCertificate.Subject)"
    }
} catch {
    Write-Warning "签名读取失败：$($_.Exception.Message)"
}

# 3) Hook DLL 与构建记录
$native = Join-Path $root 'state\hook\native'
$dll = Join-Path $native 'version.dll'
$buildFile = Join-Path $native 'build.json'
if (-not (Test-Path -LiteralPath $dll) -or -not (Test-Path -LiteralPath $buildFile)) {
    throw "缺少 Hook DLL：$native（需要 state/hook/native/version.dll 与 build.json）"
}
$build = Get-Content -LiteralPath $buildFile -Raw -Encoding UTF8 | ConvertFrom-Json
$dllHash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
if ($build.targetVersion -ne $expectedVersion -or $dllHash -ne $build.sha256) {
    throw "Hook DLL 构建记录不匹配：target=$($build.targetVersion) hash=$dllHash"
}

# 4) 共存补丁检测（BetterWX 方案：Mutex/窗口名/自动登录文件改名；Hook 偏移不变）
$coexistPatched = $false
$coexistInfoPath = Join-Path $root 'state\research\coexist-patch.json'
if ($hook.allowCoexist -eq $true -and (Test-Path -LiteralPath $coexistInfoPath)) {
    try {
        $coexistInfo = Get-Content -LiteralPath $coexistInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($coexistInfo.patchedSha256 -and (Test-Path -LiteralPath $coexistInfo.dll)) {
            $actual = (Get-FileHash -LiteralPath $coexistInfo.dll -Algorithm SHA256).Hash.ToLowerInvariant()
            $coexistPatched = ($actual -eq ([string]$coexistInfo.patchedSha256).ToLowerInvariant())
        }
    } catch { $coexistPatched = $false }
}
if ($coexistPatched) {
    Write-Host '共存补丁已启用：固定版微信可与其它微信客户端同时运行。'
}

# 5) 微信单实例拦截（未打共存补丁时生效）
$desktop = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch '--type=|--crashpad-handler' })
$ours = @($desktop | Where-Object { $_.ExecutablePath -eq $exe })
$others = @($desktop | Where-Object { $_.ExecutablePath -ne $exe })
if ($others.Count -gt 0 -and $ours.Count -eq 0 -and -not $PrepareOnly -and -not $coexistPatched) {
    Write-Host "WECHAT_OTHER_INSTANCE_RUNNING：检测到其它微信客户端正在运行（pid=$($others.ProcessId -join ',')）。微信为单实例，请先退出其它微信，再启动固定版；登录完成后其它微信可正常重新打开。"
    exit 3
}
if ($others.Count -gt 0) {
    if ($coexistPatched) {
        Write-Host "检测到其它微信客户端（pid=$($others.ProcessId -join ',')）；共存补丁已启用，继续启动固定版。"
    } else {
        Write-Host "检测到其它微信客户端（pid=$($others.ProcessId -join ',')）；按 -PrepareOnly 继续准备 Hook 文件。"
    }
}
if ($ours.Count -gt 0 -and -not $PrepareOnly) {
    Write-Host "固定版本客户端已在运行，直接使用即可。登录后运行：node scripts/sender-adapter.mjs --check"
    exit 0
}
if ($ours.Count -gt 0 -and $PrepareOnly) {
    throw '固定版本客户端正在运行，替换 DLL 前请先退出它。'
}

# 5) 复制 DLL + token，禁用更新器
$tokenFile = Join-Path $root 'state\tokens\hook.txt'
if (-not (Test-Path -LiteralPath $tokenFile)) { throw '缺少 state/tokens/hook.txt，请先运行 npm run init' }
$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if ($token -notmatch '^[0-9a-f]{64}$') { throw 'hook token 不是 64-hex' }
Copy-Item -LiteralPath $dll -Destination (Join-Path $directory 'version.dll') -Force
Copy-Item -LiteralPath $tokenFile -Destination (Join-Path $directory 'wechatagent-hook.token') -Force
$updater = Join-Path $directory 'WeixinUpdate.exe'
if (Test-Path -LiteralPath $updater) {
    try {
        Rename-Item -LiteralPath $updater -NewName 'WeixinUpdate.exe.disabled' -Force
        Write-Host '已禁用更新器 WeixinUpdate.exe'
    } catch {
        Write-Warning "更新器改名失败：$($_.Exception.Message)"
    }
}
Write-Host "已安装 Hook DLL 与 token 到：$directory"

if ($PrepareOnly) {
    Write-Host 'PrepareOnly：客户端已就绪但未启动。'
    exit 0
}

# 6) 端口必须空闲
if (Get-NetTCPConnection -LocalPort $hookPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Hook 端口 $hookPort 已被占用，请先检查占用进程。"
}

# 7) 启动固定版本客户端（参数：StartPort / CallBackURL 指向不存在的路径，入站回调弃用）
$arguments = 'StartPort=' + $hookPort + ' CallBackURL="http://127.0.0.1:' + $adapterPort + '/unused"'
Write-Host "启动：$exe $arguments"
$process = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Normal -PassThru
Start-Sleep -Seconds 2
$process.Refresh()
if ($process.HasExited) {
    $replacement = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=|--crashpad-handler' })
    if (-not $replacement.Count) {
        throw 'WECHAT_LAUNCH_EXITED：固定版本客户端启动后退出（可能被要求升级/版本不兼容）。'
    }
}
$deadline = (Get-Date).AddSeconds(35)
while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -LocalPort $hookPort -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "Hook HTTP 已监听：http://127.0.0.1:$hookPort"
        Write-Host '请在微信里登录目标账号，然后运行：node scripts/sender-adapter.mjs --check'
        exit 0
    }
    Start-Sleep -Milliseconds 250
}
Write-Warning "35s 内未见 Hook 端口监听，请查看 %LOCALAPPDATA%\Tencent\xwechat\log 与微信是否已完成登录。"
exit 1
