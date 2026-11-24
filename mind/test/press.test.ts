// v1 push-to-talk: one command per side-button press (`wake`), debounced; speech outside a
// listening window is ignored; narration never piles up. From the first real-phone run, where
// every `heard` (room chatter included) started a new decide and cancelled the running task.
// (A v2 Mouth sends tool calls instead, with no debounce: see v2.test.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerConfirmV1, setup, sleep, until } from "./helpers";

const routes = (t: Awaited<ReturnType<typeof setup>>) => t.ai.calls.filter((c) => c.role === "route");

test("a command split over two heards (the user paused) is decided once, joined", async () => {
  const t = await setup({ timing: { commandMs: 300 } });
  try {
    t.mouth!.hear("reply to Sarah");
    await sleep(150);
    t.mouth!.hearMore("and tell her 3 works");
    assert.ok(await until(() => t.tasks().length > 0, 4000), "task started");
    await sleep(300);
    assert.equal(routes(t).length, 1, "one router call for the whole command");
    assert.match(routes(t)[0].user, /The user just said: "reply to Sarah and tell her 3 works"/);
  } finally {
    await t.close();
  }
});

test("heard outside a listening window is ignored and logged", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("what did I miss?");
    assert.ok(await until(() => routes(t).length === 1, 2000));
    await sleep(200);
    t.mouth!.hearMore("open Spotify");
    await sleep(500);
    assert.equal(t.tasks().length, 0);
    assert.ok(t.lines.some((l) => /ignored heard.*open Spotify/.test(l)), "logged as ignored");
  } finally {
    await t.close();
  }
});

test("a running task is not cancelled or replaced by speech outside a listening window", async () => {
  const t = await setup({ latency: { exec: 80 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.acts().length >= 1, 5000), "task under way");
    t.mouth!.hearMore("No, stop, stop, stop. Send a email to Hamza saying hello");
    t.mouth!.hearMore("stop");
    t.mouth!.hearMore("open Spotify");
    assert.ok(await answerConfirmV1(t, "yes"), "asked to confirm");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 8000), "task finished");
    assert.ok(!t.tasks().some((m) => m.status === "cancelled"), "nothing cancelled");
    assert.equal(t.tasks().filter((m) => m.status === "started").length, 1, "no second task");
    assert.equal(t.fromMind("hush").length, 0);
    assert.ok(t.hub.phone.sent, "email sent");
  } finally {
    await t.close();
  }
});

test("a new press while a task runs can still stop it", async () => {
  const t = await setup({ latency: { exec: 150 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.acts().length >= 1, 5000);
    t.mouth!.hearMore("stop"); // no press: ignored
    await sleep(200);
    assert.ok(!t.tasks().some((m) => m.status === "cancelled"));
    t.mouth!.hear("stop");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 2000), "cancelled");
  } finally {
    await t.close();
  }
});

test("narration never piles up: at most one say outstanding", async () => {
  const t = await setup({ msPerChar: 30, timing: { sayMs: 6000 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await answerConfirmV1(t, "yes", 10000));
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 15000), "task finished");
    await until(() => t.fromMind("say").some((m) => /Sent your reply/.test(m.text)), 5000);
    const open = new Set<string>();
    let worst = 0;
    for (const w of t.hub.wire) {
      if (w.from === "mind" && w.msg.type === "say") {
        worst = Math.max(worst, open.size);
        open.add(w.msg.id);
      } else if (w.to === "mind" && w.msg.type === "say_done") open.delete(w.msg.re);
    }
    assert.equal(worst, 0, "never two lines outstanding");
    assert.ok(t.fromMind("say").some((m) => /Sent your reply to Sarah/.test(m.text)), "the result line is never skipped");
  } finally {
    await t.close();
  }
});

test("no sleep during a listening window", async () => {
  const t = await setup({ sleepMs: 200, timing: { listenMs: 1500 } });
  try {
    t.mouth!.wake();
    await sleep(900);
    assert.equal(t.fromMind("sleep").length, 0, "the mic is open: no sleep");
    assert.ok(await until(() => t.fromMind("sleep").length === 1, 3000), "sleep once the window closes");
  } finally {
    await t.close();
  }
});
