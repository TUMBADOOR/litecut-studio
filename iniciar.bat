@echo off
rem Abre LiteCut Studio en modo desarrollo (sin instalar).
setlocal
cd /d "%~dp0"
if exist "tools\node\node.exe" set "PATH=%~dp0tools\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala Node.js 22 o superior desde https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Instalando dependencias, espera unos minutos...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
