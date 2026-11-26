// The real Caller with fetch stubbed out: no request leaves this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realCall, isDryRun, mapTwilioStatus, summarize, toTranscript, form, startCallerWith, type CallDeps } from "../src/caller";
import type { Frame } from "../src/hub";

type Req = { method: string; url: string; headers: Record<string, string>; body?: string };
type Route = [method: string, url: RegExp, reply: (r: Req) => { status?: number; body: unknown }];

function stubFetch(routes: Route[]) {
  const reqs: Req[] = [];
  const fetch: CallDeps["fetch"] = async (url, init = {}) => {
    const r: Req = { method: init.method ?? "GET", url, headers: init.headers ?? {}, body: init.body };
    reqs.push(r);
    const route = routes.find(([m, re]) => m === r.method && re.test(url));
    if (!route) throw new Error(`unexpected ${r.method} ${url}`);
    const { status = 200, body } = route[2](r);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status < 400, status, text: async () => text };
  };
  return { fetch, reqs };
}
/** Returns the next item each time, repeating the last one. */
const seq = <T>(items: T[]) => { let i = 0; return () => items[Math.min(i++, items.length - 1)]; };

const ENV = {
  CALLER_DRY_RUN: "0",
  CALL_ALLOWLIST: "+14155550123",
  ELEVENLABS_API_KEY: "el-test-key",
  ELEVENLABS_CALLER_AGENT_ID: "agent_caller",
  ELEVENLABS_PHONE_NUMBER_ID: "phnum_1",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "tw-test-token",
  OWNER_NUMBER: "+14155550100",
};
const CALL: Frame = {
  type: "call", to: "caller", id: "m9", number: "+14155550123",
  goal: "Say I'm running 20 minutes late and ask if 3pm still works.", context: "Alex is a friend.",
};
const CONV_DONE = {
  status: "done",
  transcript: [
    { role: "agent", message: "Hey Alex, I'm running 20 minutes late. Does 3pm still work?" },
    { role: "user", message: "Sure, 3 is fine." },
    { role: "agent", message: null },
  ],
  analysis: { transcript_summary: "The caller said they were late; Alex agreed.", data_collection_results: { their_answer: { value: "Alex said 3pm works. He'll see you there. Bye." } } },
  metadata: { phone_call: { call_sid: "CA1" } },
};

async function run(env: Record<string, string>, routes: Route[], extra: Partial<CallDeps> = {}) {
  const sent: Frame[] = [];
  const logs: string[] = [];
  const { fetch, reqs } = stubFetch(routes);
  let t = 1_790_000_000_000;
  await realCall(CALL, { env, send: (f) => sent.push(f), log: (l) => logs.push(l), fetch, sleep: async () => {}, now: () => (t += 1000), ...extra });
  const statuses = sent.filter((f) => f.type === "call_status").map((f) => f.status);
  const results = sent.filter((f) => f.type === "call_result");
  assert.equal(results.length, 1, "exactly one call_result");
  assert.ok(sent.every((f) => f.re === "m9"));
  return { sent, reqs, logs, statuses, result: results[0] };
}

