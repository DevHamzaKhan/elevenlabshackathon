# Mouth: status (Wajeeh, 1x budget: Core only)

## Questions from the Mind (James C's AI, 2026-11-26, at James C's request; branch `t3/tibby-clarifying-questions`, in a pull request)
- `ask_request` from the Mind (`mind/PROTOCOL-V2.md`): Bobby reads the line the Mind sends ("Which Alex? Option one: Alex Chen. Option two: Alex Kim."), the mic opens at once and again when he has finished reading (so its 12 s limit starts after the options, not before), and the voice model is given the question and numbered options as context. New sixth tool `answer(id, option, text)` → `ask_reply` with the voice model's pick, its wording and the raw transcript since the question was asked (never the earlier request; empty if the transcript hasn't arrived). `voice_caps` now lists `answer`. No `barge_in` while a question is out; a question is dropped when its task ends or the session sleeps. `task_update` status `waiting_answer` counts as an active task.
- `src/realtime.ts`: the `answer` tool and one instruction line (ask it as given, never answer for the user, never add options).
- Checks: 4 new tests in `tests/v2.test.ts` (79 pass after the rebase onto teaching); `tools/integration-with-mind.mts` now also runs a question round trip with the real Mind in both passes (24/24); `SKIP_BUILD=1 ./check.sh` passes. Not run: the Android build (TypeScript only, no native change) and a real voice session (no key here).
- Try it yourself: with two contacts that share a first name in `CONTACTS` (`Sam Lee=+1...,Sam Park=+1...`), say "text Sam I'm running late". Bobby should ask "Which Sam?" with both options; answer "the second one", or "Park", or something else entirely.

## v2 rebuild on OpenAI (James C's AI, 2026-11-24, authorized by James C; worktree branch, not pushed)
- M6 done (code + Node tests; nothing real called, no OPENAI_API_KEY here): the voice vendor sits behind one file. `src/openai.ts` (React Native only) runs **OpenAI Realtime over WebRTC** with `@livekit/react-native-webrtc` (already in the app) and routes audio Bluetooth-first with `@livekit/react-native`'s AudioSession; `src/realtime.ts` (plain TS, tested) builds the session (Bobby's instructions, five tools, semantic VAD, input transcription), mints the ephemeral client secret from `OPENAI_API_KEY` on the phone, exchanges SDP with `/v1/realtime/calls`, and translates server events. `MOUTH_VOICE_MODEL` (default `gpt-realtime-2.1-mini`), `MOUTH_VOICE` (default `marin`), `MOUTH_TRANSCRIBE_MODEL` (default `gpt-live-transcribe`).
- Protocol v2 in `src/mouth.ts` (see `mind/PROTOCOL-V2.md`): `voice_caps` before each `wake`; tool calls become `request`/`amend`/`cancel`/`confirm_reply`/`status` (with the raw transcript in `heard`); `progress` (silent/when_idle/interrupt), `confirm_request` (asked aloud, mic reopened), `task_update`, `status_result` from the Mind; `barge_in` when the user talks during a task. v1 `say`/`whisper`/`correct`/`hush`/`sleep` unchanged. `tests/v2.test.ts` (11 tests); `tools/integration-with-mind.mts` runs the real Mind + real Mouth with the v2 tools and is part of `check.sh`.
- M8 done (code + stubbed tests; no real call placed): `src/caller-live.ts`, the Caller: GPT-Live (`CALLER_MODEL`, default `gpt-live-1.1`, stock voice `CALLER_VOICE`) dials out over a SIP trunk via `POST /v1/live/sessions` (transport sip, digest auth, `OWNER_NUMBER` as caller number), attaches the sideband WebSocket, maps transport.ringing/answered/failed and session.closed to `call_status`, says an exact AI disclosure on answer (`session.instructions.append`), hangs up on the model's end-of-call delegation, on the Mind's new `{"type":"hangup","re"}`, or after 5 min, and summarizes with `CALLER_SUMMARY_MODEL` (default `gpt-6-luna`) or their own words. Allowlist and `CALLER_DRY_RUN=1` default unchanged; the dry run also honours `hangup` and its canned transcript starts with the disclosure. No bridge: outbound SIP needs no public endpoint. `tests/caller-live.test.ts` (5) + a hangup test; 70 Node tests pass.
- M9 done: `VOICE-VENDORS.md` compares gpt-realtime-2.1-mini / gpt-realtime-2.1 / gpt-live-1.1 with ElevenLabs (since removed) and Gemini Live (latency claims, barge-in, tool behaviour while work runs, price per minute, session limits, React Native support, doc URLs) and records the decision (mini default, GPT-Live client delegation next). `tools/voice-bench.mjs` measures time to first audio and the tool-call round trip on a fixed script per target over WebSocket and writes JSON to `logs/`; only `--dry-run` has run (no key), and that is in `check.sh`.

