// OpenAI Realtime, the plain-TypeScript half (runs in Node tests and React Native): the session
// config with Bobby's instructions and tools, the ephemeral client-secret and SDP requests, the
// client events we send, and a translator from server events to VoiceCallbacks. The WebRTC half
// (peer connection, microphone, data channel) is in openai.ts.
// Docs: developers.openai.com/api/docs/guides/voice-webrtc, /realtime-conversations,
// /realtime-transcription, /realtime-vad (checked 2026-11-24).

import type { VoiceCallbacks } from "./voice";

export const OPENAI_API = "https://api.openai.com/v1";
export const DEFAULT_VOICE_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_VOICE = "marin";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-live-transcribe";

export const BOBBY_INSTRUCTIONS = `You are Bobby, a friendly voice assistant who operates the user's Android phone for them. The user talks to you through earbuds while doing something else. You talk like a friend: warm, casual, a few words at a time. No customer-service phrases.

You own the conversation; a separate "phone brain" does the work on the phone. You reach it only through your tools:
- request(text): the user wants something done on the phone, or asks something about their phone, messages, notifications or calls. Pass their words, lightly cleaned up, in one call (a chain like "open Spotify then text Alex" is one request). Then acknowledge in two or three words ("On it.", "Sure, doing that.") and stop talking.
- amend(text): the user changes or adds detail to what is already being done ("actually make it 4", "add that I'll bring snacks").
- cancel(scope): the user wants it stopped. scope "current" for the thing in progress, "all" for everything.
- confirm(id, answer): you were asked to check something with the user (a CONFIRM line with an id). Read the summary to the user and ask. When they answer, call confirm with that id and "yes" or "no". Only "yes" if they clearly said yes.
- status(): the user asks how it's going.

Hard rules:
- Never say a task is done, sent, called, booked or failed on your own. You only know outcomes from UPDATE lines the phone brain sends you; say those when they come, in your own words, briefly.
- Lines marked SAY are for you to say right away, in your voice, keeping the meaning. Don't answer them, don't add to them.
- Lines marked CONTEXT are background. Don't read them out; use them if the user asks.
- If the user is just chatting, chat back briefly without calling a tool.
- Never ask follow-up questions about details the phone brain can fill in. Don't invent facts.
- Speech that isn't meant for you (people talking nearby): stay quiet.`;

export type ToolDef = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };

export const BOBBY_TOOLS: ToolDef[] = [
  {
    type: "function",
    name: "request",
    description: "Send what the user wants done (or asked about their phone) to the phone brain. Returns at once; results come later as UPDATE lines.",
    parameters: { type: "object", properties: { text: { type: "string", description: "The user's request in their words." } }, required: ["text"], additionalProperties: false },
  },
  {
    type: "function",
    name: "amend",
    description: "Change or add detail to the task in progress.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
  {
    type: "function",
    name: "cancel",
    description: "Stop the task in progress ('current') or everything queued too ('all').",
    parameters: { type: "object", properties: { scope: { type: "string", enum: ["current", "all"] } }, required: ["scope"], additionalProperties: false },
  },
  {
    type: "function",
    name: "confirm",
    description: "The user's answer to a CONFIRM question, by its id.",
    parameters: { type: "object", properties: { id: { type: "string" }, answer: { type: "string", enum: ["yes", "no"] } }, required: ["id", "answer"], additionalProperties: false },
  },
  {
    type: "function",
    name: "status",
    description: "What the phone brain is doing right now.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type RealtimeOptions = {
  model?: string;
  voice?: string;
  transcribeModel?: string;
  instructions?: string;
  /** Extra non-secret instruction text, e.g. the user's name. */
  extra?: string;
};

/** The `session` object for POST /v1/realtime/client_secrets. */
export function sessionConfig(o: RealtimeOptions = {}) {
  return {
    type: "realtime",
    model: o.model || DEFAULT_VOICE_MODEL,
    instructions: [o.instructions ?? BOBBY_INSTRUCTIONS, o.extra ?? ""].filter(Boolean).join("\n\n"),
    audio: {
      input: {
        transcription: { model: o.transcribeModel || DEFAULT_TRANSCRIBE_MODEL },
        turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
      },
      output: { voice: o.voice || DEFAULT_VOICE },
    },
    tools: BOBBY_TOOLS,
    tool_choice: "auto",
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Mints a short-lived client secret from the API key (on the phone, for now). Never logs the key. */
export async function mintClientSecret(apiKey: string, session: object, f: Fetch): Promise<string> {
  const res = await f(`${OPENAI_API}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`client_secrets ${res.status}: ${text.slice(0, 200)}`);
  const v = JSON.parse(text)?.value;
  if (typeof v !== "string" || !v) throw new Error("client_secrets: no value in the reply");
  return v;
}

/** Sends our SDP offer, returns the answer SDP. */
export async function exchangeSdp(ephemeral: string, offerSdp: string, f: Fetch): Promise<string> {
  const res = await f(`${OPENAI_API}/realtime/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ephemeral}`, "Content-Type": "application/sdp" },
    body: offerSdp,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`realtime/calls ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

// ---------- client events ----------

export const ev = {
  /** Background knowledge, not spoken. */
  context: (text: string) => ({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: `CONTEXT: ${text}` }] } }),
  /** A typed user turn (tests and the typed test path). */
  userText: (text: string) => ({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
  /** Speak a given line now. */
  say: (text: string) => ({ type: "response.create", response: { instructions: `SAY, right now, in your own voice, keeping the meaning (light rephrasing only, no additions): "${text}"` } }),
  toolOutput: (callId: string, output: string) => ({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } }),
  respond: () => ({ type: "response.create" }),
  cancel: () => ({ type: "response.cancel" }),
  clearAudio: () => ({ type: "output_audio_buffer.clear" }),
};

// ---------- server events -> callbacks ----------

/** Feeds Realtime server events (parsed JSON from the data channel) into VoiceCallbacks. */
export function translator(cb: VoiceCallbacks, log: (l: string) => void = () => {}) {
  const seenCalls = new Set<string>();
  return (e: any) => {
    if (!e || typeof e.type !== "string") return;
    switch (e.type) {
      case "session.created":
        cb.onConnect();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof e.transcript === "string") cb.onUserTranscript(e.transcript);
        break;
      case "input_audio_buffer.speech_started":
        cb.onSpeechStarted?.();
        break;
      case "output_audio_buffer.started":
        cb.onModeChange("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        cb.onModeChange("listening");
        break;
      case "response.output_audio_transcript.done":
        if (typeof e.transcript === "string" && e.transcript.trim()) cb.onAgentResponse(e.transcript);
        break;
      case "response.output_item.done": {
        const it = e.item;
        if (it?.type === "function_call" && it.call_id && !seenCalls.has(it.call_id)) {
          seenCalls.add(it.call_id);
          let args: Record<string, unknown> = {};
          try {
            args = it.arguments ? JSON.parse(it.arguments) : {};
          } catch {
            log(`realtime: bad tool arguments for ${it.name}`);
          }
          cb.onToolCall?.(String(it.name), args, String(it.call_id));
        }
        break;
      }
      case "error":
        cb.onError(String(e.error?.message ?? "realtime error"));
        break;
      default:
        break;
    }
  };
}
