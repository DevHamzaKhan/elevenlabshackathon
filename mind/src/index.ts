// bobby-mind: the entry point the final app calls. Everything arrives through `config`.
// Nothing under src/ reads files or environment variables, or imports Node-only modules.

import { Brain, type ConfirmPolicy } from "./brain";
import { parseContactBook } from "./contacts";
import { HubClient } from "./hub";
import { DEFAULT_MODELS, makeModel, modelOptionsFromEnv } from "./model";
import { DEFAULT_TIMING, type MindConfig, type ModelFn } from "./types";
import type { TeachMode } from "./teach";

export type { MindConfig, ModelFn, ModelRequest, ModelReply } from "./types";
export { makeModel, modelOptionsFromEnv, DEFAULT_MODELS, DEFAULT_EFFORTS } from "./model";
export { describeScreen, describeCompact } from "./screen";
export { InMemoryStore, type KeyValueStore } from "./memory";
export { ShortcutIndex } from "./shortcuts";
export { teachIntent, teachEnd, type Skill, type TeachMode } from "./teach";

/** `ws://127.0.0.1:8765` + role and token, unless hubUrl already names the role. */
export function mindUrl(hubUrl: string, token: string): string {
  const base = hubUrl.replace(/\/+$/, "");
  const withRole = /\/mind(\?|$)/.test(base) ? base : `${base}/mind`;
  if (/[?&]token=/.test(withRole)) return withRole;
  return `${withRole}${withRole.includes("?") ? "&" : "?"}token=${encodeURIComponent(token ?? "")}`;
}

function confirmPolicy(v: string | undefined, log: (l: string) => void): ConfirmPolicy {
  const p = (v ?? "").trim().toLowerCase();
  if (!p) return "always";
  if (p === "always" || p === "unknown_contacts" || p === "never") return p;
  log(`mind: MIND_CONFIRM="${v}" is not always|unknown_contacts|never; using always`);
  return "always";
}

function teachMode(v: string | undefined, log: (l: string) => void): TeachMode {
  const p = (v ?? "").trim().toLowerCase();
  if (!p) return "hybrid";
  if (p === "hybrid" || p === "script" || p === "guided" || p === "pixels") return p;
  log(`mind: MIND_TEACH_MODE="${v}" is not hybrid|script|guided|pixels; using hybrid`);
  return "hybrid";
}

/** MIND_ASK_MAX: most questions per request and per running task. Default 1; 0 turns questions off. */
function askMax(v: string | undefined, log: (l: string) => void): number {
  const t = (v ?? "").trim();
  if (!t) return 1;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
  log(`mind: MIND_ASK_MAX="${v}" is not a whole number from 0 to 3; using 1`);
  return 1;
}

export function startMind(config: MindConfig): { stop(): void; brain: Brain } {
  const log = config.log ?? (() => {});
  const env = config.env ?? {};
  const timing = { ...DEFAULT_TIMING, ...(config.timing ?? {}) };
  const model: ModelFn =
    config.model ??
    makeModel({ ...modelOptionsFromEnv(env), log });
  if (!config.model && !env.OPENAI_API_KEY) log("mind: OPENAI_API_KEY is missing; model calls will fail");
  const mo = modelOptionsFromEnv(env).models ?? {};

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
    contacts: parseContactBook(env.CONTACTS),
    timing,
    confirm: confirmPolicy(env.MIND_CONFIRM, log),
    askMax: askMax(env.MIND_ASK_MAX, log),
    storage: config.storage,
    teachMode: teachMode(env.MIND_TEACH_MODE, log),
  });
  hub.start();
  log(
    `mind: started (router ${mo.router || DEFAULT_MODELS.router}, exec ${mo.exec || DEFAULT_MODELS.exec}, escalate ${mo.escalate || DEFAULT_MODELS.escalate}, ${config.hints?.length ?? 0} hints)`,
  );
  return {
    brain: brain!,
    stop() {
      brain?.stop();
      hub.stop();
      log("mind: stopped");
    },
  };
}
