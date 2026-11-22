# Mouth: status (Wajeeh, 1x budget: Core only)

## Done
- **Core done (live, in the emulator):** `setup.mjs` created/updated the Bobby agent in **Realtime** mode (`eleven_realtime_v1_mini`). Opening the test app starts a session and sends `wake`; a typed user turn arrives as `heard`; Bobby's answers arrive as `spoke`; a `say` is spoken in his voice with `say_started` 0.26–0.28 s after it was sent and `say_done` when he finishes; `hush` cuts him off mid-sentence; `sleep` ends the session with `asleep`. Run: `logs/live.script` against `fakes/hub.mjs`. 21 Node tests pass.
- Fixed from the live run: (1) a `say` that was waiting while the user spoke got the credit for Bobby's answer to the user; it is now re-sent after that answer. (2) The SDK reports "listening" in short pauses inside one turn, which ended `say`s early; "listening" now has to last 600 ms. (3) Bobby acknowledged `[SAY]` lines ("Got it, I'll help...") instead of narrating them; the prompt now makes them first-person narration.
- Core 3 (code): `src/hub.ts` (contract reconnect rules, 4001), `src/mouth.ts` (wake, held messages while starting, whisper, say queue with say_started/say_done, correct, hush, sleep, asleep rules, 5 min backstop, heard/spoke), `src/elevenlabs.ts` (the only ElevenLabs file), `src/index.ts` (`startMouth`, `startCaller`). 19 Node tests pass. Expo 58 test app in `example/` type-checks. Built (`npx expo run:android`) and run in the emulator: the app connects to the pretend hub as `mouth` and `caller`, reconnects when the hub restarts, answers a `say` while asleep with `say_done spoken:false`, and the dry-run Caller answers `call`. **A live voice session is still untested: no ELEVENLABS_API_KEY, so no agent id.**
- Core 4: dry-run `startCaller` (`src/caller.ts`).
- Read CLAUDE.md, CONTRACT.md v1, roles/mouth.md.
- Core 2: `agent/setup.mjs` + `agent/bobby-prompt.md`: creates/updates the public "Bobby" agent, tries Realtime (`MOUTH_REALTIME_MODEL`, default `eleven_realtime_v1_mini`) and falls back to the standard mode, writes the id to `.env` and `example/.env`. Dry run checked; **not yet run for real: no API key** (see Needs the human).
- Core 1: pretend hub `fakes/hub.mjs` (say, whisper, correct, hush, sleep, call, plus test-only `user`, `wait`, `expect`, `mark`). Smoke-tested from Node.

## Doing now
- Core is done. Stopped (1x budget). Extras are open to Hamza.

## Open
Core (Wajeeh's AI, in order):
1. Pretend hub.
2. `agent/setup.mjs` for the Bobby agent only.
3. The Mouth + Expo test app in the emulator (session, heard/spoke, whisper/say/correct/hush/sleep, reconnect).
4. Dry-run-only `startCaller`.
5. `npm test`, `check.sh`, `MERGE.md`.

Extras (open to the backup, Hamza's AI, from the start; claim with `(claimed: <name>)`):
1. Working from the back: the background test, with whatever it takes in `MERGE.md`.
2. The real Caller, `tools/caller.mjs`, tests with `fetch` stubbed, dry-run call in `check.sh`.
3. The rest of `setup.mjs`: voice clone, caller agent + `caller-prompt.md`, Twilio number import.
4. ~~Measuring the `say` delay~~: measured 0.26–0.28 s from `say` to `say_started` in the emulator (Realtime mode). Re-check on the real phone.
5. The 5 minute backstop and earbud routing.
6. A real call to the team's own Twilio number.
7. The remaining tests in item 6 of the brief.

## Needs the human
1. For the Extras only: `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (James C is sending them), a bought Twilio number, `OWNER_NUMBER` verified as a caller ID in Twilio, `CALL_ALLOWLIST` (a teammate who agreed to one test call), and 1–2 minutes of the owner talking in `mouth/private/`. Whoever builds the Extras (Hamza) needs these `.env` lines from Wajeeh: `ELEVENLABS_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OWNER_NUMBER`, `CALL_ALLOWLIST`.
2. The Bobby agent is called "Bobby" in the ElevenLabs workspace. One with that name already existed and was updated in place; if a teammate made it for something else, tell Wajeeh.
3. Privacy: with the emulator's host mic on, Bobby hears the room around the Mac and sends it to ElevenLabs. Keep it off (`adb emu avd hostmicoff`) unless you are doing the listen test.

## Try it yourself
- **Listen test** (after `node mouth/agent/setup.mjs` has run with your key): start the emulator with the host mic (`emulator -avd bobby -allow-host-audio`, then `adb emu avd hostmicon`), run `node mouth/fakes/hub.mjs --port 8766`, open the test app (`cd mouth/example && npx expo start --dev-client`, then `npx expo run:android`). Say out loud "Hi Bobby, how are you?": you should hear a short friendly answer, and the hub prints `heard` then `spoke`. Then type `say I'm looking for the word Reply to answer Sarah` in the hub: Bobby should say it within about a second, in his own words. Type it again and then `hush` straight away: he should stop mid-sentence.

## Decisions
- `@livekit/react-native-webrtc` pinned to exactly 144.1.2: 144.2.0 renamed its Java package and breaks `@livekit/react-native` 2.12.0.
- An empty `CALL_ALLOWLIST` allows no numbers.
- The pretend hub runs on port 8766 on this Mac, because another project holds 8765; the test app's `.env` points at `ws://10.0.2.2:8766`.
- `@elevenlabs/react-native` doesn't export an imperative API, so `elevenlabs.ts` imports it for its side effect (native WebRTC audio setup) and drives `VoiceConversation` from `@elevenlabs/client` (same copy, 1.37.1).
- `hush`: the SDK has no public interrupt for voice sessions, so hush sets the output volume to 0 until Bobby's turn ends, then restores it.
- LiveKit versions follow ElevenLabs' own Expo example (`@livekit/react-native` 2.x, webrtc 144.x); `@livekit/react-native-expo-plugin` pinned to ~1.1 because 1.2 needs LiveKit 3.
- `startMouth()` also returns `status()` (an extra, for test screens).
- Test-only hub message `test_user_turn` {text}: the Mouth sends it to the agent as a typed user turn and reports it as `heard`. The real Mind never sends it.
- `say` and `correct` reach the agent as typed user messages tagged `[SAY]` / `[CORRECT]`, which `bobby-prompt.md` tells it to speak and never answer; `whisper` is a contextual update. The tagged messages are never forwarded as `heard`.
- Bobby's `first_message` is empty: the Mind decides what he says first.
- Laptop tools (fake hub, setup script, tests) are Node `.mjs`/TypeScript run with `tsx`; the package itself is plain TS with no build step.

## Contract questions
- None yet.
