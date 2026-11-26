# Mouth and the call (`mouth/`)

You're building Bobby's voice and the phone call, as one TypeScript package that ends up inside an Expo app on the phone. That is three small pieces: a pretend hub for testing, the Mouth, which runs an OpenAI Realtime speech model with Bobby's tools, and the Caller, which places a call through GPT-Live over a SIP trunk, in a stock voice, and says up front that it is an AI assistant calling for the owner.

Much of this part is vendor setup. Do as much of it as possible with the vendors' APIs, so the human only does what truly needs a person. Your code is thin glue. **Keep it small:** build the pieces in the order below, simplest and most certain first, and don't add anything that isn't listed.

- **Stack:** TypeScript, package name `bobby-mouth`, in `mouth/`, with OpenAI Realtime over WebRTC (`@livekit/react-native-webrtc`, and `@livekit/react-native` for audio routing). Node 22 or newer on the laptop, with npm.
- **Accounts needed:** OpenAI (an API key with billing) and Twilio (a bought number and an Elastic SIP Trunk).
- **No wake word.** Bobby starts when the app is opened, which the phone's side button does. Don't add a wake-word library or service.
- **Device: an Android emulator, never a real phone.** The team has one Android phone, and the Hands part has it for the whole build, so never ask for it. Set up the emulator yourself: a current Google APIs image that matches this Mac's processor, with the host microphone turned on so it hears the laptop's mic, and sound out through the laptop. From the emulator, the pretend hub is at `ws://10.0.2.2:8765`.

## The package

The contract's "Packages" section fixes the entry points:

- **`startMouth(config)`** returns `{wake(), stop()}`. It connects to the hub as `mouth`. `wake()` starts a voice session and sends `voice_caps`, then `wake`. It does nothing if a session is already live.
- **`startCaller(config)`** returns `{stop()}`. It connects to the hub as `caller`.
- Everything arrives through `config`: the hub URL, the token, `env` and `log`. The package never reads files or environment variables itself.
- **No build step.** `package.json` points straight at the TypeScript source, with no path aliases.
- **Keep the logic testable.** Put message handling, the `say` queue and all of the Caller in plain TypeScript that runs in Node as well as React Native: `fetch`, `WebSocket` and timers only, with no Node-only libraries. Only the thin layer that runs WebRTC (`src/openai.ts`) needs React Native.
- **The final app is built by the Hands part, not you.** It opens, calls your `wake()`, and then moves itself to the back. Write everything it needs in `mouth/MERGE.md`: permissions, config plugins, native settings, and what kind of foreground service keeps the microphone and the session working while another app is on screen.

## Configuration

These are the only variables this part uses, and they arrive in `config.env`. Don't ask for any others.

**Secret keys.** The human puts these in the root `.env`.

| Variable | Used by | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | Mouth, Caller | The Mouth mints a short-lived Realtime client secret from it on the phone; the Caller starts GPT-Live sessions with it. |
| `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD` | Caller | The Twilio Elastic SIP Trunk's termination URI and credentials. |

**Settings**, also in the root `.env`:

| Variable | Used by | Meaning |
|---|---|---|
| `OWNER_NUMBER` | Caller | The caller number sent on the SIP trunk: a number on the Twilio account (or a caller ID Twilio accepts on the trunk). |
| `CALL_ALLOWLIST` | Caller | Comma-separated numbers the Caller may dial. |
| `CALLER_DRY_RUN` | Caller | Defaults to `1`, which fakes every call instead of dialing. |

Optional, non-secret overrides: `MOUTH_VOICE_MODEL`, `MOUTH_VOICE`, `MOUTH_TRANSCRIBE_MODEL`, `CALLER_MODEL`, `CALLER_VOICE`, `CALLER_SUMMARY_MODEL`, `CALLER_OWNER_NAME` (the name in the AI disclosure).

Your test app gets what it needs from a `.env` in its own folder. Git ignores it. That is for the test app only: the final app receives them through its settings.

## First steps

