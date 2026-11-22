# Bobby

Bobby is a voice assistant that operates an Android phone for you. You double-press the phone's side button and talk to Bobby through your earbuds. He talks with you, and a cursor moves on the phone doing what you asked while Bobby explains each step and why ("I'm looking for the word 'Reply' to answer Sarah"). The demo story: he tells you about your notifications, replies to an email in Gmail, then phones a friend in the owner's cloned voice and reports back what they said.

**Everything runs on the phone, in one Expo (React Native) app.** There is no laptop server at the demo. The phone needs internet, because the AI models and the voice run in the cloud.

**Expo and Kotlin, each in one place.** The app, the Mind and the Mouth are TypeScript on Expo. Kotlin appears only inside the Hands package, because reading and tapping other apps needs a native Android accessibility service.

Four people are building four parts at the same time, in this repo, each in their own folder. Each part is a package with its own small test app. At the end the packages are merged into one app, "Bobby".

## Who you are working for

The human tells you their name. The name decides your part, your folders, your brief and how much you may spend.

| Name | Part | Folders | Brief | Budget | Backs up |
|---|---|---|---|---|---|
| **Hamza** | **Hands**: a Kotlin module for Expo that reads the screen and does the taps, with a cursor overlay. It also hosts the hub the parts talk through, and builds the final merged app. | `hands/`, `app/` | `roles/hands.md` | 20x | Wajeeh's Mouth |
| **James C** | **Mind**: a TypeScript package, the slow brain (Claude) that plans tasks and drives the phone one step at a time. Only the Mind may start or cancel a task. | `mind/` | `roles/mind.md` | 10x | James H's Stage |
| **Wajeeh** | **Mouth**: a TypeScript package, Bobby's voice, an ElevenLabs realtime speech agent started by the side button, and the code that places the phone call. Bobby only talks. | `mouth/` | `roles/mouth.md` | 1x | |
| **James H** | **Stage**: live dashboard, cursor art, app icon, per-app hints, README material. Nothing depends on it. | `stage/` | `roles/stage.md` | 1x | |

### Starting

A message that is only a name, or a name plus "go", "start" or "continue", means: build your part, starting now.

1. **Find the name.** It is in the human's message ("I'm Hamza", "Wajeeh here", or just "James H"), or in the file `.bobby-who` at the repo root, left by an earlier session. Match loosely: ignore case and small typos. "James" on its own fits two people, so ask "James C or James H?" once, and ask nothing else.
2. **No name?** If the human asked for something specific, do that and don't start a build. If they want you to start and gave no name, ask "Which teammate are you: Hamza, James C, Wajeeh or James H?" once.
3. **Remember it.** Write the name from the table into `.bobby-who`, and create the empty file `.bobby-run`, both at the repo root. Git ignores both.
4. **Read.** Run `git pull`. Then read this file, `CONTRACT.md` and your brief. If your folder already has a `STATUS.md`, read it and your code too, and continue from where it says.
5. **Go.** Start with "First steps" in your brief. Don't confirm the plan, don't summarise what you read, and don't ask whether to begin.

You are building one part, mostly on your own. Teammates you can't see are building the others right now, and your human is not watching. `CONTRACT.md` is the only thing the parts share. Build against it exactly, and build fakes of the other parts inside your own folder so you never wait for anyone.

## Budgets

The Budget column is how much AI usage each person has, relative to the smallest. Hamza has twenty times what Wajeeh or James H has. Work to your human's budget.

**1x: Wajeeh, James H. Build the core, cheaply.** Your session can end without warning when the budget runs out, so work as if every step were your last.

- Build only the **Core** list in your brief's "Core and extras" section, in order. The **Extras** list belongs to your backup. In your first commit, copy it under "Open" in your `STATUS.md` so they can see it.
- Commit and push after every step, with `STATUS.md` updated in the same commit. Whatever isn't pushed is lost when the session ends.
- Don't start subagents or parallel work. Don't read other parts' folders.
- Keep command output short: send long build and test output to a file under `logs/` and read only the errors or the last lines.
- Look up docs only for the exact call you're about to write.
- No refactors, no polish, and no tests beyond the ones Core lists.
- When the same thing has failed twice, write it under "Open" and move to the next item.
- When Core is done, update `STATUS.md`, delete `.bobby-run` and stop.

**10x: James C. Build the whole brief**, including its tuning section. Use a subagent only for independent work that is clearly worth its cost. You also back up Stage.

**20x: Hamza. Build the whole brief and its "Then keep going" list.** Check generously: screenshots after each action, and repeated runs. Use subagents for independent pieces that can run side by side, such as tests, tools and the final app's stand-ins. You also back up Mouth.

### Backing up a 1x part

Hamza backs up Mouth. James C backs up Stage. Backing up means working in your partner's folder, and it is the one exception to "Stay in your folder".

- **Order of work.** Your own "Done when" comes first. Then your partner's "Open" items. Then your own extra list.
- **Extras are yours from the start.** After each `git pull`, read your partner's `STATUS.md`. Anything under "Open" that came from their Extras list is yours to take once your own "Done when" is met.
- **Core items stay with your partner**, unless your human tells you to take them, or their folder has had no new commit for 45 minutes while Core items are still open (`git log -1 --format=%cr -- <folder>/`). If their folder doesn't exist yet, they haven't started: leave it alone.
- **Claim before you touch.** Write `(claimed: <your name>)` next to the item in their `STATUS.md`, commit only that file, `git pull --rebase`, and push. If the pull shows the item is already claimed or done, pick another.
- **Work to their brief.** Read `roles/<their part>.md` and follow it as if it were yours. Their `check.sh` must pass before you push. Move each finished item to "Done" in their `STATUS.md`.
- **You don't have their keys.** Build against fakes and stubs. Whatever needs a real key goes under "Needs the human" in their `STATUS.md`, as "send <your name> these `.env` lines: ...", by variable name only.
- **If you are the 1x owner and you come back:** `git pull`, read your `STATUS.md`, and skip anything that is claimed or done.

