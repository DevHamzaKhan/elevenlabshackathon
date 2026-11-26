# bobby-hands

Bobby's hands on the phone. An Expo native module (Kotlin) that gives the app:

- an **accessibility service** (`HandsService`) that reads the screen and taps, swipes, types,
  presses keys and launches apps;
- the **hub**, a WebSocket server on `ws://127.0.0.1:8765` that the Mind, Mouth, Caller and watch
  clients connect to (CONTRACT.md "Connecting", "Routing"). It runs inside the accessibility service;
- a **cursor overlay** that glides to each target before acting;
- a **notification listener** that forwards notifications to the Mind;
- a **keep-alive foreground service**, so the app's JavaScript keeps running behind Gmail;
- a small JS API (below).

Android only, minSdk 30. Package `bobby-hands`; `main` is the TypeScript source (`src/index.ts`),
no build step.

## Layout

| Path | What |
|---|---|
| `src/` | JS API (`index.ts`), types (`BobbyHands.types.ts`), native module binding |
| `android/` | Kotlin: accessibility service, hub (`HubCore`), protocol, cursor, notification listener, keep-alive; JVM unit tests in `android/src/test` |
| `app.plugin.js` | Config plugin: `usesCleartextTraffic` and `android.minSdkVersion=30` |
| `example/` | Test app "Bobby Hands Test", id `dev.bobby.hands`, always uses hub token `dev` |
| `tools/` | Laptop tools: `drive.mjs`, `fakehub.mjs`, `hub-test.mjs`, `grant.sh`, `smoke.txt` |
| `check.sh` | Runs everything (see "Tests") |
| `MERGE.md` | What the final app needs to include this package |
| `STATUS.md` | Progress, decisions, open items |

## JS API

```ts
import * as Hands from 'bobby-hands';

Hands.configure({ token });          // hub token, stored on the phone (survives restarts)
Hands.status();                      // {accessibility, serviceRunning, notificationAccess, notifications,
                                     //  microphone, hubRunning, tokenSet, keepAlive, peers}
Hands.openSettings('accessibility'); // | 'notificationAccess' | 'notifications' | 'microphone' | 'app'
Hands.moveToBack();                  // show whatever was on screen before
Hands.startKeepAlive('Bobby is listening'); // foreground service + notification
Hands.stopKeepAlive();
Hands.openedFromNotification();      // true when opened from Bobby's notification
Hands.clearOpenedFromNotification();
```

## Protocol additions (beyond CONTRACT.md v1)

All additive: a v1 Mind that ignores unknown fields works unchanged. `caps_result.features` lists
them, so a Mind can check before relying on one.

