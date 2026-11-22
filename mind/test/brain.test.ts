// The brain against the fake hub, with the model stubbed out. No API key needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sleep, until } from "./helpers";

test("email story: reply to Sarah ends with the email sent, narrated", async () => {
  const t = await setup();
  try {
    t.hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    const ok = await until(() => t.tasks().some((m) => m.status === "done"), 15000);
    assert.ok(ok, "task finished as done");
    assert.ok(t.hub.phone.sent, "the fake phone sent an email");
    assert.match(t.hub.phone.sent!.text, /3/);
    const says = t.fromMind("say").map((m) => m.text);
    assert.ok(says.length >= 5, `narrated (${says.length} lines)`);
    assert.ok(says.some((s) => /Sending Sarah/.test(s)), "one-line summary before sending");
    // Every frame from the Mind carries `to`.
    for (const w of t.hub.wire.filter((w) => w.from === "mind")) assert.ok(w.msg.to, `${w.msg.type} has to`);
    // Plan and step updates were published.
    assert.ok(t.hub.watched.some((m) => m.type === "plan"), "plan published");
    assert.ok(t.hub.watched.some((m) => m.type === "step" && m.status === "running"), "steps published");
    // say and act go out together: each act is preceded directly by its say.
    const mindFrames = t.hub.wire.filter((w) => w.from === "mind" && ["say", "act"].includes(w.msg.type));
    const firstAct = mindFrames.findIndex((w) => w.msg.type === "act");
    assert.equal(mindFrames[firstAct - 1]?.msg.type, "say");
    assert.ok(mindFrames[firstAct].at - mindFrames[firstAct - 1].at < 50, "say and act sent at the same instant");
  } finally {
    await t.close();
  }
});

test("notification digest is whispered on wake", async () => {
  const t = await setup({ mouth: false });
  const { startFakeMouth } = await import("../fakes/mouth");
  const mouth = startFakeMouth({ url: t.url("mouth"), log: () => {}, msPerChar: 0 });
  try {
    t.hub.notify("com.whatsapp", "Mum", "Call me");
    t.hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
    await sleep(100);
    mouth.asleep();
    mouth.wake();
    const ok = await until(() =>
      t.fromMind("whisper").some((m) => /2 new notifications/.test(m.text) && /Mum/.test(m.text) && /Sarah Chen/.test(m.text)),
    );
    assert.ok(ok, "digest whisper lists both notifications");
  } finally {
    mouth.close();
    await t.close();
  }
});

test("stop cancels a running task: hush, cursor hidden, cancelled, whisper, no more acts", async () => {
  const t = await setup({ slowMs: 120 });
  try {
    t.mouth!.hear("open Spotify");
    await until(() => t.fromMind("act").length >= 1, 5000);
    t.mouth!.hear("stop");
    const ok = await until(() => t.tasks().some((m) => m.status === "cancelled"), 5000);
    assert.ok(ok, "task published as cancelled");
    const acts = t.fromMind("act").length;
    await sleep(600);
    assert.equal(t.fromMind("act").length, acts, "no acts after the cancel");
    assert.ok(t.fromMind("hush").length >= 1, "hush sent");
    assert.ok(t.fromMind("cursor").some((m) => m.show === false), "cursor hidden");
    assert.ok(t.fromMind("whisper").some((m) => /cancelled/.test(m.text)), "Bobby told what happened");
    // "stop" never went to the model.
    assert.ok(!t.model.calls.some((c) => c.purpose === "decide" && /"stop"/.test(c.user)));
  } finally {
    await t.close();
  }
});

