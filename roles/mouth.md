# Mouth and the call (`mouth/`)

You're building Bobby's voice and the phone call, as one TypeScript package that ends up inside an Expo app on the phone. That is four small pieces: a pretend hub for testing, a setup script that configures ElevenLabs, the Mouth, which runs the ElevenLabs realtime speech agent, and the Caller, which places a call in the owner's cloned voice.

Much of this part is vendor setup. Do as much of it as possible with the vendors' APIs, so the human only does what truly needs a person. Your code is thin glue. **Keep it small:** build the pieces in the order below, simplest and most certain first, and don't add anything that isn't listed.

- **Stack:** TypeScript, package name `bobby-mouth`, in `mouth/`, with ElevenLabs' official React Native SDK. Node 22 or newer on the laptop, with npm.
- **Accounts needed:** ElevenLabs (a paid plan that allows voice cloning) and Twilio.
- **No wake word.** Bobby starts when the app is opened, which the phone's side button does. Don't add a wake-word library or service.
- **Device: an Android emulator, never a real phone.** The team has one Android phone, and the Hands part has it for the whole build, so never ask for it. Set up the emulator yourself: a current Google APIs image that matches this Mac's processor, with the host microphone turned on so it hears the laptop's mic, and sound out through the laptop. From the emulator, the pretend hub is at `ws://10.0.2.2:8765`.

## The package

The contract's "Packages" section fixes the entry points:

- **`startMouth(config)`** returns `{wake(), stop()}`. It connects to the hub as `mouth`. `wake()` starts a session with the Bobby agent and sends `wake`. It does nothing if a session is already live.
- **`startCaller(config)`** returns `{stop()}`. It connects to the hub as `caller`.
- Everything arrives through `config`: the hub URL, the token, `env` and `log`. The package never reads files or environment variables itself.
- **No build step.** `package.json` points straight at the TypeScript source, with no path aliases.
- **Keep the logic testable.** Put message handling, the `say` queue and all of the Caller in plain TypeScript that runs in Node as well as React Native: `fetch`, `WebSocket` and timers only, with no Node-only libraries. Only the thin layer that talks to the ElevenLabs SDK needs React Native.
- **The final app is built by the Hands part, not you.** It opens, calls your `wake()`, and then moves itself to the back. Write everything it needs in `mouth/MERGE.md`: permissions, config plugins, native settings, and what kind of foreground service keeps the microphone and the session working while another app is on screen.

## Configuration

These are the only variables this part uses, and they arrive in `config.env`. Don't ask for any others.

**Secret keys.** The human puts these in the root `.env`.

| Variable | Used by | Meaning |
|---|---|---|
| `ELEVENLABS_API_KEY` | setup script, Caller | Never needed by the Mouth itself. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | setup script, Caller | Used to import the number into ElevenLabs and to place calls through Twilio. |

**Settings**, also in the root `.env`:

| Variable | Used by | Meaning |
|---|---|---|
| `OWNER_NUMBER` | Caller | The owner's own mobile, verified in Twilio, shown to the person being called. |
| `CALL_ALLOWLIST` | Caller | Comma-separated numbers the Caller may dial. |
| `CALLER_DRY_RUN` | Caller | Defaults to `1`, which fakes every call instead of dialing. |

**Ids that the setup script writes into the root `.env`.** Nobody types these by hand.

| Variable | Used by | Meaning |
|---|---|---|
| `ELEVENLABS_BOBBY_AGENT_ID` | Mouth | The Bobby agent. |
| `ELEVENLABS_CALLER_AGENT_ID` | Caller | The cloned-voice agent that makes calls. |
| `ELEVENLABS_PHONE_NUMBER_ID` | Caller | The Twilio number as imported into ElevenLabs. |

Your test app gets these from a `.env` in its own folder, which the setup script also writes. Git ignores it. That is for the test app only: the final app receives them through its settings.

## First steps

1. **Tools.** Check for Node, `adb`, a JDK and the Android SDK, and install whatever is missing. Prefer command-line installs, because they need no clicks: Homebrew's `node`, Homebrew's `openjdk` at the version the Expo SDK in `VERSIONS.md` needs, Homebrew's `android-commandlinetools`, then `sdkmanager` for platform-tools, the platform and build-tools that Expo version needs, the emulator and a system image. Create the emulator with `avdmanager` and start it from the command line. Turn on its host microphone from the command line if you can. If you can't, leave it off and note the clicks under "Try it yourself": your own tests don't need a microphone.
2. **What the human did before starting you.** Check each one, and follow "Never wait for the human" for anything missing:
   1. **ElevenLabs:** an account on a plan that allows voice cloning, with its API key in the root `.env` as `ELEVENLABS_API_KEY`.
   2. **Voice sample:** 1 to 2 minutes of the phone's owner talking, saved in `mouth/private/` in any common audio format. Until it's there, give the caller agent a ready-made voice.
   3. **Twilio:** an account with the SID and auth token in the root `.env`, the owner's own mobile verified as a caller ID and written in `OWNER_NUMBER`, and one bought number.
   4. **A test contact:** a teammate who agreed to take one test call, with their number in `CALL_ALLOWLIST`.
