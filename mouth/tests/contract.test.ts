// Every contract example the Mouth or the Caller sends or receives parses, and the Mouth
// handles each one it receives without crashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Mouth } from "../src/mouth";
import { dryRunCall } from "../src/caller";
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
  const m = new Mouth({ send: (f) => sent.push(f), log: () => {}, voice: async () => ({ sendUserMessage() {}, sendContextualUpdate() {}, interrupt() {}, async end() {} }) });
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
