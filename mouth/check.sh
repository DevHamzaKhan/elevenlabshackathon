#!/usr/bin/env bash
# Every Mouth check that needs no person. Long output goes to logs/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

echo "== npm test"
npm test > logs/check-test.log 2>&1 || { tail -40 logs/check-test.log; exit 1; }
grep -E "^(ℹ|#) (pass|fail) " logs/check-test.log

echo "== type check (package + test app)"
[[ -d example/node_modules ]] || (cd example && npm ci) > logs/check-example-npm.log 2>&1 || { tail -20 logs/check-example-npm.log; exit 1; }
(cd example && npx tsc --noEmit -p .) > logs/check-tsc.log 2>&1 || { cat logs/check-tsc.log; exit 1; }
echo "ok"

echo "== dry-run call through tools/caller.mjs (pretend hub; no call is placed)"
PORT="${MOUTH_CHECK_PORT:-8797}"
node fakes/hub.mjs --port "$PORT" --script tools/dry-call.script > logs/check-call-hub.log 2>&1 &
HUB=$!
sleep 0.5
CALLER_DRY_RUN=1 CALL_ALLOWLIST=+15555550100 node tools/caller.mjs --dry-run --hub "ws://localhost:$PORT" > logs/check-call-caller.log 2>&1 &
CALLER=$!
HUB_OK=0; wait "$HUB" || HUB_OK=$?
kill "$CALLER" 2>/dev/null || true
if [[ $HUB_OK != 0 ]] || ! grep -q '"type":"call_result","re":"m1","ok":true' logs/check-call-hub.log; then
  tail -20 logs/check-call-hub.log; tail -20 logs/check-call-caller.log; exit 1
fi
grep -o '"status":"[a-z]*"' logs/check-call-hub.log | tr '\n' ' '; echo "call_result ok"

echo "== voice bench plumbing (dry run, local fake server)"
node tools/voice-bench.mjs --dry-run --runs 1 > logs/check-bench.log 2>&1 || { tail -20 logs/check-bench.log; exit 1; }
echo "ok"

echo "== integration with the real Mind (v2 voice, fake hub/phone/OpenAI)"
if [[ -d ../mind/node_modules ]]; then
  (cd ../mind && npx tsx ../mouth/tools/integration-with-mind.mts) > logs/check-integration.log 2>&1 || { tail -30 logs/check-integration.log; exit 1; }
  tail -1 logs/check-integration.log
else
  echo "skipped (run npm ci in ../mind)"
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "== test app build (assembleDebug)"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  (cd example && { [[ -d android ]] || CI=1 npx expo prebuild --platform android --no-install; } && cd android && ./gradlew -q assembleDebug) \
    > logs/check-build.log 2>&1 || { grep -E "error|What went wrong" logs/check-build.log | head -20; exit 1; }
  echo "ok"
fi
echo "== all Mouth checks passed"
