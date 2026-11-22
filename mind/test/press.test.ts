// Push-to-talk: one command per side-button press (`wake`), debounced; speech outside a
// listening window is ignored; narration never piles up. From the first real-phone run, where
// every `heard` (room chatter included) started a new decide and cancelled the running task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sleep, until } from "./helpers";

const decides = (t: Awaited<ReturnType<typeof setup>>) => t.model.calls.filter((c) => c.purpose === "decide");

test("a command split over two heards (the user paused) is decided once, joined", async () => {
  const t = await setup({ timing: { commandMs: 300 } });
  try {
    t.mouth!.hear("reply to Sarah");
    await sleep(150);
    t.mouth!.hearMore("and tell her 3 works");
    assert.ok(await until(() => t.tasks().length > 0, 4000), "task started");
    await sleep(400);
    const d = decides(t);
    assert.equal(d.length, 1, "one decide for the whole command");
    assert.match(d[0].user, /The user just said: "reply to Sarah and tell her 3 works"/);
  } finally {
    await t.close();
  }
});

test("heard outside a listening window is ignored and logged", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("what did I miss?");
    assert.ok(await until(() => decides(t).length === 1, 2000));
    await sleep(200); // the command was taken: the window is closed until the next press
    t.mouth!.hearMore("open Spotify");
    await sleep(500);
    assert.equal(decides(t).length, 1, "no decide for speech without a press");
    assert.equal(t.tasks().length, 0);
    assert.ok(t.lines.some((l) => /ignored heard.*open Spotify/.test(l)), "logged as ignored");
  } finally {
    await t.close();
  }
});

test("a running task is not cancelled or replaced by speech outside a listening window", async () => {
  const t = await setup({ slowMs: 100 });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.fromMind("act").length >= 1, 5000), "task under way");
    t.mouth!.hearMore("No, stop, stop, stop. Send a email to Hamza saying hello");
    t.mouth!.hearMore("stop");
    t.mouth!.hearMore("open Spotify");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 15000), "task finished");
    assert.ok(!t.tasks().some((m) => m.status === "cancelled"), "nothing cancelled");
    assert.equal(t.tasks().filter((m) => m.status === "started").length, 1, "no second task");
    assert.equal(decides(t).length, 1);
    assert.equal(t.fromMind("hush").length, 0);
    assert.ok(t.hub.phone.sent, "email sent");
  } finally {
    await t.close();
  }
});

test("a new press while a task runs can still stop it", async () => {
  const t = await setup({ slowMs: 150 });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.fromMind("act").length >= 1, 5000);
    t.mouth!.hearMore("stop"); // no press: ignored
    await sleep(200);
    assert.ok(!t.tasks().some((m) => m.status === "cancelled"));
    t.mouth!.hear("stop"); // press, then "stop"
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 2000), "cancelled");
  } finally {
    await t.close();
  }
});

test("narration never piles up: a line is skipped while the last is still playing", async () => {
  const t = await setup({ msPerChar: 40 });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 20000), "task finished");
    await until(() => t.fromMind("say").some((m) => /sent/i.test(m.text)), 5000);
    // Replay the wire: at every `say` the Mind sent, no earlier `say` may still be unfinished.
    const open = new Set<string>();
    let worst = 0;
    for (const w of t.hub.wire) {
      if (w.from === "mind" && w.msg.type === "say") {
        worst = Math.max(worst, open.size);
        open.add(w.msg.id);
      } else if (w.to === "mind" && w.msg.type === "say_done") open.delete(w.msg.re);
    }
    assert.equal(worst, 0, "never two lines outstanding");
    assert.ok(t.lines.some((l) => /skipped say/.test(l)), "some step lines were skipped");
    const says = t.fromMind("say").map((m) => m.text);
    assert.ok(says.some((s) => /Sending Sarah/.test(s)), "the Send line is never skipped");
    assert.ok(says.some((s) => /reply to Sarah is sent/.test(s)), "the result line is never skipped");
  } finally {
    await t.close();
  }
});

test("no sleep during a listening window", async () => {
  const t = await setup({ sleepMs: 200, timing: { listenMs: 1500 } });
  try {
    t.mouth!.wake(); // already awake from connecting; the window opened then
    await sleep(900);
    assert.equal(t.fromMind("sleep").length, 0, "the mic is open: no sleep");
    assert.ok(await until(() => t.fromMind("sleep").length === 1, 3000), "sleep once the window closes");
  } finally {
    await t.close();
  }
});