1. **Tools.** Check for Node, `adb`, a JDK and the Android SDK, and install whatever is missing. Prefer command-line installs, because they need no clicks: Homebrew's `node`, Homebrew's `openjdk` at the version the Expo SDK in `VERSIONS.md` needs, Homebrew's `android-commandlinetools`, then `sdkmanager` for platform-tools, the platform and build-tools that Expo version needs, the emulator and a system image. Create the emulator with `avdmanager` and start it from the command line. Turn on its host microphone from the command line if you can. If you can't, leave it off and note the clicks under "Try it yourself": your own tests don't need a microphone.
2. **What the human did before starting you.** Check each one, and follow "Never wait for the human" for anything missing:
   1. **OpenAI:** an API key with billing, in the root `.env` as `OPENAI_API_KEY`.
   2. **Twilio:** one bought number and an Elastic SIP Trunk with secure trunking, its termination URI and credentials in `CALLER_SIP_URL`, `CALLER_SIP_USERNAME` and `CALLER_SIP_PASSWORD`, and the caller number in `OWNER_NUMBER`.
   3. **A test contact:** a teammate who agreed to take one test call, with their number in `CALL_ALLOWLIST`.
3. **STATUS.md.**

## What to build

1. **`mouth/fakes/hub.mjs`**, a Node script that pretends to be the hub on port 8765 and accepts any token. It follows the contract's "Connecting" section, prints every frame it receives, and lets you type `say hello there`, `whisper ...`, `correct ...`, `hush`, `sleep`, and `call +1415... <goal>`, sending each to the right role. `--script <file>` runs the same commands from a file, where `wait 2` pauses for two seconds. You'll test both other pieces against it.
2. **The Caller**, started by `startCaller`:
   - On a `call` message it checks the number against `CALL_ALLOWLIST`, then dials it through GPT-Live over the SIP trunk, with `OWNER_NUMBER` as the caller number. Pass the `goal` and `context` into the session for that one call.
   - It speaks a fixed AI disclosure as soon as the call is answered, in a stock voice. It never imitates the owner's voice.
   - It talks to OpenAI with `fetch` and `WebSocket`, because Node libraries won't run on the phone.
   - It sends `call_status` as the call progresses, and hangs up on `hangup` from the Mind.
   - When the call ends it writes a one or two sentence summary of what the other person said from the transcript, and sends `call_result`.
   - Any failure still ends in a `call_result` with `"ok":false`.
   - With `CALLER_DRY_RUN=1` it skips dialing and returns a canned result, so tests never place a call.
   - **Real calls without a person.** To prove the real path, make the team's own bought Twilio number answer with a short recorded message, add it to the allowlist yourself, and call that. Nobody has to pick up, so repeat it as often as you need. Put that number's settings back when you're done.
   - `mouth/tools/caller.mjs` runs it on the laptop with Node, against the pretend hub, reading the root `.env`.
3. **The Mouth**, started by `startMouth`:
   - `wake()` starts an OpenAI Realtime session over WebRTC with Bobby's instructions and tools (protocol v2, `mind/PROTOCOL-V2.md`), and sends `voice_caps` before `wake`.
   - It forwards each final user transcript as `heard`, each thing Bobby says as `spoke`, and each tool call as its v2 message.
   - It implements `whisper`, `say`, `correct`, `hush` and `sleep` exactly as the contract describes, including `say_started` and `say_done`, plus the v2 `progress`, `confirm_request`, `ask_request` and `task_update`. Silent context goes in as a system item; a line to speak goes out as a response the model speaks. Getting `say` to start within one second is the hard part, so spend your effort there. Measure the delay and record it in STATUS.md.
   - It follows the contract's "Sleeping" rules. On `sleep` it ends the session, sends `asleep` and goes idle, with the microphone off, until `wake()` is called again. It doesn't time out on silence by itself, apart from the 5 minute backstop, because a phone call can leave Bobby silent for minutes.
   - It follows the contract's reconnect rules, including not reconnecting after close code 4001.
   - Audio goes through connected Bluetooth earbuds when there are any. The emulator can't test this, so write the code from the docs, and add "check that Bobby plays through the earbuds" to `mouth/MERGE.md`.
4. **`mouth/example/`**, a small Expo test app, id `dev.bobby.mouth`, for the version in `VERSIONS.md`, installing the package from `..`:
   - It needs a development build, because WebRTC has native code. Build and run it in the emulator with `npx expo run:android`.
   - Opening it calls `startMouth` and `startCaller`, then `wake()`. One screen shows a status line (idle, live or disconnected) and a button for the microphone permission. Grant the permission yourself with `adb shell pm grant` while testing.
   - **Test it in the back.** After `wake()`, send the app to the back with `adb shell input keyevent HOME`, and confirm from the pretend hub that Bobby still hears and still speaks. Whatever that takes goes in `mouth/MERGE.md`.
