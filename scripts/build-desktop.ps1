# build-desktop.ps1 —— 编译桌面版 WXBOT.exe（WinForms，单 exe，不使用浏览器）
#
# 产物默认：<项目根>\WXBOT.exe（可指定 -Output）
# 依赖：Windows PowerShell 5.1 自带 .NET Framework csc（无需 SDK / NuGet / WebView2）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -Output dist\WXBOT.exe

param(
    [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sources = @(
    (Join-Path $root 'scripts\desktop\WXBOTControls.cs'),
    (Join-Path $root 'scripts\desktop\WXBOTMascotData.cs'),
    (Join-Path $root 'scripts\desktop\WXBOTDesktop.cs'),
    (Join-Path $root 'scripts\desktop\WXBOTSettingsPanel.cs'),
    (Join-Path $root 'scripts\desktop\WXBOTStickerPanel.cs'),
    (Join-Path $root 'scripts\desktop\WXBOTStickerGeneralPanel.cs')
)
foreach ($source in $sources) {
    if (-not (Test-Path -LiteralPath $source)) { throw "缺少桌面版源码：$source" }
}
if (-not $Output) { $Output = Join-Path $root 'WXBOT.exe' }
$Output = [System.IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) { throw '找不到 .NET Framework csc.exe（需要 Windows 自带 .NET 4.x）' }

$references = @(
    'System.dll', 'System.Core.dll', 'System.Windows.Forms.dll',
    'System.Drawing.dll', 'System.Web.Extensions.dll'
)
$arguments = @('/nologo', '/target:exe', '/codepage:65001', ('/out:' + $Output))
foreach ($reference in $references) { $arguments += ('/r:' + $reference) }
$arguments += $sources

& $csc @arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw "编译失败（exit=$LASTEXITCODE）：$Output" }

$item = Get-Item -LiteralPath $Output
Write-Host ("已生成桌面版：{0}  ({1:N1} KB)" -f $item.FullName, ($item.Length / 1KB))

