// The one door to the model. Every model call in the Mind goes through makeModel().
// OpenAI Responses API over plain fetch (no SDK: nothing to shim in React Native), structured
// outputs (strict JSON schema), stable instruction prefixes for prompt caching, non-streaming.
//
// Three roles, each with its own model id and reasoning effort from env (never hard-coded in logic):
//   router   - turns what the user said into routes, tasks and sub-goals   (MIND_ROUTER_MODEL)
//   exec     - grounded executor: screen + sub-goal -> a few actions        (MIND_EXEC_MODEL)
//   escalate - screenshot + tree + history -> re-plan or actions            (MIND_ESCALATE_MODEL)
//   check    - cheap yes/no "is this sub-goal done?" when code can't tell   (uses the exec model)

import type { ModelFn, ModelReply, ModelRequest, ModelRole } from "./types";

/** Defaults, overridable per role by env. Chosen 2026-11-24 from developers.openai.com/api/docs/models. */
export const DEFAULT_MODELS: Record<"router" | "exec" | "escalate", string> = {
  router: "gpt-6-luna",
  exec: "gpt-6-luna",
  escalate: "gpt-6.1-terra",
};
export const DEFAULT_EFFORTS: Record<ModelRole, string> = {
  router: "none",
  exec: "low",
  escalate: "medium",
  check: "none",
};
export const OPENAI_BASE = "https://api.openai.com/v1";

export type ModelOptions = {
  apiKey: string;
  /** Model id per role. Missing roles use DEFAULT_MODELS. */
  models?: Partial<Record<"router" | "exec" | "escalate", string>>;
  /** Reasoning effort per role ("none", "low", "medium", ...). Missing roles use DEFAULT_EFFORTS. */
  efforts?: Partial<Record<ModelRole, string>>;
  log: (line: string) => void;
  /** Optional fetch override (tests, expo/fetch). Defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Retries after a timeout, 429 or 5xx. */
  retries?: number;
};

/** Reads the per-role settings from a Mind env object. */
export function modelOptionsFromEnv(env: Record<string, string | undefined>): Omit<ModelOptions, "log"> {
  const pick = (k: string) => (env[k] ?? "").trim() || undefined;
  return {
    apiKey: env.OPENAI_API_KEY ?? "",
    models: {
      router: pick("MIND_ROUTER_MODEL"),
      exec: pick("MIND_EXEC_MODEL"),
      escalate: pick("MIND_ESCALATE_MODEL"),
    },
    efforts: {
      router: pick("MIND_ROUTER_EFFORT"),
      exec: pick("MIND_EXEC_EFFORT"),
      escalate: pick("MIND_ESCALATE_EFFORT"),
      check: pick("MIND_CHECK_EFFORT"),
    },
    baseUrl: pick("MIND_OPENAI_BASE_URL"),
  };
}

export function roleOf(req: ModelRequest): ModelRole {
  if (req.role) return req.role;
  return req.purpose === "decide" || req.purpose === "route" ? "router" : req.purpose === "escalate" ? "escalate" : "exec";
}

