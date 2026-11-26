# Bobby wire protocol v2 (proposal, additive to CONTRACT.md v1)

Written by the Mind for the lead to fold into `CONTRACT.md`. Everything here is **additive**: v1 frames keep working, unknown types and fields are still ignored, and every part degrades when the other side is older. Frames from the Mind still carry `to`; frames to the Mind still don't. `id`/`re` work as in v1.

## Mouth ↔ Mind

A v2 Mouth puts a voice model with tools in front (OpenAI Realtime by default, `mouth/src/openai.ts`). The voice model owns turn-taking and wording. It acknowledges at once ("On it") but states outcomes **only** from Mind messages. The Mind decides what runs.

**Mouth → Mind**

| Message | Meaning |
|---|---|
| `{"type":"voice_caps","v":2,"tools":["request","amend","cancel","confirm","status"]}` | Sent before every `wake`. The Mind switches to v2 for this Mouth: `request` is the input, `heard` is only the raw transcript (not routed, no debounce), and the Mind sends `progress`/`confirm_request`/`task_update` instead of `say`/`whisper`. Reset when the Mouth disconnects. |
| `{"type":"request","text":"Send an email to Hamza saying I'm late","heard":"uh send an email to hamza saying i'm late"}` | The voice model's `request(text)` tool. `heard` is the last raw speech-to-text transcript. Handled at once (no debounce). A short request that is only "stop"/"cancel" cancels everything. |
| `{"type":"amend","text":"actually make it 4","heard":"..."}` | `amend(text)`: change the running task. The Mind re-plans it and swaps the plan at the next step boundary. With no running task it is treated as a request. |
| `{"type":"cancel","scope":"current"}` | `cancel(scope)`: `"current"` stops the running task (the queue continues); `"all"` also drops the queue. A running call is hung up. |
| `{"type":"confirm_reply","re":"m7","ok":true,"heard":"yeah go ahead"}` | `confirm(id, yes\|no)`: the answer to `confirm_request` `m7`. The Mind goes ahead only if `ok` is true **and** `heard` (the raw transcript) is affirmative with no "no/wait/don't/stop"; the voice model's word alone is not trusted. |
| `{"type":"barge_in"}` | The user started talking while a task runs. The Mind pauses the task at the next step boundary; any request/amend/cancel/confirm that follows resumes or changes it; with nothing after it the task resumes after 4 s. |
| `{"type":"status","id":"st1"}` | `status()` tool. Answered with `status_result`. |

**Mind → Mouth**

