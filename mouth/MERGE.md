# Merging bobby-mouth into the final app

## 0. OpenAI Realtime voice and the OpenAI caller

- **React Native libraries:** `src/openai.ts` uses `@livekit/react-native-webrtc` (RTCPeerConnection, microphone, data channel) and `@livekit/react-native` (AudioSession: Bluetooth, then headset, then speaker). Permissions, plugins and the foreground service are below.
- **App tsconfig:** bare imports from `../mouth/src` resolve through `paths`; `app/tsconfig.json` now maps `@livekit/react-native` and `@livekit/react-native-webrtc` to `app/node_modules` (done).
- **Env** (all through `config.env`): `OPENAI_API_KEY` (the Mouth mints a short-lived Realtime client secret from it on the phone, for now; the key never leaves the phone except to api.openai.com), optional `MOUTH_VOICE_MODEL` (default `gpt-realtime-2.1-mini`), `MOUTH_VOICE` (default `marin`), `MOUTH_TRANSCRIBE_MODEL` (default `gpt-live-transcribe`). Caller: `CALLER_MODEL`, `CALLER_VOICE`, `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD`, `CALLER_SUMMARY_MODEL`, `CALLER_OWNER_NAME`, `OWNER_NUMBER` (caller number on the SIP trunk), `CALL_ALLOWLIST`, `CALLER_DRY_RUN` (default 1).
- **Network:** HTTPS and WebRTC (UDP) to api.openai.com; WSS to api.openai.com for the caller's sideband.
- Keep `@livekit/react-native-expo-plugin`: it configures WebRTC.
- **Check on the phone:** Bobby plays through the earbuds; `say`/`progress` start within ~1 s; the mic closes after a command and reopens for a confirmation question and for a question with options (again once Bobby has finished reading it out).

Everything the final Bobby app (built by Hands) needs to include this package. The test app in `example/` is a working reference: copy from its `package.json`, `app.json` and `metro.config.js`.

## 1. Install

From the final app's folder, with the Expo version in `VERSIONS.md`:

```sh
npm install bobby-mouth@file:../mouth
npm install "@livekit/react-native@2.12.0" "@livekit/react-native-webrtc@144.1.2" livekit-client \
  "@livekit/react-native-expo-plugin@~1.1.0" "@config-plugins/react-native-webrtc@^15.0.2"
npx expo install expo-dev-client expo-build-properties
```

- **Pin `@livekit/react-native-webrtc` to exactly 144.1.2.** 144.2.0 renamed its Java package (`org.webrtc` → `livekit.org.webrtc`) and `@livekit/react-native` 2.12.0 no longer compiles against it. Don't upgrade `@livekit/react-native` to 3.x or the expo plugin to 1.2 without testing: these versions are the ones built and run together.
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

`env` must contain `OPENAI_API_KEY` (Mouth and Caller). The Caller also reads the `CALLER_*` settings, `OWNER_NUMBER`, `CALL_ALLOWLIST` and `CALLER_DRY_RUN` from `env` (section 0).

- The Caller uses only `fetch`, `WebSocket` and timers (no Node libraries), talking to `https://api.openai.com` (HTTPS, and WSS for the sideband): no extra permissions or config plugins beyond `INTERNET`.
- **`CALLER_DRY_RUN` defaults to 1.** Every call is faked unless `env.CALLER_DRY_RUN` is exactly `"0"`. Leave it at 1 until the human chooses to place a real call.
- The phone carries no call audio: GPT-Live and the SIP trunk do. The app only follows the call over the sideband WebSocket, which the keep-alive service (section 5) keeps running in the back.

## 5. Working from the back (tested)

After `wake()` the final app moves itself to the back. Without a **foreground service of type `microphone`**, Android freezes the app about 8 s later: in the emulator both hub sockets dropped (1006) and Bobby went deaf and silent. With one, the session keeps going: tested in the emulator with Home pressed right after `wake`, then a typed user turn → `heard` + `spoke`, a `say` → `say_started`/`say_done` right away and again 60 s later, then `sleep` → `asleep`.

**In the final app, Hands' keep-alive is that service.** `hands.startKeepAlive()` runs `KeepAliveService` with `foregroundServiceType="microphone|dataSync"` and uses the microphone type only when `RECORD_AUDIO` is granted. So:

1. **Grant `RECORD_AUDIO` before the first wake** (runtime request or `adb shell pm grant`). Without it the keep-alive falls back to `dataSync` and the Mouth loses the microphone in the back.
2. **Order:** `startKeepAlive()` → `mouth.wake()` → `moveToBack()`, all while the app is in front. That is what `app/src/bobby.ts` already does.
3. **Don't add `react-native-background-actions`** to the final app: the test app uses it (plus `example/plugins/withMicForegroundService.js`) only because it has no Hands. One microphone service is enough.

## 6. No React provider needed

`startMouth` is a plain function: `src/openai.ts` drives the WebRTC peer connection directly, so the app doesn't wrap anything in a provider.

## 7. Not yet verified

- **Earbuds** (Extra 5): `src/openai.ts` asks `AudioSession` for Bluetooth first, then headset, then speaker. Untested; the emulator can't check it.
- **On the real phone:** the `say`/`progress` delay and the background behaviour on Samsung's battery settings.
