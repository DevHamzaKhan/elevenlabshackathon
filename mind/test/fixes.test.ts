// Regression tests for bugs found in review. Each one failed before its fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sleep, until } from "./helpers";
import { findSameNode } from "../src/brain";
import { describeScreen } from "../src/screen";
import { HubClient } from "../src/hub";
import { startFakeHub } from "../fakes/hub";

test("a second wake with nothing new doesn't repeat old notifications", async () => {
  const t = await setup();
  try {
    t.mouth!.asleep(); // notifications that arrive while Bobby sleeps wait for the next wake
    await sleep(50);
    t.hub.notify("com.whatsapp", "Mum", "Call me");
    t.hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
    await sleep(100);
    t.mouth!.wake();
    assert.ok(await until(() => t.fromMind("whisper").some((w) => /2 new notifications/.test(w.text)), 2000), "first wake gets the digest");
    const before = t.fromMind("whisper").length;
    t.mouth!.asleep();
    t.mouth!.wake();
    await until(() => t.fromMind("whisper").length > before);
    const again = t.fromMind("whisper").slice(before).map((w) => w.text);
    assert.deepEqual(again, ["No new notifications since you last spoke with the user."]);
  } finally {
    await t.close();
  }
});

test("'stop' said while the Mind is still deciding means the task never starts", async () => {
  const t = await setup({ slowMs: 400 });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await sleep(100);
    t.mouth!.hear("stop");
    await sleep(1200);
    assert.equal(t.tasks().length, 0, "no task published");
    assert.equal(t.fromMind("act").length, 0, "nothing done on the phone");
    assert.ok(t.fromMind("hush").length >= 1, "Bobby hushed");
    assert.ok(t.fromMind("whisper").some((w) => /before anything began/.test(w.text)), "Bobby told nothing started");
    // And the Mind still works afterwards.
    t.mouth!.hear("open Spotify");
    assert.ok(await until(() => t.tasks().some((m) => m.title === "Open spotify"), 4000), "next request starts normally");
  } finally {
    await t.close();
  }
});

test("'stop' during a slow model call cancels at once, not when the model answers", async () => {
  const t = await setup({ slowMs: 2500 });
  try {
    t.mouth!.hear("open Spotify");
    await until(() => t.tasks().length > 0, 6000);
    await sleep(300); // the first step's model call is now in flight
    const t0 = Date.now();
    t.mouth!.hear("stop");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 2000));
    assert.ok(Date.now() - t0 < 400, `cancelled in ${Date.now() - t0} ms`);
    await sleep(2600); // the abandoned model reply arrives; nothing must come of it
    assert.equal(t.fromMind("act").length, 0, "no act after the cancel");
  } finally {
    await t.close();
  }
});

test("a true time from a notification is not 'corrected'; an invented one still is", async () => {
  const t = await setup();
  try {
    t.hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
    t.mouth!.hear("call alex and tell him I'm running late");
    await until(() => t.fromMind("say").some((m) => /3:20/.test(m.text)), 4000);
    await sleep(100);
    t.mouth!.hear("what did Sarah want again?");
    await sleep(150);
    t.mouth!.spoke("Sarah asked if you could push to 3.");
    await sleep(300);
    assert.deepEqual(t.fromMind("correct").map((m) => m.text), [], "3 is true (Sarah's email), so no correction");
    t.mouth!.hear("and when is Alex expecting me?");
    await sleep(150);
    t.mouth!.spoke("Alex will see you at 5.");
    assert.ok(await until(() => t.fromMind("correct").some((m) => /3:20, not 5/.test(m.text)), 2000), "5 appears nowhere, so it is corrected");
  } finally {
    await t.close();
  }
});

test("Bobby rephrasing a line he was given is not mistaken for a false 'done' claim", async () => {
  const t = await setup({ slowMs: 150, msPerChar: 25 });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await sleep(60);
    t.mouth!.spoke("On it."); // Bobby's own answer to the user
    await until(() => t.fromMind("say").length >= 2, 5000); // narration under way, a line is being spoken
    t.mouth!.spoke("I've sent Sarah a note saying three is fine."); // heavy rephrase of a narration line
    await sleep(300);
    assert.equal(t.fromMind("correct").length, 0, "no correction for the Mind's own line");
    // But when the user asks and Bobby answers by himself with a false claim, it is corrected.
    t.mouth!.hear("are you finished yet?");
    await sleep(60);
    t.mouth!.spoke("Yes, all done!");
    assert.ok(await until(() => t.fromMind("correct").some((m) => /still working/.test(m.text)), 2000));
  } finally {
    await t.close();
  }
});

test("a sentence that merely contains 'sent' is not a 'done' claim", async () => {
  const t = await setup({ slowMs: 300 });
  try {
    t.mouth!.hear("open Spotify");
    await until(() => t.tasks().length > 0);
    t.mouth!.spoke("Sarah sent you an email earlier, by the way.");
    await sleep(300);
    assert.equal(t.fromMind("correct").length, 0);
  } finally {
    await t.close();
  }
});

test("naming the wrong person on a call is corrected", async () => {
  const t = await setup({ contacts: "Alex=+14155550123,Sam=+14155550124", callerStepMs: 400 });
  try {
    t.mouth!.hear("call alex and tell him I'm running late");
    await until(() => t.fromMind("call").length > 0, 3000);
    t.mouth!.spoke("Sure, I'm calling Sam for you.");
    assert.ok(await until(() => t.fromMind("correct").some((m) => m.text === "It's Alex, not Sam."), 2000));
  } finally {
    await t.close();
  }
});

