# 并行分段下载 4.1.10.27 安装包（仅用于恢复固定版客户端）
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$url = 'https://gh-proxy.com/https://github.com/cscnk52/wechat-windows-versions/releases/download/v4.1.10.27/weixin_4.1.10.27.exe'
$out = Join-Path (Get-Location).Path 'state\backups\weixin_4.1.10.27.exe'
$expected = '54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74'
$size = 239441904
$parts = 16
$chunk = [math]::Ceiling($size / $parts)
$root = (Get-Location).Path
$dir = Join-Path $root 'state\backups\parts'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'state\backups') | Out-Null
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$jobs = @()
for ($i = 0; $i -lt $parts; $i++) {
    $start = $i * $chunk
    $end = [math]::Min($size - 1, $start + $chunk - 1)
    if ($start -gt $end) { continue }
    $target = Join-Path $dir ("part{0:D2}" -f $i)
    Write-Output "part $i target=$target"
    $jobs += Start-Job -ScriptBlock {
        param($u, $s, $e, $o)
        & curl.exe -L --retry 5 --retry-delay 2 --max-time 1800 -r "$s-$e" -o $o $u 2>$null
        if (-not (Test-Path -LiteralPath $o)) { throw "missing part $o" }
        $expectedLen = $e - $s + 1
        $actual = (Get-Item -LiteralPath $o).Length
        if ($actual -ne $expectedLen) { throw "part size mismatch $o expected=$expectedLen actual=$actual" }
        Write-Output "ok $o $actual"
    } -ArgumentList $url, $start, $end, $target
}
Write-Host "started $($jobs.Count) parallel parts"
$jobs | Wait-Job | Out-Null
$bad = @($jobs | Where-Object { $_.State -ne 'Completed' })
if ($bad.Count -gt 0) {
    $bad | ForEach-Object { Receive-Job $_ }
    throw "parallel download failed: $($bad.Count) parts"
}
$jobs | Receive-Job | Select-Object -Last 4

# 合并
$fs = [System.IO.File]::Create((Join-Path (Get-Location) $out))
try {
    for ($i = 0; $i -lt $parts; $i++) {
        $part = Join-Path $dir ("part{0:D2}" -f $i)
        if (-not (Test-Path $part)) { continue }
        $bytes = [System.IO.File]::ReadAllBytes($part)
        $fs.Write($bytes, 0, $bytes.Length)
    }
} finally {
    $fs.Dispose()
}
Remove-Item $dir -Recurse -Force

$hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "sha256=$hash size=$((Get-Item $out).Length)"
if ($hash -ne $expected) { throw 'SHA256 mismatch' }
Write-Host 'DOWNLOAD_OK'
