# Role: Exec + Android shell (`android/app`, `android/core`, `android/exec`, `android/tools`) — Person B

You build the execution engine that reads the phone's screen and performs taps, swipes and typing, with a cursor that glides to each target first. You also own the **Android project skeleton and the shared `:core` hub client**, which the Voice and Chat modules build on. Read `CLAUDE.md` and `CONTRACT.md` first.

- **Target:** Samsung Galaxy S21, current Android. Kotlin, minSdk 30, application id `dev.bobby.agent`.
- **Device:** the S21, plugged into the Mac over USB. It's the team's only test phone and yours until stitching day. Leave it in a normal state: no leftover drafts, no settings changed beyond what the app needs.
- **Accounts:** none.

## Day 0, first hour: the scaffold (others build on it, so push it fast)

1. **Gradle project** in `android/` with the version catalog, Compose enabled, and `settings.gradle.kts` that auto-includes every direct subfolder containing a `build.gradle.kts`. Nobody else should ever need to edit settings.
2. **`:app`** shell (`com.android.application`, id `dev.bobby.agent`): depends on `:core`, and on `:exec`, `:voice`, `:chat` **only if each project exists**. `usesCleartextTraffic="true"`. Launcher activity `.MainActivity`.
3. **`:core`** library with a **frozen API** (publish it in `android/core/API.md`; change only additively):
   - `HubSettings` — hub URL and token in DataStore; set from the setup screen or intent extras `hub`, `token`.
   - `HubClient(role: String)` — one socket per role (OkHttp WebSocket), hello/welcome with `v:2`, reconnect 1/2/5/5… s, stop forever on 4001, surface 4003/4002 as errors. `messages: SharedFlow<JSONObject>`, `state: StateFlow<Conn>` (`Disconnected`, `Connecting`, `Live`, `Replaced`, `BadToken`), `send(JSONObject)`, `request(JSONObject, timeoutMs): JSONObject?` (awaits the `re`). Logs every frame to logcat `Bobby/<role>` and a rolling file.
   - `Feature` interface, discovered with `ServiceLoader`: `name`, `permissions(): List<PermissionItem>` (label, isGranted(ctx), settingsIntent(ctx)), optional `entryPoints(): List<EntryPoint>` (label + intent), optional `start(ctx)`.
   - `HubService` — a foreground service (type `connectedDevice` or `dataSync`; check current Android rules and pick the right one) that hosts the `HubClient`s for every feature that asks for one, survives screen-off and swipe-away, and restarts on boot. Modules register a role with it rather than each running their own service.
4. **`MainActivity`** (Compose): hub URL and token fields, one connection light per role, the permission checklist gathered from all `Feature`s (each with a button to the right settings page), and buttons for each feature's entry points. If a `:chat` feature exposes a "Chat" entry point, show a prominent "Open chat" button.
5. Push. Then tell the team in `STATUS.md` → Decisions that the scaffold and `core/API.md` are live.

## Tools first

1. Check for `adb`, a JDK, the Android SDK and `uv`; install what's missing with Homebrew (`openjdk` at the version the current Android Gradle Plugin needs, `android-commandlinetools`), then `sdkmanager` for platform-tools, a current platform and build-tools, accepting licences.
2. `adb devices`. If the phone isn't listed, put it on the human's list and build everything else meanwhile. Once listed: `adb shell svc power stayon usb`.
3. `STATUS.md` → Needs the human:
   1. Turn on Developer options and USB debugging, plug the phone in, tap "Allow" with "Always allow from this computer" ticked.
   2. Keep the phone unlocked while the agent works, or set the lock screen to Swipe for now.
   3. Gmail signed in, its icon on a home screen other than the first (so the scenic route has somewhere to go).
   4. Ask a teammate to send a test email; write their name in `STATUS.md`. The demo replies to it.
   5. Anything Android won't let `adb` grant (list it once you know).

## What to build in `:exec`

1. **Accessibility service** (the core):
   - Live tree → `screen_result`, following the contract's inclusion rules. Optional `image` screenshot via the accessibility screenshot API.
   - Every `do` in the contract's table: gestures for tap / long press / swipe, `ACTION_SET_TEXT` for `type`, global actions for `key`, a launch intent for `launch`, `wait`.
   - The three target forms (`n`, `text`, `x`/`y`) resolved exactly as the contract says.
   - Settle detection before `act_result`: no window-content change for 300 ms, max 3 s.
   - `abort`: cancel a glide that hasn't touched yet, reply `error:"cancelled"`.
