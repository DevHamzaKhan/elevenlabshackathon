// The v2 architecture end to end against the fakes: shortcuts, the queue, multi-action batches
// with checks, escalation, confirmations, recipes, barge-in, amend, cancel, old-Hands degradation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sleep, until } from "./helpers";
import { action, actReply } from "../fakes/openai";
import { InMemoryStore } from "../src/memory";

const ended = (t: Awaited<ReturnType<typeof setup>>, status?: string) => t.tasks().filter((m) => m.status !== "started" && (!status || m.status === status));

test("shortcut: 'send an email to Hamza saying I'm late' -> mailto open, confirm, Send; no router or exec call", async () => {
  const t = await setup({ v2: true });
  try {
    t.mouth!.request("send an email to Hamza saying I'm late");
    assert.ok(await until(() => ended(t).length > 0, 6000), "task ended");
    assert.equal(ended(t)[0].status, "done");
    const acts = t.acts();
    assert.equal(acts[0].do, "open");
    assert.equal(acts[0].uri, "mailto:hamza@example.com?subject=I'm%20late&body=I'm%20late");
    assert.equal(acts[0].then_screen, true);
    assert.deepEqual(t.hub.phone.mails.map((m) => [m.to, m.body]), [["hamza@example.com", "I'm late"]]);
    assert.equal(t.ai.count("route"), 0, "no router call");
    assert.equal(t.ai.count("exec"), 0, "no exec call");
    const conf = t.fromMind("confirm_request");
    assert.equal(conf.length, 1);
    assert.match(conf[0].summary, /Email to Hamza: "I'm late"/);
    // The Send tap came after the confirmation.
    const sendAt = t.hub.wire.find((w) => w.from === "mind" && w.msg.type === "act" && w.msg.do === "tap")!.at;
    const replyAt = t.hub.wire.find((w) => w.to === "mind" && w.msg.type === "confirm_reply")!.at;
    assert.ok(sendAt >= replyAt, "Send only after the confirm_reply");
    assert.ok(t.fromMind("progress").some((m) => /Writing to Hamza/.test(m.text)));
    assert.ok(t.fromMind("task_update").some((m) => m.status === "waiting_confirm"));
  } finally {
    await t.close();
  }
});

test("chained command -> 3 queued tasks run in order", async () => {
  const t = await setup({ v2: true });
  try {
    t.mouth!.request("open Spotify, then text Alex I'm late, then call Mom");
    assert.ok(await until(() => ended(t).length === 3, 8000), `3 tasks ended (${ended(t).length})`);
    const started = t.tasks().filter((m) => m.status === "started").map((m) => m.title);
    assert.deepEqual(started, ["Open Spotify", "Text Alex", "Call Mom"]);
    assert.deepEqual(ended(t).map((m) => m.status), ["done", "done", "done"]);
    const queued = t.fromMind("task_update").filter((m) => m.status === "queued");
    assert.equal(queued.length, 3, "all three queued first");
    assert.deepEqual(t.hub.phone.texts.map((x) => [x.to, x.body]), [["+14155550123", "I'm late"]]);
    assert.deepEqual(t.hub.phone.calls.map((c) => c.number), ["+14155550199"]);
    assert.equal(t.ai.count("route") + t.ai.count("exec"), 0, "all three from the local shortcut index");
    // Each task's first act came after the previous task ended.
    const firstActs = t.acts().filter((a) => a.do === "launch" || a.do === "open").map((a) => a.app ?? a.uri);
    assert.deepEqual(firstActs, ["Spotify", "smsto:+14155550123?body=I'm%20late", "tel:+14155550199"]);
  } finally {
    await t.close();
  }
});

