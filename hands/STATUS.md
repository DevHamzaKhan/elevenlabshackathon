# Hands: status

## Done
- `bobby-hands` Expo module (Kotlin): accessibility service, hub on 127.0.0.1:8765, cursor overlay, notification listener, keep-alive foreground service, JS API (`configure`, `status`, `openSettings`, `moveToBack`, plus `startKeepAlive`/`stopKeepAlive`/`openedFromNotification`).
- Test app `hands/example` (id `dev.bobby.hands`) builds and installs on the S21; hub accepts token `dev`, hello/welcome/peers and `screen` work on the phone.
- 94 JVM unit tests (protocol, contract examples, node filter, target matching, hub routing) pass.

## Doing now
- Laptop tools (`tools/drive.mjs`, `fakehub.mjs`, `hub-test.mjs`, `grant.sh`), then tap/swipe/type/cursor checks on the phone.

## Open
1. Verify every `do` on the phone with screenshots; cursor glide visible.
2. Notifications forwarded; hub routing test against the real hub.
3. `demo` (scenic route to Gmail, reply) from cold start.
4. Final app `app/` with stand-ins (in progress in parallel).
5. Then-keep-going list from `roles/hands.md`.

## Needs the human
- Nothing right now. Setup checked: phone authorised over USB, screen lock Swipe, Gmail signed in and off the first home screen, `HANDS_TEST_SENDER=Hamza Khan` in root `.env`.

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
