# 从 GPT-SoVITS v2pro 语音包创建本地 TTS 音色，供管理代理自动发现。
$ErrorActionPreference = 'Stop'
$engineRoot = 'D:\GPT-SoVITS-src'
$voiceRoot = Join-Path $engineRoot 'voices'
$sourceRoot = 'D:\GPT-SoVITS-v2pro-20250604'
$ref = Join-Path $sourceRoot '语音包\安比\v4\安比\reference_audios\中文\emotions\【默认】虽然的确有小孩子误入空洞的情况，但猫鼬你指的方向似乎刚好与我们原先前进的路线重合。.wav'
if (-not (Test-Path -LiteralPath $ref)) { throw "未找到安比参考音频：$ref" }
$dir = Join-Path $voiceRoot '安比'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -LiteralPath $ref -Destination (Join-Path $dir 'ref.wav') -Force
Set-Content -LiteralPath (Join-Path $dir 'ref.txt') -Encoding UTF8 -Value '虽然的确有小孩子误入空洞的情况，但猫鼬你指的方向似乎刚好与我们原先前进的路线重合。'
Set-Content -LiteralPath (Join-Path $dir 'ref.lang') -Encoding UTF8 -Value 'zh'
$weights = @{
  gpt = 'D:/GPT-SoVITS-v2pro-20250604/GPT_weights/anbi-e10.ckpt'
  sovits = 'D:/GPT-SoVITS-v2pro-20250604/SoVITS_weights/anbii_e10_s710_l32.pth'
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $dir 'weights.json') -Encoding UTF8 -Value $weights
Write-Host '音色已创建：安比'
Write-Host $dir