3. **Find out yourself** whether the account offers the Realtime voice mode, by asking the API or trying to set it. Don't ask the human to look.
4. **STATUS.md.**

## What to build

1. **`mouth/fakes/hub.mjs`**, a Node script that pretends to be the hub on port 8765 and accepts any token. It follows the contract's "Connecting" section, prints every frame it receives, and lets you type `say hello there`, `whisper ...`, `correct ...`, `hush`, `sleep`, and `call +1415... <goal>`, sending each to the right role. `--script <file>` runs the same commands from a file, where `wait 2` pauses for two seconds. You'll test both other pieces against it.
2. **`mouth/agent/setup.mjs`**, a Node script that configures ElevenLabs through its API, and can be run again safely to apply changes:
   - Creates or updates the Bobby agent from `mouth/agent/bobby-prompt.md`, set to Realtime voice mode, and connectable by agent id alone so the Mouth never needs the API key.
   - Makes the voice clone from the sample in `mouth/private/`.
   - Creates or updates the caller agent, using the cloned voice and `mouth/agent/caller-prompt.md`.
   - Imports the Twilio number into ElevenLabs.
   - Writes the three ids into the root `.env`, and what the test app needs into `mouth/example/.env`.
   - Anything the API can't do goes on the human's list as exact clicks. If Realtime isn't available yet, use the standard voice mode for now and note it. Switching later must not need a code change.
3. **The Caller**, started by `startCaller`:
   - On a `call` message it checks the number against `CALL_ALLOWLIST`, then dials it with the caller agent. Pass the `goal` and `context` into the agent for that one call.
   - The person called should see `OWNER_NUMBER`. Try these in order and use the first that works: ElevenLabs' outbound call API, if it can show a Twilio verified caller ID; then placing the call yourself through Twilio's REST API from `OWNER_NUMBER` and connecting it to the caller agent with ElevenLabs' own support for calls you place through Twilio; then calling from the bought Twilio number. Write which one you used under "Decisions", and tell the human under "Needs the human" if it had to be the last.
   - It talks to both services with `fetch`, because their Node libraries won't run on the phone.
   - It sends `call_status` as the call progresses.
   - When the call ends it fetches the transcript, writes a one or two sentence summary of what the other person said, and sends `call_result`.
   - Any failure still ends in a `call_result` with `"ok":false`.
   - With `CALLER_DRY_RUN=1` it skips dialing and returns a canned result, so tests never place a call.
   - **Real calls without a person.** To prove the real path, make the team's own bought Twilio number answer with a short recorded message, add it to the allowlist yourself, and call that. Nobody has to pick up, so repeat it as often as you need. Put that number's settings back when you're done.
   - `mouth/tools/caller.mjs` runs it on the laptop with Node, against the pretend hub, reading the root `.env`.
4. **The Mouth**, started by `startMouth`:
   - `wake()` starts a session with the Bobby agent through ElevenLabs' React Native SDK. If that SDK doesn't support what you need, use the agent's WebSocket API directly.
   - It forwards each final user transcript as `heard` and each thing Bobby says as `spoke`.
   - It implements `whisper`, `say`, `correct`, `hush` and `sleep` exactly as the contract describes, including `say_started` and `say_done`. Find the SDK's way of giving the agent silent context and of making it speak a given line. Getting `say` to start within one second is the hard part, so spend your effort there. Measure the delay and record it in STATUS.md.
   - It follows the contract's "Sleeping" rules. On `sleep` it ends the session, sends `asleep` and goes idle, with the microphone off, until `wake()` is called again. It doesn't time out on silence by itself, apart from the 5 minute backstop, because a phone call can leave Bobby silent for minutes.
   - It follows the contract's reconnect rules, including not reconnecting after close code 4001.
   - Audio goes through connected Bluetooth earbuds when there are any. The emulator can't test this, so write the code from the docs, and add "check that Bobby plays through the earbuds" to `mouth/MERGE.md`.
5. **`mouth/example/`**, a small Expo test app, id `dev.bobby.mouth`, for the version in `VERSIONS.md`, installing the package from `..`:
   - It needs a development build, because the ElevenLabs SDK has native code. Build and run it in the emulator with `npx expo run:android`.
   - Opening it calls `startMouth` and `startCaller`, then `wake()`. One screen shows a status line (idle, live or disconnected) and a button for the microphone permission. Grant the permission yourself with `adb shell pm grant` while testing.
   - **Test it in the back.** After `wake()`, send the app to the back with `adb shell input keyevent HOME`, and confirm from the pretend hub that Bobby still hears and still speaks. Whatever that takes goes in `mouth/MERGE.md`.