test("owner route: register-call TwiML, Twilio dials from OWNER_NUMBER, transcript and summary come back", async () => {
  const twilioStatus = seq(["queued", "ringing", "in-progress", "in-progress", "completed"]);
  const convStatus = seq([{ status: "processing", transcript: [] }, CONV_DONE]);
  const r = await run(ENV, [
    ["POST", /\/v1\/convai\/twilio\/register-call$/, () => ({ body: "<Response><Connect><Stream url=\"wss://x\"/></Connect></Response>" })],
    ["POST", /api\.twilio\.com\/2010-04-01\/Accounts\/AC123\/Calls\.json$/, () => ({ status: 201, body: { sid: "CA1", status: "queued" } })],
    ["GET", /Accounts\/AC123\/Calls\/CA1\.json$/, () => ({ body: { sid: "CA1", status: twilioStatus() } })],
    ["GET", /\/v1\/convai\/conversations\?.*user_id=bobby-call-m9-/, () => ({ body: { conversations: [{ conversation_id: "conv_1" }] } })],
    ["GET", /\/v1\/convai\/conversations\/conv_1$/, () => ({ body: convStatus() })],
  ]);
  assert.deepEqual(r.statuses, ["dialing", "answered", "ended"]);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.summary, "Alex said 3pm works. He'll see you there.");
  assert.deepEqual(r.result.transcript, [
    { who: "me", text: "Hey Alex, I'm running 20 minutes late. Does 3pm still work?" },
    { who: "them", text: "Sure, 3 is fine." },
  ]);

  const reg = r.reqs[0];
  assert.equal(reg.headers["xi-api-key"], "el-test-key");
  const regBody = JSON.parse(reg.body!);
  assert.equal(regBody.agent_id, "agent_caller");
  assert.equal(regBody.from_number, "+14155550100");
  assert.equal(regBody.to_number, "+14155550123");
  assert.equal(regBody.direction, "outbound");
  assert.deepEqual(regBody.conversation_initiation_client_data.dynamic_variables, { goal: CALL.goal, context: CALL.context });

  const dial = r.reqs[1];
  assert.equal(dial.headers.Authorization, `Basic ${btoa("AC123:tw-test-token")}`);
  assert.equal(dial.headers["Content-Type"], "application/x-www-form-urlencoded");
  const f = new URLSearchParams(dial.body);
  assert.equal(f.get("From"), "+14155550100");
  assert.equal(f.get("To"), "+14155550123");
  assert.match(f.get("Twiml")!, /^<Response>/);
});

test("Twilio refuses OWNER_NUMBER as caller ID: falls back to ElevenLabs outbound-call from the bought number", async () => {
  const twilioStatus = seq(["ringing", "completed"]); // answered between two polls
  const r = await run(ENV, [
    ["POST", /register-call$/, () => ({ body: "\"<Response/>\"" })],
    ["POST", /Calls\.json$/, () => ({ status: 400, body: { code: 21210, message: "The source phone number provided, +14155550100, is not yet verified" } })],
    ["POST", /\/v1\/convai\/twilio\/outbound-call$/, () => ({ body: { success: true, message: "ok", conversation_id: "conv_2", callSid: "CA2" } })],
    ["GET", /Calls\/CA2\.json$/, () => ({ body: { status: twilioStatus() } })],
    ["GET", /\/v1\/convai\/conversations\/conv_2$/, () => ({ body: { ...CONV_DONE, analysis: { transcript_summary: "Alex agreed to 3pm. All good. Thanks." } } })],
  ]);
  assert.equal(new URLSearchParams(r.reqs[1].body).get("Twiml"), "<Response/>", "JSON-quoted TwiML is unwrapped");
  const out = JSON.parse(r.reqs[2].body!);
  assert.equal(out.agent_phone_number_id, "phnum_1");
  assert.equal(out.to_number, "+14155550123");
  assert.equal(out.conversation_initiation_client_data.dynamic_variables.goal, CALL.goal);
  assert.deepEqual(r.statuses, ["dialing", "answered", "ended"]);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.summary, "Alex agreed to 3pm. All good.");
  assert.ok(r.logs.some((l) => /refused OWNER_NUMBER/.test(l)));
});

test("no OWNER_NUMBER: dials straight from the bought number", async () => {
  const { OWNER_NUMBER, ...env } = ENV;
  const r = await run(env, [
    ["POST", /outbound-call$/, () => ({ body: { success: true, message: "ok", conversation_id: "conv_3", callSid: "CA3" } })],
    ["GET", /Calls\/CA3\.json$/, () => ({ body: { status: "completed" } })],
    ["GET", /conversations\/conv_3$/, () => ({ body: { status: "done", transcript: [{ role: "user", message: "Yes. Three works! See you." }] } })],
  ]);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.summary, "They said: Yes. Three works!");
});

