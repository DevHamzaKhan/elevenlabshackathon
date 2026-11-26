// The real Caller: an outbound phone call carried by GPT-Live over a SIP trunk (e.g. Twilio
// Elastic SIP Trunking), in a stock voice.
// Plain TypeScript (fetch, WebSocket, timers): runs on the phone and in Node.
//
// Flow (developers.openai.com/api/docs/guides/voice-sip "Place an outbound call", and
// /voice-server-controls "Attach to the existing session", checked 2026-11-24):
//   1. POST /v1/live/sessions with the session (model, instructions, voice, client delegation) and
//      transport {type:"sip", destination, trunk:{provider_url, auth:{digest}, caller_number}}.
//      No public webhook or bridge is needed for outbound calls.
//   2. Attach the sideband WebSocket wss://api.openai.com/v1/live/sessions/{id}/attach at once
//      (it replays only 3 s), dedupe by event_id, follow transport.ringing/answered/failed.
//   3. On answer: session.instructions.append with the exact AI disclosure.
//   4. Collect session.input_transcript.delta (them) / session.output_transcript.delta (me).
//   5. The model "delegates" when the conversation is over: we hang up (POST .../hangup). Also
//      on `hangup` from the Mind, the Caller stopping, or the length cap.
//   6. session.closed -> ended; summary (CALLER_SUMMARY_MODEL via Responses, else their words).
// Every call ends in exactly one call_result.

import type { Frame } from "./hub";
import { allowlist, E164, type Line } from "./caller";

export const OPENAI_API = "https://api.openai.com/v1";
export const DEFAULT_CALLER_MODEL = "gpt-live-1.1";
export const DEFAULT_CALLER_VOICE = "marin";
export const DEFAULT_SUMMARY_MODEL = "gpt-6-luna";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveCallDeps {
  env: Record<string, string | undefined>;
  send: (f: Frame) => void;
  log: (line: string) => void;
  fetch?: FetchLike;
  /** Opens the sideband with an Authorization header. Default: React Native's WebSocket(url, protocols, {headers}). */
  connect?: (url: string, headers: Record<string, string>) => SocketLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** True once the Mind sent `hangup` for this call, or the Caller is stopping. */
  cancelled?: () => boolean;
  /** Longest call before we hang up. */
  maxCallMs?: number;
  /** Wait after the model's goodbye before hanging up. */
  goodbyeMs?: number;
}

export function disclosure(env: Record<string, string | undefined>): string {
  const owner = (env.CALLER_OWNER_NAME ?? "").trim();
  return `Hi, this is Bobby, an AI assistant calling on behalf of ${owner || "my owner"}.`;
}

export function callerInstructions(goal: string, context: string, env: Record<string, string | undefined>): string {
  return `You are Bobby, an AI assistant making a short phone call on behalf of the phone's owner. You are not the owner and never pretend to be a person.
Goal of this call: ${goal || "Say hello."}
${context ? `Context: ${context}\n` : ""}Start with the disclosure you are given, then get to the goal in one or two friendly sentences. Listen to the answer. If they ask something you don't know, say you'll pass it on. Once you have an answer (or they can't talk), thank them, say goodbye, and then ask your backend for help to end the call; that hangs up. Keep it under a minute. ${env.CALLER_EXTRA_INSTRUCTIONS ?? ""}`.trim();
}

/** The body for POST /v1/live/sessions. */
export function liveSessionBody(msg: Frame, env: Record<string, string | undefined>) {
  return {
    session: {
      model: (env.CALLER_MODEL ?? "").trim() || DEFAULT_CALLER_MODEL,
      instructions: callerInstructions(String(msg.goal ?? ""), String(msg.context ?? ""), env),
      audio: { output: { voice: (env.CALLER_VOICE ?? "").trim() || DEFAULT_CALLER_VOICE } },
      delegation: { type: "client" },
    },
    transport: {
      type: "sip",
      destination: String(msg.number ?? ""),
      trunk: {
        provider_url: env.CALLER_SIP_URL ?? "",
        auth: { type: "digest", username: env.CALLER_SIP_USERNAME ?? "", password: env.CALLER_SIP_PASSWORD ?? "" },
        caller_number: env.OWNER_NUMBER ?? "",
      },
    },
  };
}

