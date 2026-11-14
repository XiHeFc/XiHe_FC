@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install from https://nodejs.org/
  echo Or download the installer: https://github.com/XiHeFc/XiHe_FC/releases
  pause
  exit /b 1
)
node.exe "%~dp0start-source.cjs" %*
if errorlevel 1 (
  echo Startup failed. See the error above.
  pause
  exit /b 1
)
