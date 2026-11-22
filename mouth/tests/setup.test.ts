// agent/setup.mjs against a stubbed fetch: no request leaves this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain .mjs laptop script
import { runSetup, callerAgentBody, dryRunFetch, VOICE_NAME, DEFAULT_FALLBACK_VOICE_ID } from "../agent/setup.mjs";

type Req = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A tiny in-memory ElevenLabs + Twilio account. */
function account(start: { agents?: { agent_id: string; name: string }[]; voices?: { voice_id: string; name: string }[]; phones?: { phone_number: string; phone_number_id: string }[]; twilioNumbers?: string[]; verified?: string[] } = {}) {
  const s = { agents: [...(start.agents ?? [])], voices: [...(start.voices ?? [])], phones: [...(start.phones ?? [])], twilioNumbers: start.twilioNumbers ?? ["+15555550199"], verified: start.verified ?? [] };
  const reqs: Req[] = [];
  let n = 0;
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    reqs.push({ method, url, headers: init.headers ?? {}, body: init.body });
    const u = new URL(url);
    const p = u.pathname;
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (p === "/v1/convai/agents" && method === "GET") return reply({ agents: s.agents.filter((a) => a.name.includes(u.searchParams.get("search") ?? "")) });
    if (p === "/v1/convai/agents/create") { const a = { agent_id: `agent_${++n}`, name: JSON.parse(String(init.body)).name }; s.agents.push(a); return reply({ agent_id: a.agent_id }); }
    if (p.startsWith("/v1/convai/agents/")) {
      const a = s.agents.find((x) => x.agent_id === p.split("/").pop());
      return a ? reply(a) : reply({ detail: "not found" }, 404);
    }
    if (p === "/v2/voices") return reply({ voices: s.voices });
    if (p === "/v1/voices/add") { const v = { voice_id: `voice_${++n}`, name: VOICE_NAME }; s.voices.push(v); return reply({ voice_id: v.voice_id, requires_verification: false }); }
    if (p === "/v1/convai/phone-numbers" && method === "GET") return reply(s.phones);
    if (p === "/v1/convai/phone-numbers") { const b = JSON.parse(String(init.body)); const x = { phone_number: b.phone_number, phone_number_id: `phnum_${++n}` }; s.phones.push(x); return reply({ phone_number_id: x.phone_number_id }); }
    if (p.endsWith("/IncomingPhoneNumbers.json")) return reply({ incoming_phone_numbers: s.twilioNumbers.map((phone_number) => ({ phone_number })) });
    if (p.endsWith("/OutgoingCallerIds.json")) return reply({ outgoing_caller_ids: s.verified.filter((v) => v === u.searchParams.get("PhoneNumber")).map((phone_number) => ({ phone_number })) });
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetch, reqs, s };
}

