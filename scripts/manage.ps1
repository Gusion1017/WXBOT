# manage.ps1 —— 进程编排（M7：supervisor 统一管理 + 崩溃自愈；不含开机自启）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 status
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 stop
#
# 约定：
#   - start 只启动一个 supervisor 进程（node scripts/supervisor.mjs），由它按序拉起
#     reader → bridge → adapter → console，并负责健康检查与崩溃重启
#   - runtime.json 记录 supervisor pid；stop 用 taskkill /T 杀整棵进程树
#   - 只管理自己启动的进程（未知进程不杀）

param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'start', 'stop', 'restart', 'health')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $root 'state\runtime.json'
$supervisorStatePath = Join-Path $root 'state\supervisor.json'
$runtimeNode = Join-Path $root 'runtime\node\node.exe'
$node = if (Test-Path -LiteralPath $runtimeNode) { $runtimeNode } else { (Get-Command node -ErrorAction Stop).Source }
$configCli = Join-Path $root 'scripts\project-config.mjs'
$supervisorScript = Join-Path $root 'scripts\supervisor.mjs'

function Read-Runtime {
    if (-not (Test-Path $runtimePath)) { return $null }
    try { return Get-Content $runtimePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-Runtime($runtime) {
    $dir = Split-Path -Parent $runtimePath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$runtimePath.$PID.tmp"
    ($runtime | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Force $tmp $runtimePath
}

function Read-SupervisorState {
    if (-not (Test-Path $supervisorStatePath)) { return $null }
    try { return Get-Content $supervisorStatePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-RecordAlive($record) {
    if (-not $record -or -not $record.pid) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)" -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    if ($record.script -and $proc.CommandLine -and ($proc.CommandLine -notlike "*$($record.script)*")) { return $false }
    return $true
}

function Wait-Port([int]$port, [int]$timeoutMs = 10000) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
            if ($async.AsyncWaitHandle.WaitOne(300)) {
                $client.EndConnect($async)
                $client.Close()
                return $true
            }
            $client.Close()
        } catch {
            # 继续等
        }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Start-Detached([string]$exe, [string]$script, [string]$stdoutPath, [string]$stderrPath) {
    # cmd 负责重定向；Win32_Process.Create 让进程脱离当前调用方的 Job Object。
    $cmdLine = 'cmd.exe /d /s /c ""' + $exe + '" "' + $script + '" >> "' + $stdoutPath + '" 2>> "' + $stderrPath + '" < NUL"'
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = $cmdLine
        CurrentDirectory = $root
    }
    if ($result.ReturnValue -ne 0) {
        throw "Win32_Process.Create failed: $($result.ReturnValue)"
    }
    return [int]$result.ProcessId
}

function Show-Supervisor {
    $supervisor = Read-SupervisorState
    if (-not $supervisor) {
        Write-Host '  supervisor：无状态文件（尚未 start 或正在启动）'
        return
    }
    $alive = $false
    if ($supervisor.supervisorPid) {
        $alive = [bool](Get-Process -Id ([int]$supervisor.supervisorPid) -ErrorAction SilentlyContinue)
    }
    if (-not $alive) {
        Write-Host ("  supervisor：已停止（上次 pid={0}，状态文件为历史记录）" -f $supervisor.supervisorPid)
        return
    }
    Write-Host ("  supervisor：pid={0}  启动于 {1}" -f $supervisor.supervisorPid, ([datetimeoffset]::FromUnixTimeMilliseconds([long]$supervisor.startedAt)).LocalDateTime.ToString('HH:mm:ss'))
    foreach ($property in $supervisor.services.PSObject.Properties) {
        $service = $property.Value
        $fails = if ($service.consecutiveFailures) { " fails=$($service.consecutiveFailures)" } else { '' }
        Write-Host ("    {0,-8} {1,-9} pid={2,-8} restarts={3}{4} {5}" -f $service.name, $service.status, $service.pid, $service.restarts, $fails, $service.lastError)
    }
}

function Invoke-Status {
    & $node $configCli status
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $runtime = Read-Runtime
    if ($runtime -and $runtime.processes -and @($runtime.processes).Count -gt 0) {
        foreach ($record in @($runtime.processes)) {
            $alive = Test-RecordAlive $record
            Write-Host ("  受管入口：{0} pid={1} {2}" -f $record.name, $record.pid, ($(if ($alive) { 'alive' } else { 'dead' })))
        }
    } else {
        Write-Host '  受管入口：无（尚未 start）'
    }
    Show-Supervisor
}

function Invoke-Start {
    & $node $configCli init
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $configPath = Join-Path $root 'config\app.json'
    $configJson = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ports = $configJson.ports
    $runtime = Read-Runtime
    if (-not $runtime) { $runtime = [pscustomobject]@{ started = (Get-Date).ToString('o'); processes = @() } }
    $existing = @($runtime.processes) | Where-Object { $_.name -eq 'supervisor' } | Select-Object -First 1
    if (Test-RecordAlive $existing) {
        Write-Host "  supervisor 已在运行（pid=$($existing.pid)），执行健康检查"
    } else {
        if (-not (Test-Path $supervisorScript)) { throw "缺少 supervisor 脚本：$supervisorScript" }
        $logDir = Join-Path $root 'state\logs'
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        $stdout = Join-Path $logDir 'supervisor.stdout.log'
        $stderr = Join-Path $logDir 'supervisor.stderr.log'
        $pidValue = Start-Detached $node $supervisorScript $stdout $stderr
        $runtime.processes = @([pscustomobject]@{
            name = 'supervisor'; pid = $pidValue; exe = $node; script = $supervisorScript;
            marker = 'wxbot-managed:supervisor'; started = (Get-Date).ToString('o')
        })
        Write-Runtime $runtime
        Write-Host "  已启动 supervisor pid=$pidValue"
    }
    foreach ($portName in @('reader', 'onebot', 'adapter', 'console')) {
        $ready = Wait-Port ([int]$ports.$portName) 45000
        if (-not $ready) { Write-Host "  警告：$portName 端口 45s 内未监听（supervisor 会继续重试，查看 state/logs/*.stderr.log）" }
    }
    Start-Sleep -Milliseconds 500
    Invoke-Status
}

function Invoke-Stop {
    $runtime = Read-Runtime
    if (-not $runtime -or -not $runtime.processes -or @($runtime.processes).Count -eq 0) {
        Write-Host '没有受管进程需要停止'
        return
    }
    foreach ($record in @($runtime.processes)) {
        if (Test-RecordAlive $record) {
            Write-Host ("  停止 {0} (pid={1}) 及其进程树" -f $record.name, $record.pid)
            & taskkill.exe /PID ([int]$record.pid) /T /F 2>&1 | Out-Null
        } else {
            Write-Host ("  {0} 已不在运行" -f $record.name)
        }
    }
    if (Test-Path $runtimePath) { Remove-Item -Force $runtimePath }
    Start-Sleep -Milliseconds 800
    # 兜底：清理本项目遗留的服务进程。
    # 必须排除当前进程及其祖先链，且只匹配本项目根目录下的脚本路径，
    # 只匹配本项目根目录路径，避免误杀其它项目副本/调用方。
    $ancestors = @{}
    $current = $PID
    while ($current -and -not $ancestors.ContainsKey($current)) {
        $ancestors[$current] = $true
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        $current = [int]$proc.ParentProcessId
    }
    $rootPattern = [regex]::Escape($root) + '\\scripts\\(reader-api\.py|bridge\.mjs|adapter\.mjs|console-server\.mjs|supervisor\.mjs)'
    $leftovers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessId -and -not $ancestors.ContainsKey([int]$_.ProcessId) -and
            $_.Name -match '^(node|python|cmd)\.exe$' -and
            $_.CommandLine -and
            ($_.CommandLine -match $rootPattern) -and
            ($_.CommandLine -notmatch 'manage\.ps1|dsh-subprocess|runner\.js|npm-cli')
        })
    foreach ($leftover in $leftovers) {
        Write-Host ("  清理残留 {0} pid={1}" -f $leftover.Name, $leftover.ProcessId)
        & taskkill.exe /PID $leftover.ProcessId /T /F 2>&1 | Out-Null
    }
    Write-Host '已停止本项目启动的全部受管进程'
}

switch ($Action) {
    'status' { Invoke-Status }
    'health' { Invoke-Status }
    'start' { Invoke-Start }
    'stop' { Invoke-Stop }
    'restart' { Invoke-Stop; Invoke-Start }
}
