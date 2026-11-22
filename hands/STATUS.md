# Hands: status

## Done
- `bobby-hands` Expo module (Kotlin): accessibility service, hub on 127.0.0.1:8765, cursor overlay, notification listener, keep-alive foreground service, JS API (`configure`, `status`, `openSettings`, `moveToBack`, plus `startKeepAlive`/`stopKeepAlive`/`openedFromNotification`).
- Test app `hands/example` (id `dev.bobby.hands`) builds and installs on the S21; hub accepts token `dev`, hello/welcome/peers and `screen` work on the phone.
- 94 JVM unit tests (protocol, contract examples, node filter, target matching, hub routing) pass.
- On the phone: `screen`, `tap`, `long`, `point`, `swipe`, `type` (incl. Gmail's web-view reply body), `key`, `launch` all work; cursor glides before each action (seen in screenshots); notifications from `adb shell cmd notification post` arrive at the Mind; `hub-test.mjs` passes 11/11 against the real phone hub.
- `demo` passed from a cold start (2026-11-22 12:28): home → swipe to page 2 → Gmail → newest email from "Hamza Khan" → Reply → typed → Send. Gmail showed "Sent" and the reply in the thread. **Job 1 "Done when" met.**
- Extras: `screen` with `"image":true` adds a base64 JPEG (720 px wide) as `image`; a tap target hidden under the keyboard makes Hands hide the keyboard first; screen off / Swipe lock screen: any `screen` or `act` wakes the phone and clears the lock first (checked: dozing + locked → home screen); hints checked (`HINTS-CHECK.md`); web pages: a plain label repeating its parent's label over the same box is dropped (Chrome Wikipedia page 100 → 74 nodes), and a still-loading web view gets one 700 ms retry; `demo` falls back to the app drawer (pages and folders) when Gmail is on no home page (`drawer-gmail` checks that route alone: found and pointed at Gmail on the phone); cursor glide has a slight overshoot; `drive.mjs` `screen image [file]` saves the screenshot; scrolling inside a node checked (`swipe up` on Settings' list brings "Display" into view).
- Laptop tools: `drive.mjs`, `fakehub.mjs`, `hub-test.mjs`, `grant.sh`, `check.sh`, README, MERGE.

- **Job 2:** final app `app/` ("Bobby", `dev.bobby.app`) with the real Hands, Mind and Mouth/Caller packages, release APK installed on the S21. Checked on the phone (the steps of `app/check.sh`): `grant.sh dev.bobby.app` all granted, `push-config.mjs` sent the `.env`, Mind switched off, `drive.mjs` smoke script passes against the app's hub, opening the app logs "woke (came to front), moved to back" with the launcher in front, keep-alive foreground service runs with the microphone type, and after 75 s with the screen off the Mouth and Caller are still connected (`peers`). **Job 2 "Done when" met** (Mind/Mouth can't do real work until their keys are pushed; see Needs the human).
- Stitched with Mind f52515e/9b60d5f and Mouth b0aea73/328cfdb and the full `.env` (2026-11-22 13:04): `app/check.sh` passes; on wake the real ElevenLabs session runs (heard/spoke work); the Mind's Anthropic key is rejected (401). Details in `app/MERGE-ISSUES.md`.
- Mouth backup: Extras 2 (real Caller), 3 (rest of `setup.mjs`), 7 (remaining tests) done and pushed in `mouth/`, all against stubs (no keys here).

## Doing now
- Nothing that doesn't need a person: see Needs the human.

## Open
1. With keys: run the real Mind + Mouth on the phone end to end (wake, notifications, Gmail reply by voice).
2. Mouth Extras 4, 5, 6 (need the phone + keys + a person); Extra 1 claimed by Wajeeh.
3. Then-keep-going leftovers: open a chat in Messages/WhatsApp to check field/send labels (would need a real conversation; reading only).

## Needs the human
0. **`ANTHROPIC_API_KEY` in the root `.env` is invalid** (the API answers 401). Get a working key from James C, put it in `.env`, then `node app/tools/push-config.mjs`. Until then the Mind can't answer, and a woken session doesn't go back to sleep by itself (force-stop the app, then `hands/tools/grant.sh dev.bobby.app`).
1. **For the final app to think and talk (stitching day):** the root `.env` on this Mac has only `HANDS_TEST_SENDER`. `app/tools/push-config.mjs` sends that file to the phone, so it needs these lines (by name; get the values from the teammates, never paste them in chat):
   - from James C (Mind): `ANTHROPIC_API_KEY`, `CONTACTS`
   - from Wajeeh (Mouth): `ELEVENLABS_API_KEY`, `ELEVENLABS_BOBBY_AGENT_ID`, and for real calls `ELEVENLABS_CALLER_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OWNER_NUMBER`, `CALL_ALLOWLIST` (leave `CALLER_DRY_RUN=1` until you choose to place a real call)
   Then run `node app/tools/push-config.mjs` with the phone plugged in.
2. Done, for the record: Gmail wasn't on any home screen, so Hands put it on a new home page 2 itself ("Add to Home" + drag). It also moved out of the app drawer's "Google" folder to drawer page 2; drag it back into the folder if you care. Setup checked: phone authorised over USB, screen lock Swipe, Gmail signed in, `HANDS_TEST_SENDER=Hamza Khan` in root `.env`.

## Try it yourself
- `cd hands/example && npx expo run:android`, then `hands/tools/grant.sh dev.bobby.hands`, then `node hands/tools/drive.mjs` and type `screen`.

## Decisions
- Library namespace is `dev.bobby.hands.lib` (Kotlin package stays `dev.bobby.hands`) because the test app's id `dev.bobby.hands` must differ from any library namespace.
- Services, permissions and `<queries>` live in the library manifest (merged automatically); the config plugin adds `usesCleartextTraffic` and `android.minSdkVersion=30`.
- `package.json` points at TypeScript source (`src/index.ts`), so the final app needs no build step.
- `screen_result` nodes carry an extra `hint` field (an empty field's hint, e.g. "Compose email"); `{text}` targets fall back to it after text/desc.
- `type` replaces the field's text (ACTION_SET_TEXT) rather than appending.
- Unknown role or no configured token: the hub closes with 4003.
- WebSocket server: `org.java-websocket` 1.6.0.
- Release builds: R8 broke `org.java_websocket` (VerifyError at hub start), so the package ships `consumer-rules.pro` keeping `org.java_websocket.**` and `dev.bobby.hands.**`.
- Waking: `TURN_SCREEN_ON` (appop granted by `grant.sh`) plus an invisible `WakeActivity` that calls `requestDismissKeyguard`, because Android 15 ignores `ACQUIRE_CAUSES_WAKEUP` without that permission.

## Contract questions
- None yet.
