// Shared types for the Mind. Plain TypeScript only: this folder must run in Node and in React Native.

/** Anything that arrives over the wire. Unknown types and fields are ignored, never fatal. */
export type Msg = { type: string; [k: string]: any };

/** One model call: fixed instructions (cached), the changing part, and the JSON schema of the reply. */
export type ModelRole = "router" | "exec" | "escalate" | "check";

export type ModelRequest = {
  /** Short label for logs, e.g. "route", "exec", "escalate", "check". */
  purpose: string;
  /** Which model and effort to use. Defaults from `purpose` ("decide"/"route" -> router, else exec). */
  role?: ModelRole;
  /** Base64 JPEG screenshots (or data: URLs), for the escalation model. */
  images?: string[];
  /** Instructions that stay byte-for-byte the same between calls, so they cache. */
  system: string;
  /** The changing part: screen, history, what the user said. */
  user: string;
  /** JSON schema the reply must follow. */
  schema: Record<string, unknown>;
  /** Optional reasoning-effort override ("none", "low", "medium", ...). */
  effort?: string;
  maxTokens?: number;
  /** Per-attempt timeout; a slow attempt is abandoned and retried once. */
  timeoutMs?: number;
};

export type ModelReply = {
  /** Parsed JSON reply, or null when the model refused or the reply wasn't valid JSON. */
  json: any | null;
  stopReason: string | null;
  ms: number;
  error?: string;
  usage?: { input: number; cached: number; output: number };
  model?: string;
};

/** The one door to the model. Tests pass a stub with the same shape. */
export type ModelFn = (req: ModelRequest) => Promise<ModelReply>;

export type MindConfig = {
  hubUrl: string;
  token: string;
  /** OPENAI_API_KEY, MIND_ROUTER_MODEL, MIND_EXEC_MODEL, MIND_ESCALATE_MODEL, MIND_*_EFFORT,
   *  MIND_CONFIRM, CONTACTS, plus optional MIND_* tuning knobs. */
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
  /** A screen read older than this is read again before tapping a node on it. */
  staleMs: number;
  /** After the user says goodbye, how long Bobby gets to answer before `sleep`. */
  goodbyeMs: number;
  /** A step call slower than this makes Bobby say "give me a second" (once per task). */
  stallMs: number;
  /** After `wake`, a command is taken once this long passes with no new `heard` (debounce). */
  commandMs: number;
  /** A listening window with nothing heard closes after this long. */
  listenMs: number;
  /** The final result line or the Send line waits this long at most for the previous line to finish. */
  sayWaitMs: number;
};

export const DEFAULT_TIMING: Timing = {
  actMs: 10_000,
  sayMs: 15_000,
  callMs: 180_000,
  sleepMs: 10_000,
  staleMs: 2_500,
  goodbyeMs: 3_000,
  stallMs: 7_000,
  commandMs: 1_500,
  listenMs: 14_000,
  sayWaitMs: 4_000,
};

export type PlanStep = { n: number; do: string; why: string };

export type ScreenNode = {
  n: number;
  text?: string;
  desc?: string;
  /** Extra field from Hands: an empty text field's placeholder, e.g. "Compose email". */
  hint?: string;
  cls?: string;
  bounds?: [number, number, number, number];
  tap?: boolean;
  edit?: boolean;
  scroll?: boolean;
};
