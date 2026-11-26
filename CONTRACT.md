# Bobby wire contract, v1

Nobody edits this file unless the team agrees a change.

Everything runs on the phone. There is no server on a laptop. The parts are three packages that end up inside one Expo app, and they talk to each other through a small WebSocket hub on the phone itself.

```
                 on the phone
Mind   ──┐
Mouth  ──┼──▶  hub, inside the Hands package  ──▶  Hands (same process)
Caller ──┤     ws://127.0.0.1:8765
         │
Dashboard ─┘   (on a laptop, through `adb forward`)
```

- **The hub lives in the Hands package**, in native code. It starts and stops with the Hands accessibility service, and doesn't depend on any screen being open.
- **The Mind, the Mouth and the Caller are clients.** Each opens its own WebSocket to the hub, even when they all run inside the same app. That is what lets each part be built and tested alone.
- During the build each part runs in its own small test app against its own pretend hub. At the end they are merged into one app with no change to this contract.

## Connecting

- URL: `ws://<host>:8765/<role>?token=<HUB_TOKEN>`, where `<role>` is `mind`, `mouth`, `caller` or `watch`.
- `<host>`:
  - On the phone it is `127.0.0.1`. The hub listens only there, never on the network.
  - From a laptop it is `localhost`, after `adb forward tcp:8765 tcp:8765` with the phone on USB.
  - During the build, a pretend hub on a laptop is `localhost`, or `10.0.2.2` from an Android emulator.
- The hub is plain `ws://` with no TLS. Android blocks that by default, so every app must allow cleartext traffic to those hosts.
- Every frame is one JSON object as UTF-8 text.
- The client's first frame is `{"type":"hello","role":"mind","v":1}` (with its own role). The hub answers `{"type":"welcome","v":1}`. The hub closes a socket that has a wrong token with close code 4003.
- Clients reconnect forever: wait 1 s, 2 s, 5 s, then every 5 s. The one exception is close code 4001, below.
- The hub keeps only the newest connection for `mind`, `mouth` and `caller`, and closes the older one with close code 4001. A client closed with 4001 has been replaced and must not reconnect. Without this rule a fake and the real part would kick each other out forever.
- Any number of `watch` clients may connect.
- A request carries an `id`, any string unique to its sender. The reply carries `re` with the same value.
- Ignore message types and fields you don't know. Never crash on them.
- Each `json` block below holds one or more complete JSON objects, one after another. Tests may parse them as examples.

## Routing

The hub doesn't understand messages. It only delivers them.

- **Every frame the Mind sends carries `to`**: `hands`, `mouth`, `caller` or `watch`. The hub delivers the frame, unchanged, to that part. `watch` means every connected watch client.
- **Every frame from Hands, the Mouth or the Caller goes to the Mind.** They don't set `to`.
- A frame for a part that isn't connected is dropped. The Mind knows who is connected from `peers`.
- **`peers`:** the hub sends `{"type":"peers","hands":true,"mind":true,"mouth":true,"caller":false}` to the Mind and to every watch client, each time something connects or drops, and straight after their `welcome`. `hands` is true while the accessibility service is switched on.

## Hands

**Mind → Hands: read the screen**

```json
{"type":"screen","to":"hands","id":"m1"}
```

```json
{"type":"screen_result","re":"m1","app":"com.google.android.gm","size":[1080,2400],
 "nodes":[{"n":0,"text":"Reply","desc":"","cls":"Button","bounds":[840,2100,1040,2220],
           "tap":true,"edit":false,"scroll":false}]}
```

- `nodes` lists only what is visible on screen right now and has text, a description, or one of the three flags set.
- `bounds` is `[left, top, right, bottom]` in pixels. `size` is `[width, height]` in the current orientation.
- `n` is valid only until the next `screen_result`.

**Mind → Hands: do one thing**

```json
{"type":"act","to":"hands","id":"m2","do":"tap","on":{"text":"Reply"}}
```

```json
{"type":"act_result","re":"m2","ok":true}
{"type":"act_result","re":"m2","ok":false,"error":"not_found"}
```

The target `on` is one of:

- `{"n":0}`: a node from the latest `screen_result`.
- `{"text":"Reply"}`: the first visible node whose text or description matches, ignoring case. An exact match wins over a "contains" match.
- `{"x":540,"y":1200}`: a pixel.