| Where | Addition | Meaning |
|---|---|---|
| request | `{"type":"caps","to":"hands","id":"m1"}` | Reply `caps_result`: `sdk`, `release`, `oem`, `brand`, `model`, `locale`, `size`, `density`, `orientation`, `launcher`, `ime`, `secureLock`, `locked`, `gestureNav`, `imeTyping`, `screenshot`, `displays`, `features`. Best effort: any may be `null`. |
| `screen` | `since:"<hash>"` | Same hash now: `{"type":"screen_result","re","same":true,"hash","app","size"}`, no `nodes`. Otherwise a full result. |
| `screen` | `compact:true` | Nodes drop `false` booleans and `""` strings (`tap`, `edit`, `scroll`, `text`, `desc`, `cls`). |
| `screen` | `image:true` (existing) | Cursor overlay hidden during capture; one retry after 350 ms when Android rate-limits; `image_error`: `secure`, `rate_limited`, `no_permission`, ... |
| `screen_result` | `hash` (always) | 16 hex chars over app + node labels/flags/bounds (8 px rounding). System UI in the status-bar strip is ignored and clock/battery numbers in system UI are masked. |
| `screen_result` | `locked:true` | A secure lock (PIN/pattern/password) is showing: `nodes:[]`, `app:""`, `hash:"locked"`. |
| node | `checked` | Only on checkable nodes (`true`/`false`, kept in compact). A row whose switch is a plain child gets the switch's state. |
| node | `disabled`, `focused`, `selected`, `password` | Only when `true`. A password field's `text` is always `""`. |
| node | `id` | Short resource id (`compose_button`), when the app sets one. |
| node | `key` | Stable id: hash of package + resource id + class + label prefix + position bucket (screen in 8 x 16 cells); twins get `-2`, `-3`. Same element on an unchanged screen = same key; a scroll that moves it to another cell changes it. Editable fields key on hint/desc, not typed text. |
| node | `scrollDirs` | On scrollable nodes: `up`/`down`/`left`/`right` from the node's scroll actions. |
| nodes | folding | A plain text/desc child inside a tappable ancestor with no label of its own becomes part of that ancestor's `text`, joined with ` · ` (max 120 chars; overflow stays separate; ancestors over a third of the screen don't fold). `{text}` matches any one part exactly before falling back to contains. |
| `act` target | `{"id":"compose_button"}` | By resource id: full `pkg:id/name` or short `name`. Tappable/editable match wins. |
| `act` target | `{"key":"k1a2b3c4d"}` | By node `key` (on a fresh read). |
| `act` `{n}` | freshness | The node is refreshed first; gone or hidden: `ok:false,"error":"not_found","why":"stale"`. Bounds re-read. |
| `act` | `do:"open"` | `uri`, optional `action`, `pkg`, `extras` (string, number: int if integral else double, boolean, string array), `type_mime`. Default action: `mailto:`/`sms:`/`smsto:` SENDTO, `tel:` DIAL (CALL is always turned into DIAL), else VIEW. `uri` optional when `action` given. Nothing handles it: `not_found`, `why:"no app handles mailto:"`. |
| `act_result` | `app` | After `launch`/`open`: the package in front once the screen settled. |
| `act_result` | `why` | Same text as the v1 `detail` (both sent). |
| `act` | `then_screen:true` (+ `compact`) | The `act_result` carries `screen`: a screen_result body (no `type`/`re`) read after settling; it also becomes the `{n}` reference. |
| `act` | `fast:true` | Cursor glide 120-250 ms instead of 400-900 ms. |
| `act` (secure lock) | | Any act except `wait`: `ok:false,"error":"no_permission","why":"locked"`. Swipe lock: woken and dismissed as before. |
| `act` `do:"launch"` | `fresh:true` | Starts the app at its first screen instead of resuming where it was left (`FLAG_ACTIVITY_CLEAR_TASK`). |
| request | `{"type":"observe","to":"hands","id":"m3","on":true}` | Teaching by showing: report what the **user** does as `observed` frames (taps, typed text, scrolls, and the settled screens between them) until `on:false` or 10 minutes. Replies `observe_result` (`ok`, and `screen` on start / `count` on stop). Frames and rules: `mind/PROTOCOL-V2.md`, "Teaching by showing". |

**Observing** (`Observe.kt`): while it is on, the service adds `TYPE_VIEW_CLICKED`, `TYPE_VIEW_LONG_CLICKED`,
`TYPE_VIEW_TEXT_CHANGED` and `TYPE_VIEW_SCROLLED` to its event types at run time (`setServiceInfo`; the
XML and the permission are unchanged) and takes them off again afterwards. A click is matched to the
node of the last settled screen it came from (same platform node, else same resource id at that
place, else the tappable node under it, else its words). Typing is one frame per burst with the
final text; password fields send `password:true` and no text. Nothing from this app or the keyboard
is reported. `Recorder` is plain Kotlin and unit-tested (`ObserveTest`).

**Settling** (all acts): event-driven, not polled. Only `TYPE_WINDOW_STATE_CHANGED`,
`TYPE_WINDOWS_CHANGED` and `TYPE_WINDOW_CONTENT_CHANGED` count, not from system UI or this app.
Done 400 ms after the action if nothing happened, else after 150 ms of quiet, 2 s at most.
When a window or activity changed, Hands also waits (up to 600 ms) until two reads 100 ms apart
match, because slide-in animations send no events. `launch`/`open`: 250 ms floor, first-event
window 1 s, then wait (up to 3.5 s in all) for the expected app to be in front with at least two
readable nodes that hold still. Constants: `SettleTiming` in `Settle.kt`.

