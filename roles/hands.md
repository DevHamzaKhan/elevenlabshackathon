# Hands (`hands/`, then `app/`)

You have two jobs, in this order.

1. **The Hands package**, in `hands/`: a Kotlin module for Expo that reads the phone's screen and performs the taps, swipes and typing the Mind asks for, while drawing a cursor that glides to each target first. The cursor is the only thing Bobby ever draws on screen. This package also hosts the hub that the other parts connect to.
2. **The final app**, in `app/`: one Expo app that includes your package, the Mind package and the Mouth package. You build it because you have the phone.

- **Target:** Samsung Galaxy S21 on a current Android version. Kotlin for native code, TypeScript for the rest, minSdk 30.
- **Accounts and keys:** none. You never need to know any other part's keys by name. The root `.env` may hold one plain setting for you, `HANDS_TEST_SENDER`: the name of the teammate whose test email the demo replies to.
- **Device:** the S21, plugged in to this Mac over USB. It is the team's only Android phone, and no other part uses it. Leave it in a normal state: no leftover drafts, and no settings changed beyond what Bobby needs.

## First steps

1. **Tools.** Check for Node, `adb`, a JDK and the Android SDK, and install whatever is missing. Prefer command-line installs, because they need no clicks: Homebrew's `node`, Homebrew's `openjdk` at the version the Expo SDK in `VERSIONS.md` needs, Homebrew's `android-commandlinetools`, then `sdkmanager` for platform-tools, the platform and build-tools that Expo version needs, accepting the licences. Android Studio is optional.
2. **Phone.** Run `adb devices`. If the phone isn't listed, it goes in the human's list, and you build everything that doesn't need it meanwhile. Once it's listed, run `adb shell svc power stayon usb` so the screen stays on while plugged in.
3. **What the human did before starting you.** Check each one, and follow "Never wait for the human" for anything missing:
   1. Developer options and USB debugging are on. On Samsung, Auto Blocker is off (Settings → Security and privacy → Auto Blocker), because it blocks commands over USB. The phone is plugged in with a data cable, and this computer is allowed, with "Always allow from this computer" ticked.
   2. The lock screen is set to Swipe or None, so the phone never needs a PIN while you work.
   3. Gmail is signed in, and its icon sits on a home screen other than the first, so the scenic route has somewhere to go.
   4. A teammate has sent a test email, and their name is in the root `.env` as `HANDS_TEST_SENDER`.
4. **STATUS.md.** Anything Android won't let `adb` grant goes under "Needs the human". Work on everything that doesn't need it meanwhile.

## Job 1: the Hands package

1. **An Expo native module** in `hands/`, package name `bobby-hands`, created with Expo's module tooling so it comes with a test app in `hands/example/`. The test app's id is `dev.bobby.hands`. It needs a development build: build and install it on the phone with `npx expo run:android`. A config plugin in the package adds everything the Android manifest needs, so any app that installs the package gets it.
2. **Accessibility service**, in Kotlin, the core of the package:
   - Turns the live accessibility tree into a `screen_result`, following the contract's rules on which nodes to include.
   - Performs every `do` in the contract's table: gestures for tap, long press and swipe; setting text for `type`; global actions for `key`; a launch intent for `launch`.
   - Resolves the three target forms (`n`, `text`, `x`/`y`) exactly as the contract says.
   - Detects when the screen has settled before sending `act_result`.
3. **The hub**, in Kotlin, inside the same service:
   - A small WebSocket server on `127.0.0.1:8765` that follows the contract's "Connecting" and "Routing" sections exactly: the four roles, the token check, hello/welcome, the 4001 and 4003 close codes, delivery by `to`, `peers`, `wire` copies, and the `task` and `plan` it remembers for new watch clients.
   - It starts and stops with the accessibility service, and keeps working when no screen of the app is open.
   - Frames for `hands` are handled in the same process. Hands' own frames go to the Mind.
