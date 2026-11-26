// Every contract example the Mouth or the Caller sends or receives parses, and the Mouth
// handles each one it receives without crashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Mouth } from "../src/mouth";
import { dryRunCall } from "../src/caller";
import { liveCall, type SocketLike } from "../src/caller-live";
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
  const m = new Mouth({ send: (f) => sent.push(f), log: () => {}, voice: async () => ({ sendUserMessage() {}, sendContextualUpdate() {}, speak() {}, toolResult() {}, interrupt() {}, setMicMuted() {}, async end() {} }) });
  for (const f of toMouth) m.onHub(f); // asleep
  await m.wake();
  for (const f of toMouth) m.onHub(f); // live
  await new Promise((r) => setImmediate(r));
  const shapes = new Map(fromMouth.map((f) => [f.type, Object.keys(f).sort().join(",")]));
  for (const f of sent) {
    if (f.type === "voice_caps") continue; // protocol v2 (mind/PROTOCOL-V2.md), not in CONTRACT.md v1
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
  const m = new Mouth({ send: (f) => out.push(f), log: () => {}, voice: async () => ({ sendUserMessage() {}, sendContextualUpdate() {}, speak() {}, toolResult() {}, interrupt() {}, setMicMuted() {}, async end() {} }) });
  m.onHub(peers);
  m.onHub({ type: "brand_new", to: "mouth" });
  assert.deepEqual(out, []);
});

test("Caller examples: the real Caller's frames (fetch and the sideband socket stubbed) match the contract's shapes too", async () => {
  const ex = blocks(section("Caller"));
  const call = ex.find((f) => f.type === "call")!;
  const status = ex.find((f) => f.type === "call_status")!;
  const result = ex.find((f) => f.type === "call_result")!;
  const statusText = /`status` is ([^.]+)\./.exec(section("Caller"))![1];
  const allowedStatuses = [...statusText.matchAll(/`(\w+)`/g)].map((x) => x[1]);
  assert.deepEqual(allowedStatuses, ["dialing", "answered", "ended", "failed"]);
  const sent: Frame[] = [];
  const sock: SocketLike & { emit(e: object): void } = {
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send() {}, close() {},
    emit(e: object) { this.onmessage?.({ data: JSON.stringify(e) }); },
  };
  const fetch = async (url: string) => {
    let body: unknown = "";
    if (url.endsWith("/live/sessions")) body = { session: { id: "live_1" } };
    else if (url.endsWith("/hangup")) setTimeout(() => sock.emit({ type: "session.closed", event_id: "e9" }), 5);
    else if (url.endsWith("/responses")) body = { output: [{ type: "message", content: [{ type: "output_text", text: "Alex said 3pm works." }] }] };
    return { ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  await liveCall(call, {
    env: { CALLER_DRY_RUN: "0", CALL_ALLOWLIST: String(call.number), OPENAI_API_KEY: "k", CALLER_SIP_URL: "sips:trunk.example:5061", CALLER_SIP_USERNAME: "u", CALLER_SIP_PASSWORD: "p", OWNER_NUMBER: "+14155550100" },
    send: (f) => sent.push(f), log: () => {}, fetch,
    connect: () => {
      setTimeout(() => {
        sock.emit({ type: "transport.answered", event_id: "e1" });
        sock.emit({ type: "session.output_transcript.delta", event_id: "e2", delta: "Hey Alex..." });
        sock.emit({ type: "session.input_transcript.delta", event_id: "e3", delta: "Sure, 3 is fine." });
        sock.emit({ type: "session.delegation.created", event_id: "e4", delegation: { id: "d1", type: "delegation", target: "client" } });
      }, 5);
      return sock;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    goodbyeMs: 20,
    maxCallMs: 3000,
  });
  for (const f of sent) {
    const ref = f.type === "call_status" ? status : result;
    assert.deepEqual(Object.keys(f).sort(), Object.keys(ref).sort(), f.type);
    assert.equal(f.re, call.id);
    if (f.type === "call_status") assert.ok(allowedStatuses.includes(String(f.status)));
  }
  assert.deepEqual(sent.at(-1), { type: "call_result", re: call.id, ok: true, summary: "Alex said 3pm works.", transcript: [{ who: "me", text: "Hey Alex..." }, { who: "them", text: "Sure, 3 is fine." }] });
});