/** transport.failed error -> contract error. */
export function failureOf(e: any): string {
  const s = `${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (/busy|486/.test(s)) return "busy";
  if (/no.?answer|timeout|408|480|ring/.test(s)) return "no_answer";
  if (/not.?allowed|forbidden|403|603/.test(s)) return "not_allowed";
  return "failed";
}

/** Appends a transcript delta to the running lines, merging consecutive fragments by speaker. */
export function addDelta(lines: Line[], who: Line["who"], delta: string) {
  if (!delta) return;
  const last = lines[lines.length - 1];
  if (last && last.who === who) last.text += delta;
  else lines.push({ who, text: delta.replace(/^\s+/, "") });
}

const twoSentences = (s: string) => (s.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).slice(0, 2).join("").trim();

/** One or two sentences on what the other person said: a small model if configured, else their words. */
export async function summarizeCall(transcript: Line[], goal: string, env: Record<string, string | undefined>, f: FetchLike, log: (l: string) => void): Promise<string> {
  const theirs = transcript.filter((l) => l.who === "them").map((l) => l.text.trim()).filter(Boolean).join(" ");
  if (!theirs) return "They didn't say anything.";
  const key = env.OPENAI_API_KEY ?? "";
  if (key) {
    try {
      const res = await f(`${OPENAI_API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: (env.CALLER_SUMMARY_MODEL ?? "").trim() || DEFAULT_SUMMARY_MODEL,
          reasoning: { effort: "none" },
          store: false,
          input: [
            { role: "developer", content: [{ type: "input_text", text: "Summarize in one or two short sentences what the other person said on this phone call, for the phone's owner. Refer to them as 'they' or by name; never 'the user'. Plain text." }] },
            { role: "user", content: [{ type: "input_text", text: `Goal of the call: ${goal}\n\nTranscript:\n${transcript.map((l) => `${l.who === "me" ? "Bobby" : "Them"}: ${l.text.trim()}`).join("\n")}` }] },
          ],
          max_output_tokens: 200,
        }),
      });
      const body = JSON.parse(await res.text());
      const text = (body.output ?? []).filter((o: any) => o.type === "message").flatMap((o: any) => o.content ?? []).filter((p: any) => p.type === "output_text").map((p: any) => p.text).join("").trim();
      if (res.ok && text) return twoSentences(text);
      log(`caller: summary model failed (${res.status}); using their own words`);
    } catch (e) {
      log(`caller: summary failed (${String(e)}); using their own words`);
    }
  }
  return `They said: ${twoSentences(theirs)}`;
}

function defaultConnect(url: string, headers: Record<string, string>): SocketLike {
  const WS = (globalThis as any).WebSocket;
  return new WS(url, undefined, { headers }); // React Native accepts headers as the third argument
}

