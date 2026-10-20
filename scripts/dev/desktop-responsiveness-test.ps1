# desktop-responsiveness-test.ps1 —— 实测桌面版在「暂停/启动服务」「设置保存并重启」时的 UI 响应
#
# 通过 UI Automation 点击按钮，同时用 SendMessageTimeout(WM_NULL, 300ms) 采样主窗口消息循环：
# 超时/耗时即为 UI 线程被阻塞的证据。结果写入 state/logs/desktop-responsiveness.json。
param(
    [int]$MeasureSeconds = 12
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UiPerf {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    public static IntPtr FindButton(IntPtr root, string text) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(root, (h, l) => {
            StringBuilder cls = new StringBuilder(256); GetClassName(h, cls, 256);
            if (cls.ToString().Contains("BUTTON")) {
                StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256);
                if (sb.ToString() == text) { found = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string AllText(IntPtr root) {
        StringBuilder all = new StringBuilder();
        EnumChildWindows(root, (h, l) => {
            StringBuilder sb = new StringBuilder(1024); GetWindowText(h, sb, 1024);
            if (sb.Length > 0) { all.Append(sb.ToString()).Append(" | "); }
            return true;
        }, IntPtr.Zero);
        return all.ToString();
    }

    public static void Click(IntPtr button) { SendMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); }

    public static long Ping(IntPtr root, uint timeoutMs) {
        IntPtr result;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        IntPtr ok = SendMessageTimeout(root, 0x0000, IntPtr.Zero, IntPtr.Zero, 0x0002, timeoutMs, out result);
        sw.Stop();
        return ok == IntPtr.Zero ? -sw.ElapsedMilliseconds : sw.ElapsedMilliseconds;
    }
}
'@

function Get-App {
    $process = Get-Process WXBOT -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $process) {
        $process = Start-Process -FilePath (Join-Path $root 'WXBOT.exe') -PassThru
        Start-Sleep -Seconds 3
    }
    $process.Refresh()
    return $process
}

function Get-Root($process) {
    $process.Refresh()
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'WXBOT 主窗口未就绪' }
    return $process.MainWindowHandle
}

function Wait-Text([IntPtr]$handle, [string]$text, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $all = [UiPerf]::AllText($handle)
        if ($all.Contains($text)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Click-Button([IntPtr]$handle, [string]$text) {
    $button = [UiPerf]::FindButton($handle, $text)
    if ($button -eq [IntPtr]::Zero) { throw "找不到按钮：$text" }
    [UiPerf]::Click($button)
}

function Measure-Action([IntPtr]$handle, [string]$name, [scriptblock]$action, [int]$seconds) {
    $action.Invoke()
    $blocked = 0
    $samples = 0
    $max = 0
    $negative = 0
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $seconds) {
        $latency = [UiPerf]::Ping($handle, 300)
        if ($latency -lt 0) { $blocked += 1; $negative += 1 }
        else {
            $samples += 1
            if ($latency -gt $max) { $max = $latency }
        }
        Start-Sleep -Milliseconds 80
    }
    return [pscustomobject]@{
        Operation = $name
        Samples = $samples + $blocked
        Blocked = $blocked
        MaxLatencyMs = $max
        NegativeLatency = $negative
    }
}

$process = Get-App
$handle = Get-Root $process
Start-Sleep -Seconds 2
if (-not (Wait-Text $handle '服务运行中' 30)) { Write-Host '警告：服务未显示运行中，等待自动启动…' }
$results = @()

# 1) 暂停服务
$stop = Measure-Action $handle 'stop-service' { Click-Button $handle '停止服务' } $MeasureSeconds
$results += $stop
$stopped = Wait-Text $handle '启动服务' 90
Write-Host ("stop: blocked={0}/{1} max={2}ms  stopped={3}" -f $stop.Blocked, $stop.Samples, $stop.MaxLatencyMs, $stopped)

# 2) 启动服务
$start = Measure-Action $handle 'start-service' { Click-Button $handle '启动服务' } $MeasureSeconds
$results += $start
$started = Wait-Text $handle '停止服务' 90
Write-Host ("start: blocked={0}/{1} max={2}ms  started={3}" -f $start.Blocked, $start.Samples, $start.MaxLatencyMs, $started)

# 等待服务就绪
Start-Sleep -Seconds 3

# 3) 设置保存（默认勾选“保存后立即重启后台服务”）
$settings = Measure-Action $handle 'save-settings-restart' {
    Click-Button $handle '设置'
    Start-Sleep -Milliseconds 800
    Click-Button $handle '保存'
} $MeasureSeconds
$results += $settings
$settingsClosed = Wait-Text $handle '停止服务' 90
Write-Host ("settings: blocked={0}/{1} max={2}ms  mainVisible={3}" -f $settings.Blocked, $settings.Samples, $settings.MaxLatencyMs, $settingsClosed)

Start-Sleep -Seconds 2

$logDir = Join-Path $root 'state\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$json = $results | ConvertTo-Json -Depth 4
$json | Set-Content -LiteralPath (Join-Path $logDir 'desktop-responsiveness.json') -Encoding UTF8
Write-Host ''
Write-Host '== 结果 =='
$results | Format-Table -AutoSize
Write-Host ("日志：{0}" -f (Join-Path $logDir 'desktop-responsiveness.json'))
