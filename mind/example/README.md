# bobby-mind example (Expo Go)

A one-screen Expo app (SDK 58.0.26) that proves `bobby-mind` runs inside React Native. On launch it:

1. calls `makeModel({apiKey, log})` twice with a tiny JSON schema and shows each reply and its milliseconds;
2. calls `startMind({hubUrl: "ws://10.0.2.2:8765", token: "dev", env: {ANTHROPIC_API_KEY}, log, hints: []})` and shows the log, including `hub: connected`.

`proof.png` is a screenshot of it working in Expo Go on an Android 15 emulator.

## Setup (once)

```sh
cd mind && npm install            # the package's own deps (@anthropic-ai/sdk lives in mind/node_modules)
cd example && npm install         # links bobby-mind as file:.. (a symlink)
grep '^ANTHROPIC_API_KEY=' ../../.env | sed 's/^/EXPO_PUBLIC_/' > .env   # git ignores it
```

`EXPO_PUBLIC_MIND_HUB_URL` in `.env` overrides the hub URL (default `ws://10.0.2.2:8765`, the laptop seen from the emulator).

## Run

```sh
# 1. emulator (AVD made with: avdmanager create avd -n bobby_api35 -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7)
$ANDROID_HOME/emulator/emulator -avd bobby_api35 &      # add -no-window to run headless
# 2. pretend hub, in another terminal
cd mind && npx tsx fakes/hub.ts --port 8765              # prints "hub: mind connected" when the app connects
# 3. the app (installs Expo Go on the emulator on first run)
cd mind/example && npx expo start --android
```

If Expo Go opens the laptop's LAN address and shows "Something went wrong", open `exp://10.0.2.2:8081` in Expo Go instead (or `adb shell am start -a android.intent.action.VIEW -d exp://10.0.2.2:8081`).

On a real phone over USB: `adb reverse tcp:8765 tcp:8765` and set `EXPO_PUBLIC_MIND_HUB_URL=ws://127.0.0.1:8765`.

## What is special here

- `metro.config.js`: watches `mind/` and adds `mind/node_modules` to the lookup paths, because `file:..` is a symlink outside the project.
- `index.ts`: loads `bobby-mind` while React Refresh is hidden. Without that, dev builds crash on start with `Cannot read property 'BetaToolRunner' of undefined` (circular imports inside `@anthropic-ai/sdk`). Details in `../MERGE.md`, "Running inside Expo".
- The API key is inlined into the JS bundle by `EXPO_PUBLIC_`. That is fine for this local test app only. The final app hands keys to `startMind` through `config.env` at run time.

Measured from the emulator (Opus 5.5, effort low, ~250 input tokens): 2460 ms first call, 1675 ms second call.
