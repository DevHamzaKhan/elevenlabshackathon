# Merging bobby-mouth into the final app

Everything the final Bobby app (built by Hands) needs to include this package. The test app in `example/` is a working reference: copy from its `package.json`, `app.json` and `metro.config.js`.

## 1. Install

From the final app's folder, with the Expo version in `VERSIONS.md`:

```sh
npm install bobby-mouth@file:../mouth
npm install @elevenlabs/react-native@1.2.42 @elevenlabs/client@1.37.1 \
  "@livekit/react-native@2.12.0" "@livekit/react-native-webrtc@144.1.2" livekit-client \
  "@livekit/react-native-expo-plugin@~1.1.0" "@config-plugins/react-native-webrtc@^15.0.2"
npx expo install expo-dev-client expo-build-properties
```

- **Exactly one copy of `@elevenlabs/client`**, the version `@elevenlabs/react-native` depends on (1.37.1 here). Check with `npm ls @elevenlabs/client`. Two copies would leave the voice without its native audio setup.
- **Pin `@livekit/react-native-webrtc` to exactly 144.1.2.** 144.2.0 renamed its Java package (`org.webrtc` → `livekit.org.webrtc`) and `@livekit/react-native` 2.12.0 no longer compiles against it. The LiveKit versions follow ElevenLabs' own Expo example. Don't upgrade `@livekit/react-native` to 3.x or the expo plugin to 1.2: the ElevenLabs SDK's peers want LiveKit 2 / webrtc 144.
- A development build is required (`npx expo run:android`); Expo Go can't run the native WebRTC code.

## 2. Metro

`bobby-mouth` is plain TypeScript installed from `../mouth` (a symlink). Metro must watch that folder but resolve every dependency from the app's own `node_modules`, so there is one React:

```js
// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const config = getDefaultConfig(__dirname);
const pkgs = [path.resolve(__dirname, "../mouth")]; // add ../mind etc.
config.watchFolders = pkgs;
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.blockList = pkgs.map((p) => new RegExp(`^${path.join(p, "node_modules").replace(/[/\\]/g, "[/\\\\]")}[/\\\\].*`));
module.exports = config;
```

## 3. app.json

```json
{
  "android": {
    "permissions": [
      "android.permission.RECORD_AUDIO",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.WAKE_LOCK",
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_CONNECT"
    ]
  },
  "plugins": [
    "@livekit/react-native-expo-plugin",
    "@config-plugins/react-native-webrtc",
    ["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
  ]
}
```

`usesCleartextTraffic` lets the package reach the hub at `ws://127.0.0.1:8765` (contract, "Connecting").

## 4. Wiring

```ts
import { startMouth, startCaller } from "bobby-mouth";

const config = { hubUrl: "ws://127.0.0.1:8765", token: env.HUB_TOKEN, env, log };
const mouth = startMouth(config);   // connects as `mouth`
const caller = startCaller(config); // connects as `caller`; dry run unless env.CALLER_DRY_RUN === "0"
// Request RECORD_AUDIO before the first wake().
mouth.wake();                       // each time the app is opened (side button)
// on shutdown: mouth.stop(); caller.stop();
```

`env` must contain `ELEVENLABS_BOBBY_AGENT_ID` (written into the root `.env` by `mouth/agent/setup.mjs`). The Caller reads `CALL_ALLOWLIST`, `CALLER_DRY_RUN`, `OWNER_NUMBER`, `ELEVENLABS_API_KEY`, `ELEVENLABS_CALLER_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` from `env`. No API key is needed by the Mouth itself.

- The Caller uses only `fetch`, `btoa` and timers (no Node libraries), talking to `https://api.elevenlabs.io` and `https://api.twilio.com` over HTTPS: no extra permissions or config plugins beyond `INTERNET`. Hermes has `btoa` (React Native 0.74+).
- **`CALLER_DRY_RUN` defaults to 1.** Every call is faked unless `env.CALLER_DRY_RUN` is exactly `"0"`. Leave it at 1 until the human chooses to place a real call.
- A call runs while the app is in the back without a foreground service: it's only HTTPS polling (every 2 s) while Twilio and ElevenLabs carry the audio. If Android pauses the JS thread, the `call_result` arrives late but still arrives.

## 5. Not yet verified (open items in STATUS.md)

- **Working from the back** (Extra 1). After `wake()` the final app moves itself to the back. Android stops giving the microphone to a background app unless a **foreground service of type `microphone`** is running, started while the app is still in front. Expected needs: permissions `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MICROPHONE`, a service declared with `android:foregroundServiceType="microphone"` and an ongoing notification. Hands' native module is the natural place for that service. This hasn't been tested yet.
- **Earbuds** (Extra 5): check that Bobby plays through connected Bluetooth earbuds. `@elevenlabs/react-native` sets the output to the speaker by default, so routing may need `AudioSession` from `@livekit/react-native`. Untested; the emulator can't check it.