test("grounded task: router sub-goals, launch (no scenic route), batches, code-checked done_when, confirm, sent", async () => {
  const t = await setup({ v2: true });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
    assert.equal(t.ai.count("route"), 1);
    assert.equal(t.ai.count("exec"), 3, "one exec call per sub-goal (open email, write, send)");
    const acts = t.acts();
    assert.equal(acts[0].do, "launch", "straight to Gmail");
    assert.ok(!acts.some((a) => a.do === "swipe" || (a.do === "key" && a.name === "home")), "no home/swipe hunting");
    // The write step was a two-action batch: tap Reply (n, narrated), then type (fast, no n).
    const typeAct = acts.find((a) => a.do === "type")!;
    assert.equal(typeAct.fast, true);
    assert.equal(typeAct.on, undefined, "typed into the focused field");
    assert.ok(t.hub.phone.fastActs >= 1);
    assert.ok(t.fromMind("progress").some((m) => /Sent your reply to Sarah/.test(m.text)), "outcome spoken from the Mind");
    assert.ok(t.hub.watched.some((m) => m.type === "plan" && m.steps.length === 4), "plan with the launch step + 3 sub-goals");
    for (const w of t.hub.wire.filter((w) => w.from === "mind")) assert.ok(w.msg.to, `${w.msg.type} has to`);
  } finally {
    await t.close();
  }
});

test("a batch stops at the first failed expect and re-grounds with the mismatch in the history", async () => {
  const t = await setup({ v2: true });
  let first = true;
  t.ai.override("exec", (user) => {
    if (!first || !/Sub-goal: Write the reply/.test(user)) return null;
    first = false;
    const reply = /^\[(\d+)\] "Reply"/m.exec(user)!;
    return actReply(
      [
        action({ n: Number(reply[1]), expect: { text_present: "Compose email" } }),
        action({ do: "type", text: "3 works for me.", expect: { text_present: "something that never appears" } }),
        action({ do: "key", key: "back", expect: {} }),
      ],
      "Writing the reply.",
    );
  });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.ok(!t.acts().some((a) => a.do === "key" && a.name === "back"), "the third action never ran");
    const after = t.ai.calls.filter((c) => c.role === "exec" && /MISMATCH/.test(c.user));
    assert.ok(after.length >= 1, "the next exec call saw the mismatch");
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
  } finally {
    await t.close();
  }
});

test("escalation after 2 consecutive mismatches; bounded; fails with a spoken reason", async () => {
  const t = await setup({ v2: true });
  t.ai.override("exec", (user) => (/Sub-goal: Open Sarah Chen's email/.test(user) ? actReply([action({ do: "swipe", dir: "up", expect: { text_present: "Nope, never" } })], "") : null));
  t.ai.override("escalate", () => ({ status: "failed", say: "Gmail isn't showing Sarah's email, so I've stopped.", note: "", actions: [], replan: [] }));
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "failed");
    const firstEsc = t.ai.calls.findIndex((c) => c.role === "escalate");
    assert.ok(firstEsc > 0, "escalated");
    assert.equal(t.ai.calls.slice(0, firstEsc).filter((c) => c.role === "exec").length, 2, "after exactly 2 mismatched batches");
    assert.ok(t.ai.calls[firstEsc].images >= 1, "with a screenshot");
    assert.equal(t.ai.calls[firstEsc].model, "gpt-6.1-terra");
    assert.ok(t.fromMind("progress").some((m) => /isn't showing Sarah's email/.test(m.text)), "reason spoken");
  } finally {
    await t.close();
  }
});

test("escalation on an unreadable tree (web view): screenshot -> pixel tap -> checked done", async () => {
  const t = await setup({ v2: true });
  try {
    t.mouth!.request("save my ticket");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.ok(t.hub.phone.ticketSaved);
    assert.equal(t.ai.count("exec"), 0, "no point asking the text executor");
    assert.equal(t.ai.count("escalate"), 1);
    assert.ok(t.acts().some((a) => a.do === "tap" && a.on?.x === 540 && a.on?.y === 1260));
    assert.ok(t.hub.phone.reads.images >= 1, "asked Hands for image:true");
  } finally {
    await t.close();
  }
});

