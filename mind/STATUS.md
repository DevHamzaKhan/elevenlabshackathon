# Mind: status (James C, 10x)

## Done
- **Fakes** (`fakes/`): pretend hub + phone (3 home screens, Google folder on page 2, Gmail on page 3, inbox → email → reply → sent, notification shade, pop-ups), pretend Mouth, pretend Caller. Contract rules: hello/welcome, `peers`, `wire` mirroring, 4001 replacement, 4003 with `--strict-token`, routing by `to`.
- **Brain** (`src/`): decide (chat / task / call / cancel / sleep) per `heard`; plan published; step loop (screen → model → `say` + `act` at the same instant → wait for both; the next model call runs while Bobby is still talking); scenic route; re-plan and recovery; give-up limits; notifications digest on `wake`; email sent without confirmation after a one-line summary; calls via `CONTACTS`; instant "stop" (hush, cursor hidden, cancelled, whisper); cheap rule-based corrections (false "done", call claims, wrong time); `sleep` after 20 s idle; timeouts 10 s / 15 s / 3 min; peers checks; hints.
- **One door to the model** (`src/model.ts`): `claude-opus-5-5`, `output_config.effort: medium`, structured JSON output, cached system prompt, `fallbacks: "default"` with `server-side-fallback-2026-07-01`, refusal check, non-streaming (React Native fetch can't stream). Every request/response and its duration go to `config.log`.
- **`npm run story` PASSES** (8/8): digest on wake, "what did I miss?", email task ends sent on the fake phone, call summary spoken, "stop" cancels in 0.3 s.
- **`npm test`**: 21 tests, model stubbed (email story, digest, stop, phone not ready, calls, sleep, corrections, no-Mouth, contract examples, hub close codes). **`check.sh`** passes without an API key.
- **Expo Go proof** (`example/`): the package runs in Expo Go (SDK 58.0.26) on an Android 15 emulator: a real model call (2.5 s first, 1.7 s second) and a hub connection. Screenshot `example/proof.png`. MERGE.md "Running inside Expo" lists what the final app needs (Metro `watchFolders`/`nodeModulesPaths` for `file:`, a dev-build React Refresh shim for the SDK's circular imports, `expo-build-properties` cleartext for release builds).
- **"Done when" is met.**
- README.md, MERGE.md.
- Backing up Stage: extras 1 (hints for six apps), 2 (app icon) and 5 (cursor preview) done.

## Doing now
- Stage extra 3 (README draft + architecture diagram), then more tuning.

## Open
1. Stage extra 3 (README + diagram), then extra 6 experiments (timing strip).
2. Tuning against a real Hands hub once Hamza's phone build is up (screens with many more nodes, real labels).

## Needs the human
- Nothing blocking. Root `.env` has `ANTHROPIC_API_KEY`, `CONTACTS` (Hamza) and a generated `HUB_TOKEN`.
- Your working copy of `env/mind.env` (a committed template) holds your real API key. It is not committed; please clear it there and keep the key only in the root `.env`, so nobody `git add`s it by accident.

## Try it yourself
- `cd mind && npm install && npm run story` (about 70 s, uses the real model, prints PASS/FAIL and the log path).
- `npm run story -- --flaky --flaky-rate 0.35 --only email` to watch it recover from failed taps and pop-ups.
- By hand: `npm run hub`, `npm run mind`, `npm run caller`, `npm run mouth` in four terminals, then type to the mouth.

## Tuning notes (what changed, how the numbers moved)
- Baseline story run: step calls avg 1.9 s (max 2.3 s), decide avg 2.9 s (max 3.7 s), with the 6.1k-token system prompt (instructions + hints) read from cache on every call after the first. Email task: 9 actions, 30 s end to end including speech.
- Pipelining: the next screen read and model call start as soon as `act_result` arrives, while Bobby is still speaking; the next `say`/`act` waits for `say_done`. Steps are paced by speech, not by the model.
- Flaky phone at 35% faults: first version gave up after a stuck pop-up and avoided retrying a timed-out "Reply" (switched to "Reply all"). Now: one retry allowed after a `timeout`, "prefer the obvious target", and "a pop-up that keeps coming back is not a reason to stop". Two runs at 35%: both pass (17 and 22 actions).
- Opening line: right after deciding on a task, Bobby speaks a one-line plan ("I'll open Gmail, find Sarah's email and tell her 3 works.") while the first step is computed, instead of ~2 s of silence.
- Latency spike: one step call took 21 s for 87 output tokens (server side). Each attempt now times out at 15 s (decide 20 s) and the SDK retries; if a step takes over 7 s, Bobby says "Give me a second" once per task.
- With all 8 hint files (7.3k-token cached prefix) step calls stay at ~1.3–1.9 s.
- Call lines: the start line now carries the reason ("I'm calling Alex to tell him you're running late"), and the summary isn't prefixed twice with the name.

## Decisions
- Structured outputs (`output_config.format`) instead of tools: each call needs exactly one JSON answer, and forced `tool_choice` isn't allowed on this model.
- Each step call is stateless (cached system prompt + one user turn with task, plan, last 10 actions and the screen), rather than a growing conversation: keeps requests small and latency flat.
- The plan is written in the same call that decides to start a task, saving one model call per task.
- Corrections are rule-based (no model call), as the brief asks for a cheap check. Lines the Mind itself gave Bobby are skipped.
- "stop"/"cancel" with 8 words or fewer is caught before the model. A stop during a call only whispers Bobby, because the contract has no way to hang up.
- `hints`: the laptop runner skips `TO-CHECK.md`.
- Fakes use `ws` for the server; clients use the global `WebSocket`. The package is `"type": "module"`; laptop scripts run with `tsx`.
- `npm run story` adds an invented `Alex=+14155550123` to `CONTACTS` if Alex isn't there; the fake Caller dials nothing.
- `startMind` also accepts optional `model` and `timing` in `config` (extra fields), used by tests.
- The Expo example's ping uses effort `low`; every Mind request uses `medium` (or `MIND_EFFORT`).
- Kept the official SDK (the brief asks for it) even though its circular imports need a dev-build shim in Expo; the shim is documented in MERGE.md and isn't needed in release builds.

## Contract questions
- There is no Mind → Caller message to hang up a call in progress. "Stop" during a call can only tell Bobby. Suggest `{"type":"hangup","to":"caller","re":"m9"}`.