/** Places one call through GPT-Live over SIP and sends its call_status frames and one call_result. */
export async function liveCall(msg: Frame, d: LiveCallDeps): Promise<void> {
  const re = String(msg.id ?? "");
  const env = d.env;
  const f: FetchLike = d.fetch ?? (globalThis as any).fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const cancelled = d.cancelled ?? (() => false);
  let lastStatus = "";
  let finished = false;
  const status = (s: string) => {
    if (s === lastStatus || finished) return;
    lastStatus = s;
    d.send({ type: "call_status", re, status: s });
  };
  const result = (fields: Record<string, unknown>) => {
    if (finished) return;
    if (fields.ok === false && lastStatus && lastStatus !== "ended" && lastStatus !== "failed") {
      lastStatus = "failed";
      d.send({ type: "call_status", re, status: "failed" });
    }
    finished = true;
    d.send({ type: "call_result", re, ...fields });
  };

  const number = String(msg.number ?? "");
  if (!E164.test(number) || !allowlist(env).includes(number)) return void result({ ok: false, error: "not_allowed" });
  const missing = ["OPENAI_API_KEY", "CALLER_SIP_URL", "CALLER_SIP_USERNAME", "CALLER_SIP_PASSWORD", "OWNER_NUMBER"].filter((k) => !(env[k] ?? "").trim());
  if (missing.length) {
    d.log(`caller: can't place a real call, missing ${missing.join(", ")}`);
    return void result({ ok: false, error: "not_configured" });
  }
  const key = env.OPENAI_API_KEY!;
  const auth = { Authorization: `Bearer ${key}` };
  const transcript: Line[] = [];
  let sessionId = "";
  let answered = false;
  let closed = false;
  let failure = "";
  let endRequested = false;
  let hungUp = false;
  let hungUpAt = 0;
  const seen = new Set<string>();
  let sock: SocketLike | null = null;

  const hangup = async (why: string) => {
    if (hungUp || !sessionId) return;
    hungUp = true;
    hungUpAt = now();
    d.log(`caller: hanging up (${why})`);
    try {
      await f(`${OPENAI_API}/live/sessions/${encodeURIComponent(sessionId)}/hangup`, { method: "POST", headers: auth });
    } catch (e) {
      d.log(`caller: hangup request failed: ${String(e)}`);
    }
  };

  try {
    status("dialing");
    const res = await f(`${OPENAI_API}/live/sessions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(liveSessionBody(msg, env)) });
    const text = await res.text();
    if (!res.ok) {
      d.log(`caller: live session create ${res.status}: ${text.slice(0, 200)}`);
      return void result({ ok: false, error: "failed" });
    }
    sessionId = String(JSON.parse(text)?.session?.id ?? "");
    if (!sessionId) return void result({ ok: false, error: "failed" });
    d.log(`caller: session ${sessionId} dialing ${number}`);

    const connect = d.connect ?? defaultConnect;
    sock = connect(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, auth);
    sock.onmessage = (ev) => {
      let e: any;
      try {
        e = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!e || typeof e.type !== "string") return;
      if (e.event_id) {
        if (seen.has(e.event_id)) return; // replayed on attach
        seen.add(e.event_id);
      }
      switch (e.type) {
        case "transport.ringing":
          status("dialing");
          break;
        case "transport.answered":
          answered = true;
          status("answered");
          sock?.send(JSON.stringify({ type: "session.instructions.append", event_id: `disclose_${re}`, delegation_id: null, content: `Immediately say the following disclosure exactly and in full before anything else: ${disclosure(env)}` }));
          break;
        case "transport.failed":
          failure = failureOf(e.error);
          break;
        case "session.input_transcript.delta":
          addDelta(transcript, "them", String(e.delta ?? ""));
          break;
        case "session.output_transcript.delta":
          addDelta(transcript, "me", String(e.delta ?? ""));
          break;
        case "session.delegation.created":
          endRequested = true; // the model's signal that the conversation is over
          break;
        case "session.closed":
          closed = true;
          break;
        default:
          break;
      }
    };
    sock.onclose = () => {
      closed = true;
    };
    sock.onerror = () => {};

    const deadline = now() + (d.maxCallMs ?? 5 * 60_000);
    let endAt = 0;
    while (!closed && !failure) {
      if (cancelled()) await hangup("asked to hang up");
      else if (now() > deadline) await hangup("call too long");
      else if (endRequested && !endAt) endAt = now() + (d.goodbyeMs ?? 1500);
      else if (endAt && now() >= endAt) await hangup("conversation over");
      if (hungUp && now() > hungUpAt + 10_000) break; // closed never came
      await sleep(200);
    }
    try {
      sock.close();
    } catch {}
    if (failure) return void result({ ok: false, error: failure });
    if (!answered) return void result({ ok: false, error: cancelled() ? "cancelled" : "no_answer" });
    status("ended");
    if (!transcript.some((l) => l.who === "them" && l.text.trim())) {
      return void result(cancelled() ? { ok: false, error: "cancelled" } : { ok: true, summary: "They picked up but didn't say anything.", transcript });
    }
    const summary = await summarizeCall(transcript, String(msg.goal ?? ""), env, f, d.log);
    result({ ok: true, summary, transcript: transcript.map((l) => ({ who: l.who, text: l.text.trim() })) });
  } catch (e) {
    d.log(`caller: call failed: ${e instanceof Error ? e.message : String(e)}`);
    await hangup("error");
    result({ ok: false, error: "failed" });
  } finally {
    if (!finished) result({ ok: false, error: "failed" });
  }
}
