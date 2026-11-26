// Questions back to the user: how an answer is read (pure), then end to end against the fakes
// from each place a question can start: code (two contacts share a name), the router, and the
// executor looking at the screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanQuestion, resolveAnswer, spokenQuestion } from "../src/ask";
import { sharedFirstName } from "../src/contacts";
import { InMemoryStore } from "../src/memory";
import { askReply, replyToSarahTask, routeAsk } from "../fakes/openai";
import { answerConfirmV1, setup, sleep, until } from "./helpers";

const ended = (t: Awaited<ReturnType<typeof setup>>) => t.tasks().filter((m) => m.status !== "started");
const SAMS = "Sam Lee=+14155550144,Sam Park=+14155550155,Alex=+14155550123";

// ---------- reading an answer ----------

const Q = { question: "Which Alex?", options: ["Alex Chen", "Alex Kim", "Alex Wu"] };
const picked = (heard: string, option = 0, q = Q) => {
  const a = resolveAnswer(q, { heard, option, text: heard });
  return a.kind === "option" ? a.index : a.kind;
};

test("spoken form: options are numbered; a tidy question keeps at most four distinct options", () => {
  assert.equal(spokenQuestion(Q), "Which Alex? Option one: Alex Chen. Option two: Alex Kim. Option three: Alex Wu.");
  assert.equal(spokenQuestion({ question: "What should the subject be?", options: [] }), "What should the subject be?");
  const q = cleanQuestion({ question: " Which   account ", options: ["Work.", "work", "", "Personal", "School", "Old", "Extra"] })!;
  assert.deepEqual(q, { question: "Which account?", options: ["Work", "Personal", "School", "Old"] });
  assert.equal(cleanQuestion({ question: "  ", options: ["a"] }), null);
});

test("an option by its label, by a word only it has, or by its number", () => {
  assert.equal(picked("Alex Kim"), 1);
  assert.equal(picked("uh, Kim I think"), 1);
  assert.equal(picked("yeah the second one works"), 1);
  assert.equal(picked("option three"), 2);
  assert.equal(picked("Yeah, C works"), 2);
  assert.equal(picked("two"), 1);
  assert.equal(picked("go with one"), 0);
  assert.equal(picked("the last one"), 2);
  assert.equal(picked("not the first one, the second"), 1);
  assert.equal(picked("the work one", 0, { question: "Which account?", options: ["Work Gmail", "Personal Gmail"] }), 0);
});

test("'you pick' takes the first option; 'never mind' cancels; anything else is passed on as said", () => {
  assert.equal(picked("whatever, you pick"), 0);
  assert.equal(picked("yeah sure"), 0);
  assert.equal(picked("never mind"), "cancel");
  assert.equal(picked("neither"), "cancel");
  assert.equal(picked("no"), "cancel");
  const free = resolveAnswer(Q, { heard: "oh you know what, just email the whole team instead", option: 0 });
  assert.deepEqual(free, { kind: "free", text: "oh you know what, just email the whole team instead" });
  assert.deepEqual(resolveAnswer(Q, {}), { kind: "none" });
});

test("the voice model's pick stands in when the words name no option, and breaks ties", () => {
  const times = { question: "Which time?", options: ["3 pm", "5 pm"] };
  assert.equal(picked("the later one", 2, times), 1);
  assert.equal(picked("the later one", 0, times), "free");
  assert.equal(picked("Chen or Kim, hmm, Kim", 2), 1);
  // No transcript yet (it can arrive after the tool call): the voice model's reading is used.
  assert.deepEqual(resolveAnswer(Q, { heard: "", text: "the second one", option: 0 }), { kind: "option", index: 1, label: "Alex Kim" });
  // The user's own words beat the voice model's number.
  assert.equal(picked("the first one", 3), 0);
});

test("an open question (no options) always passes the words on", () => {
  const open = { question: "What should the subject be?", options: [] };
  assert.deepEqual(resolveAnswer(open, { heard: "lunch on Friday" }), { kind: "free", text: "lunch on Friday" });
  assert.deepEqual(resolveAnswer(open, { heard: "forget it" }), { kind: "cancel" });
});

test("a shared first name is only a question when nothing settles it", () => {
  const book = [{ name: "Sam Lee" }, { name: "Sam Park" }, { name: "Alex" }, { name: "Alex Kim" }];
  assert.deepEqual(sharedFirstName(book, "text Sam I'm late"), { first: "Sam", names: ["Sam Lee", "Sam Park"] });
  assert.equal(sharedFirstName(book, "text Sam Park I'm late"), null);
  assert.equal(sharedFirstName(book, "text Alex I'm late"), null, "a contact called just Alex is the match");
  assert.equal(sharedFirstName(book, "open Spotify"), null);
});

