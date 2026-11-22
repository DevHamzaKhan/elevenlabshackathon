# bobby-mouth

Bobby's voice: an ElevenLabs realtime speech agent driven by the hub (CONTRACT.md, "Mouth"), plus the Caller, which places calls in the owner's cloned voice (dry run unless `CALLER_DRY_RUN=0`). Plain TypeScript with no build step; only `src/elevenlabs.ts` needs React Native.

| Path | What |
|---|---|
| `src/hub.ts` | Hub client: hello/welcome, reconnect 1/2/5/5 s, never after 4001. |
| `src/mouth.ts` | The Mouth's logic: wake, whisper, the `say` queue, correct, hush, sleep, asleep rules, 5 min backstop. |
| `src/elevenlabs.ts` | The only file that talks to ElevenLabs. |
| `src/caller.ts` | The Caller: allowlist, Twilio call from `OWNER_NUMBER` connected to the caller agent (fallback: ElevenLabs dials from the bought number), `call_status`, transcript + summary in `call_result`. Dry run by default. |
| `src/index.ts` | `startMouth(config)` → `{wake, stop, status}`, `startCaller(config)` → `{stop}`. |
| `agent/` | `bobby-prompt.md`, `caller-prompt.md` and `setup.mjs`, which creates/updates both agents, the voice clone and the Twilio number import. |
| `tools/caller.mjs` | Runs the Caller on the laptop against a hub, reading the root `.env`. |
| `fakes/hub.mjs` | Pretend hub. |
| `example/` | Expo test app (`dev.bobby.mouth`). |

## Run

```sh
npm install                 # in mouth/ (test tools only)
./check.sh                  # tests, type check, setup dry run, test app build
SKIP_BUILD=1 ./check.sh     # without the Android build
```

**Set up ElevenLabs** (needs `ELEVENLABS_API_KEY` in the root `.env`; Twilio steps also need `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`):

```sh
node agent/setup.mjs            # Bobby agent, voice clone (from mouth/private/), caller agent, Twilio number import
node agent/setup.mjs --dry-run  # every step against a fake API; prints each request, keys redacted
node agent/setup.mjs --reclone  # make the voice clone again from a new sample
```

It writes `ELEVENLABS_BOBBY_AGENT_ID`, `ELEVENLABS_CALLER_AGENT_ID` and `ELEVENLABS_PHONE_NUMBER_ID` to the root `.env` (and the Bobby id to `example/.env`), and prints what is still for a person.

Setting `MOUTH_REALTIME_MODEL` in the root `.env` picks the Realtime model (default `eleven_realtime_v1_mini`). Re-run `setup.mjs` after changing the prompt.

## Against the pretend hub

```sh
node fakes/hub.mjs --port 8766        # then type: say hello | whisper ... | correct ... | hush | sleep | user <text> | call +1... <goal>
```

Test app, in an Android emulator (the pretend hub is `10.0.2.2` from there):

```sh
cd example && npm install
# example/.env: EXPO_PUBLIC_HUB_URL=ws://10.0.2.2:8766  (setup.mjs adds the agent id)
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

## Settings

Only these, through `config.env`: `ELEVENLABS_BOBBY_AGENT_ID` (Mouth); `CALL_ALLOWLIST`, `CALLER_DRY_RUN`, `OWNER_NUMBER`, `ELEVENLABS_API_KEY`, `ELEVENLABS_CALLER_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Caller).

Laptop-only, non-secret: `MOUTH_REALTIME_MODEL` (Bobby's Realtime model), `MOUTH_CALLER_FALLBACK_VOICE_ID` (caller voice until the sample exists), `MOUTH_CALLER_TTS_MODEL` (optional TTS model for the caller agent), `MOUTH_TWILIO_NUMBER` (which bought number to import, if there are several), `MOUTH_HUB_PORT` (pretend hub default port), `MOUTH_CHECK_PORT` (port for the dry-run call in `check.sh`, default 8797).
