// Protocol v2 in the Mouth (mind/PROTOCOL-V2.md): the voice model's tool calls become
// request/amend/cancel/confirm_reply/status; progress/confirm_request/task_update from the Mind;
// barge_in; and the OpenAI Realtime plain-TS half (session config, client secret, SDP, events).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Mouth } from "../src/mouth";
import type { Frame } from "../src/hub";
import type { VoiceCallbacks, VoiceSession } from "../src/voice";
import { BOBBY_TOOLS, ev, exchangeSdp, mintClientSecret, sessionConfig, translator } from "../src/realtime";
import { voiceChoice } from "../src/vendors";

class ToolVoice implements VoiceSession {
  readonly tools = true;
  cb!: VoiceCallbacks;
  spoken: string[] = [];
  context: string[] = [];
  results: { callId: string; output: any; respond: boolean }[] = [];
  userMessages: string[] = [];
  interrupts = 0;
  mic: boolean[] = [];
  sendUserMessage(t: string) { this.userMessages.push(t); }
  sendContextualUpdate(t: string) { this.context.push(t); }
  speak(t: string) { this.spoken.push(t); }
  toolResult(callId: string, output: string, respond: boolean) { this.results.push({ callId, output: JSON.parse(output), respond }); }
  interrupt() { this.interrupts++; }
  setMicMuted(m: boolean) { this.mic.push(m); }
  async end() {}
}

const made: Mouth[] = [];
afterEach(async () => {
  for (const m of made.splice(0)) await m.sleep();
});

async function live() {
  const sent: Frame[] = [];
  const v = new ToolVoice();
  const m = new Mouth({ send: (f) => sent.push(f), voice: async (cb) => ((v.cb = cb), v), log: () => {}, listenSettleMs: 0 });
  made.push(m);
  await m.wake();
  return { m, v, sent, of: (t: string) => sent.filter((f) => f.type === t) };
}

test("wake announces voice_caps v2 (tools) before wake", async () => {
  const s = await live();
  assert.deepEqual(s.sent.slice(0, 2).map((f) => f.type), ["voice_caps", "wake"]);
  assert.equal(s.sent[0].v, 2);
  assert.deepEqual(s.sent[0].tools, ["request", "amend", "cancel", "confirm", "status"]);
});

test("request tool -> `request` with the raw transcript; the model may acknowledge (respond:true)", async () => {
  const s = await live();
  s.v.cb.onUserTranscript("uh send an email to hamza saying i'm late");
  s.v.cb.onToolCall!("request", { text: "Send an email to Hamza saying I'm late" }, "c1");
  const r = s.of("request")[0];
  assert.equal(r.text, "Send an email to Hamza saying I'm late");
  assert.equal(r.heard, "uh send an email to hamza saying i'm late");
  assert.equal(s.v.results[0].callId, "c1");
  assert.equal(s.v.results[0].respond, true);
  assert.equal(s.v.results[0].output.accepted, true);
});

test("amend, cancel(scope) and status tools", async () => {
  const s = await live();
  s.v.cb.onToolCall!("amend", { text: "make it 4" }, "c1");
  s.v.cb.onToolCall!("cancel", { scope: "current" }, "c2");
  s.v.cb.onToolCall!("status", {}, "c3");
  assert.equal(s.of("amend")[0].text, "make it 4");
  assert.equal(s.of("cancel")[0].scope, "current");
  const st = s.of("status")[0];
  s.m.onHub({ type: "status_result", re: st.id, to: "mouth", text: "Reply to Sarah: on step 2 of 4." });
  const res = s.v.results.find((x) => x.callId === "c3")!;
  assert.match(res.output.status, /step 2 of 4/);
});

