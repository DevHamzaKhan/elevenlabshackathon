# Bobby: an AI coworker on your phone

Bobby is one Android AI agent that operates your phone for you. You can reach it two ways:

- **Voice.** Press the shortcut (Quick Settings tile, launcher shortcut, or the assistant gesture), talk naturally through your earbuds. Bobby acknowledges, operates the phone with a visible cursor, narrates each step and why ("I'm looking for 'Reply' to answer Sarah"), and takes corrections or "stop" mid-task.
- **Text.** Type in the chat screen. The same agent does the same work and shows progress as messages, with a live plan checklist and a Stop button.

**One system, two surfaces.** Voice and chat are thin front-ends. Both send the same `request` message to one **Orchestrator**, which owns every task, and both render the same `update` stream coming back. There is one planner, one task state machine, one execution engine. If you catch yourself building task logic inside a surface, stop: it belongs in the Orchestrator.

```
 ┌─────────── Android phone: one APK, dev.bobby.agent ───────────┐
 │                                                               │
 │  Voice surface ──┐                     ┌── Exec (accessibility│
 │  (ElevenLabs     │                     │   service + cursor)  │
 │   agent, tools)  │                     │                      │
 │  Chat surface ───┤                     │                      │
 └──────────────────┼─────────────────────┼──────────────────────┘
                    │  WebSocket, one per role, via :core
                    ▼                     ▲
          ┌─────────────────────────────────────────┐
          │  Orchestrator (Mac, Python)             │
          │  hub · triage · planner · task loop     │
          │  narration · interruptions · memory     │
          └─────────────────────────────────────────┘
                    │  watch
                    ▼
          Dashboard (Stage), read-only
```

Voice flow, end to end:

1. User presses the shortcut. Voice surface opens an ElevenLabs agent session and sends `session live`.
2. User: "Reply to Sarah, tell her 3 works." The ElevenLabs agent calls its client tool `start_task`. The voice surface sends `request {intent:"task"}`.
3. Orchestrator acks within 300 ms (the tool result lets the agent say "On it"), plans, then loops: read screen → pick one action + one narration line → send `act` to Exec and `update` to surfaces **at the same instant** → wait for `act_result` (and `spoken` if narrated) → repeat.
4. Exec glides the cursor, acts, waits for the screen to settle, replies.
5. Orchestrator sends the final `update {kind:"done"}`. The voice agent says it; chat shows it.

Text flow is identical, except the chat surface sends `request {intent:"auto"}` and the Orchestrator's triage decides chat reply vs new task vs amend vs cancel.

Interruptions work the same from both surfaces: `cancel` stops after the current action; `amend` re-plans with the change, keeping progress; voice barge-in pauses the loop briefly while the user is speaking. Details in `CONTRACT.md`.

## Who builds what

Four people work at the same time, each in their own folders, against `CONTRACT.md` only. Each person reads **this file, `CONTRACT.md`, and their own brief** in `roles/`.

| Part | Owner | Folders | Brief |
|---|---|---|---|
| **Orchestrator** (Mind) | James H | `mind/` | `roles/orchestrator.md` |
| **Exec** (Hands) + Android shell | Hamza | `android/app/`, `android/core/`, `android/exec/`, `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle/`, `android/tools/` | `roles/exec.md` |
| **Voice** (Mouth) | James C | `android/voice/`, `voice-agent/` | `roles/voice.md` |
| **Chat + Stage + Caller** | Wajeeh | `android/chat/`, `stage/`, `caller/` | `roles/chat.md` |

`INTEGRATION.md` is the merge plan: Day 0 scaffold, milestones, stitching order and the final acceptance script.

### Start your part

Parts are matched to each person's AI usage limits. The heaviest parts went to the biggest plans:

