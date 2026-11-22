# Hands: status

## Done
- `bobby-hands` Expo module (Kotlin): accessibility service, hub on 127.0.0.1:8765, cursor overlay, notification listener, keep-alive foreground service, JS API (`configure`, `status`, `openSettings`, `moveToBack`, plus `startKeepAlive`/`stopKeepAlive`/`openedFromNotification`).
- Test app `hands/example` (id `dev.bobby.hands`) builds and installs on the S21; hub accepts token `dev`, hello/welcome/peers and `screen` work on the phone.
- 94 JVM unit tests (protocol, contract examples, node filter, target matching, hub routing) pass.
- On the phone: `screen`, `tap`, `long`, `point`, `swipe`, `type` (incl. Gmail's web-view reply body), `key`, `launch` all work; cursor glides before each action (seen in screenshots); notifications from `adb shell cmd notification post` arrive at the Mind; `hub-test.mjs` passes 11/11 against the real phone hub.
- `demo` passed from a cold start (2026-11-22 12:28): home → swipe to page 2 → Gmail → newest email from "Hamza Khan" → Reply → typed → Send. Gmail showed "Sent" and the reply in the thread. **Job 1 "Done when" met.**
- Laptop tools: `drive.mjs`, `fakehub.mjs`, `hub-test.mjs`, `grant.sh`, `check.sh`, README, MERGE.

## Doing now
- Job 2: final app on the phone (`app/check.sh`).

## Open
1. Final app `app/` installed on the phone, passing `app/check.sh`; swap in real Mind/Mouth as they land.
2. Mouth backup (open items in `mouth/STATUS.md`).
3. Then-keep-going list from `roles/hands.md` (hints check, other apps, scrolling, keyboard, app drawer, `image`, cursor feel, odd states).

## Needs the human
- Nothing right now. Note: Gmail wasn't on any home screen, so Hands put it on a new home page 2 itself (via "Add to Home" and a drag). Gmail also moved out of the app drawer's "Google" folder to drawer page 2 during that; drag it back into the folder if you care. Setup checked: phone authorised over USB, screen lock Swipe, Gmail signed in and off the first home screen, `HANDS_TEST_SENDER=Hamza Khan` in root `.env`.

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

## Contract questions
- None yet.