// ---------- end to end ----------

test("two contacts share a name: one question with options, answered by label, no model call", async () => {
  const t = await setup({ v2: true, contacts: SAMS });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000), "asked");
    const ask = t.fromMind("ask_request")[0];
    assert.equal(ask.question, "Which Sam?");
    assert.deepEqual(ask.options, ["Sam Lee", "Sam Park"]);
    assert.equal(ask.say, "Which Sam? Option one: Sam Lee. Option two: Sam Park.");
    await sleep(200);
    assert.equal(t.acts().length, 0, "nothing happens on the phone while the question is out");
    t.mouth!.answer("uh, Park");
    assert.ok(await until(() => ended(t).length > 0, 6000), "task ended");
    assert.deepEqual(t.hub.phone.texts.map((x) => [x.to, x.body]), [["+14155550155", "I'm late"]]);
    assert.equal(t.ai.calls.length, 0, "no model call at all");
    assert.equal(t.fromMind("ask_request").length, 1, "one question");
  } finally {
    await t.close();
  }
});

test("an answered question is remembered: the same request later isn't asked again (and survives a restart)", async () => {
  const storage = new InMemoryStore();
  let t = await setup({ v2: true, contacts: SAMS, storage, autoAnswer: { heard: "the second one" } });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000), "first text sent");
    assert.equal(t.fromMind("ask_request").length, 1);
    await t.brain.memory.flush();
  } finally {
    await t.close();
  }
  t = await setup({ v2: true, contacts: SAMS, storage, autoAnswer: null });
  try {
    t.mouth!.request("text Sam running behind");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000), "second text sent");
    assert.equal(t.hub.phone.texts[0].to, "+14155550155");
    assert.equal(t.fromMind("ask_request").length, 0, "not asked again");
    assert.ok(t.fromMind("progress").some((m) => /Going with Sam Park, like last time/.test(m.text)), "says which one it went with");
  } finally {
    await t.close();
  }
});

test("a free answer to a code question goes to the router with the question; only a shortcut's name is asked about", async () => {
  const t = await setup({ v2: true, contacts: SAMS });
  let seen = "";
  t.ai.override("route", (user) => {
    if (!/Bobby then asked: "Which Sam\?"/.test(user)) return null;
    seen = user;
    return { question: "", options: [], whisper: "", cancel_scope: "", route: "tasks", say: "", tasks: [{ title: "Open Spotify", goal: "Open the Spotify app", done_say: "Spotify's open.", shortcut_id: "app.open", slots: [{ name: "app", value: "Spotify" }], app: "", subgoals: [] }] };
  });
  try {
    // Mentioning Sam in something no shortcut handles is not a reason to ask.
    t.mouth!.request("what did Sam say");
    assert.ok(await until(() => t.ai.count("route") === 1, 3000));
    assert.equal(t.fromMind("ask_request").length, 0);
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    t.mouth!.answer("oh you know what, just open Spotify instead");
    assert.ok(await until(() => ended(t).length > 0, 6000), "the router's task ran");
    assert.match(seen, /\(options: Sam Lee; Sam Park\)\. The user answered: "oh you know what, just open Spotify instead"/);
    assert.equal(t.hub.phone.texts.length, 0, "no text to either Sam");
    assert.ok(t.acts().some((a) => a.do === "launch" && a.app === "Spotify"));
  } finally {
    await t.close();
  }
});

test("nobody answers: the first option stands, and the confirmation still guards the send", async () => {
  const t = await setup({ v2: true, contacts: SAMS, autoConfirm: null, timing: { askMs: 250 } });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingConfirm, 4000), "went on to the confirmation");
    assert.match(t.mouth!.pendingConfirm.summary, /Sam Lee/);
    assert.ok(t.fromMind("progress").some((m) => /Going with Sam Lee/.test(m.text)));
    assert.equal(t.hub.phone.texts.length, 0, "not sent without a yes");
  } finally {
    await t.close();
  }
});

test("'never mind' to a question drops the request; so does cancel", async () => {
  let t = await setup({ v2: true, contacts: SAMS });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    t.mouth!.answer("never mind");
    assert.ok(await until(() => t.fromMind("progress").some((m) => /never mind/i.test(m.text)), 2000));
    await sleep(200);
    assert.equal(t.acts().length, 0);
    assert.equal(t.tasks().length, 0, "no task was ever started");
  } finally {
    await t.close();
  }
  t = await setup({ v2: true, contacts: SAMS });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    t.mouth!.cancel("all");
    await sleep(300);
    assert.equal(t.acts().length, 0);
    assert.equal(t.brain.queue.length, 0);
  } finally {
    await t.close();
  }
});

