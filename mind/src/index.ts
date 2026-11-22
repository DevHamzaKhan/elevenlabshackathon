// bobby-mind: the entry point the final app calls. Everything arrives through `config`.
// Nothing under src/ reads files or environment variables, or imports Node-only modules.

import { Brain, parseContacts } from "./brain";
import { HubClient } from "./hub";
import { DEFAULT_EFFORT, DEFAULT_MODEL, makeModel } from "./model";
import { DEFAULT_TIMING, type MindConfig, type ModelFn } from "./types";

export type { MindConfig, ModelFn, ModelRequest, ModelReply } from "./types";
export { makeModel } from "./model";
export { describeScreen } from "./screen";

/** `ws://127.0.0.1:8765` + role and token, unless hubUrl already names the role. */
export function mindUrl(hubUrl: string, token: string): string {
  const base = hubUrl.replace(/\/+$/, "");
  const withRole = /\/mind(\?|$)/.test(base) ? base : `${base}/mind`;
  if (/[?&]token=/.test(withRole)) return withRole;
  return `${withRole}${withRole.includes("?") ? "&" : "?"}token=${encodeURIComponent(token ?? "")}`;
}

export function startMind(config: MindConfig): { stop(): void } {
  const log = config.log ?? (() => {});
  const env = config.env ?? {};
  const timing = { ...DEFAULT_TIMING, ...(config.timing ?? {}) };
  const model: ModelFn =
    config.model ??
    makeModel({
      apiKey: env.ANTHROPIC_API_KEY ?? "",
      model: env.MIND_MODEL || DEFAULT_MODEL,
      effort: env.MIND_EFFORT || DEFAULT_EFFORT,
      log,
    });
  if (!config.model && !env.ANTHROPIC_API_KEY) log("mind: ANTHROPIC_API_KEY is missing; model calls will fail");

  let brain: Brain | null = null;
  const hub = new HubClient(
    mindUrl(config.hubUrl, config.token),
    "mind",
    (m) => brain?.handle(m),
    log,
    // With the hub gone nobody is reachable; the hub sends fresh `peers` after the next welcome.
    (up) => {
      if (!up) brain?.handle({ type: "peers", hands: false, mouth: false, caller: false });
    },
  );
  brain = new Brain({
    hub,
    model,
    log,
    hints: config.hints ?? [],
    contacts: parseContacts(env.CONTACTS),
    timing,
  });
  hub.start();
  log(`mind: started (model ${env.MIND_MODEL || DEFAULT_MODEL}, effort ${env.MIND_EFFORT || DEFAULT_EFFORT}, ${config.hints?.length ?? 0} hints)`);
  return {
    stop() {
      brain?.stop();
      hub.stop();
      log("mind: stopped");
    },
  };
}
