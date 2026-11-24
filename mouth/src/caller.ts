// The Caller (CONTRACT.md v1, "Caller"). Plain TypeScript: fetch, WebSocket and timers only,
// so it runs the same in Node (tests, tools/caller.mjs) and React Native (the app).
//
// On a `call` it checks the number against CALL_ALLOWLIST, then (unless CALLER_DRY_RUN is
// exactly "0") fakes the call, or dials it with the caller agent:
//   route "owner":  ElevenLabs register-call gives TwiML for the caller agent; Twilio's REST API
//                   places the call from OWNER_NUMBER (a verified caller ID) with that TwiML.
//   route "bought": if Twilio refuses OWNER_NUMBER as the caller ID, ElevenLabs' outbound-call
//                   API dials from the imported Twilio number (ELEVENLABS_PHONE_NUMBER_ID).
// Progress comes from polling Twilio's call resource; the transcript and summary come from the
// ElevenLabs conversation once the call has ended. Every call ends in exactly one call_result.
import { connectHub, type Frame, type Hub, type HubOptions } from "./hub";
import { liveCall, type LiveCallDeps } from "./caller-live";
import { callerChoice } from "./vendors";

export const E164 = /^\+[1-9]\d{6,14}$/;
export const ELEVENLABS_API = "https://api.elevenlabs.io";
export const TWILIO_API = "https://api.twilio.com/2010-04-01";
/** Twilio errors that mean "this From number can't be used as the caller ID". */
export const TWILIO_BAD_FROM = [21210, 21212, 21213, 21214, 21606, 21608];