test("router question: asked once, the answer goes back to the router, which then plans", async () => {
  const t = await setup({ v2: true });
  t.ai.override("route", (user) => {
    if (!/The user just said: "reply to that email"/.test(user)) return null;
    if (!/Bobby then asked/.test(user)) return routeAsk("Which email", ["Sarah's about the meeting", "The Acme newsletter", "Sarah's about the meeting"]);
    assert.match(user, /The user answered: "Sarah's about the meeting"\. You can't ask again/);
    return { question: "", options: [], whisper: "", cancel_scope: "", route: "tasks", say: "On it.", tasks: [replyToSarahTask("3")] };
  });
  try {
    t.mouth!.request("reply to that email");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000), "asked");
    assert.deepEqual(t.fromMind("ask_request")[0].options, ["Sarah's about the meeting", "The Acme newsletter"], "duplicate option dropped");
    t.mouth!.answer("the first one");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
    assert.equal(t.ai.count("route"), 2, "one call to ask, one to plan");
    assert.equal(t.fromMind("ask_request").length, 1);
  } finally {
    await t.close();
  }
});

test("router question, free answer: the user's own words reach the router; a second question is refused", async () => {
  const t = await setup({ v2: true });
  const seen: string[] = [];
  t.ai.override("route", (user) => {
    if (!/The user just said: "reply to that email"/.test(user)) return null;
    seen.push(user);
    return routeAsk("Which email?", ["Sarah's", "The newsletter"]);
  });
  try {
    t.mouth!.request("reply to that email");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    t.mouth!.answer("oh you know what, just open Spotify instead");
    assert.ok(await until(() => seen.length === 2, 3000), "router called again");
    assert.match(seen[1], /The user answered: "oh you know what, just open Spotify instead"/);
    assert.ok(await until(() => t.fromMind("progress").some((m) => /not sure what you mean/.test(m.text)), 2000), "said so instead of asking twice");
    assert.equal(t.fromMind("ask_request").length, 1);
  } finally {
    await t.close();
  }
});

test("executor question from the screen: a picked option is a note for the next step, with no extra model call", async () => {
  const t = await setup({ v2: true });
  let askedOnce = false;
  t.ai.override("exec", (user) => {
    if (!/Sub-goal: Open Sarah Chen's email/.test(user) || askedOnce) return null;
    askedOnce = true;
    return askReply("Which email from Sarah?", ["Meeting today", "Lunch on Friday"]);
  });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 4000), "asked");
    assert.ok(t.fromMind("task_update").some((m) => m.status === "waiting_answer" && /Which email from Sarah/.test(m.text)));
    const actsBefore = t.acts().length;
    await sleep(200);
    assert.equal(t.acts().length, actsBefore, "no acts while waiting");
    t.mouth!.answer("the meeting one");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
    const next = t.ai.calls.filter((c) => c.role === "exec")[1];
    assert.match(next.user, /Asked the user "Which email from Sarah\?"; they chose "Meeting today"\./, "the next exec call sees the answer");
    assert.equal(t.ai.count("route"), 1, "the answer cost no router call");
    assert.equal(t.fromMind("ask_request").length, 1);
  } finally {
    await t.close();
  }
});

test("executor question, free answer ('oh, you know what...'): the router re-plans the running task", async () => {
  const t = await setup({ v2: true });
  let askedOnce = false;
  t.ai.override("exec", (user) => {
    if (!/Sub-goal: Open Sarah Chen's email/.test(user) || askedOnce) return null;
    askedOnce = true;
    return askReply("Which email from Sarah?", ["Meeting today", "Lunch on Friday"]);
  });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 4000), "asked");
    t.mouth!.answer("oh you know what, tell her 4 works");
    assert.ok(await until(() => ended(t).length > 0, 10000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.equal(t.hub.phone.sent?.text, "4 works for me.");
    const amend = t.ai.calls.filter((c) => c.role === "route")[1];
    assert.match(amend.user, /Change the running task: oh you know what, tell her 4 works/);
    assert.match(amend.user, /Bobby then asked: "Which email from Sarah\?"/);
  } finally {
    await t.close();
  }
});

