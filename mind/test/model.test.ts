// The OpenAI door: request shape, parsing, refusals, retries. Fetch is faked; no key needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeModel, modelOptionsFromEnv, DEFAULT_MODELS } from "../src/model";

type Seen = { url: string; body: any; headers: any };

function fakeFetch(replies: ((body: any) => { status?: number; body: any })[]) {
  const seen: Seen[] = [];
  let i = 0;
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, headers: init.headers });
    const r = replies[Math.min(i++, replies.length - 1)](body);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text } as any;
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const ok = (obj: any, usage = { input_tokens: 1200, output_tokens: 20, input_tokens_details: { cached_tokens: 1024 } }) => ({
  body: {
    status: "completed",
    model: "gpt-6-luna",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(obj) }] }],
    usage,
  },
});

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

test("request: Responses API, strict schema, developer prefix first, per-role model and effort, cache key", async () => {
  const f = fakeFetch([() => ok({ a: "x" })]);
  const lines: string[] = [];
  const opts = modelOptionsFromEnv({ OPENAI_API_KEY: "sk-test", MIND_EXEC_MODEL: "my-exec", MIND_EXEC_EFFORT: "minimal" });
  const model = makeModel({ ...opts, log: (l) => lines.push(l), fetch: f.fn });
  const r = await model({ purpose: "exec", system: "STATIC", user: "screen…", schema: SCHEMA });
  assert.deepEqual(r.json, { a: "x" });
  assert.deepEqual(r.usage, { input: 1200, cached: 1024, output: 20 });
  const { url, body, headers } = f.seen[0];
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(headers.Authorization, "Bearer sk-test");
  assert.equal(body.model, "my-exec");
  assert.deepEqual(body.reasoning, { effort: "minimal" });
  assert.equal(body.input[0].role, "developer");
  assert.equal(body.input[0].content[0].text, "STATIC");
  assert.equal(body.input[1].role, "user");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.prompt_cache_key, "bobby-mind-exec");
  assert.equal(body.store, false);
  assert.ok(lines.some((l) => /cached=1024/.test(l)));
  assert.ok(!lines.join("\n").includes("sk-test"), "the key is never logged");
});

test("roles: route goes to the router model, escalate to the escalation model with an image", async () => {
  const f = fakeFetch([() => ok({ a: "1" })]);
  const model = makeModel({ apiKey: "k", log: () => {}, fetch: f.fn });
  await model({ purpose: "route", system: "S", user: "U", schema: SCHEMA });
  await model({ purpose: "escalate", role: "escalate", system: "S", user: "U", schema: SCHEMA, images: ["AAAA"] });
  assert.equal(f.seen[0].body.model, DEFAULT_MODELS.router);
  assert.equal(f.seen[0].body.reasoning.effort, "none");
  assert.equal(f.seen[1].body.model, DEFAULT_MODELS.escalate);
  const img = f.seen[1].body.input[1].content[1];
  assert.equal(img.type, "input_image");
  assert.equal(img.image_url, "data:image/jpeg;base64,AAAA");
});

test("refusal, incomplete and bad JSON come back as json:null with a reason", async () => {
  const f = fakeFetch([
    () => ({ body: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] } }),
    () => ({ body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } }),
    () => ({ body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{oops" }] }] } }),
  ]);
  const model = makeModel({ apiKey: "k", log: () => {}, fetch: f.fn, retries: 0 });
  const req = { purpose: "exec", system: "S", user: "U", schema: SCHEMA };
  assert.equal((await model(req)).error, "refusal");
  assert.equal((await model(req)).error, "max_output_tokens");
  assert.equal((await model(req)).error, "bad_json");
});

test("a 429 or 500 is retried once; a 401 is not", async () => {
  const f = fakeFetch([() => ({ status: 500, body: "boom" }), () => ok({ a: "after retry" })]);
  const model = makeModel({ apiKey: "k", log: () => {}, fetch: f.fn });
  assert.deepEqual((await model({ purpose: "exec", system: "S", user: "U", schema: SCHEMA })).json, { a: "after retry" });
  const g = fakeFetch([() => ({ status: 401, body: { error: { message: "bad key" } } })]);
  const m2 = makeModel({ apiKey: "k", log: () => {}, fetch: g.fn });
  const r = await m2({ purpose: "exec", system: "S", user: "U", schema: SCHEMA });
  assert.equal(r.json, null);
  assert.match(r.error!, /401/);
  assert.equal(g.seen.length, 1);
});
