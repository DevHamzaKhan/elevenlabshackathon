# Role: Voice (`android/voice/`, `voice-agent/`, `caller/` stretch) — James C

You build Bobby's voice surface: the shortcut that starts a conversation, the ElevenLabs realtime agent session on the phone, the client tools that delegate work to the Orchestrator, and the speaking of the Orchestrator's progress updates in Bobby's voice, with interruptions that feel natural. You **don't** build task logic: the agent delegates, the Orchestrator decides. Read `CLAUDE.md` and `CONTRACT.md` first.

- **Stack:** Kotlin module `:voice` inside the shared Android project (built on `:core`, see `android/core/API.md`), plus Python setup scripts in `voice-agent/`.
- **Accounts:** ElevenLabs (paid plan; voice cloning needed only for the stretch call). Picovoice and Twilio only for stretch items.
- **Device:** the S21 is busy with Exec. Use your own Android phone, or an emulator with the host microphone on. Ask the human which, once, in `STATUS.md`.
- If `:core` isn't pushed yet when you start, write a minimal local stand-in behind the same API shape and delete it when the real one lands.

## Human checklist (write to `android/voice/SETUP.md` with exact clicks from current docs; don't block on it)

1. **ElevenLabs, Bobby agent.** Create an agent using the realtime / lowest-latency conversational setup available. If a realtime speech-to-speech option is missing, say so in `STATUS.md` right away. Paste the prompt from `voice-agent/bobby-prompt.md`. Add the four client tools from `voice-agent/tools.json` (or let `voice-agent/setup.py` create them via the API, if the docs support that). Turn on interruptions. Copy the agent id into `android/local.properties` as `ELEVENLABS_AGENT_ID`.
2. **Agent access.** Keep the agent public for development (agent id only, no key on the phone). Note under Decisions; on stitching day decide whether to switch to signed URLs, which would need a contract change.
3. Optional, stretch: Picovoice "Hey Bobby" wake word; voice clone + caller agent + Twilio number for the call story.

## What to build

1. **`voice-agent/`**
   - `bobby-prompt.md`: Bobby is warm, brief, natural. He never claims to have started, finished or cancelled anything on his own. When the user asks for something on the phone he calls `start_task` and says a short acknowledgement ("On it"); when they change their mind mid-task he calls `amend_task`; when they say stop he calls `cancel_task`; for phone facts he doesn't know he calls `ask_orchestrator`. He treats context updates as things he knows without reading them out. When he receives a progress line to say, he says it in his own words, keeping the meaning, in one short sentence.
   - `tools.json`: the four client tools exactly as in the contract (names, params, descriptions that tell the model when to call each).
   - `setup.py` (single-file `uv` script, reads `ELEVENLABS_API_KEY` from root `.env`): creates or updates the agent's prompt and tools via the API if the current API supports it, so the config lives in git.
   - `fakes/hub.py`: single-file `uv` script, a pretend Orchestrator on 8765 speaking contract v2. Prints every frame. Acks every `request` within 300 ms, and on `task` streams a scripted sequence of `update`s (`step` × 5 then `done`) paced by your `spoken` acks. Typed commands: `update <text>`, `context <text>`, `hush`, `sleep`, `amend-ack`, `cancel-ack`, `fail`.
