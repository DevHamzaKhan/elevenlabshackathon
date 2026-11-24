// The brain with a v1 Mouth (heard/say/whisper only) against the fake hub and the scripted fake
// OpenAI. No API key needed. v2 behaviour is in v2.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerConfirmV1, setup, sleep, until } from "./helpers";

test("email story (v1 Mouth): reply to Sarah ends with the email sent, narrated, Send confirmed by voice", async () => {
  const t = await setup();
  try {
    t.hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await answerConfirmV1(t, "yes, send it"), "asked before sending");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "done"), 8000), "task finished as done");
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
    const says = t.fromMind("say").map((m) => m.text);
    assert.ok(says.some((s) => /Should I go ahead\?/.test(s)));
    assert.ok(await until(() => t.fromMind("say").some((m) => /Sent your reply to Sarah/.test(m.text)), 5000), "result line");
    for (const w of t.hub.wire.filter((w) => w.from === "mind")) assert.ok(w.msg.to, `${w.msg.type} has to`);
    assert.ok(t.hub.watched.some((m) => m.type === "plan"), "plan published");
    assert.ok(t.hub.watched.some((m) => m.type === "step" && m.status === "running"), "steps published");
    // Narration goes out with its act: the first narrated act is directly preceded by its say.
    const frames = t.hub.wire.filter((w) => w.from === "mind" && ["say", "act"].includes(w.msg.type));
    const i = frames.findIndex((w) => w.msg.type === "act");
    assert.equal(frames[i - 1]?.msg.type, "say");
    assert.ok(frames[i].at - frames[i - 1].at < 50, "say and act sent at the same instant");
  } finally {
    await t.close();
  }
});

test("v1: 'no' to the Send question cancels and nothing is sent", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await answerConfirmV1(t, "no, don't"));
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 4000));
    assert.equal(t.hub.phone.sent, null);
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
    const ok = await until(() => t.fromMind("whisper").some((m) => /2 new notifications/.test(m.text) && /Mum/.test(m.text) && /Sarah Chen/.test(m.text)));
    assert.ok(ok, "digest whisper lists both notifications");
  } finally {
    mouth.close();
    await t.close();
  }
});

test("stop cancels a running task: hush, cursor hidden, cancelled, whisper, no more acts", async () => {
  const t = await setup({ latency: { exec: 150 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.acts().length >= 1, 5000);
    t.mouth!.hear("stop");
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 3000), "task published as cancelled");
    const acts = t.acts().length;
    await sleep(500);
    assert.equal(t.acts().length, acts, "no acts after the cancel");
    assert.ok(t.fromMind("hush").length >= 1, "hush sent");
    assert.ok(t.fromMind("cursor").some((m) => m.show === false), "cursor hidden");
    assert.ok(t.fromMind("whisper").some((m) => /cancelled/.test(m.text)), "Bobby told what happened");
    assert.ok(!t.ai.calls.some((c) => c.role === "route" && /"stop"/.test(c.user)), "stop never went to the model");
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
    assert.ok(await until(() => t.fromMind("say").some((m) => /phone isn't ready/.test(m.text))));
    assert.equal(t.tasks().length, 0);
  } finally {
    await t.close();
  }
});

test("call: confirmed, placed through the Caller, status whispered, summary said", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("call alex and tell him I'm running late");
    assert.ok(await answerConfirmV1(t, "yes"));
    assert.ok(await until(() => t.fromMind("say").some((m) => /3:20/.test(m.text)), 5000), "summary spoken");
    const call = t.fromMind("call")[0];
    assert.equal(call.number, "+14155550123");
    assert.match(call.goal, /running late/);
    assert.ok(t.fromMind("whisper").some((m) => /dialing/.test(m.text)), "status whispered");
    assert.ok(t.tasks().some((m) => m.title === "Call Alex" && m.status === "done"));
    assert.equal(t.ai.count("route"), 0, "local shortcut");
  } finally {
    await t.close();
  }
});

