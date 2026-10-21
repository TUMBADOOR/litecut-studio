#!/bin/bash
# Abre LiteCut Studio en modo desarrollo en macOS. Uso: bash iniciar-mac.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instálalo (versión 22 o superior) desde https://nodejs.org"
  exit 1
fi
[ -d node_modules ] || npm install || exit 1
npm start
