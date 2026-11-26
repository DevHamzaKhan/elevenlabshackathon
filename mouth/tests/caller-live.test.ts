// The OpenAI caller (GPT-Live over SIP) with fetch and the sideband socket stubbed. No call is placed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCall, liveSessionBody, failureOf, addDelta, disclosure, type SocketLike } from "../src/caller-live";
import { callerChoice } from "../src/vendors";
import type { Frame } from "../src/hub";
import type { Line } from "../src/caller";

const ENV = {
  OPENAI_API_KEY: "sk-test",
  CALLER_SIP_URL: "sips:bobby.pstn.twilio.com:5061",
  CALLER_SIP_USERNAME: "bobby",
  CALLER_SIP_PASSWORD: "pw",
  OWNER_NUMBER: "+14155550100",
  CALL_ALLOWLIST: "+14155550123",
  CALLER_OWNER_NAME: "James",
};
const CALL = { type: "call", id: "m9", number: "+14155550123", goal: "Say I'm running late and ask if 3pm works.", context: "Alex is a friend." };

class FakeSock implements SocketLike {
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  sent: any[] = [];
  closed = false;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  emit(e: object) { this.onmessage?.({ data: JSON.stringify(e) }); }
}

function harness(script: (s: FakeSock, h: { hungUp: () => boolean }) => Promise<void>, opts: { cancelled?: () => boolean; env?: Record<string, string> } = {}) {
  const frames: Frame[] = [];
  const requests: { url: string; init: any }[] = [];
  const sock = new FakeSock();
  let hungUp = false;
  let attachUrl = "";
  let attachHeaders: any = null;
  const f = async (url: string, init: any = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/live/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ session: { id: "live_123" }, transport: { type: "sip" } }) };
    if (url.endsWith("/hangup")) {
      hungUp = true;
      setTimeout(() => sock.emit({ type: "session.closed", event_id: "e_close", reason: "hangup" }), 5);
      return { ok: true, status: 200, text: async () => "" };
    }
    if (url.endsWith("/responses")) return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Alex said 3pm still works. He'll wait for you." }] }] }) };
    return { ok: false, status: 404, text: async () => "?" };
  };
  const run = liveCall(CALL, {
    env: { ...ENV, ...(opts.env ?? {}) },
    send: (fr) => frames.push(fr),
    log: () => {},
    fetch: f,
    connect: (url, headers) => {
      attachUrl = url;
      attachHeaders = headers;
      setTimeout(() => void script(sock, { hungUp: () => hungUp }), 5);
      return sock;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    goodbyeMs: 20,
    maxCallMs: 3000,
    cancelled: opts.cancelled,
  });
  return { run, frames, requests, sock, get attach() { return { url: attachUrl, headers: attachHeaders }; } };
}

test("session body: SIP transport with the trunk, owner caller id, client delegation, stock voice", () => {
  const b = liveSessionBody(CALL, ENV);
  assert.equal(b.session.model, "gpt-live-1.1");
  assert.equal(b.session.audio.output.voice, "marin");
  assert.deepEqual(b.session.delegation, { type: "client" });
  assert.match(b.session.instructions, /Say I'm running late/);
  assert.match(b.session.instructions, /never pretend to be a person/);
  assert.deepEqual(b.transport, {
    type: "sip",
    destination: "+14155550123",
    trunk: { provider_url: "sips:bobby.pstn.twilio.com:5061", auth: { type: "digest", username: "bobby", password: "pw" }, caller_number: "+14155550100" },
  });
  assert.equal(liveSessionBody(CALL, { ...ENV, CALLER_MODEL: "gpt-live-2", CALLER_VOICE: "cedar" }).session.audio.output.voice, "cedar");
});

test("a full call: dialing -> answered (disclosure) -> transcript -> model ends it -> hang up -> summary", async () => {
  const h = harness(async (s) => {
    s.emit({ type: "transport.ringing", event_id: "e1" });
    s.emit({ type: "transport.ringing", event_id: "e1" }); // replayed on attach: ignored
    s.emit({ type: "transport.answered", event_id: "e2" });
    s.emit({ type: "session.output_transcript.delta", event_id: "e3", delta: "Hi, this is Bobby, an AI assistant" });
    s.emit({ type: "session.output_transcript.delta", event_id: "e4", delta: " calling for James." });
    s.emit({ type: "session.input_transcript.delta", event_id: "e5", delta: "Oh hi! Yes, 3pm" });
    s.emit({ type: "session.input_transcript.delta", event_id: "e6", delta: " still works." });
    s.emit({ type: "session.delegation.created", event_id: "e7", delegation: { id: "item_1", type: "delegation", target: "client" } });
  });
  await h.run;
  assert.deepEqual(h.frames.filter((f) => f.type === "call_status").map((f) => f.status), ["dialing", "answered", "ended"]);
  const result = h.frames.filter((f) => f.type === "call_result");
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(result[0].summary, "Alex said 3pm still works. He'll wait for you.");
  assert.deepEqual(result[0].transcript, [
    { who: "me", text: "Hi, this is Bobby, an AI assistant calling for James." },
    { who: "them", text: "Oh hi! Yes, 3pm still works." },
  ]);
  assert.equal(h.attach.url, "wss://api.openai.com/v1/live/sessions/live_123/attach");
  assert.equal(h.attach.headers.Authorization, "Bearer sk-test");
  const disclose = h.sock.sent.find((e) => e.type === "session.instructions.append");
  assert.ok(disclose, "disclosure sent on answer");
  assert.match(disclose.content, /Hi, this is Bobby, an AI assistant calling on behalf of James\./);
  assert.equal(disclose.delegation_id, null);
  assert.ok(h.requests.some((r) => r.url === "https://api.openai.com/v1/live/sessions/live_123/hangup" && r.init.method === "POST"), "hung up via the API");
  const create = JSON.parse(h.requests[0].init.body);
  assert.equal(create.transport.type, "sip");
});

test("hangup from the Mind ends the call (cancelled flag) and still sends one call_result", async () => {
  let cancel = false;
  const h = harness(
    async (s) => {
      s.emit({ type: "transport.answered", event_id: "a" });
      await new Promise((r) => setTimeout(r, 30));
      cancel = true;
    },
    { cancelled: () => cancel },
  );
  await h.run;
  assert.ok(h.requests.some((r) => r.url.endsWith("/hangup")));
  const results = h.frames.filter((f) => f.type === "call_result");
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].ok, results[0].error], [false, "cancelled"]);
});

