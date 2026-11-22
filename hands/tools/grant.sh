#!/usr/bin/env bash
# grant.sh <app id>: turns on every permission adb can grant for a Bobby Hands app.
#
#   hands/tools/grant.sh dev.bobby.hands      # the Hands test app
#   hands/tools/grant.sh dev.bobby.app        # the final app
#   ANDROID_SERIAL=R3CR704ZX1K hands/tools/grant.sh dev.bobby.hands
#
# - accessibility service <app>/dev.bobby.hands.HandsService (added to the enabled list; any other
#   dev.bobby.* HandsService is removed, because two hubs can't both bind port 8765)
# - notification access <app>/dev.bobby.hands.HandsNotificationListener
# - POST_NOTIFICATIONS and RECORD_AUDIO runtime permissions (skipped if the app doesn't ask for them)
# - best effort: battery-optimisation whitelist, background running, restricted settings
# Run it after every install: reinstalling can switch the accessibility service off.
# Exit 0 even when an optional grant fails (they are listed under "Needs the human");
# non-zero only when adb has no device.
set -u

APP="${1:-}"
if [[ -z "$APP" || "$APP" == -* ]]; then
  echo "usage: $0 <app id>   e.g. $0 dev.bobby.hands" >&2
  exit 2
fi

A11Y="$APP/dev.bobby.hands.HandsService"
NLS="$APP/dev.bobby.hands.HandsNotificationListener"

sh_() { adb shell "$@" 2>&1 | tr -d '\r'; }

# ---- adb connected?
state="$(adb get-state 2>&1 | tr -d '\r')"
if [[ "$state" != "device" ]]; then
  echo "adb: no usable device ($state)." >&2
  echo "Plug the phone in, accept the USB debugging prompt, and check 'adb devices'." >&2
  echo "With several devices, set ANDROID_SERIAL." >&2
  exit 1
fi
serial="$(adb get-serialno 2>/dev/null | tr -d '\r')"
sdk="$(sh_ getprop ro.build.version.sdk)"
echo "device $serial (SDK $sdk), app $APP"

NEEDS=()
need() { NEEDS+=("$1"); }

if ! sh_ pm path "$APP" | grep -q '^package:'; then
  echo "!! $APP is not installed on this device."
  need "Install $APP first (e.g. 'cd hands/example && npx expo run:android'), then run grant.sh again."
fi

# ---- accessibility service
cur="$(sh_ settings get secure enabled_accessibility_services)"
[[ "$cur" == "null" ]] && cur=""
new=""
removed=()
IFS=':' read -r -a parts <<< "$cur"
for p in "${parts[@]:-}"; do
  [[ -z "$p" ]] && continue
  pkg="${p%%/*}"; cls="${p#*/}"
  [[ "$cls" == .* ]] && cls="$pkg$cls"
  if [[ "$pkg" == dev.bobby.* && "$cls" == *HandsService ]]; then
    [[ "$pkg/$cls" != "$A11Y" ]] && removed+=("$p")
    continue # ours is appended once below; other Bobby hubs are dropped
  fi
  case ":$new:" in *":$p:"*) continue ;; esac # de-duplicate
  new="${new:+$new:}$p"
done
new="${new:+$new:}$A11Y"
for r in "${removed[@]:-}"; do [[ -n "$r" ]] && echo "   removing other Bobby hub from accessibility: $r"; done
sh_ settings put secure enabled_accessibility_services "$new" >/dev/null
sh_ settings put secure accessibility_enabled 1 >/dev/null

# ---- notification access
nls_out="$(sh_ cmd notification allow_listener "$NLS")"

# ---- runtime permissions
grant() { # perm -> prints result word
  local perm="$1" out
  out="$(sh_ pm grant "$APP" "$perm")"
  if [[ -z "$out" ]]; then echo granted
  elif grep -qiE 'has not requested|not requested|Unknown permission' <<< "$out"; then echo "not-requested"
  else echo "failed: $out"
  fi
}
post_res="skipped (SDK < 33 needs no grant)"
if [[ "${sdk:-0}" -ge 33 ]]; then post_res="$(grant android.permission.POST_NOTIFICATIONS)"; fi
mic_res="$(grant android.permission.RECORD_AUDIO)"

