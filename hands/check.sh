#!/usr/bin/env bash
# hands/check.sh: everything that proves Bobby Hands works.
#
#   hands/check.sh              # hub test (fake), unit tests, build, then on the phone: install,
#                               # grant, smoke drive (reads home screen, points, taps nothing), hub test
#   hands/check.sh --no-phone   # stop after the build
#
# Exit 0 only when every step passed. Build output goes to logs/hands-check-build.log.
set -uo pipefail

HANDS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HANDS/.." && pwd)"
TOOLS="$HANDS/tools"
EX="$HANDS/example"
APP_ID="dev.bobby.hands"
LOGS="$ROOT/logs"
BUILD_LOG="$LOGS/hands-check-build.log"
METRO_LOG="$LOGS/hands-check-metro.log"
mkdir -p "$LOGS"

PHONE=1
for a in "$@"; do
  case "$a" in
    --no-phone) PHONE=0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
# The test app always uses token "dev"; don't let a root .env HUB_TOKEN (the final app's) leak in.
export HUB_TOKEN=dev

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

METRO_PID=""
cleanup() { [[ -n "$METRO_PID" ]] && kill "$METRO_PID" 2>/dev/null; }
trap cleanup EXIT

# ---------------------------------------------------------------- laptop
step "hub routing test against fakehub"
if [[ ! -d "$TOOLS/node_modules" ]]; then (cd "$TOOLS" && npm install --silent) || fail "npm install in tools/"; fi
node "$TOOLS/hub-test.mjs" --fake >"$LOGS/hands-check-hubtest-fake.log" 2>&1 \
  || { tail -30 "$LOGS/hands-check-hubtest-fake.log"; fail "hub-test.mjs --fake"; }
grep -E '^(#|ℹ) (pass|fail)' "$LOGS/hands-check-hubtest-fake.log" | tr '\n' ' '; echo

step "example app: install and prebuild"
cd "$EX" || fail "no $EX"
if [[ ! -d node_modules ]]; then npm install --silent >>"$BUILD_LOG" 2>&1 || fail "npm install in example/ (see $BUILD_LOG)"; fi
if [[ ! -d android ]]; then npx expo prebuild --platform android --no-install >>"$BUILD_LOG" 2>&1 || fail "expo prebuild (see $BUILD_LOG)"; fi
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
echo "ok"

step "unit tests + assembleDebug (log: logs/hands-check-build.log)"
if ! (cd android && ./gradlew :bobby-hands:testDebugUnitTest assembleDebug >"$BUILD_LOG" 2>&1); then
  tail -40 "$BUILD_LOG"
  fail "gradle"
fi
APK="$EX/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$APK" ]] || fail "no APK at $APK"
tests="$(grep -ho '<testsuite [^>]*tests="[0-9]*"' "$HANDS"/android/build/test-results/testDebugUnitTest/*.xml 2>/dev/null | sed 's/.*tests="//; s/"//' | awk '{n+=$1} END {print n}')"
echo "ok${tests:+ ($tests unit tests)}"

if [[ $PHONE -eq 0 ]]; then echo; echo "PASS (--no-phone)"; exit 0; fi

# ---------------------------------------------------------------- phone
step "phone"
state="$(adb get-state 2>&1 | tr -d '\r')"
if [[ "$state" != "device" ]]; then
  echo "no phone ($state). Plug it in and accept USB debugging, or pass --no-phone."
  fail "adb"
fi

step "install + grant"
adb install -r "$APK" >/dev/null 2>&1 || fail "adb install -r $APK"
"$TOOLS/grant.sh" "$APP_ID" | sed -n '/^verification:/,$p'

# The debug APK loads its JS UI from Metro. Only the first launch needs it (it stores token "dev");
# the accessibility service and hub are native and run without JS.
step "launch test app"
if ! curl -s --max-time 2 http://127.0.0.1:8081/status | grep -q running; then
  (cd "$EX" && CI=1 npx expo start --port 8081 >"$METRO_LOG" 2>&1) &
  METRO_PID=$!
  for _ in $(seq 1 40); do curl -s --max-time 1 http://127.0.0.1:8081/status | grep -q running && break; sleep 1; done
fi
adb reverse tcp:8081 tcp:8081 >/dev/null 2>&1 || true
adb shell am start -n "$APP_ID/.MainActivity" >/dev/null 2>&1 || fail "am start $APP_ID/.MainActivity"
adb forward tcp:8765 tcp:8765 >/dev/null || fail "adb forward tcp:8765"

step "waiting for the hub (up to 20 s)"
probe() { # 0 = open, 3 = refused with 4003, 1 = not reachable
  NODE_PATH="$TOOLS/node_modules" node -e '
    const W = require("ws"); const ws = new W("ws://127.0.0.1:8765/watch?token=dev");
    const t = setTimeout(() => process.exit(1), 1500);
    ws.on("open", () => { clearTimeout(t); setTimeout(() => process.exit(0), 300); });
    ws.on("close", (c) => process.exit(c === 4003 ? 3 : 1));
    ws.on("error", () => process.exit(1));' 2>/dev/null
}
rc=1
for _ in $(seq 1 20); do probe; rc=$?; [[ $rc -eq 0 || $rc -eq 3 ]] && break; sleep 1; done
case $rc in
  0) echo "hub up" ;;
  3) echo "The hub refused token \"dev\" (4003): the test app has never stored it."
     echo "It is stored when the app's JS runs once. Start Metro (cd hands/example && npx expo start),"
     echo "run 'adb reverse tcp:8081 tcp:8081', open \"Bobby Hands Test\" on the phone, then run check.sh again."
     echo "If the final app (dev.bobby.app) owns the hub instead, run tools/grant.sh dev.bobby.hands again."
     fail "hub token" ;;
  *) echo "Nothing answers on 8765. Is the accessibility service on? (see grant output above)"
     echo "Another dev.bobby.* app's Hands service may still be bound; grant.sh removes it from settings."
     fail "hub not reachable" ;;
esac

step "smoke drive (home, screen, point; nothing tapped)"
node "$TOOLS/drive.mjs" --script "$TOOLS/smoke.txt" >"$LOGS/hands-check-drive.log" 2>&1 \
  || { tail -30 "$LOGS/hands-check-drive.log"; fail "drive.mjs --script smoke.txt"; }
grep -E '^app |: ok|ERROR' "$LOGS/hands-check-drive.log" | head -8

step "hub routing test against the phone"
node "$TOOLS/hub-test.mjs" --url ws://127.0.0.1:8765 >"$LOGS/hands-check-hubtest-phone.log" 2>&1 \
  || { tail -30 "$LOGS/hands-check-hubtest-phone.log"; fail "hub-test.mjs on the phone"; }
grep -E '^(#|ℹ) (pass|fail)' "$LOGS/hands-check-hubtest-phone.log" | tr '\n' ' '; echo

echo; echo "PASS"