2. **`:voice` module**
   - **Entry points (the "shortcut")**, in this order: a Quick Settings tile, a launcher app shortcut ("Talk to Bobby"), and the Android assistant role (a minimal `VoiceInteractionService` so the user can make Bobby the default digital assistant and launch him with the system assistant gesture). Check on a Samsung what each actually triggers and note it under Decisions. Each one starts a session; pressing again while live ends it.
   - **Session**: on start, send `session live` and open an ElevenLabs conversation with the official Android SDK. Register the four client tools; each one sends the matching `request` through `HubClient("voice")`, awaits `request_ack` (≤ 1 s), and returns `note` as the tool result. On timeout return "I can't reach the phone controller right now."
   - **Transcripts**: forward each final user turn and each finished agent turn as `transcript`.
   - **`context`** → the SDK's contextual-update mechanism (silent to the user).
   - **`update` with `speak:true`** → Bobby says it. This is the hard part; spend your effort here. Requirements: start within 1 s when idle, in order, in the agent's voice, with `spoken started` / `done` / `dropped` for each. Approach: find the SDK's way to make the agent speak a supplied line (for example a user/system message the prompt treats as "say this"), measure latency over 20 runs and log p50/p95 in `STATUS.md`. If it can't hit ~1 s, write the problem and two concrete alternatives under Contract questions and keep the best working version.
   - **Queue**: spoken updates queue while Bobby is mid-sentence; if more than 2 pile up, merge or drop the oldest `step` lines (`spoken dropped`), never `done`/`failed`/`cancelled`/`question`.
   - **Interruptions**: when the user starts speaking over Bobby (SDK event for user speech / interruption), send `barge_in` once per interruption and clear the narration queue. The agent then hears the user and calls `amend_task`/`cancel_task` or just talks; the Orchestrator handles the rest.
   - **`hush`**: stop audio now, drop the queue. **`sleep`**: end the session, send `session asleep`. Backstop: end after 5 min with nothing heard and nothing from the hub. While asleep, answer every `speak:true` update with `spoken dropped`.
   - **Audio**: Bluetooth earbuds when connected (communication device routing, current API), speaker otherwise. Handle earbuds connecting mid-session.
   - **Foreground**: a microphone-type foreground service while a session is live, with a notification showing "Bobby is listening" and a Stop action (sends `cancel` if a task runs, then ends the session).
   - **`VoiceFeature`**: registers role `voice`, lists `RECORD_AUDIO`, `BLUETOOTH_CONNECT`, post-notifications, and the assistant-role setting; exposes entry point "Talk".
   - **Status UI** inside the shared app via the entry point: state line (idle / live / speaking / disconnected), last heard, last said, latency of the last spoken update.
3. **Unit tests**: tool → `request` mapping, `update` queue rules (order, merge/drop, never drop endings), `hush`/`sleep`/asleep behaviour, JSON round-trip of every contract example Voice sends or receives.
4. **`android/voice/check.sh`**: unit tests, `./gradlew :app:assembleDebug`, then `fakes/hub.py --selftest` (an internal client exercising ack/update/spoken flow).

## Order (commit after each)

1. `voice-agent/fakes/hub.py`, prompt and tools files.
2. Shortcut → session live → talking to the agent through the phone; `transcript`s arrive at the fake hub.
3. Client tools: "open Gmail" makes the agent call `start_task`; the fake hub prints the `request`, the agent says the ack.
4. Spoken updates: the fake hub's scripted steps are spoken in order with `spoken` acks; latency measured.
5. Interruptions: talk over Bobby → `barge_in`; "actually make it 4" → `amend_task`; "stop" → `cancel_task`; `hush` cuts him off mid-word.
6. `sleep`, backstop timer, earbuds.

## Done when

Pressing the Quick Settings tile starts a conversation through the earbuds; "reply to Sarah, tell her 3 works" reaches the fake hub as `request intent:"task"` and Bobby acknowledges; the fake hub's step updates are each spoken within ~1 s with `spoken` acks; talking over him sends `barge_in`, "actually make it 4" sends `amend`, "stop" sends `cancel`; `hush` cuts him off mid-sentence; `sleep` ends the session cleanly.

## Then keep going

- Latency: pre-warm the session on shortcut press; reuse connections; measure end-to-end from user's last word to first narrated audio.
- Natural narration: let Bobby fold short consecutive steps into one sentence; keep the "why".
- Wake word ("Hey Bobby") with Picovoice as an extra entry point, key and keyword file from `local.properties` and `private/`.
- **Call story** (`caller/`, `uv run caller`): connects as `caller`, checks `CALL_ALLOWLIST`, places an outbound call through ElevenLabs' Twilio integration with the cloned-voice caller agent and the call's `goal`/`context`, sends `call_status`, fetches the transcript at the end, writes a 1–2 sentence summary, sends `call_result`. `CALLER_DRY_RUN=1` fakes calls. Test by calling the human's own phone, once per run.

## Stitching day

See `INTEGRATION.md`. Your README must give: how to set the agent id, how to start a session without the shortcut (adb intent), and how to re-run `voice-agent/setup.py` if the prompt changes.
