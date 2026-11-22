# Stage

Everything the audience sees that isn't the phone itself, plus material the Orchestrator and Exec pick up from here.

| Folder | What | Owner |
|---|---|---|
| `dashboard/` | Live projector dashboard (`index.html`) and `replay.py`, a fake hub that plays `story.jsonl` | Wajeeh |
| `cursor/` | Three cursor designs (SVG + Android vector drawable), `cursor.xml` (recommended), `preview.html` | Wajeeh |
| `hints/` | Per-app navigation notes for the planner, plus `TO-CHECK.md` for Exec | Wajeeh |
| `readme/` | Draft project README and `architecture.svg` | Wajeeh |

## Dashboard

```sh
uv run stage/dashboard/replay.py          # fake hub on :8765 playing the demo story on a loop
open "stage/dashboard/index.html?hub=localhost:8765"
```

Against the real hub (stitching day): stop `replay.py`, run `uv run mind`, then open `stage/dashboard/index.html?hub=<mac-host>:8765&token=$HUB_TOKEN`. Only one thing can listen on 8765 at a time.

## Cursor

- Open `stage/cursor/preview.html` in a browser (no build step, works from `file://`). It shows all three designs gliding and tapping on a fake phone at true size, light and dark, with the hotspot marked.
- Designs: `ring` (recommended: open centre keeps the target label readable), `glow`, `bobby`. Each has `<name>.svg` and `cursor_<name>.xml`.
- Every drawable is 48 dp with a 48 × 48 viewport and its touch hotspot at the exact centre (24, 24), per `CONTRACT.md`. They use only `<path>` elements (circles are drawn as arcs), so they're valid VectorDrawables.
- **How Exec picks it up:** Exec copies `stage/cursor/cursor.xml` to `android/exec/src/main/res/drawable/cursor.xml`. The overlay draws that drawable centred on the target, so switching design is a file copy, no code change. To use another design, copy `cursor_glow.xml` or `cursor_bobby.xml` over `cursor.xml` (or there directly).
- To change a design, edit `stage/cursor/make.py` and run `uv run stage/cursor/make.py`; it regenerates the SVGs and XMLs, checks the XML parses, and rewrites `cursor.xml`.

## Hints

- One Markdown file per app: `gmail.md`, `messages.md`, `whatsapp.md`, `chrome.md`, `maps.md`, `spotify.md`, `settings.md`. Each tells the planner what the buttons and fields are called in the accessibility tree, where they sit, how to do the common tasks, and what goes wrong.
- **How they're used:** the Orchestrator loads every `*.md` in `HINTS_DIR` (default `stage/hints`) into the planner's instructions. To add an app, drop a new `<app>.md` here. Keep everything in that folder useful to the planner: no other notes there.
- `TO-CHECK.md` lists labels to verify on the S21 (it starts with a note saying it isn't hints). Exec checks them with `screen` and writes `android/exec/HINTS-CHECK.md`; Stage then fixes the hint files.

## README draft

`stage/readme/README.md` with `architecture.svg` (and the same diagram in Mermaid). After the merge it becomes the root README.