## How to work

The human said their name and walked away. They expect not to be needed again. They may look at `<your folder>/STATUS.md` now and then, and won't otherwise see what you do. Work on your own until your part is done.

Inside this repo, these rules come before any personal instructions your human has set up elsewhere, such as asking clarifying questions before coding or walking through each change afterwards. The briefs already answer the questions, and the walkthrough goes in `STATUS.md`.

1. **Keep going.** The file `.bobby-run` at the repo root is how Claude Code sends you back to work if you stop early. Other tools ignore it. Don't stop to report progress or to ask whether to continue. Finish "Done when" (Core, on a 1x budget), check it, then carry on with whatever your budget gives you next. Stop only when everything is done, or when only items that need the human are left. When that moment comes, update `STATUS.md`, delete `.bobby-run`, and stop. If the human later tells you to continue, create it again.
2. **Decide, don't ask.** When a choice is open, pick the sensible option, write it under "Decisions" in `STATUS.md` with one line on why, and carry on. The few things only a person can do, such as creating an account, paying, speaking, listening or handling the phone, go in `STATUS.md`. They are never a reason to stop and ask.
3. **Never wait for the human.** They did their setup before starting you, and your brief lists what that was. Check each item in your first minute. Whatever is missing goes under "Needs the human" in `STATUS.md`, with the exact steps, and you carry on with a placeholder: a fake key, a stand-in file, a skipped test. Each time you finish a step, look again. When a missing item has turned up, go back and finish what was waiting on it. Nothing in your part may block on a person speaking, listening, answering a phone or tapping a screen. Checks like those go under "Try it yourself", for the human to do whenever they like.
4. **Keep `STATUS.md` current** and commit it with your work. It has seven short sections: Done, Doing now, Open (what's left, most important first, with any claims), Needs the human (open items first), Try it yourself, Decisions, Contract questions. Replace old text rather than piling it up.
5. **Check your own work.** Run what you build. Prefer checks you can do alone: tests, scripted runs against your fakes, screenshots, logs. Keep `<your folder>/check.sh`, which runs every check that needs no person, and run it before each push. A step isn't done until you've seen it work.
6. **When stuck,** don't try the same thing a fourth time. Re-read the error and the docs and try a different approach, or move on to the next item and note the problem in `STATUS.md`.
7. **Stay in your folder.** Commit only files inside your folders from the table. The only files outside them you may change are the root `.env`, `.bobby-who` and `.bobby-run`, which git ignores. You may read other parts' folders, and never edit them, except when backing up as described above. Never edit `CLAUDE.md`, `AGENTS.md`, `CONTRACT.md`, `VERSIONS.md`, the root `README.md`, `roles/`, `env/`, `.gitignore` or `.claude/`.
8. **The contract.** Re-read `CONTRACT.md` whenever a `git pull` changes it. If it looks wrong or is missing something, write that under "Contract questions" and work around it meanwhile. Extra fields are always safe, because every part ignores fields it doesn't know.
9. **Secrets and personal files.** Keys go in the root `.env`, or in a `.env` inside your test app's folder. Voice recordings and anything else personal go in a `private/` folder inside your part. Git ignores all of these. Never write a key into source code or into the files in `env/`, and never print a full key in logs, output or `STATUS.md`.
10. **Only the keys you were given.** Use only the variables your brief lists. A new setting that isn't secret is fine: start its name with your part (`HANDS_`, `MIND_`, `MOUTH_`, `CALLER_`, `STAGE_`) and list it in your README. Never ask for a new secret key or account. If you're sure you need one, explain why under "Needs the human" and carry on without it.
11. **Real-world actions.** Never send a real email or message or place a real call, except in the tests your brief lists, and then at most once per run of that test. Don't touch accounts or devices beyond what your part needs.
12. **Commit small and often** to `main`: add your folder, commit, `git pull --rebase`, `git push`. Never force-push. If a push fails for any reason other than being behind, note it in `STATUS.md` and keep committing locally.
13. **Look things up.** The vendor products here are new: ElevenLabs' realtime speech model, Anthropic's newest Claude models, the current Expo SDK and Android SDKs. Read the current official docs before writing integration code instead of relying on memory, and keep model names and ids in variables. Where the docs disagree with your brief about how a product works, follow the docs and note it under "Decisions".
14. **Install what you need.** Install missing developer tools yourself with Homebrew or npm, without asking. Ask only if an install needs the human's password. Use Node and npm for everything that runs on a laptop: scripts are plain `.mjs` or TypeScript files, and each folder has its own `package.json` and lockfile. There is no shared root `package.json`.
15. **Use the shared versions.** The root `VERSIONS.md` names the Expo SDK version. Create every Expo app and package for exactly that version, add React Native libraries with `npx expo install`, and never upgrade it. The parts get merged into one app at the end, and mismatched versions would break that.
16. **Write `<your folder>/README.md`** with how to run your part and how to run it against your fakes. Also keep `<your folder>/MERGE.md`, as the contract's "Packages" section describes, so the final app can include your package without asking you anything.
