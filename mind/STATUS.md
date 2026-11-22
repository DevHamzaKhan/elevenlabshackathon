# Mind: status

## Done
- Fakes in `mind/fakes/`: pretend hub + phone (`hub.ts`, `phone.ts`), pretend Bobby (`mouth.ts`), pretend Caller (`caller.ts`). Messages flow between them with no brain.

## Doing now
- The brain loop with the real model ("open Gmail" by the scenic route).

## Open
1. Brain loop, single task end to end with the real model.
2. Expo Go test app (`mind/example/`), one model call + one hub connection.
3. Email story, notifications on wake, call story.
4. Cancelling, corrections, sleeping, timeouts, hints, tests, `npm run story`, `check.sh`, MERGE.md.
5. Back up Stage (after Done when).

## Needs the human
- Nothing yet. The root `.env` has `ANTHROPIC_API_KEY`, `CONTACTS` and a generated `HUB_TOKEN`.
- Note: `env/mind.env` (a committed file) currently holds your real API key in your working copy. It is not committed, but don't `git add` it; keep the key only in the root `.env`.

## Try it yourself
- `cd mind && npm install`, then in three terminals: `npm run hub`, `npm run mouth`, `npm run caller`.

## Decisions
- Fakes use `ws` for the server; clients use the global `WebSocket` (Node 22+ and React Native both have it).
- The package is `"type": "module"`; laptop scripts run with `tsx`.

## Contract questions
- None yet.
