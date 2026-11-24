// Vendor choices from env, in plain TypeScript (importable from Node tests; index.ts pulls in
// React Native modules).

export const DEFAULT_MOUTH_MODEL = "gpt-realtime-2.1-mini";

/** MOUTH_VOICE_VENDOR: "openai" (default) or "elevenlabs"; MOUTH_VOICE_MODEL for OpenAI. */
export function voiceChoice(env: Record<string, string | undefined>): { vendor: "openai" | "elevenlabs"; model: string; missing: string | null } {
  const vendor = (env.MOUTH_VOICE_VENDOR ?? "").trim().toLowerCase() === "elevenlabs" ? "elevenlabs" : "openai";
  if (vendor === "elevenlabs") return { vendor, model: "agent", missing: env.ELEVENLABS_BOBBY_AGENT_ID ? null : "ELEVENLABS_BOBBY_AGENT_ID (run mouth/agent/setup.mjs)" };
  return { vendor, model: (env.MOUTH_VOICE_MODEL ?? "").trim() || DEFAULT_MOUTH_MODEL, missing: env.OPENAI_API_KEY ? null : "OPENAI_API_KEY" };
}

/** CALLER_VENDOR: "openai" (default, GPT-Live over SIP) or "elevenlabs" (the old cloned-voice caller). */
export function callerChoice(env: Record<string, string | undefined>): "openai" | "elevenlabs" {
  return (env.CALLER_VENDOR ?? "").trim().toLowerCase() === "elevenlabs" ? "elevenlabs" : "openai";
}
