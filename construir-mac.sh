#!/bin/bash
# Genera la versión para macOS (dist/*.dmg y dist/*.zip). Debe ejecutarse en una Mac.
# Uso: bash construir-mac.sh            (arquitectura de esta Mac)
#      bash construir-mac.sh x64        (para Mac con procesador Intel)
#      bash construir-mac.sh arm64      (para Mac con chip Apple M1/M2/M3/M4)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instálalo (versión 22 o superior) desde https://nodejs.org"
  exit 1
fi
ARCH="${1:-$(uname -m | sed 's/x86_64/x64/')}"
# FFmpeg y Electron se descargan para la arquitectura elegida.
export npm_config_arch="$ARCH"
rm -rf node_modules/ffmpeg-static
npm install || exit 1
npm run dist:mac -- --"$ARCH" || exit 1
open dist
