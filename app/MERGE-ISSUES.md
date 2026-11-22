# Merge issues

Problems found while putting the packages into the final app, with the exact fix each owner
should make. The app works around each one meanwhile. Last checked 2026-11-22, after the real
`bobby-mind` and `bobby-mouth` were swapped in (release APK builds).

## bobby-mouth (`mouth/`)

1. **`@elevenlabs/client` and `@elevenlabs/react-native` don't resolve under the final app's Metro.**
   Both packages have only an `exports` map and no `main`. In this app Expo's resolver falls back to
   `main` (`index`) and fails with "Unable to resolve "@elevenlabs/client"". This happens even with a
   plain `getDefaultConfig()` metro config and an import from inside `app/`, so it isn't caused by the
   app's custom resolver.
   - Workaround in the app: `metro.config.js` catches the failure and resolves through the package's
     `exports` itself, trying the conditions `react-native`, `require`, `import`, `default` in that
     order. The bundle then has the right files (`client/dist/platform/react-native/index.js`,
     `react-native/dist/index.react-native.js`) and one copy of each.
   - Fix for Mouth: run `npx expo export --platform android` in `mouth/example` with a clean
     `npm install`. If it fails the same way, add the same fallback (or an `extraNodeModules` /
     `resolveRequest` entry) to the example's `metro.config.js` and to step 2 of `MERGE.md`.
2. **Not verified from the back yet** (your MERGE.md section 5). The app starts Hands' keep-alive
   (foreground service type `microphone|dataSync`; `microphone` when RECORD_AUDIO is granted) before
   `wake()` and `moveToBack()`. Nothing to change in `mouth/`; this needs a test on the phone.
3. The WebRTC plugin adds a second foreground service of type `mediaProjection` (screen share),
   which is never started. Harmless; noting it in case Play-style checks complain.

## bobby-mind (`mind/`)

1. **Its typecheck can't find `@anthropic-ai/sdk` from the app** when `mind/node_modules` isn't
   installed, because TypeScript looks for it next to `mind/src`. Nothing to fix in `mind/`. In the
   app, `tsconfig.json` `paths` maps it, and the other packages' deps, to `app/node_modules`. The app
   installs `@anthropic-ai/sdk@1.12.0` itself (the "alternative" in your MERGE.md) and Metro never
   reads `mind/node_modules`.
2. The React Refresh shim from your MERGE.md is in `app/index.ts`.

## bobby-hands (`hands/`)

None open.
- Fixed by Hands: the 12:40 release APK crashed the Hands service with an R8 `VerifyError` in the
  minified java-websocket (Expo 58 release builds run R8). `hands/android/consumer-rules.pro` now keeps
  `org.java_websocket.**` and `dev.bobby.hands.**`. LiveKit and WebRTC ship their own consumer rules.
- `openedFromNotification()` is now tracked natively through `OnNewIntent`.
  `app/plugins/with-new-intent.js` (`setIntent` in `MainActivity.onNewIntent`) is kept; it's harmless.
- minSdk 30 and cleartext come from `../hands/app.plugin.js`, which is now in `app.json`;
  `expo-build-properties` sets the same values again.
