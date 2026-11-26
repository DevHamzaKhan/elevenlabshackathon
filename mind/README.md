# bobby-mind

Bobby's brain. A TypeScript package that connects to the hub as `mind`, turns what the user asks into a queue of tasks, and drives the phone: shortcut intents first, saved recipes next, a grounded multi-action executor last, a vision model when stuck. Irreversible steps wait for the user's OK. It is the only part that starts or cancels a task. Wire format: `../CONTRACT.md` (v1) plus `PROTOCOL-V2.md` (additions).

```ts
import { startMind } from "bobby-mind";
const mind = startMind({ hubUrl: "ws://127.0.0.1:8765", token, env, log, hints, storage });
// later: mind.stop()
```

`storage` is optional and AsyncStorage-shaped (`getItem`/`setItem`); it keeps memory (facts, outcomes) and recipes across restarts. Without it they live in memory.

## How a request runs

1. **Input.** A v2 Mouth sends `request{text, heard}` from the voice model's tool call (no debounce). A v1 Mouth sends `heard`, collected per side-button press (1.5 s debounce, kept for v1 only). "stop"/"cancel" is caught by a regex before anything else.
2. **Local shortcut match** (`src/shortcuts.ts`). "send an email to Hamza saying I'm late", "text Alex I'm late", "call Mom", "set an alarm for 7:30", "open Spotify", and chains of them ("X, then Y, then Z") match by regex with their slots filled. A confident match starts at once with **no model call**.
3. **Router** (`MIND_ROUTER_MODEL`) otherwise: `{route, tasks:[{shortcut_id, slots, app, subgoals:[{goal, done_when, risk}]}]}`. Routes: chat, tasks, amend, cancel, status, sleep, ask.
4. **Queue** (`src/brain.ts`). Tasks run one at a time in order. Each sub-goal runs: skip if `done_when` already holds → confirm if irreversible → the shortcut's direct `open`/`tap` acts → a saved recipe → the grounded executor. `done_when` is checked in code (app in front, text present/absent, field value), with a cheap model check only when code can't tell. Facts noted along the way (scratchpad) carry to later sub-goals.
5. **Executor** (`src/exec.ts`, `MIND_EXEC_MODEL`). Compact screen without coordinates; up to 4 actions per call, each with an `expect`; sent one at a time with `then_screen:true`, later ones by stable selector, `fast:true` when not narrated; stops at the first mismatch and asks again with the mismatch in the history.
6. **Escalation** (`MIND_ESCALATE_MODEL`, with a screenshot) after 2 mismatches in a row or on an unreadable tree; may act (pixels allowed), re-plan the sub-goal, or give up with a spoken reason. At most 2 per task.
7. **Recipes** (`src/recipes.ts`): a grounded success is saved by (app, version, intent) with stable selectors and slot placeholders and replayed next time with zero exec calls; a mismatch falls back and marks it stale, two delete it.
8. **Confirmation** before send/call/pay/delete/post: `confirm_request` → `confirm_reply` ok **and** an affirmative raw transcript. `MIND_CONFIRM=always|unknown_contacts|never`.
9. **Taught skills** (`src/teach.ts`, `src/script.ts`): "I'm going to show you how to add a project" → Hands reports what the user does → the demo becomes a skill with slots, matched locally or through the router like any shortcut, replayed step by step in code with a check after each, and finished by the executor (with the demo as its guide) when the screen no longer matches. See `TEACHING.md`.
10. **Questions** (`src/ask.ts`), only when a guess would matter. Three places can ask, through one `ask_request` → `ask_reply` round trip: code (a shortcut is about to act on a first name two contacts share: "Which Sam?"), the router (route `ask`, before anything starts) and the executor or escalation (status `ask`, a choice the screen shows). A question is one spoken line with up to four options, the Mind's own pick first. The answer is read in code from the user's own words (a label, "the second one", "option B", "you pick", "never mind"); a picked option costs no model call. Anything else ("oh, you know what you should do...") goes to the router: as the answer to its question, or as a change to the running task. Limits: `MIND_ASK_MAX` questions (default 1) per request before it starts and per task while it runs; a picked option is remembered and not asked again; no answer in 30 s means the first option; irreversible steps still get their confirmation.
11. **Calls** go through the Caller (`call`, `hangup`). Notifications digest on wake, corrections, sleeping: as in v1.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `startMind(config)`. |
| `src/brain.ts` | Orchestrator: input, routing, the queue, sub-goals, confirmations, barge-in, calls, corrections, sleeping. |
| `src/exec.ts` | Direct acts, the grounded multi-action executor, expect checks, escalation. |
| `src/ask.ts` | Questions to the user: the spoken form, and reading the answer (option, free speech, never mind). |
| `src/shortcuts.ts` | The shortcut index (intents, slots, local matcher, router catalogue). |
| `src/recipes.ts` | Saved recipes. |
| `src/teach.ts` | Teaching by showing: what the user says, the demo compiler, skills and their store, local matching. |
| `src/script.ts` | Replays a taught skill: finding controls again, checks, tips, scrolling. |
| `TEACHING.md` | How teaching works, and the four approaches measured against each other. |
| `src/memory.ts` | Memory and the `KeyValueStore` interface. |
| `src/contacts.ts` | `CONTACTS` parsing (number, email or both). |
| `src/model.ts` | The one door to the models: OpenAI Responses API over fetch. |
| `src/prompts.ts` | Instructions and JSON schemas for router, executor, escalation, check. |
| `src/screen.ts` | Screen descriptions, fingerprints, code checks, stable targets. |
| `src/hub.ts` | WebSocket client with the contract's reconnect and close-code rules. |
| `fakes/` | Pretend hub + phone (Hands v2 additions, `legacy` mode), pretend Mouth (v1/v2), pretend Caller, scripted fake OpenAI. |
| `scripts/` | Laptop runner and `npm run story`. |
| `test/` | `npm test`, no API key: everything against the fakes. |
| `PROTOCOL-V2.md` | The new messages, for the contract. |

