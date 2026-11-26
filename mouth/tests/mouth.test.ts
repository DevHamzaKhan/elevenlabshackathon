import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Mouth } from "../src/mouth";
import type { Frame } from "../src/hub";
import type { VoiceCallbacks, VoiceSession } from "../src/voice";

class FakeVoice implements VoiceSession {
  cb!: VoiceCallbacks;
  userMessages: string[] = []; // typed test turns (test_user_turn) only
  spoken: string[] = []; // every line Bobby was told to say, in order
  results: { callId: string; output: string; respond: boolean }[] = [];
  context: string[] = [];
  interrupts = 0;
  ended = 0;
  sendUserMessage(t: string) { this.userMessages.push(t); }
  speak(t: string) { this.spoken.push(t); }
  toolResult(callId: string, output: string, respond: boolean) { this.results.push({ callId, output, respond }); }
  sendContextualUpdate(t: string) { this.context.push(t); }
  interrupt() { this.interrupts++; }
  micMuted: boolean[] = []; // every setMicMuted call, in order
  setMicMuted(m: boolean) { this.micMuted.push(m); }
  async end() { this.ended++; }
}

/** What a fresh session sends first: voice_caps (protocol v2), then wake. */
const WOKE: Frame[] = [{ type: "voice_caps", v: 2, tools: ["request", "amend", "cancel", "confirm", "status", "teach", "answer"] }, { type: "wake" }];

const tick = () => new Promise((r) => setImmediate(r));
const made: Mouth[] = [];
afterEach(async () => {
  for (const m of made.splice(0)) await m.sleep(); // clears the backstop and say timers
});

async function setup(opts: Partial<ConstructorParameters<typeof Mouth>[0]> = {}) {
  const sent: Frame[] = [];
  const v = new FakeVoice();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const m = new Mouth({
    send: (f) => sent.push(f),
    voice: async (cb) => { v.cb = cb; await gate; return v; },
    log: () => {},
    listenSettleMs: 0,
    ...opts,
  });
  made.push(m);
  return { m, v, sent, release, types: () => sent.map((f) => f.type) };
}

async function live(opts = {}) {
  const s = await setup(opts);
  const w = s.m.wake();
  s.release();
  await w;
  return s;
}

test("wake starts one session and sends voice_caps then wake; a second wake does nothing", async () => {
  const s = await setup();
  const w1 = s.m.wake();
  const w2 = s.m.wake();
  assert.deepEqual(s.sent, []); // not live yet
  s.release();
  await Promise.all([w1, w2]);
  assert.deepEqual(s.sent, WOKE);
  assert.equal(s.m.status, "live");
});

test("messages that arrive while the session is starting are held and handled in order", async () => {
  const s = await setup();
  const w = s.m.wake();
  s.m.onHub({ type: "whisper", to: "mouth", text: "3 new notifications" });
  s.m.onHub({ type: "say", to: "mouth", id: "m5", text: "Hello" });
  assert.equal(s.v.spoken.length, 0);
  s.release();
  await w;
  assert.deepEqual(s.v.context, ["3 new notifications"]);
  assert.deepEqual(s.v.spoken, ["Hello"]);
});

test("say: queued in order, say_started when Bobby speaks, say_done when he stops", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  assert.deepEqual(s.v.spoken, ["one"]); // second waits
  s.v.cb.onModeChange("speaking");
  s.v.cb.onAgentResponse("One.");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.spoken, ["one", "two"]);
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.sent.slice(WOKE.length), [
    { type: "say_started", re: "m1" },
    { type: "spoke", text: "One." },
    { type: "say_done", re: "m1" },
    { type: "say_started", re: "m2" },
    { type: "say_done", re: "m2" },
  ]);
  assert.equal(s.m.sayLatencies.length, 2);
});

test("a say waits while Bobby is already speaking", async () => {
  const s = await live();
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "later" });
  assert.deepEqual(s.v.spoken, []);
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.spoken, ["later"]);
});

test("hush stops audio and drops the queue; every say still gets say_done", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "hush", to: "mouth" });
  assert.equal(s.v.interrupts, 1);
  assert.deepEqual(s.sent.slice(WOKE.length), [
    { type: "say_started", re: "m1" },
    { type: "say_done", re: "m1" },
    { type: "say_done", re: "m2", spoken: false },
  ]);
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.spoken, ["one"]); // nothing else sent
});

test("correct is spoken before queued lines and gets no say_started", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  s.m.onHub({ type: "correct", to: "mouth", text: "It's 3, not 2." });
  s.v.cb.onModeChange("listening");
  assert.equal(s.v.spoken[1], "Quick correction: It's 3, not 2.");
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.equal(s.v.spoken[2], "two");
  assert.equal(s.sent.filter((f) => f.type === "say_started").length, 1);
});