test("transport.failed (busy), never answered, not allowed, not configured", async () => {
  let h = harness(async (s) => s.emit({ type: "transport.failed", event_id: "f", error: { code: "busy_here", message: "486 Busy" } }));
  await h.run;
  assert.deepEqual(h.frames.filter((f) => f.type === "call_result").map((f) => f.error), ["busy"]);
  assert.equal(h.frames.filter((f) => f.type === "call_status").pop()!.status, "failed");

  h = harness(async (s) => s.emit({ type: "session.closed", event_id: "c" }));
  await h.run;
  assert.equal(h.frames.find((f) => f.type === "call_result")!.error, "no_answer");

  const frames: Frame[] = [];
  await liveCall({ ...CALL, number: "+19995550000" }, { env: ENV, send: (f) => frames.push(f), log: () => {} });
  assert.deepEqual(frames, [{ type: "call_result", re: "m9", ok: false, error: "not_allowed" }]);
  frames.length = 0;
  await liveCall(CALL, { env: { ...ENV, CALLER_SIP_URL: "" }, send: (f) => frames.push(f), log: () => {} });
  assert.deepEqual(frames, [{ type: "call_result", re: "m9", ok: false, error: "not_configured" }]);
});

test("helpers: failure mapping, transcript merging, disclosure, vendor choice", () => {
  assert.equal(failureOf({ code: "no_answer" }), "no_answer");
  assert.equal(failureOf({ message: "486 Busy Here" }), "busy");
  assert.equal(failureOf({ message: "weird" }), "failed");
  const lines: Line[] = [];
  addDelta(lines, "me", "Hi");
  addDelta(lines, "me", " there");
  addDelta(lines, "them", " Hello");
  assert.deepEqual(lines, [{ who: "me", text: "Hi there" }, { who: "them", text: "Hello" }]);
  assert.match(disclosure({}), /AI assistant/);
  assert.equal(callerChoice({}), "openai");
  assert.equal(callerChoice({ CALLER_VENDOR: "ElevenLabs" }), "elevenlabs");
});

test("after a hangup, a session.closed that never comes stops the wait 10 s later, not at the call deadline", async () => {
  let t = 0;
  let sleeps = 0;
  const sock = new FakeSock();
  const frames: Frame[] = [];
  const f = async (url: string) => {
    if (url.endsWith("/live/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ session: { id: "live_1" } }) };
    return { ok: true, status: 200, text: async () => "" }; // hangup accepted, but no session.closed follows
  };
  await liveCall(CALL, {
    env: ENV,
    send: (fr) => frames.push(fr),
    log: () => {},
    fetch: f,
    connect: () => {
      setTimeout(() => sock.emit({ type: "transport.answered", event_id: "a" }), 0);
      return sock;
    },
    now: () => t,
    sleep: async () => {
      sleeps++;
      t += 1000;
      await new Promise((r) => setTimeout(r, 0));
    },
    maxCallMs: 10 * 60_000,
    cancelled: () => t > 3000,
  });
  assert.ok(sleeps < 30, `gave up after ${sleeps} polls`);
  assert.equal(frames.filter((x) => x.type === "call_result").length, 1);
});
