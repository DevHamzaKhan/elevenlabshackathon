// Every contract example the Mouth or the Caller sends or receives parses, and the Mouth
// handles each one it receives without crashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Mouth } from "../src/mouth";
import { dryRunCall, realCall } from "../src/caller";
import { connectHub } from "../src/hub";
import type { Frame } from "../src/hub";

const md = readFileSync(new URL("../../CONTRACT.md", import.meta.url), "utf8");
const section = (name: string) => md.split(/^## /m).find((s) => s.startsWith(name))!;
const inline = (s: string): Frame[] => [...s.matchAll(/`(\{"type".*?\})`/g)].map((m) => JSON.parse(m[1]));
function blocks(s: string): Frame[] {
  const out: Frame[] = [];
  for (const [, body] of s.matchAll(/```json\n([\s\S]*?)```/g)) {
    // one or more objects back to back
    let depth = 0, start = -1;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "{") { if (depth++ === 0) start = i; }
      else if (body[i] === "}" && --depth === 0) out.push(JSON.parse(body.slice(start, i + 1)));
    }
  }
  return out;
}

test("Mouth examples: everything the Mind sends is handled; everything we send has the contract's shape", async () => {
  const ex = inline(section("Mouth"));
  const toMouth = ex.filter((f) => f.to === "mouth");
  const fromMouth = ex.filter((f) => f.to === undefined);
  assert.deepEqual(toMouth.map((f) => f.type).sort(), ["correct", "hush", "say", "sleep", "whisper"]);
  assert.deepEqual(fromMouth.map((f) => f.type).sort(), ["asleep", "heard", "say_done", "say_started", "spoke", "wake"]);

  const sent: Frame[] = [];
  const m = new Mouth({ send: (f) => sent.push(f), log: () => {}, voice: async () => ({ sendUserMessage() {}, sendContextualUpdate() {}, interrupt() {}, setMicMuted() {}, async end() {} }) });
  for (const f of toMouth) m.onHub(f); // asleep
  await m.wake();
  for (const f of toMouth) m.onHub(f); // live
  await new Promise((r) => setImmediate(r));
  const shapes = new Map(fromMouth.map((f) => [f.type, Object.keys(f).sort().join(",")]));
  for (const f of sent) {
    const keys = Object.keys(f).sort().join(",");
    const want = shapes.get(f.type)!;
    assert.ok(keys === want || (f.type === "say_done" && keys === "re,spoken,type"), `${f.type}: ${keys} vs ${want}`);
  }
});

test("Caller examples: the call parses and our answers match the contract's shapes", () => {
  const ex = blocks(section("Caller"));
  const call = ex.find((f) => f.type === "call")!;
  const status = ex.find((f) => f.type === "call_status")!;
  const result = ex.find((f) => f.type === "call_result")!;
  const ours = dryRunCall(call, [String(call.number)]);
  for (const f of ours) {
    const ref = f.type === "call_status" ? status : result;
    assert.deepEqual(Object.keys(f).sort(), Object.keys(ref).sort(), f.type);
    assert.equal(f.re, call.id);
  }
  assert.deepEqual(Object.keys((ours.at(-1)!.transcript as Frame[])[0]).sort(), ["text", "who"]);
});

