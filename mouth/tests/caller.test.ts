// The Caller's own logic: dry run by default, the allowlist, and the hub entry point.
// The real call (GPT-Live over SIP) is tested in caller-live.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dryRunCall, isDryRun, startCallerWith } from "../src/caller";
import type { Frame } from "../src/hub";

const CALL: Frame = {
  type: "call", to: "caller", id: "m9", number: "+14155550123",
  goal: "Say I'm running 20 minutes late and ask if 3pm still works.", context: "Alex is a friend.",
};

test("dry run by default: only exactly 0 dials", () => {
  assert.equal(isDryRun({}), true);
  assert.equal(isDryRun({ CALLER_DRY_RUN: "1" }), true);
  assert.equal(isDryRun({ CALLER_DRY_RUN: "" }), true);
  assert.equal(isDryRun({ CALLER_DRY_RUN: "false" }), true, "only exactly 0 dials");
  assert.equal(isDryRun({ CALLER_DRY_RUN: "0" }), false);
});

test("not on the allowlist, not E.164, or an empty allowlist: one call_result not_allowed", () => {
  const refused = [{ type: "call_result", re: "m9", ok: false, error: "not_allowed" }];
  assert.deepEqual(dryRunCall(CALL, ["+14155550999"]), refused);
  assert.deepEqual(dryRunCall({ ...CALL, number: "4155550123" }, ["4155550123"]), refused);
  assert.deepEqual(dryRunCall(CALL, []), refused);
  const ok = dryRunCall(CALL, ["+14155550123"]);
  assert.deepEqual(ok.map((f) => f.status ?? f.type), ["dialing", "answered", "ended", "call_result"]);
  assert.match(String(ok.at(-1)?.summary), /^Dry run/);
});

test("startCaller with CALLER_DRY_RUN unset never reaches the network, even with every key present", async () => {
  const { WebSocketServer, WebSocket: NodeWS } = await import("ws");
  const got: Frame[] = [];
  const wss = new WebSocketServer({ port: 8814, host: "127.0.0.1" });
  wss.on("connection", (ws) => {
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "welcome", v: 1 }));
      ws.on("message", (d) => got.push(JSON.parse(String(d))));
      ws.send(JSON.stringify(CALL));
    });
  });
  const reqs: string[] = [];
  const fetch = async (url: string) => {
    reqs.push(url);
    throw new Error(`unexpected fetch ${url}`);
  };
  const c = startCallerWith({
    hubUrl: "ws://127.0.0.1:8814", token: "t", log: () => {}, stepMs: 5,
    env: { CALL_ALLOWLIST: "+14155550123", OPENAI_API_KEY: "sk-test", CALLER_SIP_URL: "sips:trunk.example:5061", OWNER_NUMBER: "+14155550100" },
    WebSocketImpl: NodeWS as unknown as { new (url: string): never },
    liveDeps: { fetch, connect: () => { throw new Error("unexpected connect"); } },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reqs.length, 0);
  assert.equal(got.at(-1)?.type, "call_result");
  assert.match(String(got.at(-1)?.summary), /^Dry run/);
  c.stop();
  wss.close();
});