# ---- best effort extras (failures are only notes)
sh_ cmd deviceidle whitelist "+$APP" >/dev/null || true
sh_ cmd appops set "$APP" RUN_ANY_IN_BACKGROUND allow >/dev/null || true
sh_ cmd appops set "$APP" ACCESS_RESTRICTED_SETTINGS allow >/dev/null || true

sleep 1

# ---- verify
echo
echo "verification:"
ok() { printf '  %-28s %s\n' "$1" "$2"; }

a11y_now="$(sh_ settings get secure enabled_accessibility_services)"
a11y_on="$(sh_ settings get secure accessibility_enabled)"
dump="$(sh_ dumpsys accessibility)"
short="$APP/.HandsService"
if [[ ":$a11y_now:" == *":$A11Y:"* && "$a11y_on" == "1" ]]; then
  if grep -E 'Bound services|bound' <<< "$dump" | grep -qE "$A11Y|$short|$APP/dev\.bobby\.hands\.HandsService"; then
    ok "accessibility service" "ON and bound ($A11Y)"
  elif grep -qE "$A11Y|$short" <<< "$dump"; then
    ok "accessibility service" "ON in settings (seen in dumpsys, bound state unclear)"
  else
    ok "accessibility service" "ON in settings, but Android has NOT bound it"
    need "Accessibility: Settings > Accessibility > Installed apps > Bobby Hands: switch it on (Android listed it but didn't start it; reinstalling or a crash can cause this)."
  fi
else
  ok "accessibility service" "OFF (settings now: $a11y_now, enabled=$a11y_on)"
  need "Accessibility: Settings > Accessibility > Installed apps > Bobby Hands > On. (adb's 'settings put secure' was refused or reverted.)"
fi
other="$(tr ':' '\n' <<< "$a11y_now" | grep -E '^dev\.bobby\.[^/]*/.*HandsService$' | grep -vx "$A11Y" || true)"
[[ -n "$other" ]] && ok "other Bobby hubs" "STILL ENABLED: $other" && need "Turn off the other Bobby app's accessibility service ($other): only one hub can own port 8765."

nls_now="$(sh_ settings get secure enabled_notification_listeners)"
if [[ ":$nls_now:" == *":$NLS:"* ]]; then
  ok "notification access" "ON ($NLS)"
else
  ok "notification access" "OFF ${nls_out:+($nls_out)}"
  need "Notification access: Settings > Notifications > Device & app notifications (or Notification access) > Bobby Hands > Allow."
fi

perm_state() { # perm -> granted=true/false/absent
  local line
  line="$(sh_ dumpsys package "$APP" | grep -m1 "$1: granted=")"
  if [[ -z "$line" ]]; then echo "not requested by the app"
  elif [[ "$line" == *"granted=true"* ]]; then echo "granted"
  else echo "NOT granted"
  fi
}
post_now="$(perm_state android.permission.POST_NOTIFICATIONS)"
mic_now="$(perm_state android.permission.RECORD_AUDIO)"
if [[ "${sdk:-0}" -ge 33 ]]; then
  ok "POST_NOTIFICATIONS" "$post_now"
  [[ "$post_now" == "NOT granted" ]] && need "Notifications permission: Settings > Apps > $APP > Notifications > Allow. (pm grant said: $post_res)"
else
  ok "POST_NOTIFICATIONS" "$post_res"
fi
ok "RECORD_AUDIO" "$mic_now"
[[ "$mic_now" == "NOT granted" ]] && need "Microphone: Settings > Apps > $APP > Permissions > Microphone > Allow. (pm grant said: $mic_res)"

if sh_ dumpsys deviceidle whitelist | grep -q ",$APP,"; then ok "battery optimisation" "exempt"; else ok "battery optimisation" "not exempt (optional)"; fi

echo
if [[ ${#NEEDS[@]} -eq 0 ]]; then
  echo "All granted. Nothing needs the human."
else
  echo "Needs the human:"
  for n in "${NEEDS[@]}"; do echo "  - $n"; done
fi
exit 0
