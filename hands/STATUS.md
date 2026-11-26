# Hands: status

## Done
- `bobby-hands` Expo module (Kotlin): accessibility service, hub on 127.0.0.1:8765, cursor overlay, notification listener, keep-alive foreground service, JS API (`configure`, `status`, `openSettings`, `moveToBack`, plus `startKeepAlive`/`stopKeepAlive`/`openedFromNotification`).
- Test app `hands/example` (id `dev.bobby.hands`) builds and installs on the S21; hub accepts token `dev`, hello/welcome/peers and `screen` work on the phone.
- 146 JVM unit tests (protocol, contract examples, node filter, target matching, hub routing, protocol additions, settle, intents, launch ranking) pass.
- On the phone: `screen`, `tap`, `long`, `point`, `swipe`, `type` (incl. Gmail's web-view reply body), `key`, `launch` all work; cursor glides before each action (seen in screenshots); notifications from `adb shell cmd notification post` arrive at the Mind; `hub-test.mjs` passes 11/11 against the real phone hub.
- `demo` passed from a cold start (2026-11-22 12:28): home → swipe to page 2 → Gmail → newest email from "Hamza Khan" → Reply → typed → Send. Gmail showed "Sent" and the reply in the thread. **Job 1 "Done when" met.**
- Extras: `screen` with `"image":true` adds a base64 JPEG (720 px wide) as `image`; a tap target hidden under the keyboard makes Hands hide the keyboard first; screen off / Swipe lock screen: any `screen` or `act` wakes the phone and clears the lock first (checked: dozing + locked → home screen); hints checked (`HINTS-CHECK.md`); web pages: a plain label repeating its parent's label over the same box is dropped (Chrome Wikipedia page 100 → 74 nodes), and a still-loading web view gets one 700 ms retry; `demo` falls back to the app drawer (pages and folders) when Gmail is on no home page (`drawer-gmail` checks that route alone: found and pointed at Gmail on the phone); cursor glide has a slight overshoot; `drive.mjs` `screen image [file]` saves the screenshot; scrolling inside a node checked (`swipe up` on Settings' list brings "Display" into view).
- Laptop tools: `drive.mjs`, `fakehub.mjs`, `hub-test.mjs`, `grant.sh`, `check.sh`, README, MERGE.

