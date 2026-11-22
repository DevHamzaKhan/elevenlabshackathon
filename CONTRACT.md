# Bobby wire contract, v2

Nobody edits this file unless the team agrees a change. When it changes, bump the version and note what changed at the bottom.

One hub, five kinds of client. The Orchestrator runs a WebSocket hub on the Mac. Every other part dials in to it. No part talks to another part any other way, including modules inside the same APK.

```
voice  (phone, :voice module) ──┐
chat   (phone, :chat module)  ──┤
exec   (phone, :exec module)  ──┼──▶  Orchestrator hub (Mac), port 8765
caller (Mac, stretch)         ──┤
watch  (dashboard, any)       ──┘
```

## Connecting

- URL: `ws://<host>:8765/<role>?token=<HUB_TOKEN>`, where `<role>` is `exec`, `voice`, `chat`, `caller` or `watch`.
- `<host>` is the Mac's Tailscale name on stitching day. In development it is `localhost` from a USB phone after `adb reverse tcp:8765 tcp:8765`, or `10.0.2.2` from an emulator.
- Plain `ws://`, no TLS. The APK must allow cleartext traffic.
- Every frame is one JSON object as UTF-8 text.
- The client's first frame is `{"type":"hello","role":"exec","v":2}` (with its own role). The hub answers `{"type":"welcome","v":2}`. Wrong token: the hub closes with code 4003. Wrong `v`: close code 4002.
- Clients reconnect forever: wait 1 s, 2 s, 5 s, then every 5 s. Exception: close code 4001.
- The hub keeps only the newest connection for `exec`, `voice`, `chat` and `caller`, and closes the older one with code 4001. A client closed with 4001 has been replaced and must not reconnect.
- Any number of `watch` clients may connect.
- A request carries an `id`, unique to its sender. The reply carries `re` with the same value.
- Ignore message types and fields you don't know. Never crash on them.
- Each `json` block below holds one or more complete JSON objects, one after another. Tests may parse them as examples.

## Surfaces: Voice and Chat → Orchestrator

Voice and chat send the **same** messages. `via` says which surface sent it.

**A request from the user**

```json
{"type":"request","id":"v1","via":"voice","intent":"task","text":"Reply to Sarah and tell her 3 works"}
{"type":"request","id":"c1","via":"chat","intent":"auto","text":"what did I miss?"}
{"type":"request","id":"v2","via":"voice","intent":"amend","text":"Actually make it 4, not 3"}
{"type":"request","id":"c2","via":"chat","intent":"cancel","text":""}
```

| `intent` | Meaning |
|---|---|
| `task` | Start a task with this goal. The surface has already decided it's a task (the voice agent called `start_task`). |
| `amend` | Change the running task. The Orchestrator re-plans with the change and keeps progress already made. |
| `cancel` | Stop the running task. |
| `auto` | The Orchestrator decides: answer in chat, start a task, amend, or cancel. Chat sends every typed message as `auto`. |

`task` while another task is running: the Orchestrator treats it as `amend` if it's about the same goal, otherwise it cancels the running task and starts the new one, and says so in an `update`.

**The ack.** The Orchestrator answers every `request` within 300 ms, before any planning:

```json
{"type":"request_ack","re":"v1","ok":true,"task":"t1","note":"Starting: reply to Sarah"}
{"type":"request_ack","re":"c2","ok":false,"error":"no_task","note":"Nothing is running"}
```

- `error` is one of `no_task`, `exec_offline`, `bad_request`, `busy`.
- The voice surface returns `note` as the client-tool result, so the agent can say "On it" immediately.

**Session state** (voice only; chat is always "open")

```json
{"type":"session","via":"voice","state":"live"}
{"type":"session","via":"voice","state":"asleep"}
```

**Barge-in** (voice only): the user started speaking while Bobby was narrating or a task was running.

```json
{"type":"barge_in","via":"voice","at":1790000000000}
```

The Orchestrator then finishes the current action, does **not** start the next one, and waits up to 4 s for a `request`. If one arrives it is applied; otherwise the task resumes. A `request` with `intent:"auto"` or `"task"` from voice ends the wait too.

**Transcript lines** (voice only), so chat and the dashboard show one unified thread:

```json
{"type":"transcript","via":"voice","who":"user","text":"reply to Sarah, tell her 3 works","at":1790000000000}
{"type":"transcript","via":"voice","who":"agent","text":"On it.","at":1790000000000}
```

