# bobby-mind

Bobby's slow brain. A TypeScript package that connects to the hub as `mind`, decides what to do with what the user says, plans tasks, and drives the phone one step at a time while Bobby narrates. It is the only part that starts or cancels a task. See `../CONTRACT.md` for the wire format and `../roles/mind.md` for the brief.

```ts
import { startMind } from "bobby-mind";
const mind = startMind({ hubUrl: "ws://127.0.0.1:8765", token, env, log, hints });
// later: mind.stop()
```

`env` holds `ANTHROPIC_API_KEY`, and optionally `MIND_MODEL` (default `claude-opus-5-5`), `MIND_EFFORT` (default `medium`) and `CONTACTS` (`Alex=+14155550123,Sam=+14155550124`). `hints` is a list of per-app notes (may be empty).

## Layout

| Path | What |
|---|---|
| `src/` | The package. Only `fetch`, `WebSocket`, timers and plain TypeScript, so it runs in Node and React Native. |
| `src/index.ts` | `startMind(config)`. |
| `src/brain.ts` | The decision loop: heard → chat / task / call / cancel / sleep; the step loop; calls; corrections; sleeping. |
| `src/model.ts` | The one door to Claude (`makeModel`). |
| `src/prompts.ts` | The model's instructions and JSON schemas. Most tuning happens here. |
| `src/screen.ts` | How a `screen_result` is described to the model. |
| `src/hub.ts` | WebSocket client with the contract's reconnect and close-code rules. |
| `fakes/` | Pretend hub + phone, pretend Mouth, pretend Caller (laptop only). |
| `scripts/` | Laptop runner and `npm run story`. They read the root `.env` and `HINTS_DIR`. |
| `test/` | `npm test`: the brain against the fakes with the model stubbed out. |
| `example/` | Minimal Expo app that runs the package in Expo Go. See `example/README.md`. |

## Run it

```sh
cd mind && npm install
./check.sh                  # tests, type check, Node-only import check; no API key needed
npm run story               # the whole demo against the fakes with the real model; prints PASS/FAIL and the log path
npm run story -- --flaky    # same, with a fake phone that sometimes fails or shows a pop-up
npm run story -- --only email   # one part: digest | email | call | stop
```

By hand, in four terminals (the fake hub listens on 8765):

```sh
npm run hub        # pretend hub + phone. Type: notify com.google.android.gm | Sarah Chen | Running late, can we push to 3?
npm run mind       # the brain, real model, logs to mind/logs/
npm run caller     # pretend Caller
npm run mouth      # pretend Bobby: type what the user says, e.g. "reply to Sarah and tell her 3 works"
```

Fake commands: the hub takes `notify <app> | <title> | <text>`, `hands on|off`, `where`, `sent`, `reset`, `popup`; the mouth takes any line (sent as `heard`), `!spoke <text>`, `!asleep`, `!wake`. Each fake also takes `--script <file>`, where `wait 2` pauses two seconds. `npx tsx fakes/hub.ts --flaky` makes the phone fail some actions and show pop-ups.

Against the real phone hub: `adb forward tcp:8765 tcp:8765`, then `npm run mind` (it reads `HUB_TOKEN` from the root `.env`).

## Settings

| Variable | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | `config.env` | The only secret. |
| `MIND_MODEL` | `config.env` | Default `claude-opus-5-5`. |
| `MIND_EFFORT` | `config.env` | Default `medium`. |
| `CONTACTS` | `config.env` | Who Bobby may call. |
| `HUB_TOKEN` | laptop runner only | Token for the hub. |
| `HINTS_DIR` | laptop runner only | Default `../stage/hints`. |
| `MIND_HUB_URL` | fakes only | Default `ws://localhost:8765`. |