test("confirm_request: asked aloud, mic opened, confirm tool -> confirm_reply with ok and the raw transcript", async () => {
  const s = await live();
  s.m.onHub({ type: "confirm_request", to: "mouth", id: "m7", task: "t1", summary: 'Email to Hamza: "I\'m late"', risk: "irreversible" });
  assert.match(s.v.spoken[0], /Email to Hamza: "I'm late"\. Should I go ahead\?/);
  assert.ok(s.v.context.some((c) => /CONFIRM id=m7/.test(c)));
  assert.equal(s.v.mic[s.v.mic.length - 1], false, "mic open for the answer");
  s.v.cb.onUserTranscript("yeah go ahead");
  s.v.cb.onToolCall!("confirm", { id: "m7", answer: "yes" }, "c9");
  assert.deepEqual(s.of("confirm_reply")[0], { type: "confirm_reply", re: "m7", ok: true, heard: "yeah go ahead" });
  assert.equal(s.v.results[0].respond, false, "no speech until the Mind's update");
});

test("progress: silent is context, when_idle queues, interrupt hushes first; no say_done for them", async () => {
  const s = await live();
  s.m.onHub({ type: "progress", to: "mouth", task: "t1", text: "Gmail is open.", priority: "silent" });
  assert.deepEqual(s.v.context, ["UPDATE: Gmail is open."]);
  s.m.onHub({ type: "progress", to: "mouth", task: "t1", text: "Writing to Hamza.", priority: "when_idle" });
  assert.deepEqual(s.v.spoken, ["Writing to Hamza."]);
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "progress", to: "mouth", task: "t1", text: "Sent it.", priority: "when_idle" });
  assert.equal(s.v.spoken.length, 1, "waits while speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.v.spoken, ["Writing to Hamza.", "Sent it."]);
  s.v.cb.onModeChange("speaking");
  s.m.onHub({ type: "progress", to: "mouth", task: "t1", text: "Stopped.", priority: "interrupt" });
  assert.ok(s.v.interrupts >= 1);
  assert.equal(s.of("say_done").length, 0);
  assert.equal(s.of("say_started").length, 0);
});

test("barge_in: speech while a task runs (not while confirming), at most every 2 s", async () => {
  const s = await live();
  s.v.cb.onSpeechStarted!();
  assert.equal(s.of("barge_in").length, 0, "no task running");
  s.m.onHub({ type: "task_update", to: "mouth", task: "t1", status: "running" });
  s.v.cb.onSpeechStarted!();
  s.v.cb.onSpeechStarted!();
  assert.equal(s.of("barge_in").length, 1);
  s.m.onHub({ type: "task_update", to: "mouth", task: "t1", status: "done" });
  s.v.cb.onSpeechStarted!();
  assert.equal(s.of("barge_in").length, 1);
});

test("v1 still works: say gets say_started/say_done and is spoken through speak()", async () => {
  const s = await live();
  s.m.onHub({ type: "say", to: "mouth", id: "m1", text: "Finding Gmail." });
  assert.deepEqual(s.v.spoken, ["Finding Gmail."]);
  s.v.cb.onModeChange("speaking");
  s.v.cb.onModeChange("listening");
  assert.deepEqual(s.sent.filter((f) => f.re === "m1").map((f) => f.type), ["say_started", "say_done"]);
});

// ---------- OpenAI Realtime, plain-TS half ----------

test("session config: model from env, semantic VAD, transcription, Bobby's five tools, voice", () => {
  const c = sessionConfig({ model: "gpt-realtime-2.1", voice: "cedar" });
  assert.equal(c.type, "realtime");
  assert.equal(c.model, "gpt-realtime-2.1");
  assert.equal(c.audio.output.voice, "cedar");
  assert.equal(c.audio.input.turn_detection.type, "semantic_vad");
  assert.ok(c.audio.input.transcription.model);
  assert.deepEqual(c.tools.map((t) => t.name), ["request", "amend", "cancel", "confirm", "status"]);
  for (const t of BOBBY_TOOLS) assert.equal(t.type, "function");
  assert.match(c.instructions, /Never say a task is done/);
  assert.equal(sessionConfig().model, "gpt-realtime-2.1-mini");
});

