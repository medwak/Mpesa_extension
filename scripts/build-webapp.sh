#!/bin/sh
# Builds dist/mpesa-ledger-phone-app/ (and a zip of it): only the files the
# installable phone app needs, with index.html at the top of the folder.
# Upload that folder to Netlify Drop or any static https host.
set -e
cd "$(dirname "$0")/.."
OUT=dist/mpesa-ledger-phone-app
rm -rf dist
mkdir -p "$OUT/src/ui" "$OUT/icons"
cp index.html manifest.webmanifest sw.js _headers "$OUT/"
cp icons/icon192.png icons/icon512.png icons/maskable512.png "$OUT/icons/"
cp -r src/lib "$OUT/src/lib"
cp src/ui/dashboard.html src/ui/dashboard.css src/ui/dashboard.js src/ui/theme.css "$OUT/src/ui/"
mkdir -p "$OUT/vendor"
cp -r vendor/pdfjs "$OUT/vendor/pdfjs"
(cd dist && zip -qr mpesa-ledger-phone-app.zip mpesa-ledger-phone-app)
echo "Built $OUT and dist/mpesa-ledger-phone-app.zip"
