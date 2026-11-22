# Role: Chat + Stage (`android/chat/`, `stage/`) — Wajeeh

You build the **text surface**: the chat screen where the user types instructions and watches the same agent work, plus **Stage**: the live dashboard, cursor art and per-app hints. Chat has no task logic of its own: every message goes to the Orchestrator as a `request`, and everything shown comes back as `update`, `plan`, `step` and `task`. Read `CLAUDE.md` and `CONTRACT.md` first.

- **Stack:** Kotlin + Compose module `:chat` in the shared Android project (built on `:core`, see `android/core/API.md`). Stage: plain HTML/CSS/JS with no build step, plus small `uv` Python scripts.
- **Accounts:** none.
- **Device:** an emulator or your own Android phone. The S21 belongs to Exec until stitching day.
- If `:core` isn't pushed yet when you start, write a minimal local stand-in behind the same API shape and delete it when the real one lands. Start on Stage meanwhile.

## What to build: Chat (`android/chat/`)

1. **`tools/fakehub.py`**: single-file `uv` script, a pretend Orchestrator on 8765 speaking contract v2 to `chat` and `watch`. Acks every `request` within 300 ms. Scripted behaviours: "what did I miss" → `reply`; anything with "reply"/"open"/"send" → a task with `task started`, a 5-step `plan`, `step`/`update` pairs ~1.5 s apart, then `done`; `cancel` → `cancelled`; a message mid-task → `info` "Got it, changing …" and a revised `plan`. `--voice-echo` also emits fake voice `transcript` lines so you can test the unified thread.
2. **Chat screen** (`ChatActivity`, plus a launcher shortcut "Chat with Bobby"):
   - Message list: user bubbles; Bobby bubbles for `reply`, `info`, `question` and the task ending; a **task card** per task with title, live plan checklist (pending / running / done / failed per step, each with its "why" on a second line) and the latest `step` narration beneath it. The card collapses to one line when the task ends.
   - Voice turns (`transcript` relayed by the Orchestrator, or `update`s for a voice-started task) appear in the same thread with a small mic badge, so voice and text read as one conversation.
   - Input: text field + Send. Every message is `request intent:"auto"`. While a task runs, a **Stop** button sends `intent:"cancel"`, and the input hint changes to "Change something or ask…" (typed text is still `auto`; the Orchestrator decides it's an amend).
   - Pending state: show a typing indicator from send until `request_ack`; show the ack's `note` if it fails (`exec_offline`, etc.).
   - Connection banner from `HubClient.state` and `peers` ("Phone controller offline" if `exec` is down).
   - The chat must keep working while the app is in the background for a task it started: it's fine to leave the chat screen, because Exec is driving other apps. Post a notification for `done`/`failed`/`question` when the chat screen isn't visible; tapping it returns to the thread.
   - Keep the last 200 messages on device (Room or a JSON file); restore on reopen.
3. **`ChatFeature`**: registers role `chat`, lists post-notifications, exposes entry point "Chat" (the shell shows it as the main button).
4. **Unit tests**: reducer from incoming messages to UI state (plan ticking, card collapse, ordering, unknown types ignored), JSON round-trip of every contract example Chat sends or receives.
5. **`android/chat/check.sh`**: unit tests, `./gradlew :app:assembleDebug`, a Compose UI test of the reducer-driven screen against recorded `fakehub` frames.

## What to build: Stage (`stage/`)

1. **`stage/dashboard/replay.py`**: single-file `uv` script, pretends to be the hub on 8765 for `/watch` and `/chat`, playing `stage/dashboard/story.jsonl` on a loop with realistic timing. Write `story.jsonl` yourself from the contract: voice session live, notifications context, the email reply task (started by voice, with plan, steps, an amend mid-way), a text-started task, a cancel, and the session going asleep.
2. **`stage/dashboard/index.html`**: one page on a projector, readable across a room. Connects to `/watch` using `?hub=…&token=…` from the URL; reconnects automatically.
   - **Conversation**: one thread of voice and chat (from `wire` copies of `request`, `transcript`, `update`), each with a mic or keyboard badge.
   - **Current task** title and status; **Plan** as the centrepiece, ticking as `step` arrives, with the why under each step; amendments highlighted when the plan is re-sent.
   - **Phone feed**: each `act` in plain words ("Tap Reply", "Swipe left") with its result.
   - **Peers** lights for exec, voice, chat, caller.
   - **Sync strip**: per step, the gap between the `update` and its `spoken done`, and between the `act` and its `act_result`, so the team can see whether voice and cursor land together.
3. **`stage/cursor/`**: three cursor designs, each an SVG plus a matching `cursor.xml` (48 dp, 48×48 viewport, hotspot at the centre), and `preview.html` showing all three gliding and tapping. Exec copies the chosen one.
4. **`stage/hints/`**: one short Markdown file per app (Gmail, Messages, WhatsApp, Chrome, Maps, Spotify, Settings), written as instructions to an assistant that only sees text labels and can tap them: what buttons are called, where they sit, what goes wrong. Add `TO-CHECK.md` listing labels you want verified on the real S21; Exec writes findings to `android/exec/HINTS-CHECK.md`. Read that file after each pull and fix your hints.
5. **`stage/readme/`**: draft project README: one-paragraph pitch ("an AI coworker on your phone, by voice or text"), architecture diagram (SVG and Mermaid) showing one Orchestrator behind two surfaces and one Exec, and the demo walkthrough.

## Order (commit after each)

1. `android/chat/tools/fakehub.py` and `stage/dashboard/replay.py` + `story.jsonl`.
2. Chat screen against `fakehub.py`: send, ack, task card with ticking plan, Stop.
3. Dashboard against `replay.py`.
4. Mid-task amend in chat, background notifications, persistence, unified voice thread.
5. Hints, cursor designs, README draft.

## Done when

- On an emulator with `fakehub.py`: typing "reply to Sarah and tell her 3 works" shows a task card whose plan ticks through to done with narration lines; typing "actually make it 4" mid-task shows the amendment and a revised plan; Stop ends it as cancelled; "what did I miss?" gets a reply bubble.
- `replay.py` + the dashboard plays the whole story clearly enough that someone who's never heard of Bobby understands what he's doing and why.

## Then keep going

- Quick-reply chips for `question` updates.
- A floating chat bubble (overlay) so the user can watch the phone being driven while chatting. Check current Android bubble/overlay rules first and note the choice under Decisions.
- Dashboard "record" button that saves the live stream as `.jsonl` for `replay.py`.
- A phone-shaped dashboard panel drawing the cursor from the `act` coordinates and the latest `screen_result` bounds.
- Sound cues (wake chime, done, failed) in `stage/sounds/`.
- More hint files.

## Stitching day

See `INTEGRATION.md`. Your READMEs must give: how to open the dashboard against the real hub, and how to open the chat from adb (`adb shell am start -n dev.bobby.agent/<chat activity>`).
