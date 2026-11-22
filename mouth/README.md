# bobby-mouth

Bobby's voice: an ElevenLabs realtime speech agent driven by the hub (CONTRACT.md, "Mouth"), plus the Caller (dry run for now). Plain TypeScript with no build step; only `src/elevenlabs.ts` needs React Native.

| Path | What |
|---|---|
| `src/hub.ts` | Hub client: hello/welcome, reconnect 1/2/5/5 s, never after 4001. |
| `src/mouth.ts` | The Mouth's logic: wake, whisper, the `say` queue, correct, hush, sleep, asleep rules, 5 min backstop. |
| `src/elevenlabs.ts` | The only file that talks to ElevenLabs. |
| `src/caller.ts` | The Caller (dry run: canned `call_result`). |
| `src/index.ts` | `startMouth(config)` → `{wake, stop, status}`, `startCaller(config)` → `{stop}`. |
| `agent/` | `bobby-prompt.md` and `setup.mjs`, which creates/updates the agent. |
| `fakes/hub.mjs` | Pretend hub. |
| `example/` | Expo test app (`dev.bobby.mouth`). |

## Run

```sh
npm install                 # in mouth/ (test tools only)
./check.sh                  # tests, type check, setup dry run, test app build
SKIP_BUILD=1 ./check.sh     # without the Android build
```

**Create the agent** (needs `ELEVENLABS_API_KEY` in the root `.env`):

```sh
node agent/setup.mjs        # writes ELEVENLABS_BOBBY_AGENT_ID to .env and example/.env
```

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

Opening the app connects as `mouth` and `caller` and calls `wake()`. Then in the hub type `user hi Bobby` (a typed user turn: arrives as `heard`), `say I'm looking for Reply`, `hush`, `sleep`.

## In the final app

See `MERGE.md`.

## Settings

Only these, through `config.env`: `ELEVENLABS_BOBBY_AGENT_ID` (Mouth), `CALL_ALLOWLIST` (Caller). Laptop-only: `ELEVENLABS_API_KEY` and `MOUTH_REALTIME_MODEL` (setup script), `MOUTH_HUB_PORT` (pretend hub default port).