test("sleep ends the session, sends asleep, and asleep rules apply", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  s.m.onHub({ type: "sleep", to: "mouth" });
  await tick();
  assert.equal(s.v.ended, 1);
  assert.equal(s.m.status, "asleep");
  assert.deepEqual(s.sent.slice(WOKE.length), [
    { type: "say_done", re: "m1", spoken: false },
    { type: "say_done", re: "m2", spoken: false },
    { type: "asleep" },
  ]);
  const n = s.sent.length;
  s.m.onHub({ type: "whisper", to: "mouth", text: "x" });
  s.m.onHub({ type: "correct", to: "mouth", text: "x" });
  s.m.onHub({ type: "hush", to: "mouth" });
  s.m.onHub({ type: "say", to: "mouth", id: "m3", text: "x" });
  assert.deepEqual(s.sent.slice(n), [{ type: "say_done", re: "m3", spoken: false }]);
  assert.deepEqual(s.v.context, []);
});

test("heard: real user turns only; noise and echoed test turns are not forwarded", async () => {
  const s = await live();
  s.v.cb.onUserTranscript("...");
  s.v.cb.onUserTranscript("reply to Sarah, tell her 3 works");
  s.m.onHub({ type: "test_user_turn", to: "mouth", text: "open Gmail" });
  s.v.cb.onUserTranscript("open Gmail"); // echo of the typed turn
  s.v.cb.onAgentResponse("On it.");
  assert.deepEqual(s.sent.slice(WOKE.length), [
    { type: "heard", text: "reply to Sarah, tell her 3 works" },
    { type: "heard", text: "open Gmail" },
    { type: "spoke", text: "On it." },
  ]);
  assert.deepEqual(s.v.userMessages, ["open Gmail"]);
  assert.deepEqual(s.v.spoken, []);
});

test("the user speaks before a say starts: the say is re-sent after Bobby answers the user", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "Looking for Reply" });
  s.v.cb.onUserTranscript("wait, what are you doing?");
  s.v.cb.onModeChange("speaking"); // Bobby answers the user, not the line
  s.v.cb.onAgentResponse("Just a moment.");
  s.v.cb.onModeChange("listening");
  assert.equal(s.sent.filter((f) => f.type === "say_started").length, 0, "the answer was not the say");
  assert.deepEqual(s.v.spoken, ["Looking for Reply", "Looking for Reply"]);
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.sent.filter((f) => f.type.startsWith("say_")), [
    { type: "say_started", re: "m1" },
    { type: "say_done", re: "m1" },
  ]);
});

test("a short pause inside Bobby's turn doesn't end the say", async () => {
  const s = await live({ listenSettleMs: 30 });
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening"); // pause between phrases
  await new Promise((r) => setTimeout(r, 10));
  s.v.cb.onModeChange("speaking");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.sent.filter((f) => f.type === "say_done").length, 0);
  s.v.cb.onModeChange("listening");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(s.sent.at(-1), { type: "say_done", re: "m1" });
});

test("a say that never starts is finished with spoken:false and the queue moves on", async () => {
  const s = await live({ sayStartTimeoutMs: 20 });
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(s.sent[WOKE.length], { type: "say_done", re: "m1", spoken: false });
  assert.equal(s.v.spoken[1], "two");
  await s.m.sleep();
});

test("the session ending on its own sends asleep", async () => {
  const s = await live();
  s.v.cb.onDisconnect("agent");
  await tick();
  assert.equal(s.m.status, "asleep");
  assert.deepEqual(s.sent.at(-1), { type: "asleep" });
});

test("5 minute backstop: nothing heard and nothing from the hub ends the session", async () => {
  const s = await live({ backstopMs: 30 });
  await new Promise((r) => setTimeout(r, 15));
  s.m.onHub({ type: "whisper", to: "mouth", text: "keeps it alive" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.m.status, "live");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.m.status, "asleep");
  assert.deepEqual(s.sent.at(-1), { type: "asleep" });
});

test("unknown types are ignored", async () => {
  const s = await live();
  s.m.onHub({ type: "something_new", to: "mouth", x: 1 });
  s.m.onHub({ type: "say", to: "mouth" }); // no id
  assert.deepEqual(s.sent, WOKE);
  await s.m.sleep();
});

test("sleep while the session is still starting ends it once it connects", async () => {
  const s = await setup();
  const w = s.m.wake();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "held" });
  await s.m.sleep(); // sleep is a hub message, but held messages include it; call directly here
  s.release();
  await w;
  assert.equal(s.v.ended, 1);
  assert.equal(s.m.status, "asleep");
  assert.deepEqual(s.sent, [{ type: "say_done", re: "m1", spoken: false }]);
});

// ---------- no stale narration ----------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sayFrames = (sent: Frame[]) => sent.filter((f) => f.type === "say_started" || f.type === "say_done");

