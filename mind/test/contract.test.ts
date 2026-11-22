// Parses every JSON example in CONTRACT.md, and checks the Mind handles or produces each one it
// sends or receives.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Brain, buildAct, type HubLike } from "../src/brain";
import { DEFAULT_TIMING, type Msg } from "../src/types";
import { describeScreen } from "../src/screen";
import { mindUrl } from "../src/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = fs.readFileSync(path.resolve(here, "../../CONTRACT.md"), "utf8");

/** Splits text holding one or more JSON objects one after another. */
function objects(text: string): any[] {
  const out: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return out;
}

const blocks = [...contract.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
const inline = [...contract.matchAll(/`(\{"type":[^`]*\})`/g)].map((m) => m[1]);
const examples: any[] = [...blocks.flatMap(objects), ...inline.flatMap(objects)];

const MIND_SENDS = ["screen", "act", "cursor", "whisper", "say", "correct", "hush", "sleep", "call", "task", "plan", "step"];
const MIND_GETS = ["welcome", "peers", "screen_result", "act_result", "notification", "wake", "heard", "spoke", "say_started", "say_done", "asleep", "call_status", "call_result"];

test("every contract example parses", () => {
  assert.ok(blocks.length >= 5, `found ${blocks.length} json blocks`);
  assert.ok(examples.length >= 25, `found ${examples.length} examples`);
  for (const e of examples) assert.equal(typeof e.type, "string");
});

test("every example the Mind sends carries `to` and a known type", () => {
  const sent = examples.filter((e) => MIND_SENDS.includes(e.type));
  assert.ok(sent.length >= 10);
  for (const e of sent) assert.ok(["hands", "mouth", "caller", "watch"].includes(e.to), `${e.type} has to=${e.to}`);
});

test("the brain swallows every example it may receive, plus unknown ones, without crashing", async () => {
  const sent: Msg[] = [];
  const hub: HubLike = {
    send: (m) => (sent.push(m), true),
    nextId: (() => {
      let i = 0;
      return () => `x${++i}`;
    })(),
    waitFor: () => Promise.resolve(null),
    cancelWait: () => {},
  };
  const brain = new Brain({
    hub,
    model: async () => ({ json: null, stopReason: null, ms: 0, error: "stub" }),
    log: () => {},
    hints: [],
    contacts: {},
    timing: DEFAULT_TIMING,
  });
  try {
    const got = examples.filter((e) => MIND_GETS.includes(e.type));
    assert.ok(got.length >= 10);
    for (const e of got) brain.handle(e);
    brain.handle({ type: "mystery", weird: [1, 2] });
    brain.handle({ type: "heard" }); // missing text
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(brain.notifications.length >= 1, "notification remembered");
  } finally {
    brain.stop();
  }
});

test("screen_result example renders for the model", () => {
  const sr = examples.find((e) => e.type === "screen_result");
  const text = describeScreen(sr);
  assert.match(text, /App: Gmail/);
  assert.match(text, /\[0\] "Reply" \(Button\) tap @940,2160/);
});

test("buildAct makes acts shaped like the contract's", () => {
  const screen = examples.find((e) => e.type === "screen_result");
  const tap = buildAct({ do: "tap", n: 0 }, screen);
  assert.deepEqual(tap, { act: { type: "act", do: "tap", on: { n: 0 } } });
  assert.deepEqual(buildAct({ do: "key", n: -1, key: "back" }, screen), { act: { type: "act", do: "key", name: "back" } });
  assert.deepEqual(buildAct({ do: "swipe", n: -1, dir: "left" }, screen), { act: { type: "act", do: "swipe", dir: "left" } });
  assert.deepEqual(buildAct({ do: "type", n: -1, text: "hi" }, screen), { act: { type: "act", do: "type", text: "hi" } });
  assert.deepEqual(buildAct({ do: "launch", n: -1, app: "Gmail" }, screen), { act: { type: "act", do: "launch", app: "Gmail" } });
  assert.ok("error" in buildAct({ do: "tap", n: 99 }, screen), "missing node rejected");
  const contractAct = examples.find((e) => e.type === "act");
  assert.deepEqual(Object.keys(contractAct).sort(), ["do", "id", "on", "to", "type"]);
});

test("mindUrl builds the contract URL", () => {
  assert.equal(mindUrl("ws://127.0.0.1:8765", "abc"), "ws://127.0.0.1:8765/mind?token=abc");
  assert.equal(mindUrl("ws://127.0.0.1:8765/", "a b"), "ws://127.0.0.1:8765/mind?token=a%20b");
  assert.equal(mindUrl("ws://localhost:8765/mind?token=t", "x"), "ws://localhost:8765/mind?token=t");
});
