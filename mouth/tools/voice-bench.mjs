#!/usr/bin/env node
// Voice vendor bench: time to first audio and tool-call round trip on a fixed script, per
// configured vendor/model. Writes JSON to mouth/logs/voice-bench-<time>.json.
//
//   node tools/voice-bench.mjs                 # every target whose key is in the root .env
//   node tools/voice-bench.mjs --dry-run       # plumbing only: a local fake server, no key, no cost
//   node tools/voice-bench.mjs --runs 3 --targets realtime:gpt-realtime-2.1-mini,live:gpt-live-1.1
//
// Targets (all over WebSocket from the laptop, so numbers exclude phone WebRTC setup):
//   realtime:<model>  OpenAI Realtime (wss://api.openai.com/v1/realtime?model=...). Script:
//     1. say    - response.create with a SAY line (Mind narration)        -> ms to first audio
//     2. chat   - user text "Hi Bobby, how are you?"                      -> ms to first audio
//     3. tool   - user text "Text Alex I'm running late"                  -> ms to the request() call,
//                 then function_call_output + response.create            -> ms to first audio of the ack
//   live:<model>      GPT-Live (wss://api.openai.com/v1/live/sessions). Script: session.start ->
//     session.started (ms), then session.commentary.append (a Mind line) -> ms to first audio.
//     GPT-Live takes audio, not typed user turns, so the tool round trip needs recorded speech:
//     reported as null.
// Gemini Live (and the removed ElevenLabs voice) are reference points in VOICE-VENDORS.md; not benched here.
import { WebSocket, WebSocketServer } from "ws";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const dry = args.includes("--dry-run");
const runs = Number(opt("runs", "2"));
const rootEnv = join(here, "..", "..", ".env");
const env = {};
if (existsSync(rootEnv)) for (const l of readFileSync(rootEnv, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const key = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || "";
const targets = (opt("targets", "realtime:gpt-realtime-2.1-mini,realtime:gpt-realtime-2.1,live:gpt-live-1.1")).split(",").map((t) => t.trim()).filter(Boolean);
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOOLS = [{ type: "function", name: "request", description: "Send what the user wants done on the phone to the phone brain.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }];
const INSTR = "You are Bobby, a brief friendly voice assistant. For anything to do on the phone, call request(text) and then say two or three words. Lines marked SAY: say them right away.";

function open(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const waiters = [];
    ws.on("message", (d) => {
      const e = JSON.parse(String(d));
      for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    });
    ws.on("open", () => resolve({
      send: (e) => ws.send(JSON.stringify(e)),
      next: (pred, ms = 20000) => new Promise((res, rej) => { const w = { pred, resolve: (e) => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error("timeout")); }, ms); waiters.push(w); }),
      close: () => ws.close(),
    }));
    ws.on("error", reject);
  });
}

async function benchRealtime(model, base, headers) {
  const t0 = now();
  const c = await open(`${base}/v1/realtime?model=${encodeURIComponent(model)}`, headers);
  await c.next((e) => e.type === "session.created");
  const connectMs = now() - t0;
  c.send({ type: "session.update", session: { type: "realtime", instructions: INSTR, tools: TOOLS, tool_choice: "auto", audio: { output: { voice: "marin" } } } });
  await c.next((e) => e.type === "session.updated").catch(() => {});
  const firstAudio = () => c.next((e) => e.type === "response.output_audio.delta" || e.type === "response.audio.delta");
  const done = () => c.next((e) => e.type === "response.done", 30000);
  // 1. SAY line
  let t = now();
  c.send({ type: "response.create", response: { instructions: 'SAY, right now, in your own voice: "Opening Sarah\'s email."' } });
  await firstAudio();
  const sayMs = now() - t;
  await done();
  // 2. chat
  c.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi Bobby, how are you?" }] } });
  t = now();
  c.send({ type: "response.create" });
  await firstAudio();
  const chatMs = now() - t;
  await done();
  // 3. tool call, then the acknowledgement after the tool result
  c.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Text Alex I'm running late" }] } });
  t = now();
  c.send({ type: "response.create" });
  const call = await c.next((e) => e.type === "response.output_item.done" && e.item?.type === "function_call", 30000).catch(() => null);
  const toolCallMs = call ? now() - t : null;
  let ackMs = null;
  if (call) {
    await done().catch(() => {});
    c.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.item.call_id, output: JSON.stringify({ accepted: true }) } });
    t = now();
    c.send({ type: "response.create" });
    await firstAudio().catch(() => null);
    ackMs = now() - t;
    await done().catch(() => {});
  }
  c.close();
  return { connectMs, sayFirstAudioMs: sayMs, chatFirstAudioMs: chatMs, toolCallMs, toolName: call?.item?.name ?? null, toolArgs: call?.item?.arguments ?? null, ackFirstAudioMs: ackMs };
}