| `do` | Other fields | What happens |
|---|---|---|
| `tap` | `on` | The cursor glides to the target, then taps it. |
| `long_press` | `on` | The cursor glides to the target, then presses and holds. |
| `point` | `on` | The cursor glides to the target and touches nothing. |
| `type` | `text`, optional `on` | Types into the target, or into the focused field. |
| `swipe` | `dir`, optional `on` | `dir` is the way the finger moves: `left`, `right`, `up` or `down`. Swiping `left` on the home screen shows the next page. Starts mid-screen unless `on` is given. |
| `key` | `name` | One of `home`, `back`, `recents`, `notifications`, `enter`. |
| `launch` | `app` | Opens an app directly by label or package name, skipping the scenic route. |
| `wait` | `ms` | Does nothing for that long. |

- Hands sends `act_result` only after the action has finished **and** the screen has settled: no UI change for 300 ms, or 3 s at most.
- `error` is one of `not_found`, `not_editable`, `no_permission`, `timeout`, `bad_request`.
- The cursor glide takes 400 to 900 ms depending on distance. The cursor is visible during an `act` and for 2 s after. `{"type":"cursor","to":"hands","show":false}` hides it now and `{"type":"cursor","to":"hands","show":true}` shows it.

**Hands → Mind: a notification arrived**

```json
{"type":"notification","app":"com.google.android.gm","title":"Sarah Chen",
 "text":"Running late, can we push to 3?","at":1790000000000}
```

`at` is Unix time in milliseconds, here and everywhere else. Hands never forwards notifications from the app it is running in, or from any app whose id starts with `dev.bobby.`.

## Mouth

Bobby only talks. He never starts a task, cancels a task, or says a task is done on his own. The Mind reads what the user said and decides.

**Mouth → Mind**

| Message | Meaning |
|---|---|
| `{"type":"wake"}` | The app was opened, usually by double-pressing the phone's side button, and Bobby's session is live. |
| `{"type":"heard","text":"reply to Sarah, tell her 3 works"}` | The final transcript of one user turn. |
| `{"type":"spoke","text":"On it."}` | What Bobby actually said in one turn. |
| `{"type":"say_started","re":"m5"}` | Bobby began speaking the `say` with that id. |
| `{"type":"say_done","re":"m5"}` | Bobby finished it, or it was cut off. With `"spoken":false` it was never spoken. |
| `{"type":"asleep"}` | The session ended. Bobby is idle, with the microphone off, until the app is opened again. |

**Mind → Mouth**

| Message | Meaning |
|---|---|
| `{"type":"whisper","to":"mouth","text":"3 new notifications: ..."}` | Background knowledge. Bobby doesn't say it now but may use it when he next speaks. |
| `{"type":"say","to":"mouth","id":"m5","text":"I'm looking for the word 'Reply' to answer Sarah."}` | Bobby says this now, in his own voice. He keeps the meaning and may rephrase lightly. Several `say`s are spoken in the order they arrive. He must start within 1 s when idle. |
| `{"type":"correct","to":"mouth","text":"The meeting is at 3, not 2."}` | Bobby said something wrong. He corrects himself out loud, briefly. |
| `{"type":"hush","to":"mouth"}` | Stop the audio immediately and drop any queued `say`s. Each dropped `say` still gets its `say_done`. |
| `{"type":"sleep","to":"mouth"}` | End the session and go idle. |

**Sleeping:** the Mind decides when a session ends, because only the Mind knows whether a task or call is still running.

- The Mind sends `sleep` once about 20 s have passed with no user speech and no task or call in progress.
- The Mouth ends a session only on `sleep`. As a backstop it also ends one on its own after 5 minutes with nothing heard and nothing from the hub.
- While asleep the Mouth says nothing. It ignores `whisper`, `correct` and `hush`, and answers a `say` straight away with `say_done` plus `"spoken":false`.
- Messages that arrive while a session is still starting are held and handled in order once it is live.

**Keeping the cursor and the voice together:** the Mind sends the `say` to the Mouth and the `act` to Hands at the same instant. Bobby starts speaking within a second and the cursor glide takes under a second, so they land together. The Mind waits for both `act_result` and `say_done` before the next step.

## Caller

**Mind → Caller**

```json
{"type":"call","to":"caller","id":"m9","number":"+14155550123",
 "goal":"Say I'm running 20 minutes late and ask if 3pm still works.",
 "context":"You are speaking as the phone's owner. Alex is a friend and expects this call."}
```