test("client secret and SDP exchange: URLs, headers, errors (fetch stubbed)", async () => {
  const seen: any[] = [];
  const f = async (url: string, init: any) => {
    seen.push({ url, init });
    if (url.endsWith("/client_secrets")) return { ok: true, status: 200, text: async () => JSON.stringify({ value: "ek_123", expires_at: 1 }) };
    return { ok: true, status: 201, text: async () => "v=0 answer" };
  };
  assert.equal(await mintClientSecret("sk-x", sessionConfig(), f), "ek_123");
  assert.equal(seen[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(seen[0].init.headers.Authorization, "Bearer sk-x");
  assert.equal(JSON.parse(seen[0].init.body).session.type, "realtime");
  assert.equal(await exchangeSdp("ek_123", "v=0 offer", f), "v=0 answer");
  assert.equal(seen[1].url, "https://api.openai.com/v1/realtime/calls");
  assert.equal(seen[1].init.headers["Content-Type"], "application/sdp");
  assert.equal(seen[1].init.headers.Authorization, "Bearer ek_123");
  const bad = async () => ({ ok: false, status: 401, text: async () => "nope" });
  await assert.rejects(mintClientSecret("sk-x", {}, bad), /401/);
});

test("server events -> callbacks: transcripts, speaking/listening, tool calls once, speech start", () => {
  const got: string[] = [];
  const cb: VoiceCallbacks = {
    onConnect: () => got.push("connect"),
    onDisconnect: () => got.push("disconnect"),
    onUserTranscript: (t) => got.push(`user:${t}`),
    onAgentResponse: (t) => got.push(`agent:${t}`),
    onModeChange: (m) => got.push(`mode:${m}`),
    onError: (m) => got.push(`error:${m}`),
    onToolCall: (n, a, id) => got.push(`tool:${n}:${JSON.stringify(a)}:${id}`),
    onSpeechStarted: () => got.push("speech"),
  };
  const on = translator(cb);
  on({ type: "session.created" });
  on({ type: "input_audio_buffer.speech_started" });
  on({ type: "conversation.item.input_audio_transcription.completed", transcript: "text alex" });
  on({ type: "response.output_item.done", item: { type: "function_call", name: "request", arguments: '{"text":"Text Alex"}', call_id: "c1" } });
  on({ type: "response.output_item.done", item: { type: "function_call", name: "request", arguments: '{"text":"Text Alex"}', call_id: "c1" } });
  on({ type: "output_audio_buffer.started" });
  on({ type: "response.output_audio_transcript.done", transcript: "On it." });
  on({ type: "output_audio_buffer.stopped" });
  on({ type: "error", error: { message: "boom" } });
  on({ type: "something.new" });
  assert.deepEqual(got, ["connect", "speech", "user:text alex", 'tool:request:{"text":"Text Alex"}:c1', "mode:speaking", "agent:On it.", "mode:listening", "error:boom"]);
  assert.equal(ev.say("Hi").type, "response.create");
  assert.equal(ev.toolOutput("c1", "{}").item.type, "function_call_output");
  assert.equal(ev.context("x").item.role, "system");
});

test("voice vendor choice from env", () => {
  assert.deepEqual(voiceChoice({ OPENAI_API_KEY: "k" }), { vendor: "openai", model: "gpt-realtime-2.1-mini", missing: null });
  assert.equal(voiceChoice({ MOUTH_VOICE_MODEL: "gpt-realtime-2.1" }).missing, "OPENAI_API_KEY");
  assert.equal(voiceChoice({ MOUTH_VOICE_VENDOR: "elevenlabs", ELEVENLABS_BOBBY_AGENT_ID: "a" }).vendor, "elevenlabs");
});

test("a confirmation is dropped when its task finishes, so speech can barge in again", async () => {
  const s = await live();
  s.m.onHub({ type: "task_update", task: "t1", status: "running" });
  s.m.onHub({ type: "confirm_request", id: "c1", task: "t1", summary: "Send it" });
  s.m.onHub({ type: "task_update", task: "t1", status: "failed" });
  s.m.onHub({ type: "task_update", task: "t2", status: "running" });
  s.v.cb.onSpeechStarted!();
  assert.equal(s.of("barge_in").length, 1);
});
