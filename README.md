# Bobby

A voice assistant that operates an Android phone for you. Double-press the side button, talk through your earbuds, and a cursor does what you asked while Bobby explains each step.

This page is for the four of us. The AIs read [CLAUDE.md](CLAUDE.md), [CONTRACT.md](CONTRACT.md) and one brief in [roles/](roles/).

## Who builds what

| Name | Part | Folder | Tested in | Needs |
|---|---|---|---|---|
| **Hamza** | **Hands**: a Kotlin module for Expo that reads the screen, taps, and draws the cursor. It also hosts the hub and builds the final app. | `hands/`, then `app/` | Its test app on the S21 | The S21 plugged in. No accounts. |
| **James C** | **Mind**: the brain, a TypeScript package | `mind/` | Node on a laptop, plus Expo Go in an emulator | Anthropic API key. No phone. |
| **Wajeeh** | **Mouth and the call**: Bobby's voice and the AI caller, a TypeScript package | `mouth/` | Its test app in an emulator | OpenAI API key, Twilio. No phone. |
| **James H** | **Stage**: live dashboard, cursor art, app icon, app hints, README material | `stage/` | A browser | Nothing. No phone. |

The app is Expo (React Native, TypeScript). Kotlin is used only inside Hands, because reading and tapping other apps needs native Android code. Everything runs on the phone, with no laptop server.

**Budgets.** Hamza has 20x, James C 10x, Wajeeh and James H 1x. The 1x AIs build a small core of their part and stop. Hamza's AI then finishes Mouth and James C's AI finishes Stage, once their own parts work.

**Only Hamza uses the S21.** It stays plugged in to Hamza's laptop for the whole build and for stitching, because the final app is built there.

## Before the day

**Everyone**

- Install Claude Code and sign in.
- Install Homebrew and Node, and make sure `git push` to this repo works from your laptop.

**Hamza**

- On the S21: turn on Developer options and USB debugging, turn off Auto Blocker, plug it in, and tap "Allow" with "Always allow from this computer" ticked.
- Set the lock screen to Swipe or None for the build.
- Sign Gmail in, and move its icon off the first home screen.
- Have a teammate send a test email to that Gmail. Their name goes in your `.env`.

**James C**

- Create an Anthropic API key in the Claude Console, with billing.
- Pick the teammate Bobby will call. Their name and number go in your `.env`.

**Wajeeh**

- An OpenAI API key with billing (the voice and the calls).
- Twilio: an upgraded account, one bought number, and an Elastic SIP Trunk for calls (`mouth/README.md`, "Caller on OpenAI").
- One teammate who agrees to take a test call.
- Send your filled-in `.env` lines to Hamza in a direct message, since Hamza's AI finishes the call.

**James H**: nothing.

## On the day

1. **Clone the repo.**
2. **Set up your `.env`.** Copy your file from `env/` to `.env` at the root of your clone, and fill in the copy. Never fill in the file inside `env/`, because that one is committed. James H has none.
   ```sh
   cp env/hands.env .env    # Hamza
   cp env/mind.env .env     # James C
   cp env/mouth.env .env    # Wajeeh
   ```
3. **Open Claude Code in the clone and say your name**: `I'm Hamza`, `I'm James C`, `I'm Wajeeh` or `I'm James H`. Accept the "trust this folder" question once.
4. **Walk away.** When the AI has done everything it can without you, it stops and says so in `<your folder>/STATUS.md`:
   - **Needs the human** lists anything that was missing. Fix it, then say your name again.
   - **Try it yourself** lists checks only a person can do, such as listening to Bobby's voice.

Wajeeh and James H: your AI stops when the core of your part is done, or when your budget runs out. Either is fine. Everything is pushed after each step, and a later session picks up from `STATUS.md`. Running `/model sonnet` first makes a 1x budget last longer.

### What keeps it running unattended

- **No waiting.** The AI uses a placeholder for anything missing and keeps building.
- **No questions.** It makes its own choices and records them under "Decisions".
- **Few permission prompts.** `.claude/settings.json` pre-approves the usual commands (git, Node, npm, Gradle, `adb`, Homebrew installs) and blocks force-pushes.
- **It goes back to work if it stops early.** While the marker file `.bobby-run` exists, a Claude Code hook tells the AI to carry on. The AI deletes the marker when it is truly done. If it stops five times in a row within seconds, the hook lets it stop.
- **It survives a restart.** Open Claude Code again and say your name.

Don't switch Claude Code to "approve everything". Hands can send email from the phone and Mouth can place phone calls. The briefs limit both to specific tests.

### Changing the contract

If an AI writes something under "Contract questions" in its `STATUS.md`, bring it to the group. Hamza edits `CONTRACT.md` and pushes, since the hub is in Hamza's part. The other AIs pick it up on their next `git pull`. Adding a field is always safe. Renaming or removing one is not.

## Stitching, in this order

By now Hamza's AI has built the final app in `app/` and swapped in the real packages as they arrived. `app/README.md` has the exact commands, and `app/MERGE-ISSUES.md` lists anything it wants another part to fix. Everything below happens on Hamza's laptop, with the S21 plugged in.

1. **Check the contract.** `git log --oneline -- CONTRACT.md` should show only changes the team agreed.
2. **Gather the keys.** James C and Wajeeh send the lines of their `.env` files to Hamza, in a direct message. They go into the root `.env` on Hamza's laptop. Set `CALLER_DRY_RUN=1` for now.
3. **Build and install the final app**, then send it the keys with `app/tools/push-config.mjs` and grant its permissions with `hands/tools/grant.sh dev.bobby.app`.
4. **Hands alone.** In the app's settings, switch the Mind, the Mouth and the Caller off. Run `hands/tools/drive.mjs` and type a command: the phone should move.
5. **Add the Mind.** Switch it on. Run the Mind's pretend Bobby on the laptop, which reaches the phone's hub over USB, and type a request: the phone should carry it out.
6. **Add the Mouth.** Switch it on. Set the side button: Settings → Advanced features → Side button → Double press → Open app, then pick Bobby. Connect the earbuds and double-press the side button. Check that Bobby plays through the earbuds, since the emulator couldn't test that.
7. **Add the Caller.** Switch it on, set `CALLER_DRY_RUN=0`, push the config again, and ask Bobby to call a teammate who is on the allowlist.
8. **Stage.** Run `adb forward tcp:8765 tcp:8765` and open the dashboard on the laptop with the token from the app's settings. Pick a cursor by writing its name in `stage/cursor/CHOSEN`, and rebuild the app.
9. Unplug the phone and run the full story: notifications, email, call.

After the demo, delete the keys. They are stored on the phone, so treat a lost phone as lost keys.
