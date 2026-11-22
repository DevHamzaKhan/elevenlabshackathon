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

## Build, install, grant, drive

Laptop: Node 22, JDK 21, Android SDK (`export ANDROID_HOME=$HOME/Library/Android/sdk`).
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
| `node tools/drive.mjs --script tools/smoke.txt` | Runs commands from a file, exits 1 on the first failure |
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
`./gradlew :bobby-hands:testDebugUnitTest assembleDebug` (94 JVM tests; log in
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
