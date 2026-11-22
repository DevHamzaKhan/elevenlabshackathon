// Shared types for the Mind. Plain TypeScript only: this folder must run in Node and in React Native.

/** Anything that arrives over the wire. Unknown types and fields are ignored, never fatal. */
export type Msg = { type: string; [k: string]: any };

/** One model call: fixed instructions (cached), the changing part, and the JSON schema of the reply. */
export type ModelRequest = {
  /** Short label for logs, e.g. "decide" or "step". */
  purpose: string;
  /** Instructions that stay byte-for-byte the same between calls, so they cache. */
  system: string;
  /** The changing part: screen, history, what the user said. */
  user: string;
  /** JSON schema the reply must follow. */
  schema: Record<string, unknown>;
  /** Optional effort override for cheap calls. */
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
};

export type ModelReply = {
  /** Parsed JSON reply, or null when the model refused or the reply wasn't valid JSON. */
  json: any | null;
  stopReason: string | null;
  ms: number;
  error?: string;
};

/** The one door to the model. Tests pass a stub with the same shape. */
export type ModelFn = (req: ModelRequest) => Promise<ModelReply>;

export type MindConfig = {
  hubUrl: string;
  token: string;
  /** ANTHROPIC_API_KEY, MIND_MODEL, MIND_EFFORT, CONTACTS, plus optional MIND_* tuning knobs. */
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Per-app navigation notes. May be empty. */
  hints?: string[];
  /** Not in the contract: lets tests and the laptop runner replace the model door. */
  model?: ModelFn;
  /** Not in the contract: test-only speedups (timeouts in ms). */
  timing?: Partial<Timing>;
};

export type Timing = {
  actMs: number;
  sayMs: number;
  callMs: number;
  /** Idle time with no user speech and no task/call before `sleep`. */
  sleepMs: number;
  /** How long to wait for the Mouth to start a `say` before giving up on syncing. */
  sayStartMs: number;
};

export const DEFAULT_TIMING: Timing = {
  actMs: 10_000,
  sayMs: 15_000,
  callMs: 180_000,
  sleepMs: 20_000,
  sayStartMs: 3_000,
};

export type PlanStep = { n: number; do: string; why: string };

export type ScreenNode = {
  n: number;
  text?: string;
  desc?: string;
  cls?: string;
  bounds?: [number, number, number, number];
  tap?: boolean;
  edit?: boolean;
  scroll?: boolean;
};
