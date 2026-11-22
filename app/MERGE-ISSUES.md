# Merge issues

Problems found while putting the packages into the final app, with the exact fix each owner
should make. The app works around each one meanwhile.

## bobby-mind (`mind/`), checked 2026-11-22

1. **No entry point yet.** `package.json` `main` is `src/index.ts`, which doesn't exist, and nothing
   exports `startMind`. Fix: add `mind/src/index.ts` exporting
   `startMind(config: {hubUrl, token, env, log, hints: string[]}): {stop(): void}`.
   Workaround: `app/standins/mind.ts`.
2. **No `MERGE.md`.** Fix: add one. It should say whether `@anthropic-ai/sdk` works under React
   Native/Hermes (it needs `fetch` streaming; if it needs polyfills, list them), and that the app must
   `npm install` it, since Metro resolves `@anthropic-ai/sdk` from `app/node_modules` first and only
   falls back to `mind/node_modules`.

## bobby-mouth (`mouth/`), checked 2026-11-22

1. **No entry point yet.** There is no `mouth/src/` at all; `main` points at `src/index.ts`. Fix: add
   `mouth/src/index.ts` exporting `startMouth(config): {wake(), stop()}` and
   `startCaller(config): {stop()}`. Workaround: `app/standins/mouth.ts`.
2. **No `MERGE.md`.** The peer dependencies `@elevenlabs/react-native`, `@livekit/react-native` and
   `@livekit/react-native-webrtc` are native and need config plugins. Fix: add `MERGE.md` listing the
   exact `npx expo install ...` line, every plugin for `app.json` (e.g. `@livekit/react-native-expo-plugin`,
   `@config-plugins/react-native-webrtc`), the permissions, and the foreground service type it needs
   (the app uses Hands' keep-alive, which is `microphone` when RECORD_AUDIO is granted).
3. **If the ElevenLabs SDK needs a React provider** (`<ElevenLabsProvider>` or a hook), `startMouth`
   can't be a plain function. Fix: export the provider/component as well, and say in `MERGE.md` where
   it goes; the app will wrap `App` in it.

## bobby-hands (`hands/`)

None open. Notes:
- The app relies on `openedFromNotification()` being set before the activity resumes (in
  `onCreate`/`onNewIntent`); the app waits 400 ms after coming to the front before reading it.
- **`openedFromNotification()` misses taps while the app is already running** (the usual case,
  since the keep-alive service keeps it alive). It reads `currentActivity.intent`, but React
  Native's `ReactActivity.onNewIntent` never calls `setIntent()`, so the activity still holds its
  first launch intent. Fix in Hands: add an `OnNewIntent { intent -> fromNotification =
  intent.getBooleanExtra(KeepAliveService.FROM_NOTIFICATION, false) }` block (and set it from the
  launch intent in `OnCreate`/first call), and have `openedFromNotification()` return that flag.
  Workaround in the app: `plugins/with-new-intent.js` adds `onNewIntent { setIntent(intent) }`
  to `MainActivity`.
- **minSdk 30.** `bobby-hands` declares `minSdkVersion 30`, Expo's default is 24, so the manifest
  merge fails. Fix in Hands: say so in `hands/MERGE.md` (or set it from `app.plugin.js` with
  `withGradleProperties` / `android.minSdkVersion=30`). Workaround in the app:
  `expo-build-properties` `android.minSdkVersion: 30` in `app.json`.