4. **Cursor overlay**, drawn from the accessibility service so it needs no extra permission and never blocks touches:
   - It glides with easing over 400 to 900 ms depending on distance, shows a small ripple when it taps, and fades out 2 s after the last action.
   - Draw it from a single drawable file, `cursor.xml`, so a teammate's artwork can replace it later without code changes. The contract's "Cursor artwork" section fixes its size and which point touches the target.
5. **Notification listener** that sends each new notification to the Mind as a `notification` message. Skip ongoing and silent system notifications, and the apps the contract excludes.
6. **The JavaScript side**, as the contract's "Packages" section fixes it:
   - `configure({token})` sets the hub's token.
   - `status()` reports which permissions are granted and who is connected.
   - `openSettings(which)` opens the right Android settings page for a missing permission.
   - `moveToBack()` sends the app to the back, so whatever was on screen before shows again.
7. **The test app**, `hands/example/`: one screen with a checklist of the permissions (accessibility, notification access, notifications), a button for each, and a status line. It sets the token to `dev`.
8. **`hands/tools/grant.sh <app id>`**, which turns on every permission it can over `adb` for that app: the accessibility service through `settings put secure`, notification access through `cmd notification allow_listener`, and the notification permission through `pm grant`. Run it after every install, because reinstalling can switch the accessibility service off. Whatever Android refuses goes on the human's list.
9. **`hands/tools/drive.mjs`**, a Node script that plays the Mind so you can drive the phone by typing:
   - It runs `adb forward tcp:8765 tcp:8765`, then connects to the hub on the phone as `mind`.
   - Commands: `screen`, `tap Reply`, `tap 540 1200`, `point Reply`, `type hello there`, `swipe left`, `home`, `back`, `launch Gmail`.
   - `screen` prints a compact table. Incoming notifications and `peers` are printed as they arrive.
   - `--script <file>` runs commands from a file, one per line, and exits non-zero on the first failure, so you can test without typing.
   - `demo <sender name>` runs the scenic route end to end: go home, swipe across the home screens reading each one until "Gmail" is visible, opening a folder if Gmail is inside one, tap it, open the newest email from that sender, tap Reply, type a short line, send. It stops before Send if the open email isn't from that sender, or if `HANDS_TEST_SENDER` isn't set. This sends a real email, so run it only to check the finished route.
10. **Check your work by looking.** Take screenshots with `adb exec-out screencap -p` and look at them to confirm the cursor and each action, instead of asking the human. Post test notifications yourself with `adb shell cmd notification post`.
11. **Tests.** Kotlin unit tests for the pure logic: tree-to-nodes filtering, target matching, hub routing, and JSON encoding and decoding of every contract example that Hands or the hub handles. Also a Node test that connects two clients to the real hub on the phone and checks routing, `peers` and the close codes.
12. **`hands/check.sh`**: unit tests, build, install, `grant.sh`, then a short `drive.mjs --script` run that reads the home screen and points at something without tapping.
13. **`hands/MERGE.md`**, as the contract describes.

## Job 2: the final app

Start this as soon as Job 1's "Done when" is met. Don't wait for the other parts to finish: the entry points in the contract's "Packages" section are fixed, so you can wire everything up now and fill in real packages as they land in the repo.

1. **An Expo app** in `app/`, named "Bobby", id `dev.bobby.app`, for the Expo version in `VERSIONS.md`. It installs the three packages from their folders (`../hands`, `../mind`, `../mouth`). Set up the bundler so packages outside `app/` work.
2. **Stand-ins.** Until `mind/` or `mouth/` exists in the repo with the entry points the contract names, use a tiny stand-in for it inside `app/`, so the app always builds. After each `git pull`, swap in whichever real package has arrived, follow its `MERGE.md`, and rebuild. Treat every build failure from a newly arrived package as yours to solve. If the fix belongs in their folder, write exactly what they should change in `app/MERGE-ISSUES.md`, and work around it in `app/` meanwhile.
3. **What the app does when it starts:**
   - It loads the stored settings, generates a random `HUB_TOKEN` if there isn't one, and calls `configure`.
   - It starts the Mind, the Mouth and the Caller with the contract's `config`: the hub URL `ws://127.0.0.1:8765`, the token, the stored `env`, and a `log` function. The Mind also gets the hint files as `hints`.
   - **Opening the app starts Bobby.** Each time the app comes to the front and its settings are complete, it calls the Mouth's `wake()`, then `moveToBack()`. This is what the phone's side button triggers.
   - Opening the app from its notification shows the settings screen instead, and doesn't wake Bobby.
