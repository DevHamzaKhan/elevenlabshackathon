# Mouth: status (Wajeeh, 1x budget: Core only)

## Done
- Read CLAUDE.md, CONTRACT.md v1, roles/mouth.md.
- Core 2: `agent/setup.mjs` + `agent/bobby-prompt.md`: creates/updates the public "Bobby" agent, tries Realtime (`MOUTH_REALTIME_MODEL`, default `eleven_realtime_v1_mini`) and falls back to the standard mode, writes the id to `.env` and `example/.env`. Dry run checked; **not yet run for real: no API key** (see Needs the human).
- Core 1: pretend hub `fakes/hub.mjs` (say, whisper, correct, hush, sleep, call, plus test-only `user`, `wait`, `expect`, `mark`). Smoke-tested from Node.

## Doing now
- Core 3: the Mouth + Expo test app.

## Open
Core (Wajeeh's AI, in order):
1. Pretend hub.
2. `agent/setup.mjs` for the Bobby agent only.
3. The Mouth + Expo test app in the emulator (session, heard/spoke, whisper/say/correct/hush/sleep, reconnect).
4. Dry-run-only `startCaller`.
5. `npm test`, `check.sh`, `MERGE.md`.

Extras (open to the backup, Hamza's AI, from the start; claim with `(claimed: <name>)`):
1. Working from the back: the background test, with whatever it takes in `MERGE.md`.
2. The real Caller, `tools/caller.mjs`, tests with `fetch` stubbed, dry-run call in `check.sh`.
3. The rest of `setup.mjs`: voice clone, caller agent + `caller-prompt.md`, Twilio number import.
4. Measuring the `say` delay and getting it under ~1 s.
5. The 5 minute backstop and earbud routing.
6. A real call to the team's own Twilio number.
7. The remaining tests in item 6 of the brief.

## Needs the human
1. **Root `.env` is missing.** Copy `env/mouth.env` to `.env` at the repo root and fill in `ELEVENLABS_API_KEY` (elevenlabs.io → profile menu → API Keys). Until then `setup.mjs` can't create the Bobby agent and the test app can't open a real session; everything else is built and tested against fakes.
2. Twilio, voice sample (`mouth/private/`), test contact: only needed for the Extras.

## Try it yourself
- (filled in as pieces land)

## Decisions
- `say` and `correct` reach the agent as typed user messages tagged `[SAY]` / `[CORRECT]`, which `bobby-prompt.md` tells it to speak and never answer; `whisper` is a contextual update. The tagged messages are never forwarded as `heard`.
- Bobby's `first_message` is empty: the Mind decides what he says first.
- Laptop tools (fake hub, setup script, tests) are Node `.mjs`/TypeScript run with `tsx`; the package itself is plain TS with no build step.

## Contract questions
- None yet.
