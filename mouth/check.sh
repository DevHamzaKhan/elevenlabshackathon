#!/usr/bin/env bash
# Every Mouth check that needs no person. Long output goes to logs/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

echo "== npm test"
npm test > logs/check-test.log 2>&1 || { tail -40 logs/check-test.log; exit 1; }
grep -E "^ℹ (pass|fail)" logs/check-test.log

echo "== type check (package + test app)"
(cd example && npx tsc --noEmit -p .) > logs/check-tsc.log 2>&1 || { cat logs/check-tsc.log; exit 1; }
echo "ok"

echo "== setup.mjs dry run"
node agent/setup.mjs --dry-run > logs/check-setup.log 2>&1 || { cat logs/check-setup.log; exit 1; }
echo "ok"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "== test app build (assembleDebug)"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  (cd example && { [[ -d android ]] || CI=1 npx expo prebuild --platform android --no-install; } && cd android && ./gradlew -q assembleDebug) \
    > logs/check-build.log 2>&1 || { grep -E "error|What went wrong" logs/check-build.log | head -20; exit 1; }
  echo "ok"
fi
echo "== all Mouth checks passed"
