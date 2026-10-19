@echo off
rem Claude Console in the foreground (logs to this console). The Desktop shortcut uses launch.vbs instead.
rem Node comes from PATH, else the standard Node.js install location.
cd /d "%~dp0"
set "CC_NODE="
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined CC_NODE set "CC_NODE=%%i"
if not defined CC_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "CC_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined CC_NODE (
  echo Node.js was not found. Install the LTS from https://nodejs.org or run install.ps1, then try again.
  exit /b 1
)
"%CC_NODE%" "%~dp0server\server.js" --open