**Caller → Mind**

```json
{"type":"call_status","re":"m9","status":"dialing"}
{"type":"call_result","re":"m9","ok":true,"summary":"Alex said 3pm works.",
 "transcript":[{"who":"me","text":"Hey Alex..."},{"who":"them","text":"Sure, 3 is fine."}]}
```

- `status` is `dialing`, `answered`, `ended` or `failed`. Send one `call_status` each time it changes.
- Exactly one `call_result` ends every call. On failure it is `"ok":false` with an `error` string, for example `not_allowed`, `no_answer`, `busy` or `failed`.
- The Caller dials only numbers on its own allowlist and answers `not_allowed` for anything else.
- Numbers are always in E.164 form, like `+14155550123`.

## Watch

Read-only. After its `hello`, a watch client sends nothing, and the hub ignores anything it does send.

| Message | Meaning |
|---|---|
| `{"type":"wire","from":"mind","to":"hands","at":1790000000000,"msg":{"type":"screen","to":"hands","id":"m1"}}` | The hub's copy of every frame it delivers, in either direction. `from` and `to` are `mind`, `hands`, `mouth` or `caller`. |
| `{"type":"task","to":"watch","task":"t1","title":"Reply to Sarah","status":"started"}` | From the Mind. `status` is `started`, `done`, `failed` or `cancelled`. |
| `{"type":"plan","to":"watch","task":"t1","steps":[{"n":1,"do":"Open Gmail","why":"Sarah's message is an email"}]}` | From the Mind. Its plan, sent again in full whenever it changes. |
| `{"type":"step","to":"watch","task":"t1","n":1,"status":"running"}` | From the Mind. `status` is `running`, `done` or `failed`. |
| `{"type":"peers","hands":true,"mind":true,"mouth":true,"caller":false}` | From the hub. See "Routing". |

- The hub remembers the latest `task` and `plan` and sends them to a watch client that connects while a task is running.
- The hello/welcome exchange and frames addressed to `watch` are not mirrored as `wire`. Everything else is.

## Packages

Each part is a package that the final app installs from its folder. These entry points are fixed, so the final app can be wired up before the parts are finished.

| Package | Folder | Kind | Entry points |
|---|---|---|---|
| `bobby-hands` | `hands/` | Expo native module, Kotlin | `configure({token})`, `status()`, `openSettings(which)`, `moveToBack()` |
| `bobby-mind` | `mind/` | TypeScript only | `startMind(config)` returning `{stop()}` |
| `bobby-mouth` | `mouth/` | TypeScript, with OpenAI Realtime over WebRTC (`@livekit/react-native-webrtc`) | `startMouth(config)` returning `{wake(), stop()}`, and `startCaller(config)` returning `{stop()}` |

- **`config`** is always `{hubUrl, token, env, log}`. `env` is a plain object of the variables that part's own instructions list, by the same names. `log` is a function that takes one line of text. `startMind` also takes `hints`, a list of strings.
- **No package reads files or environment variables at run time on the phone.** Everything arrives through `config`. Only laptop scripts and tests read `.env`.
- **`bobby-mind` and `bobby-mouth` need no build step.** Their `package.json` points straight at TypeScript source, with no path aliases.
- **Versions.** The repo's root `VERSIONS.md` names the Expo SDK version. Every app and package uses exactly that one. Add React Native libraries with `npx expo install`, so their versions match it.
- **Each package keeps `MERGE.md`** in its folder: every permission, config plugin, native setting and install step the final app needs in order to include it.

## Cursor artwork

The cursor is one Android vector drawable named `cursor.xml`, 48 dp square with a 48 x 48 viewport. The point that touches the target is the exact centre, (24, 24). It shows the resting cursor only: Hands draws the tap ripple itself.

## Configuration

- **During the build**, laptop scripts and tests read `.env` at the repo root. A test app reads an untracked `.env` in its own folder. Git ignores every `.env`.
- **In the final app**, keys are never baked into the build. A laptop script sends the lines of the root `.env` to the app over USB, the app stores them on the phone, and it hands every package the same `env` object.
- **`HUB_TOKEN`** is the only variable every part shares. Pretend hubs accept any token.
- Each part's own instructions list the variables that part uses. No part reads another part's keys.
