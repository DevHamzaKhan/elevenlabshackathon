# Mind (`mind/`)

You're building the slow brain: a TypeScript package that decides what to do and drives the phone one step at a time. It connects to the hub as the `mind` role. It is the only part allowed to start or cancel a task.

The package ends up inside an Expo app on the phone. You build and test it on a laptop with Node, against fakes, and prove early that it also runs inside Expo.

- **Stack:** TypeScript, package name `bobby-mind`, in `mind/`. Node 22 or newer on the laptop, with npm.
- **Accounts needed:** an Anthropic API key with billing, from the Claude Console.
- **Model:** Claude Opus 5.5, model id `claude-opus-5-5`, at **medium effort**, called through the official TypeScript SDK, `@anthropic-ai/sdk`. The Mind's own code runs the loop with plain Messages API calls, not a hosted agent service. Read the current Claude API docs before writing this code, because several things changed from older Claude models:
  - **Effort:** send `output_config: { effort: "medium" }` on every request. Medium is the default for this model, but set it anyway so it never drifts.
  - **Price:** don't use fast mode (`speed: "fast"`) or any other higher-priced option.
  - **Thinking** is always on and can't be turned off: leave `thinking` adaptive, or leave it out. Effort is the only dial.
  - **Tools:** forcing a tool with `tool_choice` `any` or `tool` returns an error. Use `tool_choice` `auto` with `strict: true` tools and say in the instructions which tool to call, or use structured outputs (`output_config.format`) when you only need JSON back.
  - **Prefill:** a prefilled assistant message is rejected.
  - **Refusals:** check `stop_reason` before reading the reply, and handle `refusal`. Turn on the server-side refusal fallback (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta), so a refused step is retried on another model instead of stalling the task.
  - **Speed:** keep the system instructions, hints and tool list byte-for-byte the same on every request, and mark them for prompt caching, so each step is faster and cheaper. Put the changing screen contents after them.
- **No phone needed.** You build and test entirely against fakes.

## It has to run inside Expo

This is the main risk in your part, so deal with it first.

- **Two layers.** Everything under `mind/src/` is the package, and may use only what both Node and React Native provide: `fetch`, `WebSocket`, timers, plain TypeScript. No `fs`, no `process.env`, no Node-only libraries. Laptop-only code (the command-line runner, the fakes, the tests, loading `.env`) lives outside `src/`.
- **Entry point,** as the contract's "Packages" section fixes it: `startMind(config)` returning `{stop()}`. Everything arrives through `config`: the hub URL, the token, `env`, `hints` and `log`.
- **No build step.** `package.json` points straight at the TypeScript source, with no path aliases.
- **Prove it early.** Make `mind/example/`, a minimal Expo app for the version in `VERSIONS.md` that installs the package from `..` and runs one real model call and one hub connection. Run it in Expo Go on an Android emulator you set up yourself. Do this as soon as the first model call works in Node. If the SDK needs anything special outside Node, such as a different `fetch` or a setting that allows it to run there, find it in the docs, fix it now, and write it in `mind/MERGE.md`.
- **One door to the model.** Keep every model call behind one small function, so the way requests are sent can be changed in one place.

## Configuration

These are the only variables the Mind uses, and they arrive in `config.env`. On the laptop, the runner reads them from the root `.env`. Don't ask for any others.

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | The only secret key the Mind needs. |
| `MIND_MODEL` | Optional. Defaults to `claude-opus-5-5`. |
| `MIND_EFFORT` | Optional. Defaults to `medium`. |
| `CONTACTS` | The people Bobby may be asked to call, as `Alex=+14155550123,Sam=+14155550124`. |

On the laptop only, the runner also reads `HUB_TOKEN`, and `HINTS_DIR`, which defaults to `../stage/hints` relative to the `mind/` folder.

## First steps

1. Make sure Node 22 or newer and npm are installed.
2. If the root `.env` is missing, create it with only the variables above. If it has no `HUB_TOKEN`, generate a random one and write it there.
3. **What the human did before starting you:** the root `.env` already holds `ANTHROPIC_API_KEY`, from an account with billing, and `CONTACTS` with a real teammate who agrees to be called. Check both, and follow "Never wait for the human" for anything missing. The fakes and the tests don't need the key, so build those first if it isn't there, and use an invented contact if `CONTACTS` is empty.
4. Write STATUS.md.

## What to build

1. **The three fakes**, in `mind/fakes/`, run with Node. Each reads commands typed on the terminal, or from a file with `--script <file>` so a whole story can run unattended, where `wait 2` pauses for two seconds.
   - `hub.ts`: a pretend hub and a pretend phone in one, because on the real phone the hub lives inside Hands. It listens on port 8765 and follows the contract's "Connecting" and "Routing" sections exactly, including `peers`, `wire` copies and the close codes. Frames for `hands` are answered by the pretend phone. The pretend phone has three home screens, a "Google" folder on the second that holds other Google apps, and Gmail on the third. It also has a Gmail inbox with an email from Sarah Chen, the open email, a reply box and a sent state. It prints what it's doing. `notify <app> | <title> | <text>` injects a notification.
   - `mouth.ts`: a pretend Bobby that connects as `mouth`. Each line is sent as `heard`. It sends `wake` when it starts, goes quiet on `sleep`, and sends `wake` again before the next line after that. It prints every `say`, `whisper`, `correct`, `hush` and `sleep` it receives, and answers each `say` with `say_started` and `say_done` after a delay that matches the line's length.
   - `caller.ts`: connects as `caller` and answers a `call` with status updates and a canned `call_result` after a few seconds.