6. **Tests**, run with `npm test` in Node: message handling, the `say` queue, parsing every contract example the Mouth or the Caller sends or receives, and the Caller with `fetch` stubbed out.
7. **`mouth/check.sh`**: `npm test`, a type check, a dry-run call through `tools/caller.mjs` against the pretend hub, and a build of the test app.
8. **`mouth/MERGE.md`**, as the contract describes.

## The two agent prompts

- **`mouth/agent/bobby-prompt.md`.** Bobby is warm and brief. He chats naturally. He never claims to have started, finished or cancelled anything on his own: when the user asks for something he gives a short acknowledgement like "On it" and waits for what he's told next. He speaks the lines he's given in his own voice, and treats background context as things he knows without reading it out.
- **`mouth/agent/caller-prompt.md`.** The caller speaks as the phone's owner, in first person, to someone who expects the call. It is friendly and brief, gets to the goal it was given, listens to the answer, and ends the call politely once it has one. It never pretends to be anyone other than the owner.

## Order

Commit after each step.

1. The pretend hub.
2. `setup.mjs`, run as far as the keys allow.
3. The Caller on the laptop, first with `CALLER_DRY_RUN=1`, then real calls to the team's own Twilio number. Never call the owner's own phone: a call that shows the owner's number and rings the owner's phone goes to voicemail. Leave the one call to the human test contact for the human, under "Try it yourself".
4. The test app running in the emulator and connecting to the pretend hub, with a typed `say` being spoken out loud.
5. Opening the app starting a session, with `heard` and `spoke` arriving at the pretend hub.
6. `hush`, `correct`, going back to sleep, working from the back, and earbud routing.

You can't speak to the emulator or hear it, and nobody is there to do it for you. Play the user's side by sending their turns as text, which the ElevenLabs SDK supports, and check Bobby's side from events, logs and transcripts. Then write one short "listen test" under "Try it yourself": what to say out loud, and what they should hear.

## Done when

All of this is confirmed from events and logs, with nobody at the keyboard. In the emulator, opening the test app starts a session. A user turn sent as text shows up at the pretend hub as `heard`. A typed `say` starts within about a second, and `hush` cuts it off. It all still works with the app in the back. A typed `call` reaches the team's own Twilio number in the cloned voice and comes back with a summary. The listen test and the one call to a person are written under "Try it yourself".

## Core and extras

Wajeeh, who owns this part, has a 1x budget, so the work is split in two. Read "Budgets" in `CLAUDE.md` first.

- **Wajeeh's AI builds the Core**, in the order below, and stops when it is done.
- **The Extras are open to the backup, Hamza's AI, from the start.** Wajeeh's AI lists them under "Open" in `mouth/STATUS.md` in its first commit.

**Core**, in this order. Item numbers refer to "What to build".

1. The pretend hub (item 1).
2. `setup.mjs` for the Bobby agent only: create or update it from `bobby-prompt.md`, and write `ELEVENLABS_BOBBY_AGENT_ID` into the root `.env` and `mouth/example/.env`.
3. The Mouth and the test app (items 4 and 5), in the emulator: opening the app starts a session, `heard` and `spoke` are forwarded, and `whisper`, `say` (with `say_started` and `say_done`), `correct`, `hush` and `sleep` work as the contract describes, along with its reconnect rules.
4. A dry-run-only `startCaller`: it connects as `caller` and answers every `call` with a canned `call_result`, whatever `CALLER_DRY_RUN` says. This gives the final app its entry point.
5. `npm test` for message handling and the `say` queue, a `check.sh` with the tests, a type check and a build of the test app, and `MERGE.md`.

Core is done when, in the emulator, opening the test app starts a session, a user turn sent as text arrives at the pretend hub as `heard`, a typed `say` is spoken, and `hush` cuts it off.

**Extras**, most important first:

1. Working from the back: the test in item 5, with whatever it takes written in `MERGE.md`. The final app depends on this.
2. The real Caller (item 3), with `tools/caller.mjs`, its tests with `fetch` stubbed, and the dry-run call in `check.sh`.
3. The rest of `setup.mjs`: the voice clone, the caller agent and `caller-prompt.md`, and the Twilio number import.
4. Measuring the `say` delay and getting it to start within about a second.
5. The 5 minute backstop and earbud routing.
6. A real call to the team's own Twilio number.
7. The remaining tests in item 6.

The Extras need the ElevenLabs and Twilio keys, which sit in Wajeeh's `.env`. The backup builds against stubs until Wajeeh sends those lines to Hamza directly.