## Run it

```sh
cd mind && npm ci
./check.sh                       # tests, type check, Node-only import check; no API key needed
npm run story:sim                # the demo against the fakes with simulated model latencies; timing table
npm run story                    # same with the real models (needs OPENAI_API_KEY)
npm run story -- --sim --v1      # with a v1 Mouth (heard/say)
npm run story -- --sim --only email   # one part: digest | email | recipe | shortcut | chain | call | ask | stop
npm run teach:bench              # teaching: pixels vs script vs guided vs hybrid on the pretend phone (table in TEACHING.md)
npm run teach:phone              # teaching on a real phone/emulator over adb: a lesson in Google Contacts, then "add a contact called ..."
```

By hand, in four terminals: `npm run hub`, `npm run mind`, `npm run caller`, `npm run mouth` (type what the user says). Hub commands: `notify <app> | <title> | <text>`, `hands on|off`, `where`, `sent`, `reset`, `popup`. Against the real phone hub: `adb forward tcp:8765 tcp:8765`, then `npm run mind`.

## Settings

| Variable | Where | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | `config.env` | The only secret. |
| `MIND_ROUTER_MODEL` | `config.env` | Default `gpt-6-luna`. |
| `MIND_EXEC_MODEL` | `config.env` | Default `gpt-6-luna` (also used for the cheap done check). |
| `MIND_ESCALATE_MODEL` | `config.env` | Default `gpt-6.1-terra` (vision). |
| `MIND_ROUTER_EFFORT`, `MIND_EXEC_EFFORT`, `MIND_ESCALATE_EFFORT`, `MIND_CHECK_EFFORT` | `config.env` | Reasoning effort; defaults `none`, `low`, `medium`, `none`. |
| `MIND_CONFIRM` | `config.env` | `always` (default), `unknown_contacts`, `never`. |
| `MIND_TEACH_MODEL`, `MIND_TEACH_EFFORT` | `config.env` | The one call that names a taught skill and finds its slots. Defaults: the escalation model, `low`. |
| `MIND_TEACH_MODE` | `config.env` | How taught skills run: `hybrid` (default), `script`, `guided`, `pixels`. The others exist for `npm run teach:bench`. |
| `MIND_ASK_MAX` | `config.env` | Most questions Bobby may ask per request before it starts, and again per task while it runs. Default `1`; `0` never asks (he guesses, as before). |
| `MIND_OPENAI_BASE_URL` | `config.env` | Optional API base (default `https://api.openai.com/v1`). |
| `CONTACTS` | `config.env` | `Name=+14155550123,Sam=+1415...\|sam@example.com` (number, email or both). |
| `HUB_TOKEN`, `HINTS_DIR` | laptop runner only | Hub token; hints folder (default `../stage/hints`). |
