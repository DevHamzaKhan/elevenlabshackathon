# Merging bobby-mind into the final app

## v2 (OpenAI), 2026-11-24: what changed for the app

- **No runtime dependency at all.** `@anthropic-ai/sdk` is gone; `src/model.ts` calls the OpenAI Responses API with the global `fetch`. The React Refresh shim in `app/index.ts` and the `@anthropic-ai/sdk` entries in `app/package.json` / `app/tsconfig.json` are no longer needed (harmless; remove when convenient).
- **Env** (through `config.env`): `OPENAI_API_KEY` replaces `ANTHROPIC_API_KEY`. Optional: `MIND_ROUTER_MODEL`, `MIND_EXEC_MODEL`, `MIND_ESCALATE_MODEL`, `MIND_ROUTER_EFFORT`, `MIND_EXEC_EFFORT`, `MIND_ESCALATE_EFFORT`, `MIND_CHECK_EFFORT`, `MIND_CONFIRM` (`always` default), `MIND_OPENAI_BASE_URL`. `CONTACTS` values may now carry an email: `Hamza=+14155550111|hamza@example.com`.
- **`config.storage`** (optional, AsyncStorage-shaped `getItem`/`setItem`) persists memory and recipes. The app passes a SecureStore-backed store (`mindStorage` in `app/src/settings.ts`; done). AsyncStorage would also work if it is ever added.
- **Network:** HTTPS to `api.openai.com` (was `api.anthropic.com`).
- **Hands:** the Mind now sends v2 fields (`open`, `since`, `compact`, `image`, `then_screen`, `fast`, `caps`, `key`/`id` targets) and falls back when Hands doesn't support them (`PROTOCOL-V2.md`).
- **Mouth:** a v2 Mouth (OpenAI Realtime) talks to the Mind with `request`/`confirm_reply`/...; a v1 Mouth keeps working.

- **Teaching by showing (2026-11-26):** nothing new to install or permit. Taught skills are kept through the same `config.storage`, under a second key (`bobby-mind/skills/v1`; `mindStorage` maps it to a valid SecureStore key already). Optional env: `MIND_TEACH_MODEL`, `MIND_TEACH_EFFORT`, `MIND_TEACH_MODE`. It needs the Hands from this branch (`observe`); with an older Hands Bobby says he can't watch on this phone. See `TEACHING.md`.

The v1 notes below still apply except where they mention the Anthropic SDK.

**Ready to swap in.** The two bobby-mind items in `app/MERGE-ISSUES.md` (checked before the Mind landed) are resolved:

1. `src/index.ts` exists and exports `startMind(config: {hubUrl, token, env, log, hints}): {stop()}`. In `app/src/packages.ts`, replace the stand-in with `export { startMind } from 'bobby-mind';`.
2. This file is the `MERGE.md`. `@anthropic-ai/sdk` works under React Native/Hermes with no polyfill: the Mind's calls are non-streaming, so `fetch` streaming is not needed. Either `npm install @anthropic-ai/sdk` in the app, or add `mind/node_modules` to Metro's `nodeModulesPaths` (below). Development builds need the short React Refresh shim described under "Running inside Expo"; release builds don't.

Screens: the Mind reads Hands' extra `hint` field on nodes, and re-reads the screen just before a tap when its last read is older than 2.5 s, so expect an occasional second `screen` request per step.

## Install

- Add `"bobby-mind": "file:../mind"` to the app's `package.json` and `npm install`. The package points straight at TypeScript source (`main`: `src/index.ts`); no build step, no path aliases.
- Its one runtime dependency is `@anthropic-ai/sdk` (installed with the package). It needs no native module, no config plugin and no permission of its own.
- Metro must be able to read a `file:` dependency outside the app folder: see "Running inside Expo" below for the exact `metro.config.js` lines.

## Start it

```ts
import { startMind } from "bobby-mind";

const mind = startMind({
  hubUrl: "ws://127.0.0.1:8765",
  token: env.HUB_TOKEN,
  env,                 // the same env object every package gets; the Mind reads ANTHROPIC_API_KEY, MIND_MODEL, MIND_EFFORT, CONTACTS
  log: (line) => ...,  // one line of text per call; every model request/response with its duration comes through here
  hints,               // string[]: the files in stage/hints/*.md, bundled as strings (may be empty)
});
// mind.stop() on shutdown.
```