test("at most one question per task: the executor is told so, and a second one falls back to its first option", async () => {
  const t = await setup({ v2: true, autoAnswer: { heard: "option one" } });
  let asks = 0;
  t.ai.override("exec", (user) => {
    if (!/Sub-goal: Open Sarah Chen's email/.test(user) || asks >= 2) return null;
    asks += 1;
    return askReply(asks === 1 ? "Which email from Sarah?" : "Reply to all?", asks === 1 ? ["Meeting today", "Lunch"] : ["Just Sarah", "Everyone"]);
  });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => ended(t).length > 0, 8000), "ended");
    assert.equal(ended(t)[0].status, "done");
    assert.equal(t.fromMind("ask_request").length, 1, "only the first question reached the user");
    const execs = t.ai.calls.filter((c) => c.role === "exec");
    assert.match(execs[1].user, /You can't ask the user anything now/);
    assert.match(execs[2].user, /Couldn't ask the user "Reply to all\?"; going with "Just Sarah"/);
  } finally {
    await t.close();
  }
});

test("MIND_ASK_MAX=0 turns questions off: the first match is used, as before", async () => {
  const t = await setup({ v2: true, contacts: SAMS, env: { MIND_ASK_MAX: "0" } });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000));
    assert.equal(t.fromMind("ask_request").length, 0);
  } finally {
    await t.close();
  }
});

test("'stop' while a task waits on a question cancels the task", async () => {
  const t = await setup({ v2: true });
  t.ai.override("exec", (user) => (/Sub-goal: Open Sarah Chen's email/.test(user) ? askReply("Which email from Sarah?", ["Meeting today", "Lunch"]) : null));
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 4000));
    t.mouth!.cancel("current");
    assert.ok(await until(() => ended(t).length > 0, 3000));
    assert.equal(ended(t)[0].status, "cancelled");
    assert.equal(t.hub.phone.sent, null);
  } finally {
    await t.close();
  }
});

test("the answer arriving as a request (voice model used the wrong tool) still answers the question", async () => {
  const t = await setup({ v2: true, contacts: SAMS });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    t.mouth!.request("Sam Park", "sam park");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000));
    assert.equal(t.hub.phone.texts[0].to, "+14155550155");
    assert.equal(t.tasks().filter((m) => m.status === "started").length, 1, "not taken as a second request");
  } finally {
    await t.close();
  }
});

test("the voice model never calls answer: the transcript alone answers after a short grace", async () => {
  const t = await setup({ v2: true, contacts: SAMS, timing: { askGraceMs: 120 } });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    t.mouth!.hearMore("uh");
    t.mouth!.hearMore("Park");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000));
    assert.equal(t.hub.phone.texts[0].to, "+14155550155");
    assert.equal(t.toMind("ask_reply").length, 0);
  } finally {
    await t.close();
  }
});

test("a v2 Mouth without the answer tool hears the question as a line and answers with a request", async () => {
  const t = await setup({ v2: true, contacts: SAMS, noAnswerTool: true });
  try {
    t.mouth!.wake(); // voice_caps goes out before every wake; the first can be lost if the Mouth connected first
    await sleep(50);
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => t.fromMind("progress").some((m) => /Which Sam\? Option one: Sam Lee/.test(m.text)), 3000), "question spoken as progress");
    assert.equal(t.fromMind("ask_request").length, 0);
    t.mouth!.request("the second one");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000));
    assert.equal(t.hub.phone.texts[0].to, "+14155550155");
  } finally {
    await t.close();
  }
});

test("v1 Mouth: the question is a say, and the next press is the answer", async () => {
  const t = await setup({ contacts: SAMS });
  try {
    t.mouth!.hear("text Sam I'm late");
    assert.ok(await until(() => t.fromMind("say").some((m) => /Which Sam\? Option one: Sam Lee\. Option two: Sam Park\./.test(m.text)), 4000), "asked aloud");
    await sleep(30);
    t.mouth!.hear("yeah, two works");
    assert.ok(await answerConfirmV1(t, "yes, send it"), "then the usual confirmation");
    assert.ok(await until(() => t.hub.phone.texts.length === 1, 6000));
    assert.equal(t.hub.phone.texts[0].to, "+14155550155");
  } finally {
    await t.close();
  }
});

test("no sleep while a question is out", async () => {
  const t = await setup({ v2: true, contacts: SAMS, sleepMs: 200, timing: { askMs: 1500 } });
  try {
    t.mouth!.request("text Sam I'm late");
    assert.ok(await until(() => !!t.mouth!.pendingAsk, 3000));
    await sleep(900);
    assert.equal(t.fromMind("sleep").length, 0);
  } finally {
    await t.close();
  }
});