test("a new say drops the queued ones (spoken:false) and only the newest waits; the queue never grows", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" }); // idle: sent to the agent at once
  assert.deepEqual(s.v.spoken, ["one"]);
  s.v.cb.onModeChange("speaking");
  for (const id of ["m2", "m3", "m4", "m5"]) s.m.onHub({ type: "say", to: "mouth", id, text: id });
  assert.deepEqual(sayFrames(s.sent), [
    { type: "say_started", re: "m1" },
    { type: "say_done", re: "m2", spoken: false },
    { type: "say_done", re: "m3", spoken: false },
    { type: "say_done", re: "m4", spoken: false },
  ]);
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.spoken, ["one", "m5"]); // only the newest is spoken
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(sayFrames(s.sent).slice(4), [
    { type: "say_done", re: "m1" },
    { type: "say_started", re: "m5" },
    { type: "say_done", re: "m5" },
  ]);
});

test("a queued say that hasn't started within sayStaleMs of arriving is dropped", async () => {
  const s = await live({ sayStaleMs: 30 });
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.v.cb.onModeChange("speaking"); // Bobby keeps talking for a long time
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  await wait(50);
  assert.deepEqual(sayFrames(s.sent), [
    { type: "say_started", re: "m1" },
    { type: "say_done", re: "m2", spoken: false },
  ]);
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.spoken, ["one"], "the stale line is never sent to the agent");
});

test("a say sent to the agent that doesn't start within sayStaleMs of arriving gets spoken:false", async () => {
  const s = await live({ sayStaleMs: 30 }); // sayStartTimeoutMs stays at its 8 s default
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  await wait(50);
  assert.deepEqual(sayFrames(s.sent), [{ type: "say_done", re: "m1", spoken: false }]);
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" }); // the next one goes straight out
  assert.equal(s.v.spoken.at(-1), "two");
});

test("a say that arrives when idle goes to the agent at once and starts when Bobby speaks", async () => {
  let t = 1000;
  const s = await live({ now: () => t });
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "Finding Gmail." });
  assert.deepEqual(s.v.spoken, ["Finding Gmail."]);
  t += 300;
  s.v.cb.onModeChange("speaking");
  assert.deepEqual(s.m.sayLatencies, [300]);
});

// ---------- push-to-talk ----------

test("push-to-talk: wake opens the mic; after the command and 1.8 s of silence it closes; no heard until the next wake", async () => {
  const logs: string[] = [];
  const s = await live({ micCloseMs: 40, log: (l: string) => logs.push(l) });
  assert.deepEqual(s.v.micMuted, [false]);
  assert.ok(logs.includes("listening"));
  s.v.cb.onUserTranscript("reply to Sarah");
  await wait(20);
  s.v.cb.onUserTranscript("tell her 3 works"); // still inside the window: its own heard, and the wait restarts
  await wait(30);
  assert.deepEqual(s.v.micMuted, [false], "the second transcript restarted the wait");
  await wait(30);
  assert.deepEqual(s.v.micMuted, [false, true]);
  assert.ok(logs.includes("mic closed"));
  s.v.cb.onUserTranscript("room chatter"); // mic closed: never heard
  assert.deepEqual(s.sent.filter((f) => f.type === "heard"), [
    { type: "heard", text: "reply to Sarah" },
    { type: "heard", text: "tell her 3 works" },
  ]);
  // Bobby still speaks while the mic is closed.
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "Opening Gmail." });
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(sayFrames(s.sent), [{ type: "say_started", re: "m1" }, { type: "say_done", re: "m1" }]);
});

test("push-to-talk: wake while live reopens the mic for one more command and sends wake again (the Mind opens a window per press)", async () => {
  const s = await live({ micCloseMs: 20 });
  s.v.cb.onUserTranscript("open Gmail");
  await wait(40);
  assert.deepEqual(s.v.micMuted, [false, true]);
  await s.m.wake();
  assert.deepEqual(s.v.micMuted, [false, true, false]);
  assert.equal(s.m.status, "live");
  s.v.cb.onUserTranscript("actually, cancel that");
  await wait(40);
  assert.deepEqual(s.v.micMuted, [false, true, false, true]);
  assert.deepEqual(s.sent.filter((f) => f.type === "wake" || f.type === "heard"), [
    { type: "wake" },
    { type: "heard", text: "open Gmail" },
    { type: "wake" },
    { type: "heard", text: "actually, cancel that" },
  ]);
});

test("push-to-talk: the mic stays open until the user speaks, and sleep resets it", async () => {
  const s = await live({ micCloseMs: 20 });
  await wait(40);
  assert.deepEqual(s.v.micMuted, [false], "no speech yet: still listening");
  await s.m.sleep();
  s.v.cb.onUserTranscript("late transcript");
  assert.equal(s.sent.filter((f) => f.type === "heard").length, 0);
});