Try them: `node tools/drive.mjs --script tools/v2.txt` (caps, hash/since, compact, open geo/https/
mailto, not_found) and `tools/v2-emu.txt` (stale `{n}`, launch ranking, then_screen = next read,
folded-label tap, `id:` target). At the prompt: `caps`, `screen since`, `screen compact`,
`open mailto:a@b.c?subject=Hi`, `tap key:k1a2b3c4d --fast --then`, `expect same=true`.

## Locked-phone unlock

Holding the side button on a PIN-locked phone wakes Bobby over the lock screen. When he hears the
owner's phrase while their trusted earbuds are connected, Hands types the PIN on the lock
screen's own keypad, once.

- **Setup is native** (`UnlockSetupActivity`, opened by `openUnlockSetup()`; the app's settings
  screen has the button). It asks for a fingerprint, face or the phone's PIN first, sets
  FLAG_SECURE (no screenshots or recording) and takes the PIN, the phrase and one connected
  Bluetooth audio device. The PIN never passes through JavaScript, the hub or `.env`.
- **Storage** (`UnlockVault`): the PIN is AES-256-GCM encrypted with a non-exportable Android
  Keystore key (StrongBox when available) and stored in `noBackupFilesDir`. The phrase is kept
  only as a salted PBKDF2 hash. `turnOffUnlock()` deletes the key and the file.
- **Rules** (`UnlockLogic.gate`, checked by Hands on every `heard` from the Mouth while the phone
  is PIN-locked): set up and armed → secure lock showing → this lock session's attempt unused →
  trusted earbuds connected (name plus the last two address bytes) → the phrase appears as
  consecutive words in what was heard (at most 3 misses per lock session).
- **One attempt, never a retry.** "Attempt started" is written to disk before the first digit.
  A failed attempt (wrong PIN, a key press failing, a crash mid-entry) disarms the feature until
  the owner sets it up again. A lock session's attempt resets only when the phone is unlocked
  (`ACTION_USER_PRESENT`). If no full 0-9 keypad is found, nothing is typed.
- **Opening the keypad** (types nothing): already showing → tap the lock screen's unlock icon
  through accessibility (what works on Android 15; an injected swipe up does not open a PIN
  keypad) → `requestDismissKeyguard` from the invisible `BouncerActivity`, which stays up while
  the PIN is typed → a swipe up. Keys are matched by id (`key0`..`key9`, `key_enter`) first,
  then by label; Delete and Emergency are never pressed.
- **Probe** (read-only, for a new phone): `node hands/tools/unlock-probe.mjs` (after `adb forward
  tcp:8765 tcp:8765`, with the phone PIN-locked) sends `{"type":"unlock_probe","to":"hands"}`.
  Hands opens the keypad and answers `unlock_probe_result` with `keypad`, `how`, `enter`,
  `clickable`, `byId`. It never types and never uses the attempt.
- While the PIN is typed the cursor and captions are hidden, and `heard` captions aren't shown on
  a locked phone with the unlock set up (they would show the phrase).
- The unlock runs on the Hands worker and the hub calls the observer before forwarding `heard`
  to the Mind, so the Mind's next `screen` waits for the unlock and then sees the real screen.
  If any rule fails, the Mind gets `locked` as before.
- JS API: `unlockStatus()` (no secrets), `openUnlockSetup()`, `turnOffUnlock()`,
  `addAssistListener(fn)` (side button on a locked phone with the unlock armed; the app wakes
  Bobby without coming to the front).

## Build, install, grant, drive

Laptop: Node 22, JDK 17 or 21 (`JAVA_HOME`; Homebrew `openjdk@17` works), Android SDK (`export ANDROID_HOME=$HOME/Library/Android/sdk`).
Phone: USB debugging on, `adb devices` shows it.

```sh
cd hands && npm install
cd example && npm install
npx expo run:android                 # builds, installs dev.bobby.hands, starts Metro
../tools/grant.sh dev.bobby.hands    # accessibility, notification access, mic, notifications
node ../tools/drive.mjs              # then type: screen
```

The test app stores token `dev` the first time its JS runs (it needs Metro for that first launch).
After that the service and hub are native and work without Metro or the app being open.

## Tools (`hands/tools`)

Run `npm install` in `tools/` once. The token comes from `HUB_TOKEN`, else the repo-root `.env`,
else `dev`. For the test app use `HUB_TOKEN=dev` if your `.env` holds the final app's token.