test("escalation can re-plan the sub-goal", async () => {
  const t = await setup({ v2: true });
  t.ai.override("exec", (user) => (/Sub-goal: Open Sarah Chen's email/.test(user) ? actReply([action({ do: "wait", ms: 100, expect: { text_present: "never" } })]) : null));
  t.ai.override("escalate", () => ({
    status: "replan",
    say: "",
    note: "",
    actions: [],
    replan: [{ goal: "Open the inbox list", done_when: { app: "gmail", text_present: "", text_absent: "", describe: "Gmail is open" }, risk: "safe" }],
  }));
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.hub.watched.filter((m) => m.type === "plan").length >= 2, 8000), "plan re-published");
    const plans = t.hub.watched.filter((m) => m.type === "plan");
    assert.equal(plans[plans.length - 1].steps[1].do, "Open the inbox list");
  } finally {
    await t.close();
  }
});

test("confirm gate: Send waits for confirm_reply ok AND an affirmative transcript; 'no' cancels", async () => {
  // ok:true but the user's own words say no: not sent.
  let t = await setup({ v2: true, autoConfirm: { ok: true, heard: "uh, no, wait" } });
  try {
    t.mouth!.request("send an email to Hamza saying I'm late");
    assert.ok(await until(() => ended(t).length > 0, 6000));
    assert.equal(ended(t)[0].status, "cancelled");
    assert.equal(t.hub.phone.mails.length, 0, "not sent");
    assert.ok(!t.acts().some((a) => a.do === "tap"), "Send never tapped");
    assert.ok(t.fromMind("progress").some((m) => /won't/.test(m.text)));
  } finally {
    await t.close();
  }
  // The transcript says yes but the voice model said no: not sent.
  t = await setup({ v2: true, autoConfirm: { ok: false, heard: "yes" } });
  try {
    t.mouth!.request("send an email to Hamza saying I'm late");
    assert.ok(await until(() => ended(t).length > 0, 6000));
    assert.equal(t.hub.phone.mails.length, 0);
  } finally {
    await t.close();
  }
  // Manual: nothing is sent while waiting; then yes.
  t = await setup({ v2: true, autoConfirm: null });
  try {
    t.mouth!.request("send an email to Hamza saying I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingConfirm, 4000), "asked");
    await sleep(400);
    assert.equal(t.hub.phone.mails.length, 0, "blocked while waiting");
    assert.ok(!t.acts().some((a) => a.do === "tap"));
    t.mouth!.confirm(true, "yeah go ahead");
    assert.ok(await until(() => t.hub.phone.mails.length === 1, 4000), "sent after yes");
  } finally {
    await t.close();
  }
});

test("confirm policy: MIND_CONFIRM=unknown_contacts skips known contacts", async () => {
  const t = await setup({ v2: true, autoConfirm: null, env: { MIND_CONFIRM: "unknown_contacts" } });
  try {
    t.mouth!.request("send an email to Hamza saying I'm late");
    assert.ok(await until(() => t.hub.phone.mails.length === 1, 4000), "sent without asking");
    assert.equal(t.fromMind("confirm_request").length, 0);
  } finally {
    await t.close();
  }
});

test("barge_in pauses the task at the next step boundary, then it resumes", async () => {
  const t = await setup({ v2: true, latency: { exec: 150 }, timing: { bargeMs: 700 } });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.acts().length >= 1, 4000));
    t.mouth!.bargeIn();
    assert.ok(await until(() => t.fromMind("task_update").some((m) => m.status === "paused"), 2000), "paused");
    const pausedAt = Date.now();
    await sleep(200);
    const n = t.acts().length;
    await sleep(350);
    assert.equal(t.acts().length, n, "no acts while paused");
    assert.ok(await until(() => ended(t).length > 0, 8000), "finished after resuming");
    assert.equal(ended(t)[0].status, "done");
    assert.ok(t.hub.wire.some((w) => w.from === "mind" && w.msg.type === "task_update" && w.msg.status === "running" && w.at > pausedAt), "resumed");
  } finally {
    await t.close();
  }
});