## Done
- **ElevenLabs and voice cloning removed (2026-11-26, at James C's request).** Gone: `src/elevenlabs.ts`, `agent/` (`setup.mjs`, `bobby-prompt.md`, `caller-prompt.md`), the ElevenLabs/Twilio-REST caller in `src/caller.ts`, `tests/setup.test.ts`, the `@elevenlabs/*` packages in `app/` and `example/`, and the `MOUTH_VOICE_VENDOR`/`CALLER_VENDOR` switches. The Mouth is OpenAI Realtime and protocol v2 only: it always sends `voice_caps` before `wake` and speaks every line with the session's `speak()` (no `[SAY]`/`[CORRECT]` tagged messages). Real calls always go through `src/caller-live.ts` (GPT-Live, stock voice, AI disclosure). The Mind's own v1 fallback is unchanged.
- (Hamza, at his request, 2026-11-22, from the real phone's logcat) **No stale narration, push-to-talk.**
  - `say`s piled up (started 70–139 s late). Now only the newest waits: a new `say` drops every queued, not-yet-sent `say` (`say_done spoken:false`), and any `say` not started within 4 s of arriving (`sayStaleMs`) is dropped the same way. A `say` on an idle Bobby is spoken at once.
  - Push-to-talk: `wake()` opens the mic (`setMicMuted(false)`, logs `listening`). After the first final user transcript, 1.8 s (`micCloseMs`) with no further final transcript closes it (`setMicMuted(true)`, logs `mic closed`). Each transcript in that window is its own `heard`. While the mic is closed no `heard` is sent. Bobby keeps speaking `say`s. `wake()` while live reopens the mic for one more command. The mic stays open until the user speaks. Tests in `tests/mouth.test.ts`.
- **Extra 1, working from the back (Wajeeh):** without a microphone foreground service Android froze the test app ~8 s after Home (hub sockets dropped). With one (test app: `react-native-background-actions` + `example/plugins/withMicForegroundService.js`), Bobby still hears and speaks after Home, right away and 60 s later, then sleeps cleanly. In the final app Hands' keep-alive is that service; `MERGE.md` §5 says what the app must do (grant RECORD_AUDIO first; startKeepAlive → wake → moveToBack).
- **Integration with the other parts (laptop):** `tools/integration-with-mind.mts` runs the real Mind (stand-in model) on the Mind's fake hub and phone with the real Mouth and Caller code: wake → request → confirm → email sent on the fake phone → call through the Caller → a question with options. The real package also type-checks against `app/src/types.ts` (`PartConfig` → `MouthHandle`, `Stoppable`).
- Noise-only transcripts like "..." are not sent as `heard`.
- **Tests (Hamza's AI):** dry-run Caller and `hangup` (`tests/caller.test.ts`), contract examples from "Connecting"/"Routing" (hello, welcome, peers), and the Caller's frames against the contract's shapes.
- **Core (Wajeeh):** the `say` queue with `say_started`/`say_done`, `hush`, `sleep` → `asleep`, reconnect, held messages while starting, the 5 min backstop and `heard`/`spoke` were proven live in the emulator against `fakes/hub.mjs` (`logs/live.script`), on the earlier voice vendor. Fixed from that run, still in `src/mouth.ts`: a `say` that was waiting while the user spoke is re-sent after Bobby's answer; "listening" has to last 600 ms before a turn counts as over. **The OpenAI voice has not been heard live yet** (no `OPENAI_API_KEY` here).
- Core 3 (code): `src/hub.ts` (contract reconnect rules, 4001), `src/mouth.ts` (wake, held messages while starting, whisper, say queue with say_started/say_done, correct, hush, sleep, asleep rules, 5 min backstop, heard/spoke), `src/openai.ts` (the only file that talks to OpenAI Realtime from the phone), `src/index.ts` (`startMouth`, `startCaller`). Expo 58 test app in `example/`. In the emulator the app connects to the pretend hub as `mouth` and `caller`, reconnects when the hub restarts, answers a `say` while asleep with `say_done spoken:false`, and the dry-run Caller answers `call`.
- Core 4: dry-run `startCaller` (`src/caller.ts`).
- Core 1: pretend hub `fakes/hub.mjs` (say, whisper, correct, hush, sleep, call, plus test-only `user`, `wait`, `expect`, `mark`). Smoke-tested from Node.
- **`teach` tool (James C's AI, at James C's request, 2026-11-26):** the Realtime voice model gets `teach(action: start|done|cancel, text)` and a paragraph on when to use it ("I'm going to show you how to…"); the Mouth sends `{"type":"teach",action,text,heard}` and lists `teach` in `voice_caps.tools`. Not yet heard with a real voice session (needs `OPENAI_API_KEY`); if the voice model calls `request` instead, the Mind recognises the sentence itself.

## Doing now
- Core is done. Stopped (1x budget). Extras are open to Hamza.

## Open
Core (Wajeeh's AI): all done.

Extras (open to the backup, Hamza's AI; claim with `(claimed: <name>)`):
1. ~~Working from the back~~: done (Wajeeh), see Done and `MERGE.md` §5.
2. ~~The real Caller~~: done (`src/caller-live.ts`), against stubs. A real call is Extra 6.
3. Measuring the `say`/`progress` delay with the OpenAI voice, on the real phone.
4. The 5 minute backstop and earbud routing (`src/openai.ts` asks for Bluetooth first; untested on earbuds).
5. A real call to the team's own Twilio number through the SIP trunk: `CALLER_DRY_RUN=0 node mouth/tools/caller.mjs --hub ws://localhost:8766`, then type `call <bought number> Say hello` in the hub.
6. ~~The remaining tests~~: done (Hamza).

## Needs the human
- **Voice bench:** with `OPENAI_API_KEY` in the root `.env`, run `node mouth/tools/voice-bench.mjs --runs 3` and paste the table into `VOICE-VENDORS.md` (costs a few cents).
- **Calls:** set up a Twilio Elastic SIP Trunk with secure trunking (README "Caller on OpenAI") and put `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD` and `OWNER_NUMBER` in the root `.env`; optional `CALLER_OWNER_NAME` for the disclosure. Put a teammate who agreed to one test call in `CALL_ALLOWLIST`.
- **Voice:** add `OPENAI_API_KEY` to the root `.env` and push it to the phone (`npm run push-config` in `app/`). Then do the listen test below.
- Privacy: with the emulator's host mic on, Bobby hears the room around the Mac and sends it to OpenAI. Keep it off (`adb emu avd hostmicoff`) unless you are doing the listen test.

## Try it yourself
- **Listen test** (with `OPENAI_API_KEY` set for the test app, see README): start the emulator with the host mic (`emulator -avd bobby -allow-host-audio`, then `adb emu avd hostmicon`), run `node mouth/fakes/hub.mjs --port 8766`, open the test app (`cd mouth/example && npx expo start --dev-client`, then `npx expo run:android`). Say out loud "Hi Bobby, how are you?": you should hear a short friendly answer, and the hub prints `heard` then `spoke`. Then type `say I'm looking for the word Reply to answer Sarah` in the hub: Bobby should say it within about a second, in his own words. Type it again and then `hush` straight away: he should stop mid-sentence.
- **One call to a person** (after the SIP trunk is set up; the test contact's number in `CALL_ALLOWLIST`): run `node mouth/fakes/hub.mjs --port 8766`, then `CALLER_DRY_RUN=0 node mouth/tools/caller.mjs --hub ws://localhost:8766`, and type `call +1... Say I'm running 20 minutes late and ask if 3pm still works.` in the hub. The contact should see `OWNER_NUMBER`, hear the AI disclosure in a stock voice, then the question, and the call should end politely once they answer. The hub prints `call_status` dialing/answered/ended and one `call_result` with a short summary of what they said.

## Decisions
- Caller errors besides the contract's: `not_configured` (keys missing), `cancelled` (Caller stopped or `hangup`; the call is hung up).
- `check.sh`'s test-count line accepts both Node test reporters (TAP `# pass` on Node 22, `ℹ pass` on newer).
- `@livekit/react-native-webrtc` pinned to exactly 144.1.2: 144.2.0 renamed its Java package and breaks `@livekit/react-native` 2.12.0. `@livekit/react-native` stays on 2.x and `@livekit/react-native-expo-plugin` on ~1.1 (1.2 needs LiveKit 3).
- An empty `CALL_ALLOWLIST` allows no numbers.
- The pretend hub runs on port 8766 on this Mac, because another project holds 8765; the test app's `.env` points at `ws://10.0.2.2:8766`.
- `startMouth()` also returns `status()` (an extra, for test screens).
- Test-only hub message `test_user_turn` {text}: the Mouth sends it to the voice model as a typed user turn and reports it as `heard`. The real Mind never sends it.
- Laptop tools (fake hub, tests) are Node `.mjs`/TypeScript run with `tsx`; the package itself is plain TS with no build step.

## For Hamza (final app)
- `app/MERGE-ISSUES.md`'s Mouth items are resolved: `mouth/src/index.ts` exports `startMouth`/`startCaller`, `MERGE.md` lists installs, plugins, permissions and the foreground-service rule, and no React provider is needed (MERGE.md §6). `app/src/packages.ts` can switch from `../standins/mouth` to `bobby-mouth`.

## Contract questions
- None yet.