for (const [twilio, error] of [["busy", "busy"], ["no-answer", "no_answer"], ["failed", "failed"], ["canceled", "failed"]]) {
  test(`Twilio status ${twilio} ends in call_status failed and call_result ${error}`, async () => {
    const st = seq(["ringing", twilio]);
    const r = await run(ENV, [
      ["POST", /register-call$/, () => ({ body: "<Response/>" })],
      ["POST", /Calls\.json$/, () => ({ body: { sid: "CA1" } })],
      ["GET", /Calls\/CA1\.json$/, () => ({ body: { status: st() } })],
    ]);
    assert.deepEqual(r.statuses, ["dialing", "failed"]);
    assert.deepEqual(r.result, { type: "call_result", re: "m9", ok: false, error });
  });
}

test("not on the allowlist, or not E.164: not_allowed, and nothing is fetched", async () => {
  for (const env of [{ ...ENV, CALL_ALLOWLIST: "+19999999999" }, { ...ENV, CALL_ALLOWLIST: "" }]) {
    const r = await run(env, []);
    assert.deepEqual(r.sent, [{ type: "call_result", re: "m9", ok: false, error: "not_allowed" }]);
    assert.equal(r.reqs.length, 0);
  }
});

test("missing keys: not_configured, nothing is fetched, and the log names variables only", async () => {
  const r = await run({ CALLER_DRY_RUN: "0", CALL_ALLOWLIST: "+14155550123", TWILIO_AUTH_TOKEN: "secret-value" }, []);
  assert.deepEqual(r.sent, [{ type: "call_result", re: "m9", ok: false, error: "not_configured" }]);
  assert.equal(r.reqs.length, 0);
  assert.ok(r.logs.join("\n").includes("ELEVENLABS_API_KEY"));
  assert.ok(!r.logs.join("\n").includes("secret-value"));
});

test("a network error or an API error still ends in one call_result ok:false", async () => {
  const r1 = await run(ENV, [["POST", /register-call$/, () => { throw new Error("offline"); }]]);
  assert.deepEqual(r1.statuses, ["dialing", "failed"]);
  assert.deepEqual(r1.result, { type: "call_result", re: "m9", ok: false, error: "failed" });

  const r2 = await run(ENV, [
    ["POST", /register-call$/, () => ({ body: "<Response/>" })],
    ["POST", /Calls\.json$/, () => ({ status: 401, body: { code: 20003, message: "Authenticate" } })],
  ]);
  assert.equal(r2.result.error, "failed");
  assert.equal(r2.reqs.length, 2, "an auth error doesn't fall back");

  const r3 = await run(ENV, [
    ["POST", /register-call$/, () => ({ body: "<Response/>" })],
    ["POST", /Calls\.json$/, () => ({ body: { sid: "CA1" } })],
    ["GET", /Calls\/CA1\.json$/, () => ({ body: { status: "completed" } })],
    ["GET", /conversations\?/, () => ({ body: { conversations: [] } })],
  ], { transcriptWaitMs: 5000 });
  assert.deepEqual(r3.statuses, ["dialing", "answered", "ended"]);
  assert.deepEqual(r3.result, { type: "call_result", re: "m9", ok: false, error: "no_transcript" });
});

test("the conversation is found by Twilio call sid when the user_id filter finds nothing", async () => {
  const r = await run(ENV, [
    ["POST", /register-call$/, () => ({ body: "<Response/>" })],
    ["POST", /Calls\.json$/, () => ({ body: { sid: "CA1" } })],
    ["GET", /Calls\/CA1\.json$/, () => ({ body: { status: "completed" } })],
    ["GET", /conversations\?.*user_id=/, () => ({ body: { conversations: [] } })],
    ["GET", /conversations\?.*call_start_after_unix=/, () => ({ body: { conversations: [{ conversation_id: "other" }, { conversation_id: "conv_1" }] } })],
    ["GET", /conversations\/other$/, () => ({ body: { status: "done", metadata: { phone_call: { call_sid: "CAx" } } } })],
    ["GET", /conversations\/conv_1$/, () => ({ body: CONV_DONE })],
  ]);
  assert.equal(r.result.ok, true);
});