test("Connecting/Routing examples: our hello matches, welcome makes us live, peers and unknown frames are ignored", () => {
  const ex = [...inline(section("Connecting")), ...inline(section("Routing"))];
  const hello = ex.find((f) => f.type === "hello")!;
  const welcome = ex.find((f) => f.type === "welcome")!;
  const peers = ex.find((f) => f.type === "peers")!;
  assert.ok(hello && welcome && peers);
  for (const role of ["mouth", "caller"] as const) {
    const sent: string[] = [];
    const got: Frame[] = [];
    let sock: any;
    class FakeWS {
      readyState = 1; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
      constructor(public url: string) { sock = this; }
      send(d: string) { sent.push(d); }
      close() {}
    }
    const hub = connectHub({ hubUrl: "ws://127.0.0.1:8765", token: "t", role, log: () => {}, onMessage: (m) => got.push(m), WebSocketImpl: FakeWS as any });
    assert.match(sock.url, new RegExp(`/${role}\\?token=t$`));
    sock.onopen({});
    const ours = JSON.parse(sent[0]);
    assert.deepEqual(Object.keys(ours).sort(), Object.keys(hello).sort());
    assert.deepEqual(ours, { ...hello, role });
    assert.equal(hub.state, "connecting");
    sock.onmessage({ data: JSON.stringify(welcome) });
    assert.equal(hub.state, "live");
    sock.onmessage({ data: JSON.stringify(peers) });
    assert.deepEqual(got.map((f) => f.type), ["peers"]); // delivered to the handler, which ignores it
    hub.stop();
  }
  // The Mouth ignores peers (and anything else it doesn't know) without sending anything.
  const out: Frame[] = [];
  const m = new Mouth({ send: (f) => out.push(f), log: () => {}, voice: async () => ({ sendUserMessage() {}, sendContextualUpdate() {}, interrupt() {}, setMicMuted() {}, async end() {} }) });
  m.onHub(peers);
  m.onHub({ type: "brand_new", to: "mouth" });
  assert.deepEqual(out, []);
});

test("Caller examples: the real Caller's frames (fetch stubbed) match the contract's shapes too", async () => {
  const ex = blocks(section("Caller"));
  const call = ex.find((f) => f.type === "call")!;
  const status = ex.find((f) => f.type === "call_status")!;
  const result = ex.find((f) => f.type === "call_result")!;
  const statusText = /`status` is ([^.]+)\./.exec(section("Caller"))![1];
  const allowedStatuses = [...statusText.matchAll(/`(\w+)`/g)].map((x) => x[1]);
  assert.deepEqual(allowedStatuses, ["dialing", "answered", "ended", "failed"]);
  const sent: Frame[] = [];
  const twilio = ["ringing", "in-progress", "completed"];
  const fetch = async (url: string, init: { method?: string } = {}) => {
    let body: unknown = {};
    if (url.endsWith("/register-call")) body = "<Response/>";
    else if (url.endsWith("/Calls.json")) body = { sid: "CA1" };
    else if (url.includes("/Calls/CA1.json")) body = { status: twilio.length > 1 ? twilio.shift() : twilio[0] };
    else if (url.includes("/conversations?")) body = { conversations: [{ conversation_id: "c1" }] };
    else if (url.endsWith("/conversations/c1")) body = { status: "done", transcript: [{ role: "agent", message: "Hey Alex..." }, { role: "user", message: "Sure, 3 is fine." }], analysis: { data_collection_results: { their_answer: { value: "Alex said 3pm works." } } } };
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: true, status: init.method === "POST" ? 201 : 200, text: async () => text };
  };
  await realCall(call, {
    env: { CALLER_DRY_RUN: "0", CALL_ALLOWLIST: String(call.number), ELEVENLABS_API_KEY: "k", ELEVENLABS_CALLER_AGENT_ID: "a", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", OWNER_NUMBER: "+14155550100" },
    send: (f) => sent.push(f), log: () => {}, fetch, sleep: async () => {},
  });
  for (const f of sent) {
    const ref = f.type === "call_status" ? status : result;
    assert.deepEqual(Object.keys(f).sort(), Object.keys(ref).sort(), f.type);
    assert.equal(f.re, call.id);
    if (f.type === "call_status") assert.ok(allowedStatuses.includes(String(f.status)));
  }
  assert.deepEqual(sent.at(-1), { type: "call_result", re: call.id, ok: true, summary: "Alex said 3pm works.", transcript: [{ who: "me", text: "Hey Alex..." }, { who: "them", text: "Sure, 3 is fine." }] });
});
