// Regression tests for bugs found in review (v1), carried over to the v2 brain, plus v2 helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerConfirmV1, setup, sleep, until } from "./helpers";
import { checkScreen, describeCompact, describeScreen, stableTarget } from "../src/screen";
import { HubClient } from "../src/hub";
import { startFakeHub } from "../fakes/hub";

test("a second wake with nothing new doesn't repeat old notifications", async () => {
  const t = await setup();
  try {
    t.mouth!.asleep();
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

test("'stop' said while the Mind is still routing means the task never starts", async () => {
  const t = await setup({ latency: { route: 400 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await sleep(100);
    t.mouth!.hear("stop");
    await sleep(800);
    assert.equal(t.tasks().length, 0, "no task published");
    assert.equal(t.acts().length, 0, "nothing done on the phone");
    assert.ok(t.fromMind("hush").length >= 1, "Bobby hushed");
    assert.ok(t.fromMind("whisper").some((w) => /before anything began/.test(w.text)), "Bobby told nothing started");
    t.mouth!.hear("open Spotify");
    assert.ok(await until(() => t.tasks().some((m) => m.title === "Open Spotify"), 4000), "next request starts normally");
  } finally {
    await t.close();
  }
});

test("'stop' during a slow model call cancels at once, not when the model answers", async () => {
  const t = await setup({ latency: { exec: 2500 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.acts().length >= 1, 6000);
    await sleep(300);
    const t0 = Date.now();
    t.mouth!.hear("stop");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 2000));
    assert.ok(Date.now() - t0 < 600, `cancelled in ${Date.now() - t0} ms`);
    const n = t.acts().length;
    await sleep(2600);
    assert.equal(t.acts().length, n, "no act after the cancel");
  } finally {
    await t.close();
  }
});

test("a true time from a notification is not 'corrected'; an invented one still is", async () => {
  const t = await setup();
  try {
    t.hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
    t.mouth!.hear("call alex and tell him I'm running late");
    await answerConfirmV1(t, "yes");
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

test("a sentence that merely contains 'sent' is not a 'done' claim", async () => {
  const t = await setup({ latency: { exec: 300 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
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
    await answerConfirmV1(t, "yes");
    await until(() => t.fromMind("call").length > 0, 3000);
    t.mouth!.spoke("Sure, I'm calling Sam for you.");
    assert.ok(await until(() => t.fromMind("correct").some((m) => m.text === "It's Alex, not Sam."), 2000));
  } finally {
    await t.close();
  }
});

test("a pop-up appearing while the model thinks: the stale tap is refused and the brain gets past it", async () => {
  let popped = false;
  const t = await setup({
    v2: true,
    model: (hub, inner) => async (req) => {
      const reply = await inner(req);
      if (!popped && req.purpose === "exec" && /Open Sarah Chen's email/.test(req.user) && /Sarah Chen, Meeting today/.test(req.user)) {
        popped = true;
        hub.phone.popup = "Update available";
      }
      return reply;
    },
  });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 10000), "task still finishes");
    assert.ok(popped);
    assert.ok(t.toMind("act_result").some((m) => m.ok === false && m.why === "stale"), "the n from the old screen was refused as stale");
    assert.ok(t.acts().some((a) => a.on?.n !== undefined && t.hub.phone.popup === null), "dismissed");
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
  } finally {
    await t.close();
  }
});

test("stableTarget: key, then id, then a unique label; never n", () => {
  const s = {
    nodes: [
      { n: 0, text: "Send", key: "gm.send", id: "x:id/send" },
      { n: 1, text: "Reply", id: "x:id/reply" },
      { n: 2, text: "OK" },
      { n: 3, text: "OK" },
      { n: 4, text: "Unique" },
    ],
  };
  assert.deepEqual(stableTarget(s, 0), { key: "gm.send" });
  assert.deepEqual(stableTarget(s, 1), { id: "x:id/reply" });
  assert.equal(stableTarget(s, 2), null, "ambiguous label");
  assert.deepEqual(stableTarget(s, 4), { text: "Unique" });
});

test("checkScreen: app, text present/absent, field value; unknown when nothing to test", () => {
  const s = { app: "com.google.android.gm", nodes: [{ n: 0, text: "Hi there" }, { n: 1, text: "3 works", hint: "", key: "body", edit: true }] };
  assert.equal(checkScreen({ app: "gmail", text_present: ["hi THERE"] }, s), null);
  assert.match(checkScreen({ app: "spotify" }, s)!, /expected spotify/);
  assert.match(checkScreen({ text_absent: ["Hi"] }, s)!, /still on screen/);
  assert.equal(checkScreen({ field: { key: "body", value: "3 works" } }, s), null);
  assert.equal(checkScreen({}, s), "unknown");
  assert.equal(checkScreen({ app: "gmail" }, { locked: true, nodes: [] }), "the phone is locked");
});

test("screen text for the model: hint shows, no pixel coords in the compact view, a long page keeps its buttons", () => {
  const field = describeScreen({ app: "com.google.android.gm", nodes: [{ n: 4, text: "", desc: "", hint: "Compose email", cls: "EditText", edit: true, bounds: [0, 0, 10, 10] }] });
  assert.match(field, /\[4\] hint="Compose email" \(EditText\) edit/);
  const compact = describeCompact({ app: "com.google.android.gm", nodes: [{ n: 4, hint: "Compose email", cls: "EditText", edit: true, focused: true, bounds: [0, 0, 10, 10] }] });
  assert.match(compact, /\[4\] hint="Compose email" \(EditText\) edit focused$/m);
  assert.ok(!/@\d/.test(compact), "no coordinates");
  const many = Array.from({ length: 150 }, (_, n) => ({ n, text: n === 149 ? "Reply" : `Paragraph ${n}`, cls: n === 149 ? "Button" : "TextView", tap: n === 149, bounds: [0, n * 20, 100, n * 20 + 20] }));
  const text = describeCompact({ app: "x", nodes: many });
  assert.match(text, /\[149\] "Reply" \(Button\) tap/, "the button at the bottom survives trimming");
  assert.match(text, /plain-text nodes not shown/);
});

test("Hands dropping off mid-task ends the task quickly with a spoken reason", async () => {
  const t = await setup({ latency: { exec: 300 }, timing: { actMs: 8000 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.acts().length >= 1, 5000);
    const t0 = Date.now();
    t.hub.setHands(false);
    assert.ok(await until(() => t.tasks().some((m) => m.status === "failed"), 4000), "task failed");
    assert.ok(Date.now() - t0 < 3000, `gave up in ${Date.now() - t0} ms, not after 8 s timeouts`);
    assert.ok(await until(() => t.fromMind("say").some((m) => /lost touch with the phone|can.t see the phone/.test(m.text)), 5000));
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
