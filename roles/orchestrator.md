# Role: Orchestrator (`mind/`) — Person A

You build the Python program on the Mac that is both the **hub** every part connects to and the **single task orchestrator** behind both the voice and text surfaces. It is the only part that starts, amends or cancels a task. Read `CLAUDE.md` and `CONTRACT.md` first.

- **Stack:** Python 3.12+, `uv`, `websockets` (or equivalent asyncio server). Run with `uv run mind`.
- **Accounts:** an OpenAI API key with billing. The team chose GPT-6.2 Sol in its "ultrafast" mode. Look up the exact model id and how the fast mode is requested in the current OpenAI docs; put them in `MIND_MODEL` and `MIND_MODEL_OPTIONS`. If that model isn't available on the key, use the best available fast model and note it under Decisions.
- **No phone needed.** You build and test against fakes.

## Architecture inside `mind/`

Keep these separate so each can be tested alone:

```
mind/
  src/mind/
    hub.py          sockets, auth, roles, newest-wins, wire mirror, peers. No task logic.
    bus.py          typed send/await helpers: await_reply(id, timeout), fan-out to surfaces
    orchestrator.py task state machine: idle → planning → running ⇄ paused(barge-in / question) → ended
    triage.py       chat `auto` requests → reply | task | amend | cancel
    planner.py      model calls: plan, next-action+narration, re-plan, summaries
    screen.py       screen_result → compact text for the model
    memory.py       recent notifications, conversation turns from both surfaces
    hints.py        loads HINTS_DIR/*.md
    llm.py          the only file that talks to OpenAI; stub-able
  fakes/            exec.py, voice.py, chat.py, caller.py
  tests/
  logs/             gitignored: every model request/response and every frame
```

## What to build

1. **Hub.** Everything in the contract's "Connecting" section: role paths, token (4003), version (4002), hello/welcome, newest-wins with 4001, any number of watchers, `wire` mirror of every frame after hello, `peers` on every change, and the on-connect snapshot for `watch` (peers + current task + plan). Also send `plan`/`step`/`task`/`peers` to `chat`.
2. **The three fakes**, each a small script that connects as a real client:
   - `fakes/exec.py`: a pretend phone with enough state for the scenic route: three home screens with Gmail on the third, a Gmail inbox with an email from Sarah Chen, an open email, a reply box, a Sent state. Answers `screen` and `act` from that state with realistic delays (glide 400–900 ms + settle). Honours `abort`. A key to inject a notification. Flags: `--fail-rate` to randomly fail actions, `--slow` to exceed timeouts.
   - `fakes/voice.py`: terminal. Lines typed as `task …`, `amend …`, `cancel`, `ask …` become `request`s with `via:"voice"`; `live`/`asleep` send `session`; `!` sends `barge_in`. Prints every `update`, `context`, `hush`, `sleep`, and answers each spoken update with `spoken started` then `done` after ~60 ms per character, or `dropped` after `hush`.
   - `fakes/chat.py`: terminal chat. Every line is a `request intent:"auto"` with `via:"chat"`; `/stop` sends `cancel`. Prints updates, plan checklists and step ticks.
   - `fakes/caller.py` (for the stretch call story): canned `call_status` sequence and `call_result` after a few seconds.
3. **Request handling and ack.** Ack every `request` within 300 ms, before any model call. Handle the four intents per the contract. A `task` during a running task: amend if same goal, else cancel and start new, and say so.
4. **Triage** for chat `auto`: one fast model call that returns one of `reply` (with text), `task` (with goal), `amend` (with change), `cancel`. Use notification memory and the unified conversation (chat messages plus voice `transcript` lines) as context, so "what did I miss?" and "actually make it 4" both work in text. Voice uses `ask_orchestrator` for the same path.
5. **The task loop.**
   - Plan: steps, each with `do` and `why`. Publish `task started` and `plan`.
   - Loop: `screen` → model picks **one** action plus **one narration line that includes the reason** → send `act` and `update {kind:"step"}` in the same tick → wait for `act_result` and (if `speak`) `spoken done|dropped` → publish `step` changes → repeat.
   - Scenic route to apps: go home and swipe across home screens reading each one for the icon, open a folder if needed. `launch` only as fallback after the scenic route fails.
   - On failure or an unexpected screen: re-read and re-plan instead of repeating the action. Give up after a sensible budget (e.g. 3 failed attempts at one step, 25 actions total) and end `failed` with a spoken reason.
   - End with exactly one `done`/`failed`/`cancelled` update. Hide the cursor.
