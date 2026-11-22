#!/usr/bin/env bash
# Every check of the final app that needs no person:
# typecheck, build the release APK, install it, grant permissions, push the config,
# switch the Mind off, drive the phone through the app's hub, and check that opening
# the app wakes Bobby and moves it to the back.
#
#   ./check.sh                 # all of it (phone on USB)
#   ./check.sh --build-only    # typecheck + APK, no phone
#   ./check.sh --clean         # regenerate android/ with expo prebuild --clean first
# Env: ANDROID_SERIAL picks the phone when several are attached.
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR=$(pwd)
ROOT=$(cd .. && pwd)
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="/opt/homebrew/opt/node@22/bin:$ANDROID_HOME/platform-tools:$PATH"
PKG=dev.bobby.app
APK="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
BUILD_ONLY=0; CLEAN=0
for a in "$@"; do
  case "$a" in
    --build-only) BUILD_ONLY=1 ;;
    --clean) CLEAN=1 ;;
    *) echo "unknown argument $a"; exit 2 ;;
  esac
done
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*"; exit 1; }

step "deps and hints"
[ -d node_modules ] || npm install >"$LOGS/app-npm.log" 2>&1 || fail "npm install (see logs/app-npm.log)"
node tools/gen-hints.mjs

step "typecheck"
npx tsc --noEmit || fail "typecheck"

step "unit tests (stand-ins against hands/tools/fakehub.mjs, settings parsing)"
npm test >"$LOGS/app-test.log" 2>&1 || { tail -30 "$LOGS/app-test.log"; fail "tests"; }
grep -E "^# (pass|fail)" "$LOGS/app-test.log"

step "build (log: logs/app-gradle.log)"
if [ "$CLEAN" = 1 ] || [ ! -d android ]; then
  npx expo prebuild --platform android --no-install $([ "$CLEAN" = 1 ] && echo --clean) >"$LOGS/app-prebuild.log" 2>&1 \
    || { tail -20 "$LOGS/app-prebuild.log"; fail "prebuild"; }
fi
(cd android && ./gradlew assembleRelease >"$LOGS/app-gradle.log" 2>&1) \
  || { grep -E "^e: |error:|What went wrong" -A3 "$LOGS/app-gradle.log" | head -30; fail "gradle"; }
grep -E "BUILD SUCCESSFUL" "$LOGS/app-gradle.log" | tail -1
ls -la "$APK"
[ "$BUILD_ONLY" = 1 ] && { echo "OK (build only)"; exit 0; }

ADB=(adb ${ANDROID_SERIAL:+-s "$ANDROID_SERIAL"})
"${ADB[@]}" get-state >/dev/null 2>&1 || fail "no phone on adb"

step "install"
"${ADB[@]}" install -r "$APK" | tail -1

step "grant"
if [ -x "$ROOT/hands/tools/grant.sh" ]; then
  "$ROOT/hands/tools/grant.sh" "$PKG"
else
  echo "hands/tools/grant.sh missing: grant accessibility, notification access, notifications and microphone by hand"
fi

step "push config"
node tools/push-config.mjs ${ANDROID_SERIAL:+--serial "$ANDROID_SERIAL"}
sleep 2

step "switch the Mind off (drive.mjs plays the Mind)"
restore_mind() { "${ADB[@]}" shell "am start -a android.intent.action.VIEW -n $PKG/.MainActivity -d 'bobby://switch?mind=1'" >/dev/null 2>&1 || true; }
trap restore_mind EXIT
"${ADB[@]}" shell "am start -W -a android.intent.action.VIEW -n $PKG/.MainActivity -d 'bobby://switch?mind=0'" >/dev/null
sleep 3

step "drive.mjs against the app's hub (log: logs/app-drive.log)"
node "$ROOT/hands/tools/drive.mjs" --script "$APP_DIR/tests/drive-smoke.txt" >"$LOGS/app-drive.log" 2>&1 \
  || { tail -20 "$LOGS/app-drive.log"; fail "drive.mjs"; }
tail -5 "$LOGS/app-drive.log"

step "opening the app wakes Bobby and moves it to the back"
"${ADB[@]}" shell input keyevent KEYCODE_HOME
"${ADB[@]}" logcat -c
"${ADB[@]}" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 4
WOKE=$("${ADB[@]}" logcat -d -s ReactNativeJS:V | grep -E "\[bobby\].*(woke|not waking)" | tail -1 || true)
echo "${WOKE:-no wake line in logcat}"
echo "$WOKE" | grep -q "woke" || fail "app did not wake"
TOP=$("${ADB[@]}" shell dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" || true)
echo "$TOP"
echo "$TOP" | grep -q "$PKG" && fail "app is still in front after wake"
"${ADB[@]}" shell dumpsys activity services "$PKG" | grep -q "ServiceRecord" && echo "keep-alive service running" \
  || echo "WARN: no foreground service found for $PKG"

echo; echo "OK: app/check.sh passed"
