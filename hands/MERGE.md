# Merging bobby-hands into an app

Everything an Expo app (the final app is `app/`, id `dev.bobby.app`) needs to include
`bobby-hands`. Android only.

## 1. Dependency

```sh
cd hands && npm install          # once, so the package's own node_modules exist
cd ../app && npm install ../hands
```

`app/package.json` then has `"bobby-hands": "file:../hands"`. `main` is `src/index.ts` (TypeScript
source): no build step. No extra React Native libraries are needed.

## 2. Config plugin and minSdk

Add the plugin to `app.json`:

```json
"plugins": ["../hands/app.plugin.js"]
```

(`"bobby-hands"` also works once it is installed.) It sets:

- `android:usesCleartextTraffic="true"` on `<application>`, so the app's own clients can reach
  `ws://127.0.0.1:8765`;
- `android.minSdkVersion=30` in `gradle.properties` (the library uses Android 11 APIs; Expo's default
  24 fails the manifest merge).

Equivalent without the plugin: `expo-build-properties` with
`{"android": {"usesCleartextTraffic": true, "minSdkVersion": 30}}` (what `app/` does today).

Run `npx expo prebuild --platform android --clean` after adding it.

## 3. Permissions and components

Merged automatically from the library's `AndroidManifest.xml`, nothing to add:

- permissions `INTERNET`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
  `FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK`, `TURN_SCREEN_ON`, `VIBRATE`, and
  `com.android.alarm.permission.SET_ALARM` (normal permission, granted at install; the clock app
  requires it for `open` with SET_ALARM / SET_TIMER);
- `<queries>` for launcher activities (so `launch` can find apps by label), HOME (`caps.launcher`),
  and the intents `open` uses most: SENDTO mailto/sms/smsto, DIAL tel, VIEW https/http/geo/
  google.navigation, SET_ALARM, SET_TIMER, SHOW_ALARMS, INSERT calendar events, WEB_SEARCH;
- the accessibility service now subscribes only to window state/content/windows-changed events
  (`res/xml/bobby_hands_accessibility.xml`); nothing for the app to change;
- services `dev.bobby.hands.HandsService` (accessibility, holds the hub),
  `dev.bobby.hands.HandsNotificationListener`, `dev.bobby.hands.KeepAliveService`
  (`foregroundServiceType="microphone|dataSync"`).

**The app must declare and request `RECORD_AUDIO` itself** (`android.permissions` in `app.json`,
and ask at run time or via `grant.sh`). Keep-alive uses the microphone service type only when
`RECORD_AUDIO` is granted; without it, it falls back to `dataSync`, and Android won't let the Mouth
use the microphone from the back.

App id: anything except `dev.bobby.hands.lib` (the library's gradle namespace). Kotlin classes stay in
package `dev.bobby.hands`, so component names are `<app id>/dev.bobby.hands.HandsService`.

## 4. Metro

The package lives outside the app folder, so Metro must watch it and resolve shared libraries
(react, react-native, expo) from the app:

```js
config.watchFolders = [path.resolve(__dirname, '../hands')];
```

plus either `"experiments": {"autolinkingModuleResolution": true}` in `app.json` (what
`hands/example` does) or a `resolveRequest` that resolves bare imports from the app first (what
`app/metro.config.js` does). Don't let a second copy of `react-native` load from
`hands/node_modules`.

## 5. Grant after every install

```sh
hands/tools/grant.sh dev.bobby.app
```

Turns on accessibility (`dev.bobby.app/dev.bobby.hands.HandsService`), notification access
(`dev.bobby.app/dev.bobby.hands.HandsNotificationListener`), `POST_NOTIFICATIONS`, `RECORD_AUDIO`
and battery exemption, then lists anything that needs the human. Reinstalling can switch the
accessibility service off, so run it after every `adb install`.

**Only one app on the phone may have the Hands service on** (each would bind port 8765). `grant.sh`
removes every other `dev.bobby.*` HandsService, e.g. the test app's. Run
`grant.sh dev.bobby.hands` to switch back to the test app.

Without adb: `openSettings('accessibility' | 'notificationAccess' | 'notifications' | 'microphone')`
from a settings screen, and check `status()`.

## 6. Using it

```ts
import * as Hands from 'bobby-hands';

Hands.configure({ token: HUB_TOKEN });   // on every start, before starting Mind/Mouth/Caller
// Mind/Mouth/Caller connect to ws://127.0.0.1:8765/<role>?token=HUB_TOKEN
```

On wake (app comes to the front, settings complete):

```ts
if (!Hands.openedFromNotification()) {
  Hands.startKeepAlive('Bobby is listening'); // foreground service; JS keeps running behind other apps
  mouth.wake();
  Hands.moveToBack();
}
Hands.clearOpenedFromNotification();
```

- Leave keep-alive on while Bobby is awake (`status().keepAlive` says if it is running);
  `stopKeepAlive()` ends it.
  Tapping its notification opens the app with `openedFromNotification()` true (show settings, don't
  wake).
- `status()` is cheap; polling it every second for status lights is fine. `status().peers` says who
  is connected; `hubRunning`/`serviceRunning` are false while accessibility is off.
- The hub refuses everyone (4003) until `configure` has been called with a token.

## Notes

- **`openedFromNotification()` while the app is already running:** React Native's
  `ReactActivity.onNewIntent` doesn't call `setIntent()`, so the module can see a stale launch
  intent. `app/` adds `onNewIntent { setIntent(intent) }` to `MainActivity`
  (`app/plugins/with-new-intent.js`); keep that until Hands tracks the flag itself.
- Read `openedFromNotification()` a moment after the app becomes active (the app waits 400 ms).
- Laptop tools for the final app need its token: `HUB_TOKEN` in the root `.env`
  (`app/tools/push-config.mjs` adds it), then `node hands/tools/drive.mjs`.
- The release build bundles the JS (no Metro); the hub and accessibility service never need JS.
- Teaching by showing (`observe`) needs no new permission, manifest entry or accessibility XML
  change: the extra event types are switched on at run time, only while a lesson is being watched.
