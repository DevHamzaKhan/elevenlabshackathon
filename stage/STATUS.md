# Stage: status

## Done
- 0.1 STATUS.md.
- 1.1 `dashboard/replay.mjs`: pretend hub on :8765 for `/watch`, any token, plays `story.jsonl` on a loop (`--speed`, `--once`, `--story`), sends peers/task/plan snapshot to late joiners. Tested with a Node WebSocket client.

## Doing now
- 1.2 `story.jsonl`: startup and notification digest.

## Open
Core (James H's AI, in order):
1. `dashboard/replay.mjs` + `story.jsonl`
2. `dashboard/index.html` against the replay, one headless screenshot
3. `hints/home.md`, `hints/gmail.md`, `hints/TO-CHECK.md`
4. One cursor in `cursor/<name>/`, name in `cursor/CHOSEN`
5. `check.sh`

Extras (open to James C's AI from the start, most important first):
1. Hints for Messages, WhatsApp, Chrome, Maps, Spotify, Settings (drafts from the old design are already in `hints/`; check them against the new brief)
2. App icon in `stage/icon/` (1024 PNG + SVG)
3. README draft + architecture diagram (SVG and Mermaid) in `stage/readme/` (the current files describe the dropped design)
4. Fix hints from `hands/HINTS-CHECK.md` after each pull
5. Two more cursor designs + `cursor/preview.html` showing all three
6. Experiments: timing strip, record button, phone panel, sounds, more hints

## Needs the human
- Nothing.

## Try it yourself
- (after step 2) `node stage/dashboard/replay.mjs`, then open `stage/dashboard/index.html?hub=ws://localhost:8765&token=x` in Chrome.

## Decisions
- `replay.mjs` uses the `ws` npm package (Node has a WebSocket client built in but no server).

## Contract questions
- None.