Send one per final user turn and one per finished agent turn. Never interim text. The Orchestrator forwards each `transcript` unchanged to `chat`.

**Speech progress** (voice only), in answer to an `update` that had `"speak":true`:

```json
{"type":"spoken","re":"o5","status":"started"}
{"type":"spoken","re":"o5","status":"done"}
{"type":"spoken","re":"o5","status":"dropped"}
```

- `done`: finished, or cut off part way. `dropped`: never spoken (session asleep, `hush`, or queue cleared).
- Every `update` with `"speak":true` gets exactly one `done` or `dropped`, even if the voice surface was asleep.

## Orchestrator → Surfaces

**Progress, replies, results: one message for everything the user should see or hear**

```json
{"type":"update","id":"o5","task":"t1","kind":"step","text":"I'm looking for the word 'Reply' to answer Sarah.","speak":true,"at":1790000000000}
{"type":"update","id":"o9","task":"t1","kind":"done","text":"Sent. I told Sarah 3 works.","speak":true,"at":1790000000000}
{"type":"update","id":"o10","task":null,"kind":"reply","text":"Two new emails: Sarah is running late, and your Amazon order shipped.","speak":false,"at":1790000000000}
```

| `kind` | Meaning |
|---|---|
| `step` | Narration of the action being taken now. Always says what and why. |
| `info` | Anything else about the task: re-planning, a retry, an amendment taken on. |
| `question` | The Orchestrator needs the user to choose (rare: "Which Sarah?"). The task waits for a `request`. |
| `done` / `failed` / `cancelled` | The task ended. Exactly one per task. |
| `reply` | A conversational answer with no task, for a chat `auto` request. |

- The Orchestrator sends every `update` to **both** voice and chat (whichever are connected).
- `speak` is true when the request came from voice, or the voice session is live. Voice speaks only `speak:true` updates and only while live. Chat shows every update.
- Several spoken updates are spoken in the order they arrive. Voice must start speaking within 1 s when idle.
- Voice may rephrase lightly in Bobby's voice but keeps the meaning.

