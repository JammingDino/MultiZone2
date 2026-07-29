#!/usr/bin/env bash
# Renders the promo pages to PNGs with headless Chrome, then publishes them
# to promo/. Everything in this directory except the sources is generated.
set -e
cd "$(dirname "$0")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"

# Stage the assets the pages reference (generated -- see .gitignore).
cp "../Screenshot 2026-07-29 184437.png" shot-dark.png
cp "../Screenshot 2026-07-29 184455.png" shot-light.png
cp ../source.png icon.png

shot () { # name width height
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 \
    --window-size="$2,$3" \
    --screenshot="$(pwd -W)/$1.png" \
    --virtual-time-budget=4000 \
    "file:///$(pwd -W)/$1.html" >/dev/null 2>&1
  cp "$1.png" "../$1.png"
  echo "rendered $1.png"
}

shot 01-hero            1600 900
shot 02-perspectives    1600 900
shot 04-features        1600 900
shot 05-response-leader 1600 764
