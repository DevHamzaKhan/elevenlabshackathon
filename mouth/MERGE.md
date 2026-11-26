# Merging bobby-mouth into the final app

## 0. v2: OpenAI Realtime voice (default) and the OpenAI caller

- **No new React Native library.** `src/openai.ts` uses `@livekit/react-native-webrtc` (RTCPeerConnection, microphone, data channel) and `@livekit/react-native` (AudioSession: Bluetooth, then headset, then speaker), both already installed for ElevenLabs. Same permissions, plugins and foreground service as below.
- **App tsconfig:** bare imports from `../mouth/src` resolve through `paths`; `app/tsconfig.json` now maps `@livekit/react-native` and `@livekit/react-native-webrtc` to `app/node_modules` (done).
- **Env** (all through `config.env`): `OPENAI_API_KEY` (the Mouth mints a short-lived Realtime client secret from it on the phone, for now; the key never leaves the phone except to api.openai.com), optional `MOUTH_VOICE_VENDOR` (`openai` default, `elevenlabs` for the old agent), `MOUTH_VOICE_MODEL` (default `gpt-realtime-2.1-mini`), `MOUTH_VOICE` (default `marin`), `MOUTH_TRANSCRIBE_MODEL` (default `gpt-live-transcribe`). Caller: `CALLER_VENDOR` (`openai` default, `elevenlabs`), `CALLER_MODEL`, `CALLER_VOICE`, `CALLER_SIP_URL`, `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD`, `CALLER_SUMMARY_MODEL`, plus the v1 `OWNER_NUMBER`, `CALL_ALLOWLIST`, `CALLER_DRY_RUN` (default 1).
- **Network:** HTTPS and WebRTC (UDP) to api.openai.com; WSS to api.openai.com for the caller's sideband.
- The ElevenLabs packages stay installed while `MOUTH_VOICE_VENDOR=elevenlabs` / `CALLER_VENDOR=elevenlabs` are still possible. Once the OpenAI path is proven on the phone they can be removed with `@livekit/react-native-expo-plugin` kept (it configures WebRTC).
- **Check on the phone:** Bobby plays through the earbuds; `say`/`progress` start within ~1 s; the mic closes after a command and reopens for a confirmation question and for a question with options (again once Bobby has finished reading it out).

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

## 5. Working from the back (tested)

After `wake()` the final app moves itself to the back. Without a **foreground service of type `microphone`**, Android freezes the app about 8 s later: in the emulator both hub sockets dropped (1006) and Bobby went deaf and silent. With one, the session keeps going: tested in the emulator with Home pressed right after `wake`, then a typed user turn → `heard` + `spoke`, a `say` → `say_started`/`say_done` right away and again 60 s later, then `sleep` → `asleep`.

**In the final app, Hands' keep-alive is that service.** `hands.startKeepAlive()` runs `KeepAliveService` with `foregroundServiceType="microphone|dataSync"` and uses the microphone type only when `RECORD_AUDIO` is granted. So:

1. **Grant `RECORD_AUDIO` before the first wake** (runtime request or `adb shell pm grant`). Without it the keep-alive falls back to `dataSync` and the Mouth loses the microphone in the back.
2. **Order:** `startKeepAlive()` → `mouth.wake()` → `moveToBack()`, all while the app is in front. That is what `app/src/bobby.ts` already does.
3. **Don't add `react-native-background-actions`** to the final app: the test app uses it (plus `example/plugins/withMicForegroundService.js`) only because it has no Hands. One microphone service is enough.

## 6. Agent settings the Mouth relies on

`agent/setup.mjs` sets these on the Bobby agent; re-run it after any change:
- `turn.turn_timeout = -1`: Bobby never speaks up on his own after a silence. With ElevenLabs' default (7 s) he kept saying "Are you still there?" while the user was quiet, which would talk over a task.
- Realtime voice mode, empty `first_message`, public (no signed URL), the prompt in `agent/bobby-prompt.md`.

## 7. No React provider needed

`startMouth` is a plain function: it drives `@elevenlabs/client`'s `VoiceConversation` directly, so the app doesn't wrap anything in `ConversationProvider`. (Answers MERGE-ISSUES.md, Mouth item 3.)

## 8. Not yet verified

- **Earbuds** (Extra 5): check that Bobby plays through connected Bluetooth earbuds. `@elevenlabs/react-native` sets the output to the speaker by default, so routing may need `AudioSession` from `@livekit/react-native`. Untested; the emulator can't check it.
- **On the real phone:** the `say` delay (0.26–0.28 s in the emulator) and the background behaviour on Samsung's battery settings.
