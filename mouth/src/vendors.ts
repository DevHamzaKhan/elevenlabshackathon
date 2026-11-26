// The voice model choice from env, in plain TypeScript (importable from Node tests; index.ts pulls
// in React Native modules).

export const DEFAULT_MOUTH_MODEL = "gpt-realtime-2.1-mini";

/** OpenAI Realtime: MOUTH_VOICE_MODEL (default gpt-realtime-2.1-mini); needs OPENAI_API_KEY. */
export function voiceChoice(env: Record<string, string | undefined>): { model: string; missing: string | null } {
  return { model: (env.MOUTH_VOICE_MODEL ?? "").trim() || DEFAULT_MOUTH_MODEL, missing: env.OPENAI_API_KEY ? null : "OPENAI_API_KEY" };
}