**Silent context for the voice agent** (Bobby knows it but doesn't say it now):

```json
{"type":"context","text":"3 new notifications: Sarah Chen (Gmail): running late, can we push to 3? ..."}
```

Sent on every `session live`, and whenever something the agent should know changes (a task started, ended, or is waiting).

**Voice control**

```json
{"type":"hush"}
{"type":"sleep"}
```

- `hush`: stop audio now, drop queued spoken updates (each gets `spoken dropped`).
- `sleep`: end the voice session; voice answers with `session asleep`. The Orchestrator sends `sleep` once ~20 s pass with no user speech and no task running. As a backstop, voice ends a session on its own after 5 minutes with nothing heard and nothing from the hub.

**Plan, for chat to draw as a checklist** (same shape as the `watch` messages, also sent to chat):

```json
{"type":"plan","task":"t1","title":"Reply to Sarah","steps":[{"n":1,"do":"Open Gmail","why":"Sarah's message is an email"},{"n":2,"do":"Open Sarah's email","why":"To reply in the same thread"}]}
{"type":"step","task":"t1","n":1,"status":"running"}
{"type":"task","task":"t1","title":"Reply to Sarah","status":"started","via":"voice"}
```

## Exec

**Orchestrator → Exec: read the screen**

```json
{"type":"screen","id":"o1"}
```

```json
{"type":"screen_result","re":"o1","app":"com.google.android.gm","size":[1080,2400],
 "nodes":[{"n":0,"text":"Reply","desc":"","cls":"Button","bounds":[840,2100,1040,2220],
           "tap":true,"edit":false,"scroll":false}]}
```

- `nodes` lists only what is visible on screen right now and has text, a description, or one of the three flags set.
- `bounds` is `[left, top, right, bottom]` in pixels. `size` is `[width, height]` in the current orientation.
- `n` is valid only until the next `screen_result`.
- Optional `"image":true` on `screen` asks for an extra `image` field: a base64 JPEG screenshot.

**Orchestrator → Exec: do one thing**

```json
{"type":"act","id":"o2","do":"tap","on":{"text":"Reply"}}
```

```json
{"type":"act_result","re":"o2","ok":true}
{"type":"act_result","re":"o2","ok":false,"error":"not_found"}
```

The target `on` is one of:

- `{"n":0}`: a node from the latest `screen_result`.
- `{"text":"Reply"}`: the first visible node whose text or description matches, ignoring case. An exact match wins over a "contains" match.
- `{"x":540,"y":1200}`: a pixel.

| `do` | Other fields | What happens |
|---|---|---|
| `tap` | `on` | The cursor glides to the target, then taps it. |
| `long_press` | `on` | The cursor glides to the target, then presses and holds. |
| `point` | `on` | The cursor glides to the target and touches nothing. |
| `type` | `text`, optional `on` | Types into the target, or into the focused field. |
| `swipe` | `dir`, optional `on` | `dir` is the way the finger moves: `left`, `right`, `up` or `down`. Swiping `left` on the home screen shows the next page. Starts mid-screen unless `on` is given. |
| `key` | `name` | One of `home`, `back`, `recents`, `notifications`, `enter`. |
| `launch` | `app` | Opens an app directly by label or package name, skipping the scenic route. |
| `wait` | `ms` | Does nothing for that long. |

- Exec sends `act_result` only after the action has finished **and** the screen has settled: no UI change for 300 ms, or 3 s at most.
- `error` is one of `not_found`, `not_editable`, `no_permission`, `timeout`, `bad_request`, `cancelled`.
- `{"type":"abort"}` cancels an `act` in progress (a glide not yet tapped). Its `act_result` comes back with `error:"cancelled"`. An action already touching the screen completes.
- The cursor glide takes 400 to 900 ms depending on distance. The cursor is visible during an `act` and for 2 s after. `{"type":"cursor","show":false}` hides it now; `{"type":"cursor","show":true}` shows it.

**Exec → Orchestrator: a notification arrived**

```json
{"type":"notification","app":"com.google.android.gm","title":"Sarah Chen",
 "text":"Running late, can we push to 3?","at":1790000000000}
```

Exec never forwards ongoing or silent system notifications, or any from an app whose id starts with `dev.bobby.`.

## Caller (stretch)

```json
{"type":"call","id":"o9","to":"+14155550123",
 "goal":"Say I'm running 20 minutes late and ask if 3pm still works.",
 "context":"You are speaking as the phone's owner. Alex is a friend and expects this call."}
```

```json
{"type":"call_status","re":"o9","status":"dialing"}
{"type":"call_result","re":"o9","ok":true,"summary":"Alex said 3pm works.",
 "transcript":[{"who":"me","text":"Hey Alex..."},{"who":"them","text":"Sure, 3 is fine."}]}
```

- `status` is `dialing`, `answered`, `ended` or `failed`. One `call_status` per change.
- Exactly one `call_result` ends every call. On failure `"ok":false` with `error`: `not_allowed`, `no_answer`, `busy` or `failed`.
- The Caller dials only numbers in `CALL_ALLOWLIST`, E.164 form.
- A call is a task: it gets `task`, `update` and a `done`/`failed` like any other.

## Watch

Read-only. After its `hello`, a watch client sends nothing; the hub ignores anything it sends.

| Message | Meaning |
|---|---|
| `{"type":"wire","from":"orchestrator","to":"exec","at":1790000000000,"msg":{"type":"screen","id":"o1"}}` | A copy of every frame that crosses the hub, either direction. `from`/`to` are `orchestrator`, `exec`, `voice`, `chat` or `caller`. |
| `{"type":"task","task":"t1","title":"Reply to Sarah","status":"started","via":"voice"}` | `status`: `started`, `done`, `failed`, `cancelled`. |
| `{"type":"plan","task":"t1","title":"Reply to Sarah","steps":[{"n":1,"do":"Open Gmail","why":"Sarah's message is an email"}]}` | Re-sent in full whenever it changes. |
| `{"type":"step","task":"t1","n":1,"status":"running"}` | `status`: `running`, `done`, `failed`. |
| `{"type":"peers","exec":true,"voice":true,"chat":true,"caller":false}` | Sent on every connect or drop. |

- On connect, a watch client gets the current `peers`, plus the latest `task` and `plan` if a task is running.
- `plan`, `step`, `task` and `peers` also go to `chat`.
- hello/welcome is not mirrored as `wire`. Everything after it is.

## Task rules (the Orchestrator guarantees these; surfaces may rely on them)

1. At most one task runs at a time.
2. Every task emits `task started`, then `plan`, then any number of `step`/`update`, then exactly one ending `update` (`done`, `failed` or `cancelled`) and the matching `task` status.
3. For each action the Orchestrator sends the `act` to Exec and its `update {kind:"step"}` to surfaces in the same tick. It moves on only after `act_result` **and**, if `speak` was true, `spoken done|dropped` (or the timeouts: 10 s for `act_result`, 6 s for `spoken`).
4. `cancel`: send `hush` if voice is live, send `abort` to Exec, hide the cursor, end the task as `cancelled` within 1 s.
5. `amend`: send an `update {kind:"info"}` acknowledging the change, re-plan from the current screen, publish the new `plan`, continue.
6. If Exec isn't connected when a task would start, `request_ack` says `exec_offline` and an `update {kind:"failed"}` explains it.

## Cursor artwork

One Android vector drawable, `cursor.xml`, 48 dp square, 48 × 48 viewport. The point that touches the target is the exact centre (24, 24). Resting cursor only; Exec draws the tap ripple.

## Voice agent client tools

The ElevenLabs agent has exactly these client tools. The voice surface maps each to a `request` and returns the `request_ack.note` as the tool result.

| Tool | Parameters | Becomes |
|---|---|---|
| `start_task` | `goal` (string) | `request intent:"task"` |
| `amend_task` | `change` (string) | `request intent:"amend"` |
| `cancel_task` | none | `request intent:"cancel"` |
| `ask_orchestrator` | `question` (string) | `request intent:"auto"`, for questions about the phone the agent can't answer from `context` |

## Configuration

Python parts read the root `.env`. Android values go in `android/local.properties`, never in git, never an API key.

| Variable | Used by | Meaning |
|---|---|---|
| `HUB_TOKEN` | all | Shared secret in the connection URL. |
| `HUB_PORT` | Orchestrator | Defaults to `8765`. |
| `HUB_URL` | Caller | For example `ws://localhost:8765`. |
| `OPENAI_API_KEY`, `MIND_MODEL` | Orchestrator | Key and model id. |
| `MIND_MODEL_OPTIONS` | Orchestrator | Extra request settings as JSON (e.g. a fast mode). |
| `MIND_TRIAGE_MODEL` | Orchestrator | Optional smaller model for triage of chat `auto` requests. Defaults to `MIND_MODEL`. |
| `HINTS_DIR` | Orchestrator | Per-app hint files. Defaults to `../stage/hints` relative to `mind/`. |
| `CONTACTS` | Orchestrator | `Alex=+14155550123,Sam=+14155550124`. |
| `ELEVENLABS_API_KEY` | voice-agent setup scripts, Caller | Mac only. Never in the APK. |
| `ELEVENLABS_AGENT_ID` | Voice (`local.properties`) | The Bobby agent. |
| `ELEVENLABS_CALLER_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID` | Caller | Stretch. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OWNER_NUMBER`, `CALL_ALLOWLIST`, `CALLER_DRY_RUN` | Caller | Stretch. |
| `PICOVOICE_ACCESS_KEY` | Voice (`local.properties`) | Stretch: wake word. |

- A part needing a variable not listed here prefixes it with its own name (`MIND_`, `EXEC_`, `VOICE_`, `CHAT_`, `STAGE_`, `CALLER_`) and documents it in its README.
- The APK stores the hub URL and token on the phone, set from the setup screen or by intent extras:
  `adb shell am start -n dev.bobby.agent/.MainActivity --es hub ws://bobby-mac:8765 --es token abc123`
  All modules read them from `:core`'s `HubSettings`.

## Changes from v1

- Roles renamed: `hands` → `exec`, `mouth` → `voice`. New role `chat`.
- Surfaces no longer send raw `heard`; they send `request` with an `intent`. The voice agent decides task vs chat via client tools; chat sends `auto` and the Orchestrator triages.
- `say`, `whisper`, `correct` replaced by one `update` stream (to both surfaces) and `context`. `say_started`/`say_done` replaced by `spoken`.
- Added `request_ack`, `session`, `barge_in`, `transcript`, `abort`, `error:"cancelled"`, `v:2`, close code 4002.
- `plan`, `step`, `task`, `peers` also go to `chat`.