| Person | Plans | Part | Why |
|---|---|---|---|
| **James H** | Claude Max (several) | Orchestrator | The most logic, model prompting and tests, and everyone else depends on it. |
| **Hamza** | Claude Max 20x | Exec + Android shell | The Day 0 scaffold everyone builds on, plus long loops with phone screenshots, which use a lot of tokens. Needs the S21. |
| **James C** | Codex + Claude, 10x | Voice | Hard but narrow: the ElevenLabs SDK, speech latency and interruptions. |
| **Wajeeh** | Codex Pro ×2, Claude Pro | Chat + Stage + Caller | The most files but the lightest reasoning: UI, dashboard, hints. Also takes the phone-call feature off Voice so James C can focus on live speech. Suits running mostly on Codex. |

Clone the repo, `cd` into it and start your agent with your line. Claude Code reads this file automatically; Codex reads `AGENTS.md`, which points here.

```sh
# James H
claude "I'm James H. Build my part, the Orchestrator. Read CLAUDE.md, CONTRACT.md and roles/orchestrator.md, then follow 'How to work'."
# Hamza (do Day 0 first: push the Android scaffold within the first hour)
claude "I'm Hamza. Build my part, Exec + Android shell. Read CLAUDE.md, CONTRACT.md and roles/exec.md, then follow 'How to work'."
# James C
codex "I'm James C. Build my part, Voice. Read CLAUDE.md, CONTRACT.md and roles/voice.md, then follow 'How to work'."
# Wajeeh
codex "I'm Wajeeh. Build my part, Chat + Stage + Caller. Read CLAUDE.md, CONTRACT.md and roles/chat.md, then follow 'How to work'."
```

Use `claude` or `codex` for any line, whichever you have quota for. Resuming later: the same line works, because the agent picks up from your `STATUS.md`.

### Repo layout

```
CLAUDE.md  AGENTS.md  CONTRACT.md  INTEGRATION.md  roles/   # shared, read-only for everyone
.env.example                                       # shared, read-only; real values in .env (gitignored)
mind/                  Orchestrator: uv project, `uv run mind`
android/               ONE Gradle project, ONE APK (dev.bobby.agent)
  settings.gradle.kts  auto-includes every subfolder that has a build.gradle.kts
  app/                 thin shell: MainActivity, setup screen, feature registry
  core/                hub client library shared by all modules (frozen API)
  exec/                accessibility service, cursor overlay, notification listener
  voice/               ElevenLabs session, shortcut entry points, audio routing
  chat/                chat UI
  tools/               grant.sh, drive.py (Exec's fake hub)
voice-agent/           ElevenLabs agent prompt + client-tool definitions
caller/                stretch: outbound phone call in the owner's cloned voice
stage/                 dashboard, hints, cursor art, README material
```

### Why one APK with modules

The user sees one agent, so it ships as one app. Modules keep the four people out of each other's files:

- `settings.gradle.kts` discovers modules by scanning folders, so adding `android/voice/` needs no edit outside it.
- `android/app` depends on each feature module **only if it exists** (`findProject(":voice")?.let { implementation(it) }`), so the app builds with any subset present.
- Each module declares its own services, activities and permissions in its own `AndroidManifest.xml`. Manifest merging does the rest.
- Each module registers itself with the shell through `java.util.ServiceLoader` (`META-INF/services/dev.bobby.core.Feature`). That's how the setup screen lists its permissions and entry points.
- Modules never call each other's code. They talk only through the hub, each with its own socket and role, exactly as if they were separate apps. That keeps the Orchestrator the single source of truth and makes every step visible on the dashboard.

## How to work

You work mostly on your own. Teammates you can't see are building the other parts right now. The human who started you is not watching all the time.

