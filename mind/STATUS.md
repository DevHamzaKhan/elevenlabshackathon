# Mind: status (James C, 10x)

## v2 rebuild on OpenAI (2026-11-24, worktree branch, not pushed)
Milestones from James's brief: M1 model layer, M2 shortcuts, M3 queue+goals, M4 grounded multi-action executor, M5 escalation, M6 voice front end (Mouth), M7 recipes, M8 caller, M9 voice comparison.
- M1 done: `src/model.ts` is an OpenAI Responses API client over plain fetch (no SDK), strict JSON-schema outputs, developer-message prefix for implicit prompt caching (`prompt_cache_key` per role), per-role model + reasoning effort from env (`MIND_ROUTER_MODEL`/`MIND_EXEC_MODEL`/`MIND_ESCALATE_MODEL`, `MIND_*_EFFORT`), image input for escalation, one retry on 429/5xx/timeout. `@anthropic-ai/sdk` removed. `test/model.test.ts` (fake fetch).

## Done
- (Hamza, at his request, 2026-11-22) One command per press, from the first real-phone run (every `heard`, room chatter included, started a decide that cancelled the running task, so nothing got past "press home"; narration queued up and played minutes late). Now: `wake` opens a listening window; `heard`s in it are collected and decided once, joined, after 1.5 s of quiet (`timing.commandMs`); the window then closes, and any `heard` until the next `wake` is logged as ignored and can't touch a running task. A window with nothing heard closes after 8 s (`listenMs`). Instant "stop" still works inside a window (it also drops a command still being collected). A new press can still replace or stop a task. Narration: at most one `say` outstanding; a step line that would queue behind an unfinished one is skipped, except the Send line and the final result line, which wait up to 4 s (`sayWaitMs`) for the previous line. A decide opening line over 8 words is dropped, and the prompt asks for only the first action ("Finding Gmail."). Sleep never fires during a listening window or while a decide is in flight. Fake Mouth: `hear()` is a press (always sends `wake`), `hearMore()` / `!more` sends `heard` with no press. New `test/press.test.ts` (6 tests). Also: the stale-screen re-read check is now `>=` staleMs, so a tap chosen in the same millisecond as the read is still re-checked when `staleMs` is 0 (the stale-tap test raced once steps stopped waiting for speech). 41/41 pass.
- (Hamza, at his request, 2026-11-22) Friend tone and push-to-talk: prompts make Bobby narrate only the current step in a few casual words ("Finding Gmail." "Drafted it." "Sending.") and never the end goal early; small repeat actions say nothing; no follow-up questions (missing subject/wording is filled in); speech not meant for Bobby is a silent chat. Sleep: after a chat answer, a finished task or call, or a model error, the session ends 3 s later (`sleepSoon`); idle `sleepMs` 20 s -> 10 s. Stall line is "One sec." 35/35 tests pass.
- **Fakes** (`fakes/`): pretend hub + phone (3 home screens, Google folder on page 2, Gmail on page 3, inbox → email → reply → sent, notification shade, pop-ups), pretend Mouth, pretend Caller. Contract rules: hello/welcome, `peers`, `wire` mirroring, 4001 replacement, 4003 with `--strict-token`, routing by `to`.
- **Brain** (`src/`): decide (chat / task / call / cancel / sleep) per `heard`; plan published; step loop (screen → model → `say` + `act` at the same instant → wait for both; the next model call runs while Bobby is still talking); scenic route; re-plan and recovery; give-up limits; notifications digest on `wake`; email sent without confirmation after a one-line summary; calls via `CONTACTS`; instant "stop" (hush, cursor hidden, cancelled, whisper); cheap rule-based corrections (false "done", call claims, wrong time); `sleep` after 20 s idle; timeouts 10 s / 15 s / 3 min; peers checks; hints.
- **One door to the model** (`src/model.ts`): `claude-opus-5-5`, `output_config.effort: medium`, structured JSON output, cached system prompt, `fallbacks: "default"` with `server-side-fallback-2026-07-01`, refusal check, non-streaming (React Native fetch can't stream). Every request/response and its duration go to `config.log`.
- **`npm run story` PASSES** (8/8): digest on wake, "what did I miss?", email task ends sent on the fake phone, call summary spoken, "stop" cancels in 0.3 s.
- **`npm test`**: 21 tests, model stubbed (email story, digest, stop, phone not ready, calls, sleep, corrections, no-Mouth, contract examples, hub close codes). **`check.sh`** passes without an API key.
- **Expo Go proof** (`example/`): the package runs in Expo Go (SDK 58.0.26) on an Android 15 emulator: a real model call (2.5 s first, 1.7 s second) and a hub connection. Screenshot `example/proof.png`. MERGE.md "Running inside Expo" lists what the final app needs (Metro `watchFolders`/`nodeModulesPaths` for `file:`, a dev-build React Refresh shim for the SDK's circular imports, `expo-build-properties` cleartext for release builds).
- **"Done when" is met.**
- README.md, MERGE.md.
- **Review pass (second session):** five bugs reproduced against the fakes and fixed, plus hardening for the real phone. Each has a regression test in `test/fixes.test.ts` (35 tests in all). See "Review fixes" below.
- Backing up Stage: extras 1 (hints for six apps), 2 (app icon), 3 (README draft + architecture diagram), 5 (cursor preview) and two experiments (voice-cursor timing strip, record button) done. Details in `stage/STATUS.md`.

## Doing now
- Nothing. Review fixes are pushed; `check.sh` and `npm run story` (8/8) pass.

## Open
1. Tune against Hamza's real Hands hub once the phone build is up (real screens have many more nodes and real labels). Needs the phone, so it waits for stitching day.
2. Stage extra 4: fix hints from `hands/HINTS-CHECK.md` once Hands writes it (it doesn't exist yet).
3. Optional Stage experiments not done: phone-shaped cursor panel, sound effects, hints for more apps.

## Needs the human
- **Add `OPENAI_API_KEY` to the root `.env`** (the Mind now runs on OpenAI; `ANTHROPIC_API_KEY` is no longer read). Nothing real has been called yet: every v2 check runs against fakes.
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
- With all 8 hint files (7.3k-token cached prefix) step calls stay at ~1.3–1.9 s. Final run: story 8/8 in 68 s; step avg 1.9 s (max 2.7 s), decide avg 2.9 s (max 4.1 s); email task 9 actions, 31 s.
- Call lines: the start line now carries the reason ("I'm calling Alex to tell him you're running late"), and the summary isn't prefixed twice with the name.

## Review fixes (what was wrong, what changed)
1. **"Stop" before the task started was ignored.** Saying "stop" while the model was still deciding left the task to start anyway. Now every stop bumps an epoch, and a decision made before it is dropped; Bobby is hushed and told nothing was started.
2. **Stop waited for the model.** Cancelling during a step's model call took as long as the call (up to 45 s with retries). The model call, the screen read and the wait for Bobby's line are now abandoned the moment the task is cancelled. Only the action already in flight is waited for, as the brief says.
3. **A second wake repeated old notifications as new** (`slice(-0)` returns everything). Fixed.
4. **False corrections.** (a) A true time from another source was "corrected" ("The time is 3:20, not 3" after Sarah's email said 3). A time is now wrong only if it appears nowhere in what the Mind knows or has told Bobby. (b) Bobby rephrasing a line he was given ("I've sent Sarah…") could be read as a false "done" claim. Lines that arrive while one of the Mind's `say`s is being spoken are now treated as that line, unless the user has just spoken. The "done" pattern is tighter ("Sarah sent you an email" no longer matches). (c) New: naming the wrong person for a call or message is corrected ("It's Alex, not Sam"), as the brief asks.
5. **The model couldn't see parts of real screens.** Hands sends an empty field's placeholder in an extra `hint` field, which was ignored (Gmail's search and reply boxes showed as "(no label)"). And the 80-node cap cut from the bottom, so "Reply" vanished on long pages. Now `hint` is shown, and on crowded screens every tappable/editable node is kept and plain text is trimmed first. The fake phone now sends `hint` the way Hands does.
6. **Taps on a stale screen.** The screen is read before the model thinks and Bobby speaks; Hands taps the remembered position of node `n`. If more than 2.5 s have passed, the Mind now reads the screen again just before a tap, finds the same target by label, class and position, and re-plans if it is gone.
7. **Slow to notice a part dropping.** Waits on Hands, the Mouth and the Caller are released as soon as `peers` shows them gone, and all waits when the hub connection drops; a task whose Hands vanished ends in about a second with "I've lost touch with the phone".
8. **Small things.** "Bye" gives Bobby 2.5 s to answer before `sleep`. Request ids carry a random session part, so a late reply to an old Mind can't match a new request. The system prompt uses the 1-hour cache life.

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
- Tried and backed out: putting the hints first as a cache block shared by "decide" and "step" calls. The reply schema is part of the cached prefix, so calls with different schemas never share an entry (measured: `cache_read=0` on the first step after a decide).
- The stale-screen re-read only happens for actions aimed at a node, and only when the read is older than 2.5 s (`timing.staleMs`), so quick steps don't pay for a second read.
- A `spoke` that arrives during one of the Mind's own lines is not checked for false claims. That leaves a small blind spot (Bobby ad-libbing mid-narration), chosen over the likelier harm of correcting a correct narration.
- The Expo example's ping uses effort `low`; every Mind request uses `medium` (or `MIND_EFFORT`).
- Kept the official SDK (the brief asks for it) even though its circular imports need a dev-build shim in Expo; the shim is documented in MERGE.md and isn't needed in release builds.

## Contract questions
- Hands sends an extra `hint` field on nodes (an empty field's placeholder). The Mind now reads it. Worth adding to the contract's `screen_result` so the other parts know.
- There is no Mind → Caller message to hang up a call in progress. "Stop" during a call can only tell Bobby. Suggest `{"type":"hangup","to":"caller","re":"m9"}`.
