# Stage (`stage/`)

You're building everything that makes Bobby look good and easy to follow: a live dashboard for the demo, the cursor artwork, per-app hints that make the brain smarter, and the material for the final README. No other part depends on yours, so you can experiment freely, and every piece you finish gets picked up on stitching day without anyone changing their code.

- **Accounts and keys:** none, and no `.env`. The dashboard takes the hub address and token from its own URL, and `replay.mjs` accepts any token.
- **Stack:** plain HTML, CSS and JavaScript with no build step, plus small Node scripts.

## First steps

1. Make sure Node 22 or newer and npm are installed.
2. **Earlier work is already in `stage/`,** made for a design the team dropped. Check it against this brief and `CONTRACT.md` before building anything new.
   - `stage/cursor/` and `stage/hints/` are worth keeping. Move them into the layout this brief asks for, replace the Python script with Node, and rewrite `TO-CHECK.md` so it points at `hands/HINTS-CHECK.md`.
   - `stage/README.md` and `stage/readme/` describe the dropped design. Don't follow them. Rewrite them when you reach those items.
3. Write STATUS.md. You should need nothing from the human, and no phone: the team's only Android phone belongs to the Hands part.

## What to build

1. **`stage/dashboard/replay.mjs`**, a Node script that pretends to be the hub on port 8765 so you can build with nothing else running:
   - It accepts connections on `/watch` with any token and plays back `stage/dashboard/story.jsonl` on a loop with realistic timing.
   - Write `story.jsonl` yourself, one `watch` message per line, covering the whole demo: the parts connecting (`peers`), Bobby starting up (`wake`), a notification digest, the email reply with its plan and steps, then the phone call and its summary. Use the contract for the exact message shapes.
2. **`stage/dashboard/index.html`**, a single page that connects to the hub's `/watch` path and shows what Bobby is doing, live. It is opened straight from disk on a laptop, with no web server. On demo day the hub is on the phone, and the laptop reaches it over USB after `adb forward tcp:8765 tcp:8765`. It will be on a projector and in the demo video, so it has to read from across a room.
   - **Conversation:** what the user said (`heard`) and what Bobby said (`spoke`), as a running transcript.
   - **Current task:** its title and status.
   - **Plan:** each step with what it does and why, ticking off as `step` messages arrive. This is the centrepiece.
   - **Phone feed:** each action sent to the phone, in plain words, such as "Tap Reply" or "Swipe left".
   - **Call:** the status while a call is live, then the summary.
   - **Connection lights** for Hands, Mind, Mouth and Caller, from the `peers` message.
   - The hub address and token come from the page's URL, like `index.html?hub=ws://localhost:8765&token=...`. Reconnect automatically.
   - Check the layout yourself: if Chrome is installed, take headless screenshots while the replay runs and look at them.
3. **`stage/hints/`**: one short Markdown file per app, named after the app, for Gmail, Messages, WhatsApp, Chrome, Maps, Spotify and Settings, plus `home.md` for the Samsung home screen itself: swiping between pages, folders, the app drawer, and what an app icon's label looks like. Each file explains in a few plain lines how to get common things done by reading on-screen labels: what the buttons are called, where they sit, and what tends to go wrong. The brain reads these files as they are, so write them as instructions to an assistant that can only see text labels and tap them. Put the labels you're least sure of in `stage/hints/TO-CHECK.md`, one per line, as "App: the label you expect, and where". The Hands part checks that list against the real phone and writes back to its own folder, in `hands/HINTS-CHECK.md`. After each `git pull`, if that file exists, fix your hints from it.
4. **`stage/cursor/`**: three different cursor designs for the phone. For each, an SVG and a matching Android vector drawable XML named `cursor.xml` in its own subfolder, sized and centred as the contract's "Cursor artwork" section says, plus a `preview.html` showing all three gliding and tapping so the team can pick one. The team picks by writing the subfolder's name in `stage/cursor/CHOSEN`. Until they do, write your own favourite there.
5. **`stage/icon/`**: an app icon for the final Bobby app, as a 1024 x 1024 PNG plus its SVG source, that matches the cursor you favour.
6. **`stage/readme/`**: a draft of the project README with a one-paragraph pitch, an architecture diagram of the parts and the hub (as SVG, and also as Mermaid), and a walkthrough of the demo story.
7. **`stage/check.sh`**: checks every line of `story.jsonl` is valid JSON with a known message type, and every `cursor.xml` is well-formed XML with the contract's size.

## Order

Commit after each step.

1. `replay.mjs` and `story.jsonl`.
2. The dashboard, working against the replay.
3. The hints files.
4. The cursor designs and the app icon.
5. The README draft and diagram.

## Done when

Running `replay.mjs` and opening the dashboard shows the whole demo story playing through clearly enough that someone who has never heard of Bobby understands what he is doing and why.

## Experiments, if you have time

Pick whichever interests you. All of these stay inside `stage/`.

- A timing strip on the dashboard showing, for each step, the gap between the `say` and the `act_result`, so the team can see whether the voice and cursor are in sync.
- A "record" button that saves the live stream to a new `.jsonl` file that `replay.mjs` can play back.
- A phone-shaped panel that draws the cursor's position from the tap coordinates in the feed.
- Short sound effects (wake chime, task done, task failed) as small audio files in `stage/sounds/`.
- Hints for more apps.

## Core and extras

James H, who owns this part, has a 1x budget, so the work is split in two. Read "Budgets" in `CLAUDE.md` first.

- **James H's AI builds the Core**, in the order below, and stops when it is done.
- **The Extras are open to the backup, James C's AI, from the start.** James H's AI lists them under "Open" in `stage/STATUS.md` in its first commit.

**Core**, in this order. Item numbers refer to "What to build".

1. `replay.mjs` and `story.jsonl` (item 1).
2. The dashboard, working against the replay (item 2). One headless screenshot is enough to check the layout.
3. Hints for the demo: `home.md` and `gmail.md`, plus `TO-CHECK.md` for them (item 3).
4. One cursor design, with its `cursor.xml`, and its name in `stage/cursor/CHOSEN` (item 4).
5. `check.sh` (item 7).

Core is done when the "Done when" above is met, and the two hint files and one cursor are pushed.

**Extras**, most important first:

1. Hints for the other apps: Messages, WhatsApp, Chrome, Maps, Spotify and Settings.
2. The app icon (item 5).
3. The README draft and the architecture diagram (item 6).
4. Fixing hints from `hands/HINTS-CHECK.md` after each `git pull`.
5. Two more cursor designs, and `preview.html` showing all three.
6. The experiments.
