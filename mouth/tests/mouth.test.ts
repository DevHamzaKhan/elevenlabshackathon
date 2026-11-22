import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Mouth } from "../src/mouth";
import type { Frame } from "../src/hub";
import type { VoiceCallbacks, VoiceSession } from "../src/voice";

class FakeVoice implements VoiceSession {
  cb!: VoiceCallbacks;
  userMessages: string[] = [];
  context: string[] = [];
  interrupts = 0;
  ended = 0;
  sendUserMessage(t: string) { this.userMessages.push(t); }
  sendContextualUpdate(t: string) { this.context.push(t); }
  interrupt() { this.interrupts++; }
  async end() { this.ended++; }
}

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

test("wake starts one session and sends wake; a second wake does nothing", async () => {
  const s = await setup();
  const w1 = s.m.wake();
  const w2 = s.m.wake();
  assert.deepEqual(s.sent, []); // not live yet
  s.release();
  await Promise.all([w1, w2]);
  assert.deepEqual(s.sent, [{ type: "wake" }]);
  assert.equal(s.m.status, "live");
});

test("messages that arrive while the session is starting are held and handled in order", async () => {
  const s = await setup();
  const w = s.m.wake();
  s.m.onHub({ type: "whisper", to: "mouth", text: "3 new notifications" });
  s.m.onHub({ type: "say", to: "mouth", id: "m5", text: "Hello" });
  assert.equal(s.v.userMessages.length, 0);
  s.release();
  await w;
  assert.deepEqual(s.v.context, ["3 new notifications"]);
  assert.deepEqual(s.v.userMessages, ["[SAY] Hello"]);
});

test("say: queued in order, say_started when Bobby speaks, say_done when he stops", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  assert.deepEqual(s.v.userMessages, ["[SAY] one"]); // second waits
  s.v.cb.onModeChange("speaking");
  s.v.cb.onAgentResponse("One.");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.userMessages, ["[SAY] one", "[SAY] two"]);
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.sent.slice(1), [
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
  assert.deepEqual(s.v.userMessages, []);
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.userMessages, ["[SAY] later"]);
});

test("hush stops audio and drops the queue; every say still gets say_done", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "hush", to: "mouth" });
  assert.equal(s.v.interrupts, 1);
  assert.deepEqual(s.sent.slice(1), [
    { type: "say_started", re: "m1" },
    { type: "say_done", re: "m1" },
    { type: "say_done", re: "m2", spoken: false },
  ]);
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.userMessages, ["[SAY] one"]); // nothing else sent
});

test("correct is spoken before queued lines and gets no say_started", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  s.m.onHub({ type: "correct", to: "mouth", text: "It's 3, not 2." });
  s.v.cb.onModeChange("listening");
  assert.equal(s.v.userMessages[1], "[CORRECT] It's 3, not 2.");
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.equal(s.v.userMessages[2], "[SAY] two");
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
  assert.deepEqual(s.sent.slice(1), [
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

test("heard: real user turns only; our own tagged lines and echoed test turns are not forwarded twice", async () => {
  const s = await live();
  s.v.cb.onUserTranscript("[SAY] one");
  s.v.cb.onUserTranscript("[CORRECT] two");
  s.v.cb.onUserTranscript("reply to Sarah, tell her 3 works");
  s.m.onHub({ type: "test_user_turn", to: "mouth", text: "open Gmail" });
  s.v.cb.onUserTranscript("open Gmail"); // echo of the typed turn
  s.v.cb.onAgentResponse("On it.");
  assert.deepEqual(s.sent.slice(1), [
    { type: "heard", text: "reply to Sarah, tell her 3 works" },
    { type: "heard", text: "open Gmail" },
    { type: "spoke", text: "On it." },
  ]);
  assert.deepEqual(s.v.userMessages, ["open Gmail"]);
});

test("a say that never starts is finished with spoken:false and the queue moves on", async () => {
  const s = await live({ sayStartTimeoutMs: 20 });
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "one" });
  s.m.onHub({ type: "say", to: "mouth", id: "m2", text: "two" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(s.sent[1], { type: "say_done", re: "m1", spoken: false });
  assert.equal(s.v.userMessages[1], "[SAY] two");
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
  assert.deepEqual(s.sent, [{ type: "wake" }]);
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