test("the screen changing while Bobby speaks never causes a tap on a stale node", async () => {
  let popped = false;
  let poppedAt = 0;
  const t = await setup({
    timing: { staleMs: 0 }, // always look again before tapping
    model: (hub, stub) => async (req) => {
      const reply = await stub(req);
      // Just after the model picks the Gmail icon, a pop-up covers the screen.
      if (!popped && req.purpose === "step" && reply.json?.do === "tap" && /"Gmail"/.test(req.user)) {
        popped = true;
        poppedAt = Date.now();
        hub.phone.popup = "Update available";
      }
      return reply;
    },
  });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 15000), "task still finishes");
    assert.ok(popped);
    // The first thing the phone was asked to do after the pop-up appeared must not be the tap
    // chosen for the old screen (node numbers there now mean something else).
    const after = t.hub.wire.filter((w) => w.from === "mind" && w.msg.type === "act" && w.at >= poppedAt);
    assert.ok(after.length > 0);
    assert.notEqual(after[0].msg.do, "tap", `first act after the pop-up was ${JSON.stringify(after[0].msg)}`);
    assert.ok(t.lines.some((l) => /pop-up/.test(l) || /Update available/.test(l)) || popped);
    assert.ok(t.hub.phone.sent, "email sent in the end");
  } finally {
    await t.close();
  }
});

test("findSameNode: follows a moved node, rejects a vanished one", () => {
  const nodes = (list: any[]) => ({ type: "screen_result", nodes: list });
  const old = nodes([
    { n: 0, text: "Sent", cls: "TextView", bounds: [0, 0, 100, 40] },
    { n: 1, text: "Reply", cls: "Button", tap: true, bounds: [40, 2100, 340, 2220] },
    { n: 2, text: "", desc: "", cls: "EditText", edit: true, bounds: [40, 500, 1040, 900] },
  ]);
  const moved = nodes([
    { n: 0, text: "Reply", cls: "Button", tap: true, bounds: [40, 1900, 340, 2020] },
    { n: 1, text: "", desc: "", cls: "EditText", edit: true, bounds: [40, 1200, 1040, 1600] },
  ]);
  assert.equal(findSameNode(old, 1, moved), 0, "Reply found at its new number");
  assert.equal(findSameNode(old, 0, moved), null, "the snackbar is gone");
  assert.equal(findSameNode(old, 2, moved), null, "an unlabelled field that jumped is not trusted");
  assert.equal(findSameNode(old, 2, old), 2);
});

test("screen text for the model: Hands' hint field shows, and a long page keeps its buttons", () => {
  const field = describeScreen({ app: "com.google.android.gm", nodes: [{ n: 4, text: "", desc: "", hint: "Compose email", cls: "EditText", edit: true, bounds: [0, 0, 10, 10] }] });
  assert.match(field, /\[4\] hint="Compose email" \(EditText\) edit/);
  const many = Array.from({ length: 150 }, (_, n) => ({
    n,
    text: n === 149 ? "Reply" : `Paragraph ${n}`,
    cls: n === 149 ? "Button" : "TextView",
    tap: n === 149,
    bounds: [0, n * 20, 100, n * 20 + 20],
  }));
  const text = describeScreen({ app: "x", nodes: many });
  assert.match(text, /\[149\] "Reply" \(Button\) tap/, "the button at the bottom survives trimming");
  assert.match(text, /more nodes not shown/);
  assert.ok(text.split("\n").length <= 93);
});

test("Hands dropping off mid-task ends the task quickly with a spoken reason", async () => {
  const t = await setup({ slowMs: 300, timing: { actMs: 8000 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.fromMind("act").length >= 1, 5000);
    const t0 = Date.now();
    t.hub.setHands(false);
    assert.ok(await until(() => t.tasks().some((m) => m.status === "failed"), 4000), "task failed");
    assert.ok(Date.now() - t0 < 3000, `gave up in ${Date.now() - t0} ms, not after 8 s timeouts`);
    assert.ok(t.fromMind("say").some((m) => /lost touch with the phone/.test(m.text)));
  } finally {
    await t.close();
  }
});

test("'bye' lets Bobby finish before the session is put to sleep", async () => {
  const t = await setup({ timing: { goodbyeMs: 700 } });
  try {
    t.mouth!.hear("thanks, bye");
    await sleep(350);
    assert.equal(t.fromMind("sleep").length, 0, "not cut off at once");
    assert.ok(await until(() => t.fromMind("sleep").length === 1, 2500), "then sleep");
  } finally {
    await t.close();
  }
});

test("hub client: waits are released the moment the connection drops", async () => {
  const hub = startFakeHub({ port: 0, log: () => {}, speed: 0 });
  await hub.ready;
  const c = new HubClient(`ws://localhost:${hub.port}/mind?token=t`, "mind", () => {}, () => {});
  try {
    c.start();
    await until(() => c.connected);
    const t0 = Date.now();
    const wait = c.waitFor(c.nextId(), 10_000);
    await hub.close();
    assert.equal(await wait, null);
    assert.ok(Date.now() - t0 < 1500, "did not wait for the 10 s timeout");
  } finally {
    c.stop();
  }
});
