#!/usr/bin/env bash
# Every Stage check that needs no person. Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
[ -d node_modules ] || npm ci --silent >logs/npm.log 2>&1

node tools/check.mjs

# Well-formed XML for every cursor (xmllint ships with macOS).
if command -v xmllint >/dev/null; then
  for f in cursor/*/cursor.xml cursor/*/*.svg; do xmllint --noout "$f"; done
  echo "ok   cursor XML well-formed"
fi

# Copies the final app looks for (app/plugins/with-bobby-art.js, app/app.config.js) must match their sources.
chosen=$(tr -d '[:space:]' < cursor/CHOSEN)
cmp -s "cursor/$chosen/cursor.xml" "cursor/cursor_$chosen.xml" || { echo "FAIL cursor/cursor_$chosen.xml differs from cursor/$chosen/cursor.xml: cp cursor/$chosen/cursor.xml cursor/cursor_$chosen.xml"; exit 1; }
cmp -s icon/bobby-icon-1024.png icon/icon.png || { echo "FAIL icon/icon.png differs from icon/bobby-icon-1024.png: cp icon/bobby-icon-1024.png icon/icon.png"; exit 1; }
echo "ok   app copies match (cursor_$chosen.xml, icon.png)"

# Replay plays the whole story once at high speed and exits cleanly.
PORT=${STAGE_CHECK_PORT:-8799}
node dashboard/replay.mjs --once --speed 1000 --port "$PORT" >logs/check-replay.log 2>&1
echo "ok   replay.mjs plays story.jsonl through"

echo "all Stage checks passed"
