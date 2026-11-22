# Stage: status

## Done
- 0.1 STATUS.md.
- 1.1 `dashboard/replay.mjs`: pretend hub on :8765 for `/watch`, any token, plays `story.jsonl` on a loop (`--speed`, `--once`, `--story`), sends peers/task/plan snapshot to late joiners. Tested with a Node WebSocket client.
- 1.2 `story.jsonl` part 1: peers connecting, three notifications, wake, digest whisper and spoken greeting.
- 1.3 `story.jsonl` part 2: email reply task, 5-step plan, say+act sent together per step, scenic route (home, swipe, tap Gmail).
- 1.4 `story.jsonl` part 3: call to Alex via the Caller (dialing, answered, ended, result with transcript), spoken summary, sleep after 20 s, asleep. Whole story is about 2 minutes.
- 2.1 `dashboard/index.html`: three-column layout (conversation, plan, call+phone), hub+token from URL, hello, reconnect 1/2/5 s, light/dark (`?theme=` override). `tools/shot.mjs` takes real-time headless screenshots with puppeteer-core and the installed Chrome.
- 2.2 Dashboard: conversation (heard/spoke bubbles, wake/asleep notes), task title + status badge, plan checklist with what + why per step, running step highlighted, changed steps outlined when a plan is re-sent.
- 2.3 Dashboard: phone feed (each `act` in plain words, ✓/✕ from `act_result`, screen reads and notifications as notes), call panel (live status, summary, transcript), connection lights for Hands, Mind, Mouth, Caller.
- 2.4 Dashboard checked by screenshot in light, dark (`&theme=dark`) and at 390 px phone width; smaller type on narrow screens.
- 3.1 `hints/home.md`: icons, dock, pages and swiping, folders, app drawer, widgets, what goes wrong.
- 3.2 `hints/gmail.md`: rewritten for contract v1 (key names, text matching), adds a check of the sender before replying and "no leftover drafts".
- 3.3 `hints/TO-CHECK.md`: one label per line for home and Gmail, pointing at `hands/HINTS-CHECK.md`.
- 4.1 Cursors moved to `cursor/<name>/` (`cursor.xml` + SVG) for ring, glow and bobby; `CHOSEN` = ring; `preview.html` paths fixed; Python `make.py` removed.
- 5.1 `check.sh` (+ `tools/check.mjs`): story lines are valid JSON with known types, Mind frames carry `to`, act targets are one form, each `cursor.xml` is a 48dp/48x48 vector, CHOSEN exists, required hints exist, XML well-formed, replay plays through. Passes; verified it fails on a bad line.
- 5.2 `README.md` (how to run against the replay and the real phone) and `MERGE.md` (hints, cursor, icon pickup), replacing the dropped design's README.

## Doing now
- Core done.

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
- Screenshots use `puppeteer-core` with the installed Chrome: Chrome's `--virtual-time-budget` screenshots fire before the WebSocket connects.

## Contract questions
- Hands bundles every `stage/hints/*.md` and the Mind loads every `*.md` in `HINTS_DIR`, which includes `TO-CHECK.md` (the brief fixes that name). Suggest both skip `TO-CHECK.md`. Meanwhile its first line tells the model to ignore it.
