// The one door to the model. Every Claude call in the Mind goes through makeModel().
// Plain Messages API calls through @anthropic-ai/sdk, non-streaming (React Native's default fetch
// can't stream), structured JSON output, cached system prompt, server-side refusal fallback.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelFn, ModelRequest, ModelReply } from "./types";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "medium";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ModelOptions = {
  apiKey: string;
  model?: string;
  effort?: string;
  log: (line: string) => void;
  /** Optional fetch override (e.g. expo/fetch). Defaults to the global fetch. */
  fetch?: typeof fetch;
};

export function makeModel(opts: ModelOptions): ModelFn {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: 2,
    timeout: 60_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const model = opts.model || DEFAULT_MODEL;
  const effort = (opts.effort || DEFAULT_EFFORT) as "low" | "medium" | "high";

  return async (req: ModelRequest): Promise<ModelReply> => {
    const t0 = Date.now();
    const body: any = {
      model,
      max_tokens: req.maxTokens ?? 4000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: {
        effort: req.effort ?? effort,
        format: { type: "json_schema", schema: req.schema },
      },
      // Fixed instructions first, marked for caching; the changing part goes in the user turn.
      // The 1-hour cache life means the first request after a quiet spell (Bobby is woken every
      // few minutes, not every few seconds) still reads the ~9k-token prompt from cache.
      // Note: the reply schema is part of the cached prefix, so "decide" and "step" calls each
      // keep their own entry and can't share one.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: req.user }],
    };
    opts.log(`model> ${req.purpose} request (${req.user.length} chars): ${oneLine(req.user, 1500)}`);
    try {
      const res: any = await client.beta.messages.create(body, { timeout: req.timeoutMs ?? 30_000 });
      const ms = Date.now() - t0;
      const u = res.usage ?? {};
      const usage = `in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`;
      if (res.stop_reason === "refusal") {
        opts.log(`model< ${req.purpose} REFUSED after ${ms} ms (${res.stop_details?.category ?? "?"}) ${usage}`);
        return { json: null, stopReason: "refusal", ms, error: "refusal" };
      }
      const text = (res.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        opts.log(`model< ${req.purpose} bad JSON after ${ms} ms (stop=${res.stop_reason}): ${oneLine(text, 500)}`);
        return { json: null, stopReason: res.stop_reason, ms, error: "bad_json" };
      }
      opts.log(`model< ${req.purpose} ${ms} ms model=${res.model} stop=${res.stop_reason} ${usage}: ${oneLine(text, 1500)}`);
      return { json, stopReason: res.stop_reason, ms };
    } catch (e: any) {
      const ms = Date.now() - t0;
      const msg = e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : String(e?.message ?? e);
      opts.log(`model< ${req.purpose} ERROR after ${ms} ms: ${msg}`);
      return { json: null, stopReason: null, ms, error: msg };
    }
  };
}

function oneLine(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