4. **Staying alive.** The app must keep working while Gmail or any other app is on screen. Run a foreground service with a notification from the moment Bobby wakes, with the microphone type the Mouth's `MERGE.md` asks for. Confirm with a long task that the JavaScript side keeps running in the back, and that it still works with the screen having been off. If it doesn't hold, find out why and fix it, because the demo depends on it.
5. **Settings screen:**
   - The permission checklist from your test app, plus microphone.
   - Switches to turn the Mind, the Mouth and the Caller on and off one at a time, so each can be tested alone.
   - Status lights from `peers`.
   - The hub token, shown so a laptop tool can use it.
   - The last 200 log lines.
   - Which settings are stored, by name only. Never show a key's value.
6. **`app/tools/push-config.mjs`**: sends every line of the root `.env` to the app over USB, with no typing on the phone. The app stores them in secure storage on the phone and uses them as `env`. It doesn't need to know what any line means, and it must never put them in the build.
7. **Hints and art.** At build time, bundle every `stage/hints/*.md` file that exists into the app. Use the cursor artwork named in `stage/cursor/CHOSEN`, and the app icon in `stage/icon/`, when they exist.
8. **`app/check.sh`**: build, install, `grant.sh dev.bobby.app`, then a `drive.mjs --script` run against the final app with the Mind switched off.
9. **`app/README.md`**: the exact steps for stitching day, from a clean phone to a working Bobby.

## Order

Work in this order and commit after each step. Every step should leave something that runs.

1. The test app builds and installs. The service starts the hub, and `drive.mjs` connects and completes the hello/welcome exchange.
2. `screen` works on the home screen and inside Gmail.
3. `tap`, `swipe`, `key` and `type` work without a cursor.
4. The cursor glides before each action, and `point` works.
5. Notifications are forwarded, and the hub passes its routing test.
6. `demo` passes from a cold start. Run it once, check the sent email in screenshots, and note the result.
7. The final app with stand-ins: it builds, installs, wakes and moves to the back, and `drive.mjs` works against it.
8. Real packages swapped in as they arrive.

## Done when

- **Job 1:** with only the phone and `drive.mjs`, typed commands take the scenic route to Gmail, open an email, write a reply and send it, with the cursor visibly leading every action in your screenshots, and a notification you post with `adb` shows up in the terminal.
- **Job 2:** the final app is installed on the phone with every package that exists in the repo, it passes `app/check.sh`, and `app/README.md` and `app/MERGE-ISSUES.md` are current.

## Then keep going

Your human, Hamza, has the largest budget, and you back up the Mouth part: once "Done when" is met, take the open items in `mouth/STATUS.md` before this list. "Backing up a 1x part" in `CLAUDE.md` has the rules.

Then, in rough priority:

- Check the hints, since you're the only part with a phone. After a `git pull`, if `stage/hints/TO-CHECK.md` exists, open each app it names, check each label with `screen`, and write what you found to `hands/HINTS-CHECK.md`: confirmed, wrong (with the real label), or not found. Do this again when that file changes.
- Make it hold up in apps beyond Gmail: Messages, WhatsApp, Chrome, Maps, Settings. Web pages and custom-drawn views often expose poor trees, so find what breaks and fix the node filtering. Test with `screen` and `point`, which change nothing.
- Scrolling: lists where the target is off screen, and `swipe` inside a specific scrollable node.
- The keyboard: typing into fields that reject direct text setting, and dismissing the keyboard when it covers the target.
- The app drawer, as a second way to find an app when it isn't on any home screen.
- An optional `"image":true` on `screen` that adds a base64 JPEG screenshot to the result as an extra `image` field.
- Cursor feel: a natural curved path, a slight overshoot, a press animation.
- Recovering from odd states: a permission dialog on top, the screen locked, the app killed by battery saver.
