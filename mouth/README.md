# bobby-mouth

Bobby's voice and the Caller, both on OpenAI. The voice is an OpenAI Realtime model over WebRTC with Bobby's tools (`request`, `amend`, `cancel`, `confirm`, `answer`, `status`, `teach`; protocol v2, `mind/PROTOCOL-V2.md`), and the Caller places calls through GPT-Live over a SIP trunk with a stock voice, starting with an AI disclosure. Every call is a dry run unless `CALLER_DRY_RUN=0`. Plain TypeScript with no build step; only `src/openai.ts` needs React Native.

| Path | What |
|---|---|
| `src/hub.ts` | Hub client: hello/welcome, reconnect 1/2/5/5 s, never after 4001. |
| `src/mouth.ts` | The Mouth's logic: wake, whisper, the `say` queue, correct, hush, sleep, asleep rules, 5 min backstop. |
| `src/openai.ts` | The only file that talks to OpenAI Realtime from the phone (WebRTC, microphone, earbud routing). |
| `src/realtime.ts` | OpenAI Realtime, plain TS: session config (instructions, tools, VAD, transcription), client secret, SDP, events. |
| `src/caller-live.ts` | The OpenAI Caller: GPT-Live outbound SIP call, sideband events, AI disclosure, hang-up, summary. |
| `src/vendors.ts` | `voiceChoice(env)`: the Realtime model and any missing setting. |
| `src/caller.ts` | The Caller's entry point: allowlist, dry run, `hangup`; real calls go to `caller-live.ts`. Dry run by default. |
| `src/index.ts` | `startMouth(config)` → `{wake, stop, status}`, `startCaller(config)` → `{stop}`. |
| `tools/caller.mjs` | Runs the Caller on the laptop against a hub, reading the root `.env`. |
| `fakes/hub.mjs` | Pretend hub. |
| `example/` | Expo test app (`dev.bobby.mouth`). |

## Run

```sh
npm install                 # in mouth/ (test tools only)
./check.sh                  # tests, type check, dry-run call, Mind integration, test app build
SKIP_BUILD=1 ./check.sh     # without the Android build
```

There is no setup script: the voice needs only `OPENAI_API_KEY`, and Bobby's instructions and tools are built in `src/realtime.ts` at the start of each session.

## Against the pretend hub

```sh
node fakes/hub.mjs --port 8766        # then type: say hello | whisper ... | correct ... | hush | sleep | user <text> | call +1... <goal>
```

Test app, in an Android emulator (the pretend hub is `10.0.2.2` from there):

```sh
cd example && npm install
# example/.env: EXPO_PUBLIC_HUB_URL=ws://10.0.2.2:8766 and EXPO_PUBLIC_OPENAI_API_KEY=...
npx expo run:android
adb shell pm grant dev.bobby.mouth android.permission.RECORD_AUDIO
```

**The Caller on the laptop** (against the pretend hub):

```sh
node fakes/hub.mjs --port 8766
node tools/caller.mjs --hub ws://localhost:8766     # dry run (CALLER_DRY_RUN defaults to 1)
CALLER_DRY_RUN=0 node tools/caller.mjs --hub ws://localhost:8766   # real calls, allowlisted numbers only
# then in the hub: call +1415... Say I'm running late and ask if 3pm works.
```

Shell variables override the root `.env` for `tools/caller.mjs`.

Opening the app connects as `mouth` and `caller` and calls `wake()`. Then in the hub type `user hi Bobby` (a typed user turn: arrives as `heard`), `say I'm looking for Reply`, `hush`, `sleep`.

## In the final app

See `MERGE.md`.

## Caller on OpenAI

GPT-Live places outbound calls itself through your SIP trunk (`POST /v1/live/sessions` with `transport.type:"sip"`), so **no public endpoint, webhook or bridge is needed** (`mouth/bridge/` would only be needed for the inbound `realtime.call.incoming` webhook flow or a Twilio Media Streams bridge; neither is used). The Caller attaches the sideband WebSocket for call progress and transcripts, speaks an AI disclosure first, hangs up when the model signals the conversation is over (a client delegation), when the Mind sends `hangup`, or after 5 minutes, then summarizes what they said with `CALLER_SUMMARY_MODEL` (default `gpt-6-luna`).

One-time Twilio setup (from Twilio's Elastic SIP Trunking docs; check the current console wording):
1. Console > Elastic SIP Trunking > Trunks > Create a trunk (e.g. "bobby").
2. Termination: set a Termination SIP URI, e.g. `bobby.pstn.twilio.com`. `CALLER_SIP_URL=sips:bobby.pstn.twilio.com:5061`.
3. Termination > Authentication > Credential List: create a username and password. `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD`.
4. General > Secure Trunking: on (OpenAI needs TLS signaling and SRTP media).
5. Numbers: attach the bought number to the trunk. `OWNER_NUMBER` is sent as the caller number: it must be a number on the account (or a caller ID Twilio accepts on the trunk), otherwise use the bought number.
6. Put the test contact in `CALL_ALLOWLIST`, then `CALLER_DRY_RUN=0 node mouth/tools/caller.mjs --hub ws://localhost:8766` and `call +1... Say hello` in the pretend hub.

## Settings

Through `config.env`: `OPENAI_API_KEY` (Mouth and Caller), `MOUTH_VOICE_MODEL` (default `gpt-realtime-2.1-mini`), `MOUTH_VOICE` (default `marin`), `MOUTH_TRANSCRIBE_MODEL` (default `gpt-live-transcribe`); for the Caller `CALL_ALLOWLIST`, `CALLER_DRY_RUN`, `OWNER_NUMBER` (the caller number sent on the SIP trunk), `CALLER_MODEL` (default `gpt-live-1.1`), `CALLER_VOICE` (default `marin`), `CALLER_SUMMARY_MODEL` (default `gpt-6-luna`), `CALLER_OWNER_NAME` (for the disclosure), `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD`.

Laptop-only, non-secret: `MOUTH_HUB_PORT` (pretend hub default port), `MOUTH_CHECK_PORT` (port for the dry-run call in `check.sh`, default 8797).