5. **Tests**, run with `npm test` in Node: message handling, the `say` queue, parsing every contract example the Mouth or the Caller sends or receives, and the Caller with `fetch` stubbed out.
6. **`mouth/check.sh`**: `npm test`, a type check, a dry-run call through `tools/caller.mjs` against the pretend hub, and a build of the test app.
7. **`mouth/MERGE.md`**, as the contract describes.

## The two sets of instructions

- **Bobby** (`src/realtime.ts`). Bobby is warm and brief. He chats naturally. He never claims to have started, finished or cancelled anything on his own: when the user asks for something he calls `request`, gives a short acknowledgement like "On it" and waits for the outcome. He speaks the lines he's given in his own voice, and treats background context as things he knows without reading it out.
- **The caller** (`src/caller-live.ts`). The caller is an AI assistant calling for the phone's owner, and says so first. It is friendly and brief, gets to the goal it was given, listens to the answer, and ends the call politely once it has one.

## Order

Commit after each step.

1. The pretend hub.
2. The Caller on the laptop, first with `CALLER_DRY_RUN=1`, then real calls to the team's own Twilio number. Leave the one call to the human test contact for the human, under "Try it yourself".
3. The test app running in the emulator and connecting to the pretend hub, with a typed `say` being spoken out loud.
4. Opening the app starting a session, with `heard` and `spoke` arriving at the pretend hub.
5. `hush`, `correct`, going back to sleep, working from the back, and earbud routing.

You can't speak to the emulator or hear it, and nobody is there to do it for you. Play the user's side by sending their turns as text, which the Realtime API supports, and check Bobby's side from events, logs and transcripts. Then write one short "listen test" under "Try it yourself": what to say out loud, and what they should hear.

## Done when

All of this is confirmed from events and logs, with nobody at the keyboard. In the emulator, opening the test app starts a session. A user turn sent as text shows up at the pretend hub as `heard`. A typed `say` starts within about a second, and `hush` cuts it off. It all still works with the app in the back. A typed `call` reaches the team's own Twilio number, opens with the AI disclosure, and comes back with a summary. The listen test and the one call to a person are written under "Try it yourself".

## Core and extras

Wajeeh, who owns this part, has a 1x budget, so the work is split in two. Read "Budgets" in `CLAUDE.md` first.

- **Wajeeh's AI builds the Core**, in the order below, and stops when it is done.
- **The Extras are open to the backup, Hamza's AI, from the start.** Wajeeh's AI lists them under "Open" in `mouth/STATUS.md` in its first commit.

**Core**, in this order. Item numbers refer to "What to build".

1. The pretend hub (item 1).
2. The Mouth and the test app (items 3 and 4), in the emulator: opening the app starts a session, `heard` and `spoke` are forwarded, and `whisper`, `say` (with `say_started` and `say_done`), `correct`, `hush` and `sleep` work as the contract describes, along with its reconnect rules.
3. A dry-run-only `startCaller`: it connects as `caller` and answers every `call` with a canned `call_result`, whatever `CALLER_DRY_RUN` says. This gives the final app its entry point.
4. `npm test` for message handling and the `say` queue, a `check.sh` with the tests, a type check and a build of the test app, and `MERGE.md`.

Core is done when, in the emulator, opening the test app starts a session, a user turn sent as text arrives at the pretend hub as `heard`, a typed `say` is spoken, and `hush` cuts it off.

**Extras**, most important first:

1. Working from the back: the test in item 4, with whatever it takes written in `MERGE.md`. The final app depends on this.
2. The real Caller (item 2), with `tools/caller.mjs`, its tests with `fetch` stubbed, and the dry-run call in `check.sh`.
3. Measuring the `say` delay and getting it to start within about a second.
4. The 5 minute backstop and earbud routing.
5. A real call to the team's own Twilio number.
6. The remaining tests in item 5.

The Extras need the OpenAI key and the SIP trunk credentials, which sit in Wajeeh's `.env`. The backup builds against stubs until Wajeeh sends those lines to Hamza directly.