export function allowlist(env: Record<string, string | undefined>): string[] {
  return (env.CALL_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** CALLER_DRY_RUN defaults to 1: only the exact value "0" places real calls. */
export function isDryRun(env: Record<string, string | undefined>): boolean {
  return (env.CALLER_DRY_RUN ?? "1").trim() !== "0";
}

function notAllowed(msg: Frame, allowed: string[]): Frame | null {
  const number = String(msg.number ?? "");
  if (E164.test(number) && allowed.includes(number)) return null; // an empty allowlist allows nothing
  return { type: "call_result", re: String(msg.id ?? ""), ok: false, error: "not_allowed" };
}

/** The frames one call produces in dry-run mode, in order. */
export function dryRunCall(msg: Frame, allowed: string[]): Frame[] {
  const re = String(msg.id ?? "");
  const refused = notAllowed(msg, allowed);
  if (refused) return [refused];
  const goal = String(msg.goal ?? "");
  return [
    { type: "call_status", re, status: "dialing" },
    { type: "call_status", re, status: "answered" },
    { type: "call_status", re, status: "ended" },
    {
      type: "call_result", re, ok: true,
      summary: "Dry run: no call was placed. They said that works for them.",
      transcript: [{ who: "me", text: `Hi, this is Bobby, an AI assistant calling for my owner. ${goal || "Just saying hello."}` }, { who: "them", text: "Sure, that works." }],
    },
  ];
}

// ---------------------------------------------------------------- real calls

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CallDeps {
  env: Record<string, string | undefined>;
  send: (f: Frame) => void;
  log: (line: string) => void;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Twilio status poll interval. */
  pollMs?: number;
  /** Give up on a call (and hang it up) after this long. */
  maxCallMs?: number;
  /** How long to wait for ElevenLabs to finish the transcript after the call ends. */
  transcriptWaitMs?: number;
  /** Set to true to abandon the call (hangs it up). */
  cancelled?: () => boolean;
}

export type Line = { who: "me" | "them"; text: string };

/** Drops the voice model's expression tags ("[sorry] Hey" -> "Hey"): they're directions, not words. */
export function stripTags(text: string): string {
  return text.replace(/\[[a-z][a-z \-]{0,30}\]\s*/gi, "").replace(/\s{2,}/g, " ").trim();
}

class ApiError extends Error {
  constructor(message: string, public status: number, public body: any) { super(message); }
}

/** application/x-www-form-urlencoded, without URLSearchParams (incomplete in some RN versions). */
export function form(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
const qs = (fields: Record<string, string | number>) =>
  Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

/** Twilio call status -> contract status, plus the error for terminal failures. */
export function mapTwilioStatus(s: string): { status: "dialing" | "answered" | "ended" | "failed"; error?: string } {
  switch (s) {
    case "in-progress": return { status: "answered" };
    case "completed": return { status: "ended" };
    case "busy": return { status: "failed", error: "busy" };
    case "no-answer": return { status: "failed", error: "no_answer" };
    case "failed":
    case "canceled": return { status: "failed", error: "failed" };
    default: return { status: "dialing" }; // queued, initiated, ringing
  }
}

/** ElevenLabs transcript -> contract transcript ("me" is the caller agent speaking as the owner). */
export function toTranscript(items: unknown): Line[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((t) => ({ who: (t?.role === "agent" ? "me" : "them") as Line["who"], text: stripTags(String(t?.message ?? "")) }))
    .filter((l) => l.text);
}

const twoSentences = (s: string) => (s.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).slice(0, 2).join("").trim();

/** One or two sentences on what the other person said: the caller agent's `their_answer` data
 *  collection item (set up by agent/setup.mjs), else ElevenLabs' call summary, else their own words. */
export function summarize(conv: any, transcript: Line[]): string {
  const answer = conv?.analysis?.data_collection_results?.their_answer?.value;
  if (typeof answer === "string" && answer.trim()) return twoSentences(answer.trim());
  const summary = conv?.analysis?.transcript_summary;
  if (typeof summary === "string" && summary.trim()) return twoSentences(summary.trim());
  const theirs = transcript.filter((l) => l.who === "them").map((l) => l.text).join(" ");
  return theirs ? `They said: ${twoSentences(theirs)}` : "They didn't say anything.";
}

/** Places one real call and sends its call_status frames and exactly one call_result. */
export async function realCall(msg: Frame, d: CallDeps): Promise<void> {
  const re = String(msg.id ?? "");
  const env = d.env;
  const doFetch: FetchLike = d.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const cancelled = d.cancelled ?? (() => false);
  const pollMs = d.pollMs ?? 2000;
  let finished = false;
  let lastStatus = "";
  const status = (s: string) => {
    if (s === lastStatus) return;
    lastStatus = s;
    d.send({ type: "call_status", re, status: s });
  };
  const result = (f: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    d.send({ type: "call_result", re, ...f });
  };
  const fail = (error: string) => {
    if (lastStatus && lastStatus !== "ended") status("failed");
    result({ ok: false, error });
  };

  const refused = notAllowed(msg, allowlist(env));
  if (refused) return void result({ ok: false, error: "not_allowed" });

  const elKey = env.ELEVENLABS_API_KEY ?? "";
  const agentId = env.ELEVENLABS_CALLER_AGENT_ID ?? "";
  const sid = env.TWILIO_ACCOUNT_SID ?? "";
  const token = env.TWILIO_AUTH_TOKEN ?? "";
  const owner = env.OWNER_NUMBER ?? "";
  const phoneNumberId = env.ELEVENLABS_PHONE_NUMBER_ID ?? "";
  const missing = [
    !elKey && "ELEVENLABS_API_KEY", !agentId && "ELEVENLABS_CALLER_AGENT_ID",
    !sid && "TWILIO_ACCOUNT_SID", !token && "TWILIO_AUTH_TOKEN",
    !owner && !phoneNumberId && "OWNER_NUMBER or ELEVENLABS_PHONE_NUMBER_ID",
  ].filter(Boolean);
  if (missing.length) {
    d.log(`caller: can't place a real call, missing ${missing.join(", ")}`);
    return void result({ ok: false, error: "not_configured" });
  }

  const api = async (base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string }, asText = false) => {
    const res = await doFetch(`${base}${path}`, init);
    const text = await res.text();
    let body: any = text;
    if (!asText) { try { body = JSON.parse(text); } catch { body = { raw: text }; } }
    if (!res.ok) throw new ApiError(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`, res.status, body);
    return body;
  };
  const el = (path: string, method = "GET", body?: unknown, asText = false) =>
    api(ELEVENLABS_API, path, {
      method, headers: { "xi-api-key": elKey, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, asText);
  const twAuth = `Basic ${btoa(`${sid}:${token}`)}`;
  const tw = (path: string, method = "GET", fields?: Record<string, string>) =>
    api(TWILIO_API, `/Accounts/${sid}${path}`, {
      method, headers: { Authorization: twAuth, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: fields ? form(fields) : undefined,
    });

  const number = String(msg.number);
  const userId = `bobby-call-${re}-${now()}`; // finds the conversation again on the "owner" route
  const clientData = {
    user_id: userId,
    dynamic_variables: { goal: String(msg.goal ?? ""), context: String(msg.context ?? "") },
  };
  const startedAt = Math.floor(now() / 1000) - 5;
  let callSid = "";
  let conversationId = "";

  try {
    status("dialing");
    // Route "owner": the person called sees OWNER_NUMBER.
    if (owner) {
      try {
        const twiml = await el("/v1/convai/twilio/register-call", "POST", {
          agent_id: agentId, from_number: owner, to_number: number, direction: "outbound",
          conversation_initiation_client_data: clientData,
        }, true);
        const xml = String(twiml).trim().startsWith('"') ? JSON.parse(String(twiml)) : String(twiml);
        const call = await tw("/Calls.json", "POST", { To: number, From: owner, Twiml: xml });
        callSid = String(call.sid ?? "");
        d.log(`caller: dialing ${number} from OWNER_NUMBER (Twilio ${callSid})`);
      } catch (e) {
        const code = e instanceof ApiError ? Number(e.body?.code) : NaN;
        if (!(TWILIO_BAD_FROM.includes(code) && phoneNumberId)) throw e;
        d.log(`caller: Twilio refused OWNER_NUMBER as caller ID (${code}); calling from the bought number`);
      }
    }
    // Route "bought": ElevenLabs dials from the imported Twilio number.
    if (!callSid) {
      if (!phoneNumberId) throw new Error("no ELEVENLABS_PHONE_NUMBER_ID for the bought-number route");
      const r = await el("/v1/convai/twilio/outbound-call", "POST", {
        agent_id: agentId, agent_phone_number_id: phoneNumberId, to_number: number,
        conversation_initiation_client_data: clientData,
      });
      if (!r.success || !r.callSid) throw new Error(`outbound-call failed: ${String(r.message ?? "")}`);
      callSid = String(r.callSid);
      conversationId = String(r.conversation_id ?? "");
      d.log(`caller: dialing ${number} from the bought number (Twilio ${callSid})`);
    }

    // Follow the call until it ends.
    const deadline = now() + (d.maxCallMs ?? 10 * 60_000);
    for (;;) {
      if (cancelled() || now() > deadline) {
        await tw(`/Calls/${callSid}.json`, "POST", { Status: "completed" }).catch(() => {});
        return void fail(cancelled() ? "cancelled" : "timeout");
      }
      const call = await tw(`/Calls/${callSid}.json`);
      const m = mapTwilioStatus(String(call.status ?? ""));
      if (m.status === "failed") return void fail(m.error ?? "failed");
      if (m.status === "ended" && lastStatus === "dialing") status("answered"); // answered between polls
      status(m.status);
      if (m.status === "ended") break;
      await sleep(pollMs);
    }

    // Transcript and summary from ElevenLabs.
    const waitUntil = now() + (d.transcriptWaitMs ?? 90_000);
    let conv: any = null;
    for (;;) {
      if (!conversationId) conversationId = await findConversation(el, agentId, userId, callSid, startedAt);
      if (conversationId) {
        conv = await el(`/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
        if (conv.status === "done" || conv.status === "failed") break;
      }
      if (now() > waitUntil) break;
      await sleep(pollMs);
    }
    const transcript = toTranscript(conv?.transcript);
    if (!transcript.length) return void result({ ok: false, error: "no_transcript" });
    result({ ok: true, summary: summarize(conv, transcript), transcript });
  } catch (e) {
    d.log(`caller: call failed: ${e instanceof Error ? e.message : String(e)}`);
    fail("failed");
  } finally {
    if (!finished) fail("failed");
  }
}

/** The conversation for a call placed on the "owner" route: by our user_id, else by Twilio call sid. */
async function findConversation(
  el: (path: string) => Promise<any>, agentId: string, userId: string, callSid: string, after: number,
): Promise<string> {
  const byUser = await el(`/v1/convai/conversations?${qs({ agent_id: agentId, user_id: userId, page_size: 5 })}`);
  const hit = byUser?.conversations?.[0]?.conversation_id;
  if (hit) return String(hit);
  const recent = await el(`/v1/convai/conversations?${qs({ agent_id: agentId, call_start_after_unix: after, page_size: 10 })}`);
  for (const c of recent?.conversations ?? []) {
    const full = await el(`/v1/convai/conversations/${encodeURIComponent(c.conversation_id)}`);
    if (full?.metadata?.phone_call?.call_sid === callSid) return String(c.conversation_id);
  }
  return "";
}

// ---------------------------------------------------------------- entry point

/**
 * Connects as `caller`. On `call`: dry run (CALLER_DRY_RUN, default 1), else CALLER_VENDOR
 * "openai" (default: GPT-Live over SIP, caller-live.ts) or "elevenlabs" (the cloned-voice caller
 * above). On `hangup` {re}: that call is ended and still gets exactly one call_result.
 */
export function startCallerWith(
  o: Omit<HubOptions, "role" | "onMessage"> & {
    env: Record<string, string | undefined>;
    stepMs?: number;
    callDeps?: Partial<Omit<CallDeps, "env" | "send" | "log" | "cancelled">>;
    liveDeps?: Partial<Omit<LiveCallDeps, "env" | "send" | "log" | "cancelled">>;
  },
): { stop(): void; hub: Hub } {
  const timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  const hungUp = new Set<string>();
  let stopped = false;
  const hub: Hub = connectHub({
    ...o,
    role: "caller",
    onMessage: (msg) => {
      if (msg.type === "hangup") {
        const re = String(msg.re ?? "");
        hungUp.add(re);
        const pending = timers.get(re);
        if (pending?.size) {
          // A dry-run call still in progress: stop it and end it once.
          pending.forEach(clearTimeout);
          timers.delete(re);
          hub.send({ type: "call_status", re, status: "ended" });
          hub.send({ type: "call_result", re, ok: false, error: "cancelled" });
        }
        o.log(`caller: hangup for ${re}`);
        return;
      }
      if (msg.type !== "call") return;
      const re = String(msg.id ?? "");
      if (isDryRun(o.env)) {
        const set = new Set<ReturnType<typeof setTimeout>>();
        timers.set(re, set);
        const frames = dryRunCall(msg, allowlist(o.env));
        frames.forEach((f, i) => {
          const t = setTimeout(() => {
            set.delete(t);
            if (i === frames.length - 1) timers.delete(re);
            hub.send(f);
          }, i * (o.stepMs ?? 700));
          set.add(t);
        });
        return;
      }
      const cancelled = () => stopped || hungUp.has(re);
      const send = (f: Frame) => hub.send(f);
      if (callerChoice(o.env) === "elevenlabs") void realCall(msg, { ...o.callDeps, env: o.env, send, log: o.log, cancelled });
      else void liveCall(msg, { ...o.liveDeps, env: o.env, send, log: o.log, cancelled });
    },
  });
  return {
    hub,
    stop: () => {
      stopped = true;
      for (const s of timers.values()) s.forEach(clearTimeout);
      timers.clear();
      hub.stop();
    },
  };
}