6. **Interruptions** (the part that makes it feel seamless):
   - `cancel`: `hush` (if voice live), `abort` to Exec, cursor hidden, `cancelled` within 1 s, `context` to the voice agent saying what happened.
   - `amend`: acknowledge with an `info` update in one short line ("Got it, 4 instead of 3."), re-plan from the current screen, publish the new plan, continue. Don't restart work already done.
   - `barge_in`: let the current action finish, hold the next one up to 4 s waiting for a `request`. Apply it if it comes; otherwise resume. Drop now-stale queued narration with `hush`.
   - `question`: when genuinely ambiguous ("Which Sarah?"), ask once with a `question` update and wait for the next request.
7. **Surfaces and speech.** Send every `update` to both voice and chat. `speak:true` when the task came from voice or the voice session is live. On `session live`, send a `context` digest of recent notifications and any running task. Send `sleep` after ~20 s of no user speech with no task running.
8. **Notifications.** Keep the last ~50 in memory, digest them for `context` and for triage.
9. **Email story.** Bobby gives a one-line summary of the reply text, then sends without asking for confirmation.
10. **Hints.** If `HINTS_DIR` exists, load every `*.md` and add them to the planner's instructions as per-app navigation notes. Work fine when it's missing.
11. **Timeouts and absences.** 10 s for `act_result`, 6 s for `spoken`, 3 min for a call. Exec offline at task start → `exec_offline`. Exec drops mid-task → pause up to 15 s for reconnect, then `failed`. Never hang.
12. **Logging.** Every model request and response to `mind/logs/llm-<date>.jsonl`, every frame to `mind/logs/wire-<date>.jsonl`, so the human can tune prompts from real runs.
13. **Tests** (`pytest`, no API key needed; `llm.py` stubbed with scripted responses):
    - Hub: token 4003, version 4002, newest-wins 4001, wire mirror, peers, watch snapshot.
    - Full email story via voice and via chat against the fakes.
    - Cancel mid-task from each surface; amend mid-task; barge-in with and without a follow-up request; exec offline; act timeout; spoken timeout.
    - Every contract example the Orchestrator sends or receives round-trips through your models.
14. **`check.sh`**: tests, then a scripted run of the fakes with the stubbed model, asserting the ending `update` is `done`.

## Order (commit after each)

1. Hub + the three fakes. With no orchestrator logic, frames typed in one fake are visible on a `watch` client and in the wire log.
2. Request/ack + a **scripted** task (no model): `request task` drives the fake phone to Gmail by the scenic route with narration. Push this early: teammates can use `uv run mind --scripted` as a stand-in hub.
3. Real model: "open Gmail" from the fake voice, then from the fake chat.
4. Email story: "reply to Sarah and tell her 3 works", from both surfaces.
5. Cancel, amend, barge-in.
6. Notifications digest, triage replies ("what did I miss?"), hints, timeouts, tests.

## Done when

With `uv run mind` and the three fakes running:

- From fake chat: "what did I miss?" gets a `reply` digest; "reply to Sarah and tell her 3 works" runs a narrated task that ends with the fake phone showing the email as sent.
- From fake voice: the same task via `task …`, with every step update spoken (`spoken` acks received) and the cursor `act` sent in the same tick.
- Mid-task `amend make it 4` changes the reply text without restarting; mid-task `cancel` (or `/stop` in chat) ends `cancelled` within 1 s; `!` barge-in pauses and resumes.
- `check.sh` passes with no API key.

## Then keep going

- Prompt quality: read `logs/`, tighten the planner and narration prompts. Narration lines short (under ~12 words), always with the why, never robotic repetition.
- Screen description quality: group nodes by region, drop noise, mark the focused field and scrollables.
- Speed: overlap the next `screen` with speech where safe; cache plans for repeated goals; measure request→first-action latency and log it.
- Call story (stretch): "call Alex and tell him I'm running late" → `call` to the Caller, `info` updates on status changes, `done` with the summary.
- `--record` mode that writes a run to `stage/`-compatible `.jsonl` for the dashboard's replay (write it in `mind/logs/`; Stage can copy it).

## Stitching day

See `INTEGRATION.md`. Your README must say: how to set `HUB_TOKEN`, how to find the Mac's Tailscale name, and the one command to start the real hub.
