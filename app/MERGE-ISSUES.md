# Merge issues

Problems found while putting the packages into the final app, with the exact fix each owner
should make. The app works around each one meanwhile. Last checked 2026-11-22, after the real
`bobby-mind` and `bobby-mouth` were swapped in (release APK builds).

## bobby-mouth (`mouth/`)

1. **Not verified from the back yet** (your MERGE.md section 5). The app starts Hands' keep-alive
   (foreground service type `microphone|dataSync`; `microphone` when RECORD_AUDIO is granted) before
   `wake()` and `moveToBack()`. Nothing to change in `mouth/`; this needs a test on the phone.
2. The WebRTC plugin adds a second foreground service of type `mediaProjection` (screen share),
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

## Stitch on the phone, 2026-11-22 13:04 (main at 328cfdb, full root `.env` pushed)

`app/check.sh` passes with the real Hands, Mind (f52515e, 9b60d5f) and Mouth (b0aea73, 328cfdb). No app changes were needed for these commits.

What happened on wake:
- Mouth: voice session started, sent `wake`, heard real speech (`heard`), spoke (`spoke`). Works. (That was the earlier voice vendor; the OpenAI voice is not yet tested on the phone.)
- Mind: started (claude-opus-5-5, 11 hints), connected, sent its notifications `whisper`; its first model call failed with **401 invalid x-api-key**. Checked from the laptop too: the `ANTHROPIC_API_KEY` in the root `.env` is rejected by the API. **Needs a valid key from James C.**

Issue for Mind (James C): when every model call fails, the Mind never sends `sleep`, so the Mouth session (and the microphone, streaming the room to the voice vendor) stayed live until the app was force-stopped. Suggested fix: the 20 s idle → `sleep` timer should run regardless of model errors (an error turn counts as "no task in progress"). The Mouth's own 5-minute backstop is the only other end.

Not in `.env` yet (only needed for real calls, `CALLER_DRY_RUN=1` meanwhile): `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD` (`mouth/README.md`, "Caller on OpenAI").