async function benchLive(model, base, headers) {
  const t0 = now();
  const c = await open(`${base}/v1/live/sessions`, headers);
  c.send({ type: "session.start", event_id: "start", session: { model, instructions: "You are Bobby, brief and friendly. Say update lines from your backend aloud.", audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } }, delegation: { type: "client" } } });
  await c.next((e) => e.type === "session.started");
  const startMs = now() - t0;
  const t = now();
  c.send({ type: "session.commentary.append", event_id: "line1", delegation_id: null, content: "Opening Sarah's email." });
  await c.next((e) => e.type === "session.output_audio.delta");
  const lineMs = now() - t;
  c.send({ type: "session.close", event_id: "close" });
  await c.next((e) => e.type === "session.closed", 10000).catch(() => {});
  c.close();
  return { connectMs: startMs, sayFirstAudioMs: lineMs, chatFirstAudioMs: null, toolCallMs: null, ackFirstAudioMs: null, note: "tool round trip needs audio input" };
}

/** Dry run: a local server that speaks just enough of both protocols, with fixed delays. */
function fakeServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws, req) => {
    const send = (e, ms = 0) => setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(e)), ms);
    const live = req.url.startsWith("/v1/live");
    if (!live) send({ type: "session.created", session: { id: "sess_fake" } }, 20);
    let pendingTool = false;
    ws.on("message", (d) => {
      const e = JSON.parse(String(d));
      if (e.type === "session.update") send({ type: "session.updated" }, 5);
      if (e.type === "session.start") send({ type: "session.started", session: { id: "live_fake" } }, 30);
      if (e.type === "session.commentary.append") send({ type: "session.output_audio.delta", delta: "AA" }, 40);
      if (e.type === "session.close") send({ type: "session.closed" }, 5);
      if (e.type === "conversation.item.create" && e.item?.role === "user" && /Text Alex/.test(e.item.content?.[0]?.text ?? "")) pendingTool = true;
      if (e.type === "response.create") {
        if (pendingTool) {
          pendingTool = false;
          send({ type: "response.output_item.done", item: { type: "function_call", name: "request", arguments: '{"text":"Text Alex I\'m running late"}', call_id: "call_1" } }, 60);
          send({ type: "response.done" }, 65);
        } else {
          send({ type: "response.output_audio.delta", delta: "AA" }, 50);
          send({ type: "response.done" }, 80);
        }
      }
    });
  });
  return new Promise((r) => wss.on("listening", () => r({ base: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() })));
}

const out = { at: new Date().toISOString(), dryRun: dry, runs, results: [] };
if (!dry && !key) {
  console.log("voice-bench: no OPENAI_API_KEY in the root .env; run with --dry-run to check the plumbing");
  process.exit(2);
}
const fake = dry ? await fakeServer() : null;
const base = fake ? fake.base : "wss://api.openai.com";
const headers = dry ? {} : { Authorization: `Bearer ${key}` };
for (const target of targets) {
  const [kind, model] = target.split(":");
  for (let i = 0; i < runs; i++) {
    try {
      const r = kind === "live" ? await benchLive(model, base, headers) : await benchRealtime(model, base, headers);
      out.results.push({ target, run: i + 1, ok: true, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v])) });
    } catch (e) {
      out.results.push({ target, run: i + 1, ok: false, error: String(e?.message ?? e) });
    }
    await sleep(200);
  }
}
fake?.close();
const logs = join(here, "..", "logs");
mkdirSync(logs, { recursive: true });
const file = join(logs, `voice-bench-${out.at.replace(/[:.]/g, "-")}${dry ? "-dry" : ""}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.table(out.results.map((r) => ({ target: r.target, run: r.run, ok: r.ok, connect: r.connectMs, say: r.sayFirstAudioMs, chat: r.chatFirstAudioMs, tool: r.toolCallMs, ack: r.ackFirstAudioMs, error: r.error })));
console.log(`voice-bench: wrote ${file}`);
process.exit(out.results.every((r) => r.ok) ? 0 : 1);