| Message | Meaning |
|---|---|
| `{"type":"progress","to":"mouth","task":"t1","text":"Writing to Hamza.","priority":"when_idle"}` | A line for Bobby. `priority`: `silent` (context only, not spoken), `when_idle` (spoken when Bobby is free, in order), `interrupt` (stop talking and say this now). Narration and outcomes ("Sent it to Hamza.") both come this way. No `say_started`/`say_done` replies. |
| `{"type":"confirm_request","to":"mouth","id":"m7","task":"t1","summary":"Email to Hamza: \"I'm late\"","risk":"irreversible"}` | Before an irreversible step (send, call, pay, delete, post). The Mouth asks "<summary>. Should I go ahead?", opens the mic, and the voice model calls `confirm("m7", yes\|no)`. No reply within 30 s counts as no. Policy: env `MIND_CONFIRM` = `always` (default), `unknown_contacts` (only when the recipient isn't a known contact), `never`. |
| `{"type":"task_update","to":"mouth","task":"t1","title":"Email Hamza","status":"waiting_confirm","text":"Email to Hamza: \"I'm late\""}` | `status` is `queued`, `running`, `waiting_confirm`, `paused`, `done`, `failed` or `cancelled`. `text` is the result line or confirm summary when there is one. The Mouth uses it to know a task is running (for `barge_in`). |
| `{"type":"status_result","to":"mouth","re":"st1","text":"Email Hamza: waiting for your OK.","tasks":[{"task":"t1","title":"Email Hamza","status":"waiting_confirm"}]}` | Answer to `status`. |

**Kept from v1:** `wake`, `heard`, `spoke`, `say_started`, `say_done`, `asleep`, `whisper`, `say`, `correct`, `hush`, `sleep`. A v1 Mouth (no `voice_caps`) gets `say`/`whisper` exactly as before; a confirmation is then a `say` ending in "Should I go ahead?" and the next `heard` (after a press) is the answer, checked with the same affirmative rule. With no Mouth connected, irreversible steps are never taken.

## Mind → Caller

| Message | Meaning |
|---|---|
| `{"type":"hangup","to":"caller","re":"m9"}` | End call `m9` now. The Caller hangs up and still sends exactly one `call_result` (`"ok":false,"error":"cancelled"` if nothing useful was said). |

The v1 `call`/`call_status`/`call_result` frames and the allowlist are unchanged. The Caller starts every call with an AI disclosure ("this is an AI assistant calling for ...").

## Mind → Hands (what the Mind relies on; Hands implements it in parallel)

The Mind uses these Hands v2 additions and degrades when they are missing.

| Request / field | Mind's use | Without it (old Hands) |
|---|---|---|
| `act` `do:"open"` with `uri`, optional `action`, `pkg`, `extras`, `type_mime`; result `"app"` | Shortcuts: `mailto:` (email draft), `smsto:` (text), `tel:` (DIAL, never CALL), `google.navigation:q=` (Maps), `SET_ALARM`, `SET_TIMER`, `INSERT` `content://com.android.calendar/events`, `WEB_SEARCH`, `android.settings.*` pages. The Mind sends settings pages with `action` and no `uri`. | `not_found`/`bad_request` → the same sub-goal is done by the grounded executor (launch the app, drive the screen). |
| `screen` `"since":"<hash>"` → `{"same":true,"hash",...}` | Every read after the first sends `since` with Hands' last hash; an unchanged screen costs no nodes. | No `hash` in replies → the Mind computes its own fingerprint and never sends `since`. |
| `screen` `"compact":true` | Always sent. | Full nodes are fine. |
| `screen` `"image":true` → `image` (base64 JPEG) | Only for escalation to the vision model. | Escalation gets the tree only. |
| any `act` `"then_screen":true` (+`"compact":true`) → `act_result.screen` | Always sent; each action's `expect` is checked on that screen. | The Mind reads the screen after the act. |
| any `act` `"fast":true` | Non-narrated actions in a batch (the 2nd-4th) and recipe replays. | Normal glide. |
| targets `{"key":...}`, `{"id":...}` | Later actions in a batch and every recipe step use `key`, else resource `id`, else a label unique on the screen. Never `n` after the first action. | Label targets (`text`). |
| stale `{n}` → `not_found`, `why:"stale"` | Counted as a mismatch; the executor re-grounds. | - |
| nodes `checked`, `disabled`, `focused`, `selected`, `password`, `id`, `key`, `scrollDirs` | Shown to the executor as flags; `key`/`id` used as targets. | Ignored. |
| `screen_result` `"locked":true`, act `no_permission`/`locked` | Task fails with "Your phone is locked, so I can't do that." | - |
| `{"type":"caps","to":"hands","id"}` → `caps_result` | Asked once when Hands appears; logged. | No reply within 1.5 s: carry on. |

## Teaching by showing (Mouth, Mind, Hands)

The user says they'll show Bobby something, does it on the phone, and says done; the Mind keeps it as a skill. How it works and how it was chosen: `mind/TEACHING.md`.

**Mouth → Mind**

| Message | Meaning |
|---|---|
| `{"type":"teach","action":"start","text":"add a new project; I'll type test test","heard":"hey tibby i'm going to show you how to..."}` | The voice model's `teach(action, text)` tool. The Mind tells Hands to observe. `heard` is the raw transcript; it is what the skill's slots are worked out from. |
| `{"type":"teach","action":"done","heard":"okay done"}` | The user is finished: the demo becomes a skill. |
| `{"type":"teach","action":"cancel"}` | Drop it. A `cancel` tool call while a demo is being watched does the same. |

The Mind also catches the same thing in a plain `request` or a v1 `heard` ("I'm going to show you how to…", "let me teach you…", then "done" / "that's it" / "stop", or "never mind"), and the router has a `teach` route, so no Mouth has to implement the tool. `voice_caps.tools` lists `teach` when it does. The Mind answers with `progress` lines: "Okay, show me. Say done when you're finished." (silent when the tool was used, since the voice model has said it), then "Got it. I've learned how to add a project. Next time, just tell me the project's name." No `sleep` is sent while a demo is being watched.

**Mind → Hands**

| Message | Meaning |
|---|---|
| `{"type":"observe","to":"hands","id":"m3","on":true}` | Start reporting what the user does. Reply `{"type":"observe_result","re":"m3","ok":true,"screen":{...}}` with the screen at that moment (a compact screen_result body; missing when Bobby's own app is in front). Observing stops by itself after 10 minutes. |
| `{"type":"observe","to":"hands","id":"m4","on":false}` | Stop. Typing still being collected and the last screen are sent first, then `{"type":"observe_result","re":"m4","ok":true,"count":14}`. |
| `act` `do:"launch"` with `"fresh":true` | Start the app at its first screen instead of resuming where it was left (`FLAG_ACTIVITY_CLEAR_TASK`). The Mind uses it only when a taught skill's first control isn't on screen. |

`caps_result.features` lists `observe` and `launch_fresh`. An older Hands doesn't answer `observe`; after 2.5 s the Mind says it can't watch on this phone.

**Hands → Mind, while observing:** `{"type":"observed","seq":N,"kind":...}`, in order.

| `kind` | Other fields | Meaning |
|---|---|---|
| `screen` | `screen` (compact screen_result body with `hash`) | A settled screen, read 200 ms after the last change (1 s at most while things keep moving). Sent when it differs from the last one sent, and always before an action that refers to it. |
| `tap`, `long_press` | `app`, `hash`, `node`, `at` | The user tapped. `hash` is the screen it happened on; `node` is that screen's node (`n`, `key`, `id`, `text`, ...), or what the event alone said with `"matched":false`. |
| `type` | `app`, `hash`, `node`, `text` | One frame per burst of typing into a field, sent when the user does something else or after 900 ms of quiet, with the field's final text. `hash` and `node` are from before the first keystroke. A password field sends `"password":true` and no `text`. |
| `scroll` | `app`, `hash`, `node`, `dir` | The first scroll of a burst. `dir` is the way the finger moved (`up` shows what is further down); missing when the app didn't say. |

Never reported: anything in Bobby's own app or in the keyboard, and the Back/Home gestures (they produce no event). Example:

```json
{"type":"observed","seq":4,"kind":"tap","app":"com.google.android.contacts","hash":"3ab3726050ba107b","at":1790000000000,
 "node":{"n":7,"desc":"Create contact","cls":"ImageButton","bounds":[870,1938,1017,2085],"tap":true,"id":"floating_action_button","key":"k60edfff6"}}
{"type":"observed","seq":8,"kind":"type","app":"com.google.android.contacts","hash":"2315e1adf6b22a11","at":1790000003000,
 "node":{"n":7,"cls":"EditText","bounds":[137,866,933,1020],"tap":true,"edit":true,"hint":"First name","key":"k74b38130"},"text":"Testy"}
```

## Watch

A lesson is published as a `task` ("Learning: add a new project", then "Learned: Add a project" with status `done`) and a `plan` whose steps are the learned steps. Otherwise unchanged. `plan` steps are now the task's sub-goals (`do` = sub-goal, `why` = its `done_when` description). `task` keeps `started`/`done`/`failed`/`cancelled`; a declined confirmation publishes `cancelled`.

## Contract questions for the lead

1. `open` for settings pages: the Mind sends `{"do":"open","action":"android.settings.WIFI_SETTINGS"}` with no `uri`. Please confirm Hands accepts a missing `uri` when `action` is given.
2. `id` targets: the Mind sends the node's full resource id as Hands reported it (`com.google.android.gm:id/send`). If Hands only matches the short form, say so.
3. Should `confirm_request` also go to `watch`, so the dashboard shows "waiting for your OK"? (The Mind already publishes `task_update` to the Mouth only.)
4. `act_result.screen` is assumed to reset `n` validity the same way a `screen_result` does.
5. Teaching adds `teach` (Mouth → Mind), `observe` / `observe_result` / `observed` (Mind ↔ Hands) and `fresh` on `launch`. All three parts implement them on this branch; please fold them into the contract.
