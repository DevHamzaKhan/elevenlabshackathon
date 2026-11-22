# Merging bobby-mind into the final app

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
