#!/bin/bash
# Installs Shot Exporter for Premiere Pro on macOS (unsigned, so CEP debug mode is turned on).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.trafarsh.shotexporter"

for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/CSXS" "$SRC/css" "$SRC/js" "$SRC/jsx" "$SRC/index.html" "$DEST/"
echo "Installed to: $DEST"
echo "Restart Premiere Pro, then open Window > Extensions > Shot Exporter."
