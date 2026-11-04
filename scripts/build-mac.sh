#!/bin/bash
# Builds FolderBridge on a Mac and installs it into /Applications.
# Run from Terminal inside the project folder:   bash scripts/build-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org (LTS), then run this again."
  exit 1
fi

echo "› Installing dependencies…"
npm install --no-audit --no-fund
# Some npm versions skip Electron's download step; make sure the binary is there.
[ -d node_modules/electron/dist ] || node node_modules/electron/install.js

ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] && ARCH=x64

echo "› Building the app ($ARCH)…"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir "--$ARCH" --publish never

APP=$(find dist -maxdepth 2 -name 'FolderBridge.app' -type d | head -n 1)
if [ -z "$APP" ]; then
  echo "The build didn't produce FolderBridge.app - see the errors above."
  exit 1
fi

echo "› Installing into /Applications…"
osascript -e 'quit app "FolderBridge"' >/dev/null 2>&1 || true
rm -rf /Applications/FolderBridge.app
cp -R "$APP" /Applications/
xattr -cr /Applications/FolderBridge.app
# Apple Silicon only runs signed apps; a local ad-hoc signature is enough.
codesign --verify --deep /Applications/FolderBridge.app >/dev/null 2>&1 ||
  codesign --force --deep --sign - /Applications/FolderBridge.app

open /Applications/FolderBridge.app
echo "✓ FolderBridge is installed and running - it's in the menu bar."