1. **Read first.** This file, `CONTRACT.md`, your `roles/<part>.md`. If you start with no memory of earlier work, read your `STATUS.md` and your code, then continue from where it says.
2. **Keep going.** Don't stop to report progress or ask whether to continue. Finish "Done when" in your brief, check it, then work down its "Then keep going" list. Stop only when everything is done or only human-only items remain.
3. **Decide, don't ask.** For an open choice, pick the sensible option, write it under "Decisions" in your `STATUS.md` with one line on why, carry on. Ask only for what only a person can do: create an account, pay, read out a code, speak, listen, handle the phone.
4. **Ask for human work once, early.** In your first few minutes, list every human task your part will need, start to finish, under "Needs the human" in `STATUS.md`, as one numbered list with exact clicks. Meanwhile use placeholders (fake keys, built-in alternatives) so nothing stalls.
5. **`STATUS.md`** lives in your main folder (`mind/`, `android/exec/`, `android/voice/`, `android/chat/`). Five short sections: Done, Doing now, Needs the human (open items first), Decisions, Contract questions. Replace old text; don't pile up. Commit it with your work.
6. **Fakes, not waiting.** Build fakes of every part you talk to, inside your own folder. Never block on a teammate.
7. **Check your own work.** Run what you build. Keep a `check.sh` in your main folder that runs every check needing no person (tests, scripted runs against fakes, screenshots where relevant). Run it before each push. A step isn't done until you've seen it work.
8. **When stuck,** don't try the same thing a fourth time. Re-read the error and the docs, try a different approach, or move on and note it in `STATUS.md`.
9. **Stay in your folders** (table above). Commit only files there. The one file outside you may change is the root `.env`, which git ignores. Never edit `CLAUDE.md`, `AGENTS.md`, `CONTRACT.md`, `INTEGRATION.md`, `roles/`, `.gitignore`, `.env.example` or `.claude/`.
10. **The contract.** Build against `CONTRACT.md` exactly. Re-read it whenever a `git pull` changes it. If it looks wrong or is missing something, write it under "Contract questions" and work around it meanwhile. Extra fields are always safe: every part ignores fields it doesn't know. New message types need a team-agreed contract change.
11. **Secrets and personal files.** Python keys go in the root `.env`; Android values go in `android/local.properties`. Voice recordings, wake-word files and anything personal go in a `private/` folder inside your part. All are gitignored. Never print a full key in logs, output or `STATUS.md`. **No API key ever goes into the APK.**
12. **Real-world actions.** Never send a real email or message or place a real call except in the tests your brief lists, and then at most once per run. Don't touch accounts or devices beyond what your part needs.
13. **Commit small and often** to `main`: add your folders, commit, `git pull --rebase`, `git push`. Never force-push. If a push fails for any reason other than being behind, note it in `STATUS.md` and keep committing locally.
14. **Look things up.** ElevenLabs Agents and its Android SDK, OpenAI's newest models, and current Android SDKs change often. Read the current official docs before writing integration code; don't trust memory. Keep model names and ids in config. Where the docs disagree with a brief, follow the docs and note it under "Decisions".
15. **Install what you need** with Homebrew or `uv`, without asking. Ask only if an install needs the human's password. Single-file Python scripts declare dependencies inline so `uv run <script>` works with no setup.
16. **Write a `README.md`** in your main folder: how to run your part, how to run it against your fakes, and the exact steps to connect to the real Orchestrator on stitching day.

## Shared conventions

- **Language.** Python 3.12+ with `uv` on the Mac. Kotlin, minSdk 30, current target SDK, Jetpack Compose for UI on Android.
- **Port.** The hub and every fake hub listen on 8765. Only one runs at a time on a machine. A phone reaches it at `localhost` after `adb reverse tcp:8765 tcp:8765`, an emulator at `10.0.2.2`.
- **Ids.** Message ids are prefixed by sender: `o` Orchestrator, `v` voice, `c` chat, `x` exec. Task ids are `t1`, `t2`, … from the Orchestrator.
- **Time.** Unix milliseconds everywhere.
- **Logging.** Every part logs every frame it sends and receives, one JSON line each, to a gitignored `logs/` folder in its own part (Android: logcat tag `Bobby/<role>` plus a file in app storage that `adb pull` can fetch).
- **Device.** The team has one Galaxy S21. Exec owns it until stitching day. Voice and Chat develop on a personal Android phone or an emulator with the host mic on.
- **Words.** In code and docs: Orchestrator (not "brain"), Exec (not "hands"), Voice, Chat, Stage. The codename Bobby stays. Roles on the wire are `exec`, `voice`, `chat`, `watch`, `caller`.
