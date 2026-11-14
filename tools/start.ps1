param(
    [switch]$NoBrowser,
    [switch]$SkipTts,
    [switch]$UseBrowser
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$tools = $PSScriptRoot
$root = Split-Path -Parent $tools
$logDir = Join-Path $root 'logs'
$webPort = 8123
$bridgePort = 8787
$webUrl = "http://127.0.0.1:$webPort/index.html?v=20261113A"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Wait-Port {
    param([int]$Port, [int]$Seconds = 30)
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Start-Hidden {
    param([string]$File, [string[]]$Arguments, [string]$WorkDir, [string]$Out, [string]$Err)
    return Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkDir `
        -WindowStyle Hidden -RedirectStandardOutput $Out -RedirectStandardError $Err -PassThru
}

function Start-AppWindow {
    param([string]$Url)
    $candidates = @(
        "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    $edge = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($edge) {
        Start-Process -FilePath $edge -ArgumentList @("--app=$Url", '--window-size=1600,1000')
    } else {
        Start-Process $Url
    }
}

function Start-TtsBackground {
    if ($SkipTts) {
        Write-Host 'TTS skipped (background).'
        return $null
    }
    $pwsh = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
    if (-not $pwsh) { $pwsh = 'powershell.exe' }
    $out = Join-Path $logDir 'sovits.out.log'
    $err = Join-Path $logDir 'sovits.err.log'
    $proc = Start-Process -FilePath $pwsh `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'start-sovits.ps1')) `
        -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Write-Host "TTS background starting (pid $($proc.Id)) ..."
    return $proc
}

Write-Host 'Starting XiHe GCS PRO local services ...'
$ttsProc = Start-TtsBackground

if (-not (Get-NetTCPConnection -LocalPort $webPort -State Listen -ErrorAction SilentlyContinue)) {
    $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if (-not $py) { $py = 'python' }
    $proc = Start-Hidden -File $py -Arguments @('tools/serve.py', "$webPort") `
        -WorkDir $root -Out (Join-Path $logDir 'web.out.log') -Err (Join-Path $logDir 'web.err.log')
    Write-Host "Web server starting (pid $($proc.Id)) ..."
    if (-not (Wait-Port -Port $webPort)) {
        Write-Host 'ERROR: web server did not start.'
        exit 1
    }
    Write-Host "Web server ready: $webUrl"
} else {
    Write-Host "Web server already running: $webUrl"
}

if (-not (Get-NetTCPConnection -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue)) {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = 'node' }
    $proc = Start-Hidden -File $node -Arguments @('mcp-server/bridge.mjs') `
        -WorkDir $root -Out (Join-Path $logDir 'bridge.out.log') -Err (Join-Path $logDir 'bridge.err.log')
    Write-Host "MCP bridge starting (pid $($proc.Id)) ..."
} else {
    Write-Host "MCP bridge already running: http://127.0.0.1:$bridgePort"
}

if (-not $NoBrowser) {
    if ($UseBrowser) {
        Start-Process $webUrl
    } else {
        Start-AppWindow -Url $webUrl
    }
}

if (-not (Wait-Port -Port $bridgePort -Seconds 3)) {
    Write-Host 'MCP bridge is still starting; the UI can open now and will reconnect when ready.'
} else {
    Write-Host "MCP bridge ready: http://127.0.0.1:$bridgePort"
}

if ($ttsProc) {
    Write-Host "TTS is loading in the background (pid $($ttsProc.Id)); log: $logDir\sovits.out.log"
}

Write-Host ''
Write-Host 'XiHe GCS PRO is ready.'
Write-Host "  UI     $webUrl"
Write-Host '  MCP    http://127.0.0.1:8787'
Write-Host "  Logs   $logDir"
