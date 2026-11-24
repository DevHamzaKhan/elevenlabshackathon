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
3. **Router** (`MIND_ROUTER_MODEL`) otherwise: `{route, tasks:[{shortcut_id, slots, app, subgoals:[{goal, done_when, risk}]}]}`. Routes: chat, tasks, amend, cancel, status, sleep.
4. **Queue** (`src/brain.ts`). Tasks run one at a time in order. Each sub-goal runs: skip if `done_when` already holds → confirm if irreversible → the shortcut's direct `open`/`tap` acts → a saved recipe → the grounded executor. `done_when` is checked in code (app in front, text present/absent, field value), with a cheap model check only when code can't tell. Facts noted along the way (scratchpad) carry to later sub-goals.
5. **Executor** (`src/exec.ts`, `MIND_EXEC_MODEL`). Compact screen without coordinates; up to 4 actions per call, each with an `expect`; sent one at a time with `then_screen:true`, later ones by stable selector, `fast:true` when not narrated; stops at the first mismatch and asks again with the mismatch in the history.
6. **Escalation** (`MIND_ESCALATE_MODEL`, with a screenshot) after 2 mismatches in a row or on an unreadable tree; may act (pixels allowed), re-plan the sub-goal, or give up with a spoken reason. At most 2 per task.
7. **Recipes** (`src/recipes.ts`): a grounded success is saved by (app, version, intent) with stable selectors and slot placeholders and replayed next time with zero exec calls; a mismatch falls back and marks it stale, two delete it.
8. **Confirmation** before send/call/pay/delete/post: `confirm_request` → `confirm_reply` ok **and** an affirmative raw transcript. `MIND_CONFIRM=always|unknown_contacts|never`.
9. **Calls** go through the Caller (`call`, `hangup`). Notifications digest on wake, corrections, sleeping: as in v1.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `startMind(config)`. |
| `src/brain.ts` | Orchestrator: input, routing, the queue, sub-goals, confirmations, barge-in, calls, corrections, sleeping. |
| `src/exec.ts` | Direct acts, the grounded multi-action executor, expect checks, escalation. |
| `src/shortcuts.ts` | The shortcut index (intents, slots, local matcher, router catalogue). |
| `src/recipes.ts` | Saved recipes. |
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
npm run story -- --sim --only email   # one part: digest | email | recipe | shortcut | chain | call | stop
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
| `MIND_OPENAI_BASE_URL` | `config.env` | Optional API base (default `https://api.openai.com/v1`). |
| `CONTACTS` | `config.env` | `Name=+14155550123,Sam=+1415...\|sam@example.com` (number, email or both). |
| `HUB_TOKEN`, `HINTS_DIR` | laptop runner only | Hub token; hints folder (default `../stage/hints`). |
