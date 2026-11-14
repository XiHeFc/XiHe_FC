@echo off
rem Xuanji MCP entry (shipped next to Xuanji.exe).
rem Usage from MCP clients: cmd.exe /c "<install dir>\xuanji-mcp.cmd"
rem No args -> stdio MCP; --doctor / --version are forwarded to launcher.mjs.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Xuanji.exe" "%~dp0resources\app.asar\mcp-server\launcher.mjs" %*
exit /b %errorlevel%