test("phone not ready: Bobby says so and no task starts", async () => {
  const t = await setup();
  try {
    t.hub.setHands(false);
    await sleep(100);
    t.mouth!.hear("open Spotify");
    const ok = await until(() => t.fromMind("say").some((m) => /phone isn't ready/.test(m.text)));
    assert.ok(ok);
    assert.equal(t.tasks().length, 0);
  } finally {
    await t.close();
  }
});

test("call: placed through the Caller, status whispered, summary said", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("call alex and tell him I'm running late");
    const ok = await until(() => t.fromMind("say").some((m) => /3:20/.test(m.text)), 5000);
    assert.ok(ok, "summary spoken");
    const call = t.fromMind("call")[0];
    assert.equal(call.number, "+14155550123");
    assert.ok(t.fromMind("whisper").some((m) => /dialing/.test(m.text)), "status whispered");
    assert.ok(t.tasks().some((m) => m.title === "Call Alex" && m.status === "done"));
  } finally {
    await t.close();
  }
});

test("call: unknown contact gets 'no number', no call placed", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("call zed and tell him hi");
    const ok = await until(() => t.fromMind("say").some((m) => /don't have a number for Zed/.test(m.text)));
    assert.ok(ok);
    assert.equal(t.fromMind("call").length, 0);
  } finally {
    await t.close();
  }
});

test("call: Caller absent means Bobby says he can't call", async () => {
  const t = await setup({ caller: false });
  try {
    t.mouth!.hear("call alex and tell him hi");
    const ok = await until(() => t.fromMind("say").some((m) => /can't make calls/.test(m.text)));
    assert.ok(ok);
  } finally {
    await t.close();
  }
});

test("sleep is sent after the idle time with nothing running", async () => {
  const t = await setup({ sleepMs: 400 });
  try {
    const ok = await until(() => t.fromMind("sleep").length === 1, 3000);
    assert.ok(ok, "sleep sent");
    await sleep(800);
    assert.equal(t.fromMind("sleep").length, 1, "sleep sent once");
  } finally {
    await t.close();
  }
});

test("no sleep while a task is running", async () => {
  const t = await setup({ sleepMs: 300, slowMs: 150 });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.tasks().length > 0);
    const startedAt = Date.now();
    await until(() => t.tasks().some((m) => m.status === "done"), 15000);
    const sleeps = t.hub.wire.filter((w) => w.from === "mind" && w.msg.type === "sleep");
    assert.ok(sleeps.every((w) => w.at < startedAt || w.at > startedAt + 300), "no sleep mid-task");
  } finally {
    await t.close();
  }
});

test("correction: Bobby claiming 'done' mid-task gets a correct", async () => {
  const t = await setup({ slowMs: 200 });
  try {
    t.mouth!.hear("open Spotify");
    await until(() => t.tasks().length > 0);
    t.mouth!.spoke("All done, Spotify is open!");
    const ok = await until(() => t.fromMind("correct").length > 0, 3000);
    assert.ok(ok, "correct sent");
    assert.match(t.fromMind("correct")[0].text, /still working/);
  } finally {
    await t.close();
  }
});

test("correction: wrong time is corrected", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("what did I miss? Sarah wants to move it to 3");
    await sleep(150);
    t.mouth!.spoke("Sarah wants to meet at 2 instead.");
    const ok = await until(() => t.fromMind("correct").length > 0, 2000);
    assert.ok(ok, "correct sent");
    assert.match(t.fromMind("correct")[0].text, /3, not 2/);
  } finally {
    await t.close();
  }
});

test("without a Mouth the task still runs, without waiting for say_done", async () => {
  const t = await setup({ mouth: false });
  const { startFakeMouth } = await import("../fakes/mouth");
  const mouth = startFakeMouth({ url: t.url("mouth"), log: () => {}, msPerChar: 0 });
  try {
    await until(() => mouth.awake, 3000);
    await sleep(100);
    mouth.hear("reply to Sarah and tell her 3 works");
    await sleep(30);
    mouth.close(); // Bobby goes away mid-task
    const t0 = Date.now();
    const ok = await until(() => t.tasks().some((m) => m.status === "done"), 8000);
    assert.ok(ok, "task finished");
    assert.ok(Date.now() - t0 < 6000, "didn't wait 2 s per line for say_done");
    assert.ok(t.hub.phone.sent);
  } finally {
    await t.close();
  }
});