- Start it after the Hands hub is up, or before: it reconnects forever (1 s, 2 s, 5 s, then every 5 s), and stops for good only on close code 4001.
- `hints`: bundle `stage/hints/*.md` (except `TO-CHECK.md`) as strings, for example with a small generated `hints.ts`. The Mind works with an empty list.

## Network

- Outbound HTTPS to `api.anthropic.com` (the phone needs internet).
- Plain `ws://127.0.0.1:8765` to the hub: the app must allow cleartext traffic to `127.0.0.1` (Android blocks it by default). See "Running inside Expo".
- Model calls are non-streaming, because React Native's default `fetch` can't stream response bodies. Nothing else is needed for the SDK in React Native unless "Running inside Expo" says so.

## Running inside Expo

Proven in Expo Go (SDK 58.0.26, React Native 0.88.1, Metro 0.87.1) on an Android 15 emulator: one real Claude call through `makeModel` and one hub connection through `startMind`. See `example/` and `example/proof.png`.

### Dependencies

- `"bobby-mind": "file:../mind"` (path relative to the app). TypeScript source, no build step.
- Its only runtime dependency is `@anthropic-ai/sdk` (^1.12.0), installed in `mind/node_modules` by `cd mind && npm install`. It pulls in `@opentelemetry/api` transitively. No other React Native library, native module or config plugin is needed.
- No polyfills. React Native's global `fetch` and `WebSocket` work as they are: the call is non-streaming, so no streaming `fetch` (and no `expo/fetch`) is needed. The SDK doesn't treat React Native as a browser (it checks for `window.document`), so `dangerouslyAllowBrowser` is not needed. Its Node-only module (`internal/node`) is swapped for a stub by the package's `browser` field, which Metro honours by default (`resolverMainFields: react-native, browser, main`).

### Metro (needed when bobby-mind is a `file:` dependency)

npm installs `file:` dependencies as a symlink, so Metro must watch the real folder and find the package's own `node_modules`:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const config = getDefaultConfig(__dirname);
const mindRoot = path.resolve(__dirname, '../mind');
config.watchFolders = [...(config.watchFolders ?? []), mindRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(mindRoot, 'node_modules'),
];
module.exports = config;
```

(Add one `watchFolders` / `nodeModulesPaths` entry per `file:` package.) Alternative: install `@anthropic-ai/sdk` in the app itself and keep only `watchFolders`.

### Dev builds: load bobby-mind with React Refresh hidden (required while `src/model.ts` imports the SDK)

In development builds Metro's `require` hands every freshly loaded module's exports to React Refresh, which reads each export getter. `@anthropic-ai/sdk` has circular imports (`resources/beta/messages` ↔ `lib/tools/BetaToolRunner`), so a getter is read before its module finishes loading and the app dies at start with:

```
TypeError: Cannot read property 'BetaToolRunner' of undefined
  registerExportsForReactRefresh ...
```

Production bundles (`__DEV__` false) are not affected. Fix, in the app's entry file (`index.ts`), before anything else imports bobby-mind:

```ts
import { registerRootComponent } from 'expo';
const g = globalThis as any;
const refresh = g.__ReactRefresh;
g.__ReactRefresh = undefined;
try { require('bobby-mind'); } finally { g.__ReactRefresh = refresh; }
const App = require('./App').default;   // require, not import: imports are hoisted above this code
registerRootComponent(App);
```

Fast Refresh keeps working for the app's own files. If `src/model.ts` later calls the Messages API with plain `fetch` instead of the SDK, this shim and the SDK dependency both go away.

### Cleartext `ws://` to the hub

The hub is plain `ws://127.0.0.1:8765` (CONTRACT.md, "Connecting"). Expo Go already allows cleartext; the example connected to `ws://10.0.2.2:8765` with no setting. The final app (dev client or release build) must allow it explicitly:

```sh
npx expo install expo-build-properties
```

```json
["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
```

in `app.json` → `expo.plugins`. (The Mouth package needs the same plugin, so one entry covers both.)

### Permissions

`android.permission.INTERNET` only, which Expo apps have by default.

### Keys

None are baked in. The app passes `env: {ANTHROPIC_API_KEY, HUB_TOKEN?, MIND_MODEL?, MIND_EFFORT?, CONTACTS?}` to `startMind` at run time. (The example app reads `EXPO_PUBLIC_ANTHROPIC_API_KEY` from its own `.env`; the final app must not.)

### Latency seen from the emulator

`claude-opus-5-5`, effort low, ~250 input tokens, 23 output tokens: 2460 ms (first call, includes TLS setup) and 1675 ms (second).