test("amend changes the running task (new reply text)", async () => {
  const t = await setup({ v2: true, latency: { exec: 120 } });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => t.acts().length >= 1, 4000));
    t.mouth!.amend("actually tell her 4 works");
    assert.ok(await until(() => ended(t).length > 0, 10000), "ended");
    assert.equal(t.hub.phone.sent?.text, "4 works for me.");
  } finally {
    await t.close();
  }
});

test("cancel all drops the running task and the queue", async () => {
  const t = await setup({ v2: true, autoConfirm: null });
  try {
    t.mouth!.request("text Alex I'm late, then open Spotify, then call Mom");
    assert.ok(await until(() => !!t.mouth!.pendingConfirm, 4000), "first task waiting on its confirm");
    t.mouth!.cancel("all");
    assert.ok(await until(() => t.fromMind("task_update").filter((m) => m.status === "cancelled").length === 3, 3000), "all three cancelled");
    await sleep(300);
    assert.equal(t.hub.phone.texts.length, 0);
    assert.ok(!t.acts().some((a) => a.do === "launch"), "Spotify never opened");
  } finally {
    await t.close();
  }
});

test("status request -> status_result", async () => {
  const t = await setup({ v2: true, autoConfirm: null });
  try {
    t.mouth!.request("text Alex I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingConfirm, 4000));
    t.mouth!.status("s9");
    assert.ok(await until(() => t.fromMind("status_result").length === 1, 2000));
    const s = t.fromMind("status_result")[0];
    assert.equal(s.re, "s9");
    assert.match(s.text, /Text Alex: waiting for your OK/);
  } finally {
    await t.close();
  }
});

test("old Hands: open is a bad_request -> grounded fallback in Gmail; no hash, no then_screen, no caps", async () => {
  const t = await setup({ v2: true, legacy: true, timing: { actMs: 2000 } });
  try {
    t.mouth!.request("send an email to Hamza saying I'm late");
    assert.ok(await until(() => ended(t).length > 0, 10000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.deepEqual(t.hub.phone.mails.map((m) => [m.to, m.subject, m.body]), [["hamza@example.com", "I'm late", "I'm late"]]);
    assert.ok(t.ai.count("exec") >= 1, "the executor drove the screen");
    assert.ok(await until(() => t.lines.some((l) => /no caps \(older Hands\)/.test(l)), 2500), "caps timed out quietly");
    assert.ok(t.lines.some((l) => /falling back to the screen/.test(l)));
    assert.ok(!t.fromMind("screen").some((m) => m.since), "never sends since without a Hands hash");
  } finally {
    await t.close();
  }
});

test("v2 Hands: an unchanged screen comes back as same:true (no nodes)", async () => {
  const t = await setup({ v2: true });
  try {
    await t.brain.readScreen();
    await t.brain.readScreen();
    assert.ok(t.hub.phone.reads.same >= 1);
    assert.ok(t.fromMind("screen").some((m) => typeof m.since === "string" && m.compact === true));
  } finally {
    await t.close();
  }
});

test("a locked phone fails the task with a clear spoken reason", async () => {
  const t = await setup({ v2: true });
  try {
    t.hub.phone.locked = true;
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => ended(t).length > 0, 6000));
    assert.equal(ended(t)[0].status, "failed");
    assert.ok(t.fromMind("progress").some((m) => /locked/i.test(m.text)));
  } finally {
    await t.close();
  }
});

test("v2 Mouth: heard is not routed (tool calls are the input), no debounce", async () => {
  const t = await setup({ v2: true });
  try {
    const t0 = Date.now();
    t.mouth!.request("open Spotify");
    assert.ok(await until(() => t.acts().length >= 1, 2000));
    assert.ok(Date.now() - t0 < 500, `first act in ${Date.now() - t0} ms`);
    await sleep(200);
    assert.equal(t.tasks().filter((m) => m.status === "started").length, 1, "the duplicate heard did not start a second task");
  } finally {
    await t.close();
  }
});
