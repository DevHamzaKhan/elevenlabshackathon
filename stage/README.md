# Stage

Everything that makes Bobby easy to watch: a live dashboard, the cursor art, and per-app hints for the Mind. No other part depends on Stage. It needs no keys and no phone.

| Folder | What |
|---|---|
| `dashboard/` | `index.html`, the live dashboard, and `replay.mjs`, a pretend hub that plays `story.jsonl` |
| `hints/` | Per-app notes the Mind reads (`home.md`, `gmail.md`, …) plus `TO-CHECK.md` for Hands |
| `cursor/` | Cursor designs, each `<name>/cursor.xml` + SVG. `CHOSEN` names the one the app uses. `preview.html` shows them moving. |
| `tools/` | `shot.mjs` (headless screenshot of the dashboard), `check.mjs` (used by `check.sh`) |

## Setup

Node 22 or newer. Then, once, from `stage/`: `npm install`.

## Run against the fake (no phone)

```sh
node stage/dashboard/replay.mjs            # pretend hub on :8765, loops the demo story (~90 s)
open "stage/dashboard/index.html?hub=ws://localhost:8765&token=x"
```

- `--speed 4` plays faster. `--once` plays once and exits. `--story file.jsonl` plays another story. `--port` changes the port.
- Add `&theme=dark` or `&theme=light` to the page URL to force a theme. Otherwise it follows the system.
- Only one thing can listen on 8765 at a time: stop any other pretend hub first.

## Run against the real phone (demo day)

The hub runs inside the Bobby app on the phone. With the phone on USB:

```sh
adb forward tcp:8765 tcp:8765
open "stage/dashboard/index.html?hub=ws://localhost:8765&token=$HUB_TOKEN"
```

The page reconnects on its own, so it can be opened before the app starts.

## Checks

`stage/check.sh` checks the story file, the cursors and the hint files, and plays the story once through. A screenshot while the replay runs: `node stage/tools/shot.mjs stage/logs/shot.png 5000` (needs Google Chrome).

## Settings

None. `STAGE_CHECK_PORT` (default 8799) sets the port `check.sh` uses for its replay run.

## Dashboard extras

- **Record:** the "● Record" button in the header saves every message the dashboard receives until you press Stop, as a `.jsonl` download in the `story.jsonl` format. Play it back with `node dashboard/replay.mjs --story ~/Downloads/bobby-….jsonl`.
- **Voice ↔ cursor strip:** for each step, when Bobby's voice started and when the cursor's action finished. Green when they land within 1.5 s of each other.
