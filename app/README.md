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
   cd hands && npm install && cd ..     # hands' own dev deps (types for the app's typecheck)
   cd app && npm install                # bobby-hands/-mind/-mouth from ../, plus every runtime dep
                                        # they need; also bundles stage/hints/*.md
   ```
   `mind/` and `mouth/` need no `npm install` for the app: their runtime deps
   (`@anthropic-ai/sdk`, ElevenLabs, LiveKit, WebRTC) are installed in `app/` and Metro never reads
   a sibling's `node_modules`.
2. **Packages.** All three are real now (`src/packages.ts`). If a package's `MERGE.md` changes,
   redo what it says here (deps with exact versions, plugins, permissions).
3. **Build and install.**
   ```sh
   ./check.sh --build-only --clean      # expo prebuild --clean + gradle assembleRelease
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```
   The APK is a release build signed with the debug key, with the JS bundled in: no Metro needed.
   Expo SDK 58 turns R8 on for release (`android.enableMinifyInReleaseBuilds=true` in the generated
   `gradle.properties`), so every native library must ship keep rules: Hands keeps
   `org.java_websocket.**` and `dev.bobby.hands.**` in `hands/android/consumer-rules.pro`; LiveKit and
   WebRTC ship their own. A `VerifyError` / `ClassNotFoundException` at run time in release only means
   a missing keep rule (app-side fallback: `expo-build-properties` `android.extraProguardRules`).
4. **Permissions.** `../hands/tools/grant.sh dev.bobby.app` grants them over adb. Without it, open
   Bobby and press each "Grant" on the settings screen: accessibility (turn on "Bobby Hands"),
   notification access, post notifications, microphone.
5. **Keys.** Put every key in the repo-root `.env` (copy from `env/*.env`). At least
   `ANTHROPIC_API_KEY` (Mind) and `ELEVENLABS_BOBBY_AGENT_ID` (Mouth; written by
   `node mouth/agent/setup.mjs`), plus `CONTACTS` / `CALL_ALLOWLIST` if used. Then
   ```sh
   node tools/push-config.mjs           # or: npm run push-config
   ```
   It sends the `.env` lines over USB as `bobby://config` deep links; the app stores them in secure
   storage and lists the names (never values). If `.env` has no `HUB_TOKEN`, it adds one first, so
   laptop tools (`drive.mjs`, the dashboard) use the same token as the phone.
6. **Side button (hold).** Make Bobby the digital assistant, so holding the side button wakes him:
   `adb shell cmd role add-role-holder --user 0 android.app.role.ASSISTANT dev.bobby.app 0`
   (or Settings > Apps > Default apps > Digital assistant app > Bobby). On Samsung, check
   Settings > Advanced features > Side button > Press and hold is set to the digital assistant.
7. **Check.** `./check.sh` (all of it: typecheck, `npm test`, build, install, grant, push config, Mind off, `drive.mjs`
   smoke script, then checks that opening the app wakes Bobby and moves it to the back).
   **Locked phone (optional).** On the settings screen, under "Unlock when locked", tap Set up:
   confirm it's you, enter your PIN twice, your phrase, and pick your connected earbuds. Then,
   with the phone PIN-locked and the earbuds connected, hold the side button and say the phrase.
   Bobby types the PIN once; if that fails he disarms until you set it up again. Details:
   `hands/README.md` "Locked-phone unlock".
8. **Try it.** Hold the side button. Bobby wakes (keep-alive notification appears) and the
   app goes to the back. Tap the notification to see the settings screen without waking.

## Swapping in

`src/packages.ts` is the switch, one line per package. Today both are real:

```ts
export { startMind } from 'bobby-mind';
// export { startMind } from '../standins/mind';
export { startMouth, startCaller } from 'bobby-mouth';
// export { startMouth, startCaller } from '../standins/mouth';
```

To fall back to a stand-in (e.g. to test one part alone, or if a package breaks the build), swap
which line is commented and `./check.sh --build-only`. If a package fails because of something in
its folder, write the exact fix in `MERGE-ISSUES.md` and work around it here.

Stand-ins (`standins/`, fallback only): the Mind has Bobby say hello on `wake` and echoes `heard`; the Mouth has no
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

`metro.config.js`:
- watches `../hands`, `../mind`, `../mouth`, and blocks their own `node_modules` (one copy of react,
  react-native, expo, `@elevenlabs/client`, LiveKit);
- resolves every bare import made from those folders as if it came from `app/`;
- falls back to reading a package's `exports` map itself when Expo's resolver fails on a package
  that has `exports` but no `main` (`@elevenlabs/client`, `@elevenlabs/react-native`), picking the
  `react-native`, `require`, `import`, `default` conditions in that order.

`tsconfig.json` maps those packages' deps to `app/node_modules` for the same reason.

`index.ts` loads `bobby-mind` once with React Refresh hidden (mind/MERGE.md, "Dev builds"); release
builds don't need it, dev builds crash without it.

## Native settings

`app.json` plugins: `../hands/app.plugin.js` (cleartext, minSdk 30), `@livekit/react-native-expo-plugin`,
`@config-plugins/react-native-webrtc`, `expo-secure-store`, `expo-build-properties` (cleartext and
minSdk 30 again, harmless), `plugins/with-bobby-art.js`, `plugins/with-new-intent.js` (harmless now
that Hands tracks `onNewIntent` itself). Permissions: RECORD_AUDIO, MODIFY_AUDIO_SETTINGS,
ACCESS_NETWORK_STATE, BLUETOOTH, BLUETOOTH_CONNECT, POST_NOTIFICATIONS, FOREGROUND_SERVICE(_MICROPHONE),
WAKE_LOCK; Hands adds the keep-alive service (`microphone|dataSync`). `expo-dev-client` is installed
per mouth/MERGE.md (only matters for debug builds).

## Settings

Non-secret settings this app adds: none. Keys come only from the pushed `.env`.