export function makeModel(opts: ModelOptions): ModelFn {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = (opts.baseUrl || OPENAI_BASE).replace(/\/+$/, "");
  const models = { ...DEFAULT_MODELS, ...stripUndef(opts.models ?? {}) };
  const efforts = { ...DEFAULT_EFFORTS, ...stripUndef(opts.efforts ?? {}) };
  const retries = opts.retries ?? 1;

  return async (req: ModelRequest): Promise<ModelReply> => {
    const role = roleOf(req);
    const model = role === "check" ? models.exec : models[role];
    const effort = req.effort ?? efforts[role];
    const t0 = Date.now();
    const userContent: any[] = [{ type: "input_text", text: req.user }];
    for (const img of req.images ?? []) {
      userContent.push({ type: "input_image", image_url: img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`, detail: "auto" });
    }
    const body: any = {
      model,
      // Fixed instructions first, as a developer message, so the implicit cache breakpoint lands
      // after them; the changing part (screen, history, what was said) goes last.
      input: [
        { role: "developer", content: [{ type: "input_text", text: req.system }] },
        { role: "user", content: userContent },
      ],
      text: { format: { type: "json_schema", name: req.purpose.replace(/[^a-zA-Z0-9_-]/g, "_") || "reply", strict: true, schema: req.schema } },
      reasoning: { effort },
      max_output_tokens: req.maxTokens ?? 2000,
      // One cache key per role keeps routing stable; the prefix is the same for every call of a role.
      prompt_cache_key: `bobby-mind-${role}`,
      store: false,
    };
    opts.log(`model> ${req.purpose} [${role} ${model} ${effort}] (${req.user.length} chars${req.images?.length ? `, ${req.images.length} image` : ""}): ${oneLine(req.user, 1500)}`);
    let lastErr = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => ctl?.abort(), req.timeoutMs ?? 20_000);
      try {
        const res = await doFetch(`${base}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(ctl ? { signal: ctl.signal } : {}),
        });
        const text = await res.text();
        clearTimeout(timer);
        const ms = Date.now() - t0;
        if (!res.ok) {
          lastErr = `HTTP ${res.status}: ${oneLine(text, 300)}`;
          opts.log(`model< ${req.purpose} ERROR after ${ms} ms: ${lastErr}`);
          if (res.status === 429 || res.status >= 500) continue;
          return { json: null, stopReason: null, ms, error: lastErr, model };
        }
        return parseResponse(text, req, ms, model, opts.log);
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e?.name === "AbortError" ? "timeout" : String(e?.message ?? e);
        opts.log(`model< ${req.purpose} ERROR after ${Date.now() - t0} ms: ${lastErr}`);
      }
    }
    return { json: null, stopReason: null, ms: Date.now() - t0, error: lastErr || "failed", model };
  };
}

/** Reads a Responses API body: refusal, incomplete, or the JSON text of the first message. */
export function parseResponse(raw: string, req: Pick<ModelRequest, "purpose">, ms: number, model: string, log: (l: string) => void): ModelReply {
  let res: any;
  try {
    res = JSON.parse(raw);
  } catch {
    log(`model< ${req.purpose} not JSON after ${ms} ms`);
    return { json: null, stopReason: null, ms, error: "bad_body", model };
  }
  const u = res.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const usage = { input: u.input_tokens ?? 0, cached, output: u.output_tokens ?? 0 };
  const usageStr = `in=${usage.input} cached=${cached} out=${usage.output}`;
  const parts: any[] = (res.output ?? []).filter((o: any) => o?.type === "message").flatMap((o: any) => o.content ?? []);
  const refusal = parts.find((p) => p?.type === "refusal");
  if (refusal) {
    log(`model< ${req.purpose} REFUSED after ${ms} ms: ${oneLine(String(refusal.refusal ?? ""), 200)} ${usageStr}`);
    return { json: null, stopReason: "refusal", ms, error: "refusal", usage, model };
  }
  const text = parts.filter((p) => p?.type === "output_text").map((p) => p.text).join("");
  if (res.status === "incomplete" && !text) {
    const why = res.incomplete_details?.reason ?? "incomplete";
    log(`model< ${req.purpose} INCOMPLETE after ${ms} ms (${why}) ${usageStr}`);
    return { json: null, stopReason: why, ms, error: why, usage, model };
  }
  try {
    const json = JSON.parse(text);
    log(`model< ${req.purpose} ${ms} ms model=${res.model ?? model} ${usageStr}: ${oneLine(text, 1500)}`);
    return { json, stopReason: res.status ?? "completed", ms, usage, model };
  } catch {
    log(`model< ${req.purpose} bad JSON after ${ms} ms: ${oneLine(text, 500)}`);
    return { json: null, stopReason: res.status ?? null, ms, error: "bad_json", usage, model };
  }
}

function stripUndef<T extends Record<string, any>>(o: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export function oneLine(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