2. **Cursor overlay**, drawn from the accessibility service (`TYPE_ACCESSIBILITY_OVERLAY`, not touchable, so no extra permission and never blocks touches):
   - Eased glide, 400–900 ms by distance; small ripple on tap; fades 2 s after the last action; `cursor show` messages honoured.
   - Drawn from one drawable, `exec/src/main/res/drawable/cursor.xml`, so Stage's artwork drops in without code changes (48 dp, hotspot at the centre).
3. **Notification listener** forwarding each new notification as `notification`. Skip ongoing and silent system ones and `dev.bobby.*`.
4. **`ExecFeature`**: registers role `exec` with `HubService`, lists accessibility + notification access + post-notifications permissions.
5. **`android/tools/grant.sh`**: enables the accessibility service via `settings put secure`, notification access via `cmd notification allow_listener`, notification permission via `pm grant`, and grants the voice module's `RECORD_AUDIO` too (harmless if the module is absent). Run after every install: reinstalling can switch accessibility off. Whatever Android refuses goes on the human's list.
6. **`android/tools/drive.py`**, single-file `uv` script pretending to be the hub (and the Orchestrator) for Exec:
   - Listens on 8765, accepts any token, speaks contract v2. `adb reverse tcp:8765 tcp:8765`.
   - Commands: `screen`, `tap Reply`, `tap 540 1200`, `point Reply`, `type hello there`, `swipe left`, `home`, `back`, `launch Gmail`, `abort`.
   - `screen` prints a compact table; notifications print as they arrive.
   - `--script <file>` runs commands one per line and exits non-zero on the first failure.
   - `demo <sender name>`: the scenic route end to end: home, swipe across home screens reading each until "Gmail" is visible (open a folder if it's inside one), tap it, open the newest email from that sender, tap Reply, type a short line, Send. Stops before Send if the open email isn't from that sender. **This sends a real email: run it only to check the finished route, once per run.**
7. **Check your work by looking.** Screenshots with `adb exec-out screencap -p`, viewed yourself, to confirm the cursor and each action. Post test notifications with `adb shell cmd notification post`.
8. **Unit tests** for pure logic: tree-to-nodes filtering, target matching, JSON encode/decode of every contract example Exec sends or receives, and `HubClient` reconnect/4001 behaviour against a local test server.
9. **`android/exec/check.sh`**: unit tests, `./gradlew :app:assembleDebug`, `adb install -r`, `grant.sh`, then a short `drive.py --script` run that reads the home screen and `point`s at something without tapping.

## Order (commit after each)

1. Day 0 scaffold + `:core`. The app builds, installs, and `:exec` completes hello/welcome with `drive.py`.
2. `screen` works on the home screen and inside Gmail.
3. `tap`, `swipe`, `key`, `type` without a cursor.
4. Cursor glides before each action; `point` works; `abort` works.
5. Notifications forwarded.
6. `demo` passes from a cold start. Run it once, check the sent email in screenshots, note the result.

## Done when

With only the phone and `drive.py`, typed commands take the scenic route to Gmail, open an email, write a reply and send it, the cursor visibly leading every action in your screenshots, and a notification posted with `adb` shows up in the terminal. The app builds with `:voice` and `:chat` absent and with stub versions present.

## Then keep going

- Apps beyond Gmail: Messages, WhatsApp, Chrome, Maps, Settings. Web views and custom views expose poor trees; find what breaks and fix node filtering. Test with `screen` and `point`, which change nothing.
- Hints check: after a `git pull`, if `stage/hints/TO-CHECK.md` exists, open each app it names, check each label with `screen`, write findings to `android/exec/HINTS-CHECK.md` (confirmed / wrong with the real label / not found). Read `stage/` only. Repeat when that file changes.
- Scrolling: off-screen list targets; `swipe` inside a specific scrollable node.
- Keyboard: fields that reject `ACTION_SET_TEXT` (fall back to paste or IME), dismissing a keyboard that covers the target.
- App drawer as a second way to find an app.
- Cursor feel: curved path, slight overshoot, press animation.
- Odd states: a permission dialog on top, screen locked, service killed by battery saver (document the S21 battery exemptions for the human).

## Stitching day

See `INTEGRATION.md`. Your README must give: build/install/grant commands, how to point the app at the real hub (intent extras), and how to read the logs off the phone.
