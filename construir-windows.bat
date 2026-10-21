@echo off
rem Genera el instalador de Windows (dist\LiteCut-Studio-Setup-*.exe) y la version portable.
setlocal
cd /d "%~dp0"
if exist "tools\node\node.exe" set "PATH=%~dp0tools\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala Node.js 22 o superior desde https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules" call npm install
call npm run dist:win
if errorlevel 1 (
  echo La compilacion fallo. Revisa los mensajes de arriba.
  pause
  exit /b 1
)
explorer dist