2. **The brain loop.** On every `heard`, the model decides one of three things: just let Bobby chat (optionally `whisper` him context), start a task, or cancel the running task. For a task:
   - Write a plan as steps, each with what to do and why, and publish it as `plan`.
   - Then loop. Read the `screen`. Have the model choose one next action plus the line Bobby should say about it, which must include the reason, for example "I'm looking for the word 'Reply' to answer Sarah." Send the `say` and the `act` at the same instant. Wait for both `act_result` and `say_done`. Publish `step` updates. Repeat until the task is done or has failed.
   - Take the scenic route to apps: go home and swipe across the home screens looking for the icon, opening folders that might hold it, rather than using `launch`. Keep `launch` as the fallback after the scenic route fails.
   - When an action fails or the screen isn't what was expected, re-read the screen and re-plan instead of repeating the same action. Give up after a sensible number of attempts and have Bobby say so.
   - Every frame you send carries `to`, as the contract's "Routing" section says.
3. **The story behaviours:**
   - **Notifications.** Remember recent `notification` messages. On `wake`, `whisper` Bobby a short digest so he can tell the user what came in.
   - **Email.** Bobby gives a one-line summary of the reply, then the Mind sends it without asking for confirmation.
   - **The call.** Look the person's name up in `CONTACTS` to get their number. If they aren't listed, have Bobby say he doesn't have a number for them. Otherwise send `call` to the Caller, `whisper` status changes, and when `call_result` arrives have Bobby `say` the summary.
   - **Corrections.** Watch each `spoke`. If Bobby claims something the Mind knows is false, such as a task being done when it isn't, or a wrong name or time, send `correct` with the right fact. Keep this check cheap.
   - **Sleeping.** Send `sleep` as the contract's "Sleeping" rules describe: after about 20 s with no `heard` and no task or call running.
4. **Cancelling.** Check each `heard` for plain words like "stop" and "cancel" before calling the model, so cancelling is instant. When the user says stop: send `hush`, stop the task after the current action, hide the cursor, publish the task as `cancelled`, and `whisper` Bobby what happened.
5. **Hints.** `config.hints` is a list of per-app navigation notes that a teammate is writing. Add them to the model's instructions. Work fine when the list is empty. On the laptop, the runner loads every `*.md` file from `HINTS_DIR` if that folder exists.
6. **Timeouts and absences.** Never hang.
   - Allow 10 s for an `act_result`, 15 s for a `say_done`, and 3 minutes for a call.
   - Use `peers` to know who is connected. If Hands isn't there when a task starts, have Bobby say the phone isn't ready. Do the same for a call when the Caller isn't connected.
   - If the Mouth isn't connected, don't wait for `say_done`.
7. **Logs.** Pass every model request and response, with how long it took, to `config.log`. On the laptop, the runner writes them to a file under `mind/logs/`, which git ignores.
8. **Tests**, run with `npm test`: the brain against the fake hub with the model stubbed out, including one full run of the email story, so it passes without an API key. Also parse every contract example the Mind sends or receives.
9. **`npm run story`**: one command that starts the fake hub, the brain and the other two fakes, plays the full story as a script ("what did I miss?", then "reply to Sarah and tell her 3 works", then "call Alex and tell him I'm running late"), and prints pass or fail plus the log path. It uses the real model, so run it to tune, not on every push.
10. **`mind/check.sh`**: `npm test`, a type check, and a check that nothing under `src/` imports a Node-only module.
11. **`mind/MERGE.md`**, as the contract describes.

## Order

Commit after each step.

1. The three fakes. With no brain at all, messages from one fake can be seen arriving at another.
2. A single task end to end with the real model: "open Gmail" in the fake mouth gets the fake phone there by the scenic route, narrated.
3. The test app in Expo Go, making one real model call and one hub connection.
4. The email story: "reply to Sarah and tell her 3 works".
5. Notifications on wake, then the call story.
6. Cancelling, corrections, sleeping, timeouts, hints, tests, `npm run story`.

## Done when

`npm run story` passes: a notification digest, a narrated task that ends with the fake phone showing the email as sent, and a spoken call summary. A "stop" in the middle of a task cancels it cleanly, `check.sh` passes without an API key, and the test app has run the package inside Expo Go.

## Then tune it

You back up the Stage part: once "Done when" is met, take the open items in `stage/STATUS.md` before tuning. "Backing up a 1x part" in `CLAUDE.md` has the rules.

Most of the quality here comes from the model's instructions and from how the screen is described to it, not from the amount of code. Keep the code small and plain, and spend the rest of your effort on this loop: run `npm run story`, read the logs, improve the instructions, and repeat. Aim for:

- Narration that sounds natural spoken aloud: short, specific, and always with the reason.
- Few steps per task, with no wasted screen reads.
- Low latency per step. Measure it, and if it's slow, shrink what you send the model. Don't switch on a faster paid mode to get there.
- Recovering well when the fake phone does something unexpected. Add a fake-phone mode that sometimes fails an action or shows a pop-up, and make sure the brain gets past it.

Note what you changed and how the numbers moved in STATUS.md.
