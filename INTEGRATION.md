# Integration plan: build apart, merge once

Four people build at the same time against `CONTRACT.md`. This file is how the parts come together. Everyone reads it; nobody but the team edits it.

## Day 0 (first hour, before anyone writes feature code)

| Who | Does | Unblocks |
|---|---|---|
| Everyone | Read `CLAUDE.md`, `CONTRACT.md`, own brief. Write `STATUS.md` with the "Needs the human" list. | The human can do all account/phone setup in one sitting. |
| Human | Create root `.env` from `.env.example` with a `HUB_TOKEN`; start the account setups listed in each `STATUS.md`. | Real keys arrive while code is written against fakes. |
| B (Exec) | Push the Android skeleton: auto-including `settings.gradle.kts`, `:app` shell, `:core` with `HubClient`, `HubSettings`, `Feature`, `HubService`, and `android/core/API.md`. | C and D can create `:voice` and `:chat` without touching anyone's files. |
| A (Orchestrator) | Push the hub + `uv run mind --scripted` as early as possible (milestone 2 of its brief). | Everyone gets a contract-faithful hub to test against besides their own fake. |

Until the skeleton lands, C and D write their fake hubs, prompts and Stage work, and may use a local stand-in for `:core` with the same API.

## Milestones

| | Orchestrator (A) | Exec (B) | Voice (C) | Chat + Stage (D) |
|---|---|---|---|---|
| **M1: alone** | Hub + fakes; scripted task drives fake phone | `screen` + `tap/swipe/type` via `drive.py` | Session + tools hit `voice-agent/fakes/hub.py` | Chat UI on `fakehub.py`; dashboard on `replay.py` |
| **M2: real logic** | Real model, email story from fake voice and fake chat | Cursor, notifications, `abort`, `demo` passes once | Spoken updates ≤ ~1 s with `spoken` acks | Plan card, Stop, amend, unified thread |
| **M3: interruptions** | cancel, amend, barge-in, timeouts, tests | Settle + abort under load | barge-in, hush, sleep, earbuds | Background notifications, persistence |

Each part's `check.sh` must pass before stitching.

## Stitching day

One Mac, the S21, earbuds. Stop every fake hub (they all use port 8765).

0. **Contract check.** `git pull`. Everyone confirms their code was built against the current `CONTRACT.md` version (`v:2`). Any open "Contract questions" in a `STATUS.md` get decided now, before wiring.
1. **Build one APK.** On the Mac: `cd android && ./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk && ./tools/grant.sh`. All three feature modules present. Fix build breaks in the owning module only.
2. **Point it at the hub.** `uv run mind` on the Mac, then `adb reverse tcp:8765 tcp:8765` and `adb shell am start -n dev.bobby.agent/.MainActivity --es hub ws://localhost:8765 --es token $HUB_TOKEN`. Open the dashboard with the same hub and token. All three phone lights go green on the setup screen and the dashboard.
3. **Orchestrator + Exec.** From `mind/fakes/chat.py` (still on the Mac): "open Gmail". The real phone takes the scenic route with the cursor. Then the email story, **without** pressing Send: use a test that stops at the reply box.
4. **Add Chat.** Same task typed in the real chat screen. Plan ticks, narration appears, Stop works.
5. **Add Voice.** Shortcut → "open Gmail". Bobby acks, narrates each step in sync with the cursor (check the dashboard's sync strip: speech start within ~1 s of the `act`).
6. **Interruptions.** Voice: talk over Bobby mid-task; "actually make it 4"; "stop". Text: type a change mid-task; press Stop. Cross-surface: start by voice, stop from chat, and the reverse.
7. **Full demo**, below. Run it once with a real send.
8. **Switch to Tailscale** for untethered use: hub URL `ws://<mac-tailscale-name>:8765` set via the setup screen.

Who fixes what: a bug lives in the part whose contract promise broke. Use the dashboard's `wire` view and each part's logs to decide. If the contract itself is wrong, agree the change together, bump the version, update `CONTRACT.md` once, then each owner updates their part.

## Acceptance script (the demo)

1. Press the Quick Settings tile. Bobby: greets, mentions what came in ("Sarah emailed, she's running late").
2. "Reply to Sarah and tell her 3 works." Bobby: "On it." The cursor goes home, swipes across home screens, finds Gmail, opens Sarah's email, taps Reply, types. Every action is narrated with its reason, voice and cursor landing together.
3. Mid-typing: "Actually, make it 4." Bobby: "Got it, 4 instead." The text changes; the task continues; Bobby gives a one-line summary and sends. "Sent."
4. Open the chat screen: the whole voice exchange is in the thread, the task card shows the finished plan.
5. Type "open Maps and search for coffee near me". The same agent does it, narrating in the chat. Press Stop half-way. "Cancelled."
6. Stay quiet for ~20 s: the voice session goes to sleep.
7. Stretch: "Call Alex and tell him I'm running late" → cloned-voice call, Bobby reports what Alex said.

Pass criteria: no step needs a retry by hand; every task ends with exactly one done/failed/cancelled message on both surfaces; the dashboard shows every frame; no leftover drafts on the phone.

## After merge

- Merge the READMEs into `stage/readme/` → final root README (by agreement, one person).
- Each part keeps its own `check.sh`; add a root `check-all.sh` only by team agreement.