| Command | Does |
|---|---|
| `node tools/drive.mjs` | Plays the Mind: `adb forward tcp:8765 tcp:8765`, connects, interactive prompt (`help` lists commands: `screen`, `tap`, `point`, `type`, `swipe`, `launch`, `home`, `demo`...) |
| `node tools/drive.mjs --script tools/smoke.txt` | Runs commands from a file, exits 1 on the first failure (a line `?cmd` may fail; check it with `expect`) |
| `node tools/drive.mjs --script tools/v2.txt` | The protocol additions, scripted (also against fakehub) |
| `node tools/drive.mjs -e screen -e "point Gmail"` | Commands from the command line |
| `node tools/drive.mjs --screenshot shots/` | Saves an adb screencap after each action |
| `node tools/drive.mjs demo --dry` (at the prompt: `demo --dry`) | Scenic route to Gmail, reply to the newest email from `HANDS_TEST_SENDER`; `--dry` discards instead of sending |
| `node tools/fakehub.mjs [--port 8765] [--token dev]` | A laptop fake of the phone hub with a fake Samsung home screen and Gmail |
| `node tools/hub-test.mjs --fake` | Routing test against a fakehub it starts itself |
| `node tools/hub-test.mjs --url ws://127.0.0.1:8765` | Same test against the phone (after `adb forward tcp:8765 tcp:8765`). It takes over the mind/mouth/caller slots, so restart any real Mind/Mouth afterwards |
| `tools/grant.sh <app id>` | Grants every permission adb can, verifies, lists what needs the human |

### Without a phone

```sh
node tools/fakehub.mjs                                   # terminal 1 (type `notify Sarah: hi` to push one)
node tools/drive.mjs --no-adb --url ws://127.0.0.1:8765  # terminal 2
```

## Tests

```sh
hands/check.sh             # everything below, then on the phone: install, grant, smoke drive, hub test
hands/check.sh --no-phone  # laptop only
```

`check.sh` runs: `hub-test.mjs --fake`; in `example/` `npm install` and `expo prebuild` if needed;
`./gradlew :bobby-hands:testDebugUnitTest assembleDebug` (146 JVM tests; log in
`logs/hands-check-build.log`); then, if `adb get-state` is `device`: `adb install -r`, `grant.sh
dev.bobby.hands`, starts Metro if it isn't running and launches the app, waits for the hub, runs
`drive.mjs --script tools/smoke.txt` (reads the home screen and points; taps nothing) and
`hub-test.mjs` against the phone. Non-zero exit on any failure.

Just the unit tests: `cd hands/example/android && ./gradlew :bobby-hands:testDebugUnitTest`
(or `npm test` in `hands/`).

## Troubleshooting

- **Accessibility switched off after reinstalling.** `adb install -r` (or a crash) can unbind the
  service. Always run `tools/grant.sh <app id>` after an install. If it says "ON in settings, but
  Android has NOT bound it", toggle it in Settings > Accessibility > Installed apps > Bobby Hands.
- **Port 8765 in use / hub not answering.** Only one app on the phone may have the Hands service on,
  because both would bind 8765: the test app (`dev.bobby.hands`) and the final app (`dev.bobby.app`)
  can't run their hubs together. `grant.sh <app id>` removes every other `dev.bobby.*` HandsService
  from the enabled list. Switch back the same way.
- **Hub closes with 4003.** Wrong token, unknown role, or no token configured yet. For the test app,
  open it once with Metro running so it stores `dev`; for the final app use its `HUB_TOKEN` (in the
  root `.env` after `push-config`).
- **Typing into the Gmail reply body does nothing.** The body is a web view, which ignores
  `ACTION_SET_TEXT`. Hands then falls back to the accessibility input-method connection (Android 13+,
  `flagInputMethodEditor`), then to a clipboard paste. Normal fields use `ACTION_SET_TEXT`, which
  replaces the field's text rather than appending.
- **`drive.mjs` can't connect.** Check `adb devices`, that `adb forward tcp:8765 tcp:8765` worked,
  and that `status().serviceRunning` is true (the hub only runs while the service does).
- **Builds can't find the SDK.** Set `ANDROID_HOME`, or write `sdk.dir=...` to
  `example/android/local.properties` (check.sh does both).
