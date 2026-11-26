# Teaching by showing

You tell Bobby you're about to show him something, do it on the phone yourself, and say "done". Later you ask for it in your own words, with different details, and he does it.

```
"Hey Tibby, I'm going to show you how to add a new project. I'll type test test."
   (you open the app, tap New project, type "test test", tap Create)
"Done."                         -> "Got it. I've learned how to add a project. Next time, just tell me the project's name."
...
"Hey Tibby, add a project with a name called test"     -> done, with no model call
```

(The wake word is not part of it: "Tibby", "Bobby" or nothing all work.)

## Four ways to do it, measured

One demonstration can be turned into something repeatable in four ways. All four are in the code (`MIND_TEACH_MODE`), so they were measured on the same pretend phone, at real phone speed, with simulated model latencies (router 700 ms, executor 900 ms, check 500 ms). Each cell: teach "add a project" once, change the app as the row says, ask for a new project, then look at the phone. `ok` means exactly one new project with the right name exists **and** Bobby said it was done. Time is from the request to the result.

| The app, compared with the day of the demo | pixels | script | guided | **hybrid** |
|---|---|---|---|---|
| nothing changed | ok 1.5 s, 0 calls | ok 1.5 s, 0 calls | ok 2.8 s, 1 call | **ok 1.5 s, 0 calls** |
| asked in other words | ok 2.2 s, 1 call | ok 2.2 s, 1 call | ok 3.5 s, 2 calls | **ok 2.2 s, 1 call** |
| button renamed | ok 1.5 s, 0 calls | ok 1.5 s, 0 calls | ok 2.8 s, 1 call | **ok 1.5 s, 0 calls** |
| layout moved | failed | ok 1.5 s, 0 calls | ok 2.8 s, 1 call | **ok 1.5 s, 0 calls** |
| app left on another screen | failed | ok 2.2 s, 0 calls | ok 4.7 s, 2 calls | **ok 2.2 s, 0 calls** |
| a tip covers the app | failed | ok 2.2 s, 0 calls | ok 6.2 s, 3 calls | **ok 2.2 s, 0 calls** |
| list grew, button below the fold | failed | ok 2.5 s, 0 calls | ok 4.3 s, 2 calls | **ok 2.5 s, 0 calls** |
| a new step in the way | failed | failed | ok 4.3 s, 2 calls | **ok 5.0 s, 2 calls** |
| **all 8** | 3/8, median 1.5 s | 7/8, median 2.2 s | 8/8, median 4.3 s | **8/8, median 2.2 s** |

Reproduce: `npm run teach:bench` (about a minute, no key).

- **pixels**: replay the taps at the coordinates they were made, like a macro recorder. As fast as anything when nothing has changed, and wrong as soon as anything has. It also can't tell that it failed.
- **script**: replay by resource id and label, with a check after every step and recovery in code (restart the app at its first screen, close a tip, scroll to find). No model at all. Fails only when the flow itself is different.
- **guided**: keep no script; hand the executor model the demo's steps as a guide every time. Always gets there in this bench, at about twice the time and one to three model calls per run. Its numbers are a best case: the pretend model follows the guide perfectly, a real one sometimes won't.
- **hybrid** (the default, and what Bobby runs): the script first, and the guided executor only when the script can't go on. It has the script's speed where the script works and the model's reach where it doesn't. Its one cost: when the script fails, the failed attempt is paid for first (5.0 s against 4.3 s in the last row).

