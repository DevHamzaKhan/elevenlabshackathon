# Bobby: the final app

One Expo app (`dev.bobby.app`, Expo SDK 58.0.26) that holds all three packages:
`bobby-hands` (`../hands`), `bobby-mind` (`../mind`) and `bobby-mouth` (`../mouth`).
Opening the app wakes Bobby and sends the app to the back; that is what the side button
double-press triggers. Opening it from its notification shows the settings screen instead.

## Stitching day: clean phone to working Bobby

Laptop: Node 22, JDK 21, Android SDK (`export ANDROID_HOME=$HOME/Library/Android/sdk`).
Phone: Developer options on, USB debugging on, plugged in, `adb devices` shows it.

1. **Pull and install.**
   ```sh
   git pull
   cd hands && npm install && cd ..
   cd mind && npm install && cd ..      # if mind/ has src/index.ts
   cd mouth && npm install && cd ..     # if mouth/ has src/index.ts
   cd app && npm install                # also bundles stage/hints/*.md into generated/hints.ts
   ```
2. **Swap in the real packages** that have arrived (see "Swapping in" below). Read each
   package's `MERGE.md` and do what it says (extra `npx expo install`, plugins, permissions).
3. **Build and install.**
   ```sh
   ./check.sh --build-only --clean      # expo prebuild --clean + gradle assembleRelease
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```
   The APK is a release build signed with the debug key, with the JS bundled in: no Metro needed.
4. **Permissions.** `../hands/tools/grant.sh dev.bobby.app` grants them over adb. Without it, open
   Bobby and press each "Grant" on the settings screen: accessibility (turn on "Bobby Hands"),
   notification access, post notifications, microphone.
5. **Keys.** Put every key in the repo-root `.env` (copy from `env/*.env`), then
   ```sh
   node tools/push-config.mjs           # or: npm run push-config
   ```
   It sends the `.env` lines over USB as `bobby://config` deep links; the app stores them in secure
   storage and lists the names (never values). If `.env` has no `HUB_TOKEN`, it adds one first, so
   laptop tools (`drive.mjs`, the dashboard) use the same token as the phone.
6. **Side button.** Settings > Advanced features > Side key > Double press > Open app > Bobby (Samsung).
7. **Check.** `./check.sh` (all of it: typecheck, `npm test`, build, install, grant, push config, Mind off, `drive.mjs`
   smoke script, then checks that opening the app wakes Bobby and moves it to the back).
8. **Try it.** Double-press the side button. Bobby wakes (keep-alive notification appears) and the
   app goes to the back. Tap the notification to see the settings screen without waking.

## Swapping in

`src/packages.ts` is the switch, one line per package:

```ts
export { startMind } from '../standins/mind';                 // -> from 'bobby-mind'
export { startMouth, startCaller } from '../standins/mouth';  // -> from 'bobby-mouth'
```

To use a real package: `npm install ../mind` (or `../mouth`), which adds `"bobby-mind": "file:../mind"`
to `package.json`; change its line; follow its `MERGE.md`; `./check.sh --clean`. If it fails because
of something in their folder, write the exact fix in `MERGE-ISSUES.md` and work around it here.

Stand-ins (`standins/`): the Mind has Bobby say hello on `wake` and echoes `heard`; the Mouth has no
voice and answers each `say` with `say_done` `spoken:false`; the Caller refuses every call. They speak
the real wire protocol, so the status lights and `drive.mjs` behave as they will with real parts.

## What the app does

- On start: loads settings from secure storage, generates `HUB_TOKEN` if missing, calls Hands
  `configure({token})`, and starts each part that is switched on with
  `{hubUrl: 'ws://127.0.0.1:8765', token, env, log}` (Mind also gets `hints`).
- Each time it comes to the front with settings complete (accessibility, microphone, config pushed)
  and the Mouth on: `startKeepAlive()`, Mouth `wake()`, `moveToBack()`. Not after a `bobby://` link,
  not when opened from the notification (`openedFromNotification()`), and not when returning from a
  permission page the settings screen opened.
- The keep-alive foreground service stays on once Bobby has woken (so JS keeps running behind Gmail);
  "Stop keep-alive" on the settings screen ends it.
- Settings screen: permission checklist, Mind/Mouth/Caller switches, status lights from
  `status().peers` (polled every 1 s), hub token, stored setting names, the last 200 log lines.

## Deep links (all from adb, none wake Bobby)

| Link | Does |
|---|---|
| `bobby://config?id=&part=&of=&data=<base64url .env>` | stores the env (what `push-config.mjs` sends) |
| `bobby://switch?mind=0&mouth=1&caller=1` | turns parts on/off (check.sh turns the Mind off) |
| `bobby://settings` | just shows settings |

e.g. `adb shell "am start -a android.intent.action.VIEW -n dev.bobby.app/.MainActivity -d 'bobby://switch?mind=0'"`

## Art and hints

- `tools/gen-hints.mjs` bundles every `../stage/hints/*.md` except `TO-CHECK.md` into
  `generated/hints.ts` (runs on `npm install`, `npm start`, `npm run prebuild`, `check.sh`).
- `plugins/with-bobby-art.js`: if `../stage/cursor/CHOSEN` exists (a design name like `ring`, or a
  file name), that xml becomes the app's `res/drawable/cursor.xml`, overriding Hands' default.
- `app.config.js`: if `../stage/icon/icon.png` exists it becomes the app icon; it also adds
  `../hands/app.plugin.js`.

## Tests

`npm test`: the stand-ins against `../hands/tools/fakehub.mjs` (wake reaches the Mind, its `say`
reaches the Mouth, calls are refused, 4001 replacement), and `.env` parsing / base64url decoding.

## Bundler

`metro.config.js` watches `../hands`, `../mind`, `../mouth`, and resolves every bare import made from
those folders from `app/node_modules` first, so there is one copy of react, react-native and expo;
it falls back to the package's own `node_modules` for things only the package has.
`experiments.autolinkingModuleResolution` is on as well.

## Native settings

`minSdkVersion` 30 (bobby-hands needs it), cleartext traffic on (`ws://127.0.0.1:8765`),
`plugins/with-new-intent.js` (see `MERGE-ISSUES.md`).

## Settings

Non-secret settings this app adds: none. Keys come only from the pushed `.env`.
