# Start GPT-SoVITS api_v2 (9880) and the XiHe management proxy (8770).
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = 'D:\GPT-SoVITS-src'
$python = Join-Path $root '.venv\Scripts\python.exe'
$engineDir = Join-Path $root 'engine'
$enginePort = 9880
$apiPort = 8770
$voiceDir = Join-Path $root 'voices'
$logDir = Join-Path $root 'logs'
$ffmpeg = 'C:\Users\ZhuanZ.DESKTOP-PH97BKO\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build-shared\bin'
$nltkData = 'D:\GPT-SoVITS-v2pro-20250604\runtime\nltk_data'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if (-not (Test-Path $python)) { Write-Host "Python not found: $python"; exit 1 }
if (Test-Path $ffmpeg) { $env:PATH = $ffmpeg + ';' + $env:PATH }
if (Test-Path $nltkData) { $env:NLTK_DATA = $nltkData }
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:no_proxy = 'localhost,127.0.0.1'
$env:PYTHONUTF8 = '1'

function Wait-Port {
    param([int]$Port, [int]$Seconds = 180)
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Start-HiddenPython {
    param([string[]]$Arguments, [string]$WorkDir, [string]$Out, [string]$Err)
    return Start-Process -FilePath $python -ArgumentList $Arguments -WorkingDirectory $WorkDir `
        -WindowStyle Hidden -RedirectStandardOutput $Out -RedirectStandardError $Err -PassThru
}

Write-Host 'Checking GPT-SoVITS api_v2 ...'
if (-not (Get-NetTCPConnection -LocalPort $enginePort -State Listen -ErrorAction SilentlyContinue)) {
    $out = Join-Path $logDir 'api-v2.out.log'
    $err = Join-Path $logDir 'api-v2.err.log'
    $proc = Start-HiddenPython -Arguments @('api_v2.py', '-a', '127.0.0.1', '-p', "$enginePort") `
        -WorkDir $engineDir -Out $out -Err $err
    Write-Host "api_v2 starting (pid $($proc.Id), first load may take 1-3 minutes) ..."
    if (-not (Wait-Port -Port $enginePort -Seconds 240)) {
        Write-Host 'ERROR: api_v2 did not start. Recent stderr:'
        if (Test-Path $err) { Get-Content $err -Tail 120 }
        exit 1
    }
    Write-Host "api_v2 ready: http://127.0.0.1:$enginePort"
} else {
    Write-Host "api_v2 already running: http://127.0.0.1:$enginePort"
}

Write-Host 'Checking XiHe TTS management proxy ...'
if (-not (Get-NetTCPConnection -LocalPort $apiPort -State Listen -ErrorAction SilentlyContinue)) {
    $out = Join-Path $logDir 'manager.out.log'
    $err = Join-Path $logDir 'manager.err.log'
    $proc = Start-HiddenPython -Arguments @('-m', 'app', "$apiPort") -WorkDir $root -Out $out -Err $err
    Write-Host "TTS management proxy starting (pid $($proc.Id)) ..."
    if (-not (Wait-Port -Port $apiPort -Seconds 30)) {
        Write-Host 'ERROR: TTS management proxy did not start. Recent stderr:'
        if (Test-Path $err) { Get-Content $err -Tail 120 }
        exit 1
    }
    Write-Host "TTS management proxy ready: http://127.0.0.1:$apiPort"
} else {
    Write-Host "TTS management proxy already running: http://127.0.0.1:$apiPort"
}

Write-Host ''
Write-Host 'AI panel TTS settings:'
Write-Host '  Voice     default (auto-select local voice)'
Write-Host "  Endpoint  http://127.0.0.1:$apiPort"
Write-Host '  API Key   leave empty (local proxy allows anonymous access by default)'
$voices = Get-ChildItem -LiteralPath $voiceDir -Directory -ErrorAction SilentlyContinue
if ($voices) { Write-Host ("  Available voices: " + (($voices.Name) -join ', ')) }
else { Write-Host '  Available voices: none, run tools\setup-sovits-voice.ps1 first' }