Not built, and why: **screen recording plus a vision model** (a consent prompt on every lesson, seconds per step, and the result is still a guess at which control was meant); **capturing raw touches** (Android 12+ hides other apps' touch coordinates from overlays; the accessibility route that does expose them turns on touch exploration, which changes how the phone responds to the user); **fine-tuning** (one demo is not a dataset).

What the bench doesn't show: real models and real phones. On the Android 15 emulator the full loop was run with real injected touches in Google Contacts (`npm run teach:phone`): taught "add a contact", then asked for another by name; five runs in a row passed, 4.6 to 6.4 s each from the request to the saved contact, zero model calls, checked against the phone's contacts database. That run used the scripted fake for the one teach call; with a real key the teach and router calls go to OpenAI (`--real`), which has not been run yet.

## How it works

**Watching (Hands).** `{"type":"observe","on":true}` makes the accessibility service also ask Android for clicks, long clicks, text changes and scrolls (it normally only listens for window changes). A small recorder (`hands/.../Observe.kt`) turns them into `observed` frames: each tap with the node it landed on (resource id, label, class, key) and the hash of the screen it happened on; each burst of typing as one frame with the final text; the settled screen between actions. Password fields are never recorded, nor is anything in Bobby's own app or the keyboard. See `PROTOCOL-V2.md`.

**Compiling (`src/teach.ts`).** In code, no model:
- taps on the home screen become "open the app" (a `launch`, not a hunt for an icon);
- a tap into a field followed by typing is one `type`; typing that ends with the field gone and no tap in between was the keyboard's enter;
- each step gets a way to find its control again (`want`: id, label, class, where it was) and a check (`expect`) made from the screens before and after it: the app that came to the front, or a label that appeared, with anything the user typed preferred over everything else ("the new project's name is in the list");
- a tip the user closed along the way becomes an optional step; a step whose result was hidden by a tip gets no check of its own (see "Tips" below);
- steps that send, post, call, pay, buy or delete are split into their own sub-goal, so the usual confirmation applies.

One model call (`MIND_TEACH_MODEL`, default the escalation model) then names the skill, writes its trigger words, and decides which typed or tapped values were only examples: the slots. "I'll type test test" is what tells it. Slot values are swapped for `{{name}}` in what is typed, in labels that are tapped, and in the checks, so "search for socks, tap Wool socks" becomes "search for X, tap Wool X". If the call fails, every typed text becomes a slot named after its field.

**Matching.** The skill joins the shortcut index. A request matches locally, with no model call, when it contains the skill's trigger words, nothing unknown, and (for a skill with a slot) "called X" / "named X" / "titled X". Anything else goes to the router, which sees the skill in its catalogue (`skill.add-a-project`) and fills the slot. A missing required value is said out loud ("I need the project's name for that") and nothing is touched.

**Running (`src/script.ts`).** Open the app; if the first control isn't on screen, restart the app at its first screen (`launch` with `fresh:true`). Then for each step: find the control on the live screen in code, act, check. A control is the same one if its resource id and label agree; an id shared by several rows needs the label; equal matches are told apart by position; if that can't decide, nothing is tapped. When something doesn't match, the replay stops and the grounded executor continues from where it stopped, with the demo's steps (slots filled in) as a numbered guide and the history of what already ran.

**Tips.** Google Contacts shows a "Some menu items have moved" tip over a saved contact, and while it is up Android gives accessibility nothing of the app underneath. So: a screen of a few nodes with one way out ("Close", "Got it", "Not now", "Skip"; never "OK", "Cancel" or "Allow") is closed when it is in the way; no check is ever pinned to one; and an ending that has no recorded check is verified on the app's own screen, in code when it can be (the tapped control is gone and what was typed now shows as plain text), by the cheap model check otherwise.

## Limits

- **What accessibility can't see can't be taught.** Games, canvases, and web pages whose controls report no clicks. The lesson ends with "I didn't see you do anything in an app".
- **Back and Home gestures** leave no event (the three-button bar's Back does). A demo that depends on going back will stop at the next step and be finished by the executor.
- **The keyboard's enter** is only inferred when the field disappears (a search that keeps its box on screen isn't caught); the executor fills that in.
- **Passwords** are not recorded; a demo stops at the first password field.
- **One demo.** A skill is as general as its one example: a branch the user didn't show isn't known.
- A lesson ends when you say so, after 25 s without a new action (`teachIdleMs`), or after 5 minutes.
- While a lesson runs, the screens you visit are sent to the Mind (same process) and mirrored to any connected dashboard.

Say "forget how to add a project" to drop a skill. Teaching it again replaces it.