- **Job 2:** final app `app/` ("Bobby", `dev.bobby.app`) with the real Hands, Mind and Mouth/Caller packages, release APK installed on the S21. Checked on the phone (the steps of `app/check.sh`): `grant.sh dev.bobby.app` all granted, `push-config.mjs` sent the `.env`, Mind switched off, `drive.mjs` smoke script passes against the app's hub, opening the app logs "woke (came to front), moved to back" with the launcher in front, keep-alive foreground service runs with the microphone type, and after 75 s with the screen off the Mouth and Caller are still connected (`peers`). **Job 2 "Done when" met** (Mind/Mouth can't do real work until their keys are pushed; see Needs the human).
- Stitched with Mind f52515e/9b60d5f and Mouth b0aea73/328cfdb and the full `.env` (2026-11-22 13:04): `app/check.sh` passes; on wake the real voice session runs (heard/spoke work; the earlier voice vendor, since replaced by OpenAI); the Mind's Anthropic key is rejected (401). Details in `app/MERGE-ISSUES.md`.
- Side button: holding the side button wakes Bobby. Hands ships an invisible `AssistActivity` (ACTION_ASSIST), so the app can be the phone's digital assistant; on the S21 the side key's press-and-hold is set to the digital assistant, and Bobby (`dev.bobby.app`) now holds that role (was ChatGPT): `adb shell cmd role add-role-holder --user 0 android.app.role.ASSISTANT dev.bobby.app 0`. Checked with a real long-press of the power key: Bobby woke and the app went to the back. (The earlier Volume Up + Down chord is removed.)
- **Protocol additions (2026-11-24, for James C's Mind rewrite; README "Protocol additions"):** `caps`; `do:"open"` intents (mailto/sms SENDTO, tel DIAL, else VIEW; CALL becomes DIAL); `launch` label ranking (exact > prefix > word prefix > contains, launcher-visible on ties) and `app` in act_result; fresh `{n}` (`why:"stale"`) and accessibility-click fallback when a gesture is cancelled; `{id}`/`{key}` targets; node folding, `checked`/`disabled`/`focused`/`selected`/`password`/`id`/`key`/`scrollDirs`; `hash`, `since` (`same:true`), `compact`, `then_screen`, `fast`; event-driven settle (Settler: lock/condition, 400/150/2000 ms) plus a two-reads-agree check after window changes; secure lock → `locked:true` screen and `no_permission`/`locked` acts; screenshot hides the overlay, retries once on rate limit, `image_error:"secure"`; keep-alive wake lock renewed every 25 min; keyboard hidden with the soft-keyboard controller before Back; WebView by class; cover rule tolerant of taskbars/split screen. Checked on the `bobby_api35` emulator: `check.sh` PASS (146 unit tests, hub-test 14/14 on the device), `tools/v2.txt` and `tools/v2-emu.txt` pass (Maps/Chrome/Gmail opened by intent, stale tap, launch ranking, then_screen equals the next read, key stable across sessions, PIN lock reported, swipe lock still cleared, cursor absent from `image`).
- Mouth backup: Extras 2 (real Caller) and 7 (remaining tests) done and pushed in `mouth/`, all against stubs (no keys here).

- **Teaching by showing (James C's AI, at James C's request, 2026-11-26):** `observe` on/off and the `observed` stream (`Observe.kt`: `Recorder`, plain Kotlin, 8 unit tests in `ObserveTest`; glue in `HandsService`: event types added at run time, a debounced settled-screen reader on its own thread, auto-stop after 10 min and on shutdown), `launch` with `fresh:true`, and `observe` / `launch_fresh` in `caps_result.features`. Checked on the `bobby_api35` emulator (Android 15) with real injected touches in Google Contacts: clicks and text changes arrive after the run-time `setServiceInfo`, match their nodes (id, key, label), typing comes out as one frame, and the Mind's replay of the learned steps saved a new contact five runs in a row (`cd mind && npm run teach:phone`). 154 unit tests pass; `assembleDebug` builds.
- **Locked-phone unlock (James C, 2026-11-26):** side button on a PIN-locked phone wakes Bobby over the lock screen; on hearing the owner's phrase with their trusted earbuds connected, Hands types the PIN once (Keystore-encrypted, set up in a native FLAG_SECURE screen behind biometric/PIN confirmation; a failure disarms). Checked on the `bobby_api35` emulator with a temporary test PIN: `unlock-probe.mjs` finds the full keypad by id from both screen-off and lock screen (`how: icon`); the typing path unlocked with the right PIN and, with a wrong one, typed once (one failed auth), then disarmed. See README "Locked-phone unlock".

## Doing now
- Nothing that doesn't need a person: see Needs the human.

## Open
1. With keys: run the real Mind + Mouth on the phone end to end (wake, notifications, Gmail reply by voice).
2. Mouth Extras 4, 5, 6 (need the phone + keys + a person); Extra 1 claimed by Wajeeh.
3. Protocol additions, still to see on the S21 (only the emulator so far): `tools/v2.txt` and `tools/v2-emu.txt` (adjust app names), Samsung's `navigation_mode`/`gestureNav`, One UI transition timing with the new settle, the keyboard-controller hide (no emulator app put a target under the keyboard), the click fallback after a cancelled gesture, and `open mailto:` into a signed-in Gmail (opens a compose screen only; nothing is sent).
4. Observing on the S21 (emulator only so far): One UI apps and Samsung's keyboard (its package must be the one in `Settings.Secure.DEFAULT_INPUT_METHOD`, or key taps would be reported), Compose/Flutter/React Native apps (do their clicks carry a source node?), and scroll deltas from Samsung lists.
5. Then-keep-going leftovers: open a chat in Messages/WhatsApp to check field/send labels (would need a real conversation; reading only).

## Needs the human
0. **`ANTHROPIC_API_KEY` in the root `.env` is invalid** (the API answers 401). Get a working key from James C, put it in `.env`, then `node app/tools/push-config.mjs`. Until then the Mind can't answer, and a woken session doesn't go back to sleep by itself (force-stop the app, then `hands/tools/grant.sh dev.bobby.app`).
1. **For the final app to think and talk (stitching day):** the root `.env` on this Mac has only `HANDS_TEST_SENDER`. `app/tools/push-config.mjs` sends that file to the phone, so it needs these lines (by name; get the values from the teammates, never paste them in chat):
   - from James C (Mind): `ANTHROPIC_API_KEY`, `CONTACTS`
   - from Wajeeh (Mouth): `OPENAI_API_KEY`, and for real calls `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD`, `OWNER_NUMBER`, `CALL_ALLOWLIST` (leave `CALLER_DRY_RUN=1` until you choose to place a real call)
   Then run `node app/tools/push-config.mjs` with the phone plugged in.
2. Done, for the record: Gmail wasn't on any home screen, so Hands put it on a new home page 2 itself ("Add to Home" + drag). It also moved out of the app drawer's "Google" folder to drawer page 2; drag it back into the folder if you care. Setup checked: phone authorised over USB, screen lock Swipe, Gmail signed in, `HANDS_TEST_SENDER=Hamza Khan` in root `.env`.

## Try it yourself
- `cd hands/example && npx expo run:android`, then `hands/tools/grant.sh dev.bobby.hands`, then `node hands/tools/drive.mjs` and type `screen`.

- Locked-phone unlock on the S21: app settings → "Unlock when locked" → Set up (PIN, phrase, earbuds). Run `node hands/tools/unlock-probe.mjs` with the phone PIN-locked to check One UI's keypad is found (`keypad:true`). Then lock the phone, earbuds in, hold the side button and say the phrase.

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

- Protocol additions: act_result keeps v1 `detail` and adds `why` with the same text, so old and new Minds both read it.
- A secure-locked `screen` sends `nodes:[]` (not absent) so v1 readers that index `nodes` don't break; only `same:true` omits `nodes`, and only a Mind that sent `since` gets it.
- `checked:false` stays in compact output: for a checkable node it is information, not an empty default.
- Folding skips ancestors larger than a third of the screen and stops at 120 chars (the rest stay separate nodes), so a whole-screen clickable container can't swallow the page.
- `open` treats an empty `resolveActivity` as a hint only (package visibility can hide handlers) and relies on `ActivityNotFoundException` for `not_found`; `<queries>` cover the common schemes/actions so `app` is known early.
- The 150 ms quiet window ends mid-transition (slide-in animations send no accessibility events), so acts that changed a window, and launch/open, also wait until two reads 100 ms apart hash the same (bounded: 600 ms, 3.5 s for launch/open). Seen on the emulator: without it `then_screen` after `launch settings` had bounds 69 px off.
- Accessibility events narrowed to window state/content/windows changes: nothing else consumes events (notifications come from the NotificationListenerService), and since Android 9 the framework still delivers cache-critical events to keep node caches fresh.
- Keys bucket position on an 8 x 16 grid: identical on an unchanged screen, but a scroll that moves an element across a cell changes its key (use `id` or `text` across scrolls).

- Observing changes the service's event types at run time instead of in the XML: outside a lesson the service still hears only window changes, as before, and installing the update needs no new consent.
- A click is matched against the last **settled** screen, read 200 ms after the last change, not a fresh read: by the time the click event arrives the screen has usually already moved on.
- Tried and backed out: treating a full-screen window whose content is tooltip-sized as see-through. Google Contacts' tip looked like that case, but Android itself leaves the app window out of the accessibility window list while a modal tip is up, so the rule changed nothing. The Mind closes such tips instead.

## Contract questions
- The protocol additions above are additive and documented in README; James C's lead will write them into CONTRACT.md.