test("call: unknown contact gets 'no number', no call placed", async () => {
  const t = await setup();
  try {
    t.mouth!.hear("call zed and tell him hi");
    assert.ok(await until(() => t.fromMind("say").some((m) => /don't have a number for Zed/.test(m.text))));
    assert.equal(t.fromMind("call").length, 0);
  } finally {
    await t.close();
  }
});

test("call: Caller absent means Bobby says he can't call", async () => {
  const t = await setup({ caller: false });
  try {
    t.mouth!.hear("call alex and tell him hi");
    assert.ok(await until(() => t.fromMind("say").some((m) => /can't make calls/.test(m.text))));
  } finally {
    await t.close();
  }
});

test("stop during a call hangs it up", async () => {
  const t = await setup({ callerStepMs: 400 });
  try {
    t.mouth!.hear("call alex and tell him I'm running late");
    assert.ok(await answerConfirmV1(t, "yes"));
    assert.ok(await until(() => t.fromMind("call").length === 1, 3000));
    t.mouth!.hear("stop");
    assert.ok(await until(() => t.fromMind("hangup").length === 1, 2000), "hangup sent");
    assert.equal(t.fromMind("hangup")[0].re, t.fromMind("call")[0].id);
    assert.ok(await until(() => t.tasks().some((m) => m.status === "cancelled"), 2000));
  } finally {
    await t.close();
  }
});

test("sleep is sent after the idle time with nothing running", async () => {
  const t = await setup({ sleepMs: 400 });
  try {
    assert.ok(await until(() => t.fromMind("sleep").length === 1, 3000), "sleep sent");
    await sleep(800);
    assert.equal(t.fromMind("sleep").length, 1, "sleep sent once");
  } finally {
    await t.close();
  }
});

test("sleep is still sent when every model call fails (from the phone stitch: 401 left the mic open)", async () => {
  const t = await setup({ sleepMs: 60_000, timing: { goodbyeMs: 200 }, model: () => async () => ({ json: null, stopReason: null, ms: 1, error: "HTTP 401" }) });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.fromMind("sleep").length === 1, 4000), "sleep after the error line");
  } finally {
    await t.close();
  }
});

test("no sleep while a task is running", async () => {
  const t = await setup({ sleepMs: 300, latency: { exec: 150 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.tasks().length > 0);
    const startedAt = Date.now();
    assert.ok(await answerConfirmV1(t, "yes", 8000));
    await until(() => t.tasks().some((m) => m.status === "done"), 8000);
    const sleeps = t.hub.wire.filter((w) => w.from === "mind" && w.msg.type === "sleep");
    assert.ok(sleeps.every((w) => w.at < startedAt || w.at > startedAt + 300), "no sleep mid-task");
  } finally {
    await t.close();
  }
});

test("correction: Bobby claiming 'done' mid-task gets a correct", async () => {
  const t = await setup({ latency: { exec: 200 } });
  try {
    t.mouth!.hear("reply to Sarah and tell her 3 works");
    await until(() => t.tasks().length > 0);
    t.mouth!.spoke("All done, it's sent!");
    assert.ok(await until(() => t.fromMind("correct").length > 0, 3000), "correct sent");
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
    assert.ok(await until(() => t.fromMind("correct").length > 0, 2000), "correct sent");
    assert.match(t.fromMind("correct")[0].text, /3, not 2/);
  } finally {
    await t.close();
  }
});

test("without a Mouth nothing irreversible happens: the Send step is not taken", async () => {
  const t = await setup({ mouth: false });
  const { startFakeMouth } = await import("../fakes/mouth");
  const mouth = startFakeMouth({ url: t.url("mouth"), log: () => {}, msPerChar: 0 });
  try {
    await until(() => mouth.awake, 3000);
    await sleep(100);
    mouth.hear("reply to Sarah and tell her 3 works");
    await until(() => t.acts().length >= 1, 3000);
    mouth.close();
    assert.ok(await until(() => t.tasks().some((m) => m.status !== "started"), 6000), "task ended");
    assert.equal(t.hub.phone.sent, null, "not sent without anyone to confirm");
  } finally {
    await t.close();
  }
});
