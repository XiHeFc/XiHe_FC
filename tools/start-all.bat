@echo off
chcp 65001 >nul
set "TOOLS=%~dp0"
set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "INSTALLED=%LOCALAPPDATA%\Programs\XiHe GCS PRO\XiHe GCS PRO.exe"
set "PACKED=%ROOT%\dist\win-unpacked\XiHe GCS PRO.exe"
set "DEV=%ROOT%\node_modules\electron\dist\electron.exe"

if exist "%INSTALLED%" (
  echo Starting installed XiHe GCS PRO ...
  start "" "%INSTALLED%"
  exit /b 0
)
if exist "%PACKED%" (
  echo Starting XiHe GCS PRO from dist ...
  start "" "%PACKED%"
  exit /b 0
)
if exist "%DEV%" (
  echo Starting XiHe GCS PRO in Electron dev mode ...
  start "" "%DEV%" "%ROOT%"
  exit /b 0
)

if not exist "%ROOT%\index.html" (
  echo ERROR: index.html not found in "%ROOT%"
  pause
  exit /b 1
)
echo Desktop build not found, falling back to the browser launcher.
powershell -NoProfile -ExecutionPolicy Bypass -File "%TOOLS%start.ps1"
if errorlevel 1 pause