const ENV = { ELEVENLABS_API_KEY: "el-key", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-token", OWNER_NUMBER: "+14155550100" };
const quiet = () => {};
const posts = (reqs: Req[]) => reqs.filter((r) => r.method === "POST").map((r) => new URL(r.url).pathname);

test("first run on an empty account: Bobby, the voice clone, the caller agent and the number import", async () => {
  const acct = account({ verified: ["+14155550100"] });
  const { ids, todo } = await runSetup({ env: ENV, doFetch: acct.fetch, sample: "/x/owner.m4a", readFile: () => new Uint8Array([1, 2, 3]), log: quiet });
  assert.deepEqual(posts(acct.reqs), ["/v1/convai/agents/create", "/v1/voices/add", "/v1/convai/agents/create", "/v1/convai/phone-numbers"]);
  assert.deepEqual(Object.keys(ids).sort(), ["ELEVENLABS_BOBBY_AGENT_ID", "ELEVENLABS_CALLER_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID"]);
  assert.notEqual(ids.ELEVENLABS_BOBBY_AGENT_ID, ids.ELEVENLABS_CALLER_AGENT_ID);
  assert.deepEqual(todo, []);

  const clone = acct.reqs.find((r) => r.url.endsWith("/v1/voices/add"))!;
  assert.ok(clone.body instanceof FormData);
  assert.equal((clone.body as FormData).get("name"), VOICE_NAME);
  assert.ok((clone.body as FormData).get("files") instanceof Blob);
  assert.equal(clone.headers["Content-Type"], undefined, "fetch sets the multipart boundary");

  const caller = JSON.parse(String(acct.reqs.filter((r) => r.url.endsWith("/agents/create"))[1].body));
  assert.equal(caller.conversation_config.tts.voice_id, "voice_2", "the caller agent speaks in the clone");
  assert.match(caller.conversation_config.agent.prompt.prompt, /\{\{goal\}\}[\s\S]*\{\{context\}\}/);
  assert.equal(caller.conversation_config.agent.prompt.built_in_tools.end_call.params.system_tool_type, "end_call");
  assert.equal(caller.platform_settings.data_collection.their_answer.type, "string");

  const phone = JSON.parse(String(acct.reqs.find((r) => r.method === "POST" && r.url.endsWith("/phone-numbers"))!.body));
  assert.deepEqual(phone, { provider: "twilio", phone_number: "+15555550199", label: "Bobby caller", sid: "AC1", token: "tw-token" });
  const tw = acct.reqs.find((r) => r.url.includes("api.twilio.com"))!;
  assert.equal(tw.headers.Authorization, `Basic ${btoa("AC1:tw-token")}`);
  assert.equal(tw.headers["xi-api-key"], undefined, "the ElevenLabs key never goes to Twilio");
});

test("running it again changes things in place and creates nothing", async () => {
  const acct = account({ verified: ["+14155550100"] });
  const first = await runSetup({ env: ENV, doFetch: acct.fetch, sample: "/x/owner.m4a", readFile: () => new Uint8Array(1), log: quiet });
  acct.reqs.length = 0;
  const again = await runSetup({ env: { ...ENV, ...first.ids }, doFetch: acct.fetch, sample: "/x/owner.m4a", readFile: () => new Uint8Array(1), log: quiet });
  assert.deepEqual(posts(acct.reqs), []);
  assert.deepEqual(again.ids, first.ids);
  assert.equal(acct.reqs.filter((r) => r.method === "PATCH").length, 3, "Bobby, Bobby's voice mode, the caller agent");
  // Without the saved ids (a fresh clone of the repo), agents are found by name.
  acct.reqs.length = 0;
  const fresh = await runSetup({ env: ENV, doFetch: acct.fetch, sample: "/x/owner.m4a", readFile: () => new Uint8Array(1), log: quiet });
  assert.deepEqual(posts(acct.reqs), []);
  assert.deepEqual(fresh.ids, first.ids);
});

test("no sample, no Twilio keys: ready-made voice, Bobby and the caller agent still set up, the rest on the human's list", async () => {
  const acct = account();
  const { ids, todo } = await runSetup({ env: { ELEVENLABS_API_KEY: "el-key" }, doFetch: acct.fetch, sample: null, log: quiet });
  assert.deepEqual(Object.keys(ids).sort(), ["ELEVENLABS_BOBBY_AGENT_ID", "ELEVENLABS_CALLER_AGENT_ID"]);
  const caller = JSON.parse(String(acct.reqs.filter((r) => r.url.endsWith("/agents/create"))[1].body));
  assert.equal(caller.conversation_config.tts.voice_id, DEFAULT_FALLBACK_VOICE_ID);
  assert.ok(!acct.reqs.some((r) => r.url.includes("twilio.com")));
  assert.equal(todo.length, 2);
  assert.match(todo.join("\n"), /mouth\/private/);
  assert.match(todo.join("\n"), /TWILIO_ACCOUNT_SID/);
});

test("Twilio checks: no bought number, a chosen number, an unverified OWNER_NUMBER", async () => {
  const none = account({ twilioNumbers: [] });
  const r1 = await runSetup({ env: ENV, doFetch: none.fetch, sample: null, log: quiet });
  assert.equal(r1.ids.ELEVENLABS_PHONE_NUMBER_ID, undefined);
  assert.match(r1.todo.join("\n"), /Buy one phone number/);

  const two = account({ twilioNumbers: ["+15555550101", "+15555550102"] });
  const r2 = await runSetup({ env: { ...ENV, MOUTH_TWILIO_NUMBER: "+15555550102" }, doFetch: two.fetch, sample: null, log: quiet });
  assert.equal(two.s.phones[0].phone_number, "+15555550102");
  assert.match(r2.todo.join("\n"), /Verify OWNER_NUMBER/);
});

test("--dry-run fake API runs every step and never shows a key", async () => {
  const lines: string[] = [];
  const env = { ELEVENLABS_API_KEY: "SECRET_EL", TWILIO_ACCOUNT_SID: "ACSECRET", TWILIO_AUTH_TOKEN: "SECRET_TW", OWNER_NUMBER: "+15555550100" };
  const { ids } = await runSetup({ env, doFetch: dryRunFetch((l: string) => lines.push(l)), sample: "/x/a.wav", readFile: () => new Uint8Array(0), log: (l: string) => lines.push(l) });
  assert.equal(Object.keys(ids).length, 3);
  const out = lines.join("\n");
  assert.ok(!/SECRET/.test(out), "no key in the dry-run output");
  assert.match(out, /POST \/v1\/voices\/add/);
  assert.match(out, /POST \/v1\/convai\/phone-numbers/);
});

test("callerAgentBody leaves the TTS model to ElevenLabs unless MOUTH_CALLER_TTS_MODEL is set", () => {
  assert.equal(callerAgentBody("p", "v").conversation_config.tts.model_id, undefined);
  assert.equal(callerAgentBody("p", "v", "eleven_flash_v2").conversation_config.tts.model_id, "eleven_flash_v2");
});