test("a call that runs too long, or a stopped Caller, is hung up", async () => {
  for (const extra of [{ maxCallMs: 3000 }, { cancelled: () => true }]) {
    const r = await run(ENV, [
      ["POST", /register-call$/, () => ({ body: "<Response/>" })],
      ["POST", /Calls\.json$/, () => ({ body: { sid: "CA1" } })],
      ["GET", /Calls\/CA1\.json$/, () => ({ body: { status: "in-progress" } })],
      ["POST", /Calls\/CA1\.json$/, () => ({ body: { status: "completed" } })],
    ], extra);
    const hangup = r.reqs.find((q) => q.method === "POST" && /Calls\/CA1\.json$/.test(q.url));
    assert.equal(new URLSearchParams(hangup?.body).get("Status"), "completed");
    assert.equal(r.result.ok, false);
    assert.equal(r.statuses.at(-1), "failed");
  }
});

test("helpers: dry run by default, status mapping, transcript, summary, form encoding", () => {
  assert.equal(isDryRun({}), true);
  assert.equal(isDryRun({ CALLER_DRY_RUN: "1" }), true);
  assert.equal(isDryRun({ CALLER_DRY_RUN: "" }), true);
  assert.equal(isDryRun({ CALLER_DRY_RUN: "false" }), true, "only exactly 0 dials");
  assert.equal(isDryRun({ CALLER_DRY_RUN: "0" }), false);
  assert.deepEqual(["queued", "ringing", "in-progress", "completed", "busy", "no-answer"].map((s) => mapTwilioStatus(s).status),
    ["dialing", "dialing", "answered", "ended", "failed", "failed"]);
  assert.deepEqual(toTranscript(null), []);
  assert.equal(summarize({}, []), "They didn't say anything.");
  assert.equal(form({ To: "+1 2", Twiml: "<a b=\"&\"/>" }), "To=%2B1%202&Twiml=%3Ca%20b%3D%22%26%22%2F%3E");
});

test("startCaller with CALLER_DRY_RUN unset never fetches, even with every key present", async () => {
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
  const { fetch, reqs } = stubFetch([]);
  const { CALLER_DRY_RUN, ...env } = ENV;
  const c = startCallerWith({
    hubUrl: "ws://127.0.0.1:8814", token: "t", log: () => {}, env, stepMs: 5,
    WebSocketImpl: NodeWS as unknown as { new (url: string): never }, callDeps: { fetch },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reqs.length, 0);
  assert.equal(got.at(-1)?.type, "call_result");
  assert.match(String(got.at(-1)?.summary), /^Dry run/);
  c.stop();
  wss.close();
});

test("transcript lines drop the voice model's expression tags", async () => {
  const { stripTags } = await import("../src/caller");
  assert.equal(stripTags("[sorry] Hey, I'm running late."), "Hey, I'm running late.");
  assert.equal(stripTags("[happy] Three thirty works great. [laughs] See you!"), "Three thirty works great. See you!");
});

test("a Twilio poll that fails mid-call hangs the call up instead of leaving it running", async () => {
  let polls = 0;
  const r = await run(ENV, [
    ["POST", /register-call$/, () => ({ body: "<Response/>" })],
    ["POST", /Calls\.json$/, () => ({ body: { sid: "CA1" } })],
    ["GET", /Calls\/CA1\.json$/, () => (++polls < 3 ? { body: { status: "in-progress" } } : { status: 500, body: "oops" })],
    ["POST", /Calls\/CA1\.json$/, () => ({ body: { status: "completed" } })],
  ]);
  const hangup = r.reqs.find((q) => q.method === "POST" && /Calls\/CA1\.json$/.test(q.url));
  assert.equal(new URLSearchParams(hangup?.body).get("Status"), "completed");
  assert.equal(r.result.ok, false);
});
