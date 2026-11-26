// Shared types for the Mind. Plain TypeScript only: this folder must run in Node and in React Native.

/** Anything that arrives over the wire. Unknown types and fields are ignored, never fatal. */
export type Msg = { type: string; [k: string]: any };

/** One model call: fixed instructions (cached), the changing part, and the JSON schema of the reply. */
export type ModelRole = "router" | "exec" | "escalate" | "check" | "teach";

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
  /** Persistent key-value store for memory and recipes (AsyncStorage-shaped). In memory if absent. */
  storage?: import("./memory").KeyValueStore;
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
  /** How long a confirmation waits for the user before it counts as "no". */
  confirmMs: number;
  /** A barge-in with nothing after it resumes the task after this long. */
  bargeMs: number;
  /** Teaching: this long with no new action from the user (after at least one) ends the demo. */
  teachIdleMs: number;
  /** Teaching: a demo is never watched for longer than this. */
  teachMaxMs: number;
  /** Teaching: how long Hands gets to answer `observe`. */
  observeMs: number;
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
  confirmMs: 30_000,
  bargeMs: 4_000,
  teachIdleMs: 25_000,
  teachMaxMs: 300_000,
  observeMs: 2_500,
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
  /** v2 Hands extras (any may be missing). */
  id?: string;
  key?: string;
  checked?: boolean;
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  password?: boolean;
  scrollDirs?: string[];
};

// ---------- v2: plans, checks and acts ----------

/** Where Hands should act. `n` is valid only for the screen it came from; the rest are stable. */
export type Target = { n?: number; id?: string; key?: string; text?: string; x?: number; y?: number };

/** One Hands `act` body (without type/to/id). See mind/PROTOCOL-V2.md for `open`. */
export type HandsAct = {
  do: string;
  on?: Target;
  text?: string;
  dir?: string;
  name?: string;
  app?: string;
  ms?: number;
  uri?: string;
  action?: string;
  pkg?: string;
  extras?: Record<string, string | number | boolean | string[]>;
  type_mime?: string;
  /** `launch` only: restart the app at its first screen instead of resuming where it was. */
  fresh?: boolean;
};

/** A condition checked in code against a screen. Every given field must hold. */
export type Check = {
  /** Package or app label in front (substring, case-insensitive). */
  app?: string;
  /** At least one of these is visible (text, description or hint contains it, ignoring case). */
  text_present?: string[];
  /** None of these is visible. */
  text_absent?: string[];
  /** A field (found by key, id or label) holds this value. */
  field?: { key?: string; id?: string; text?: string; value: string };
};

/** `done_when`: a code check plus words for the cheap model check when code can't tell. */
export type DoneWhen = Check & { describe: string };

export type Risk = "safe" | "irreversible";

export type SubgoalSpec = {
  goal: string;
  done_when: DoneWhen;
  risk: Risk;
  /** Deterministic acts to try first (from a shortcut). On failure the grounded executor takes over. */
  direct?: HandsAct[];
  /** For irreversible sub-goals: the one-line summary the user confirms ("Email to Sam: 'I'm late'"). */
  confirm?: string;
  /** Bobby's line when this sub-goal starts. */
  say?: string;
  /** From a skill the user taught by showing: the recorded steps, replayed with every check in code. */
  script?: ScriptStep[];
  /** The same steps in words, for the grounded executor when the script can't be followed. */
  guide?: string;
  /** Package the script runs in (relaunched fresh when its first target isn't on screen). */
  scriptApp?: string;
  /** No fallback when the script fails (comparison bench only). */
  scriptOnly?: boolean;
};

/** How to find a recorded control again on a later screen. Any field may be missing. */
export type Want = {
  id?: string;
  key?: string;
  text?: string;
  desc?: string;
  hint?: string;
  cls?: string;
  edit?: boolean;
  /** Where its centre was when recorded: only a tie-break between equal matches. */
  at?: [number, number];
};

/** One step of a taught skill. Strings may hold `{{slot}}` placeholders. */
export type ScriptStep = {
  /** The Hands act without its target (`on` comes from `want` at run time). */
  act: HandsAct;
  want?: Want;
  expect: Check;
  /** In words, for guides and logs: `tap "Create"`. */
  label: string;
  /** The user scrolled this way to reach the target; do the same when it isn't on screen. */
  seek?: "up" | "down" | "left" | "right" | "any";
  /** Tap this exact pixel (the coordinate-macro mode of the comparison bench only). */
  pixel?: boolean;
  /** The user closed a tip or pop-up here: do it when it is there, carry on when it isn't. */
  optional?: boolean;
};

export type TaskPlan = {
  kind: "phone" | "call";
  title: string;
  goal: string;
  subgoals: SubgoalSpec[];
  shortcut?: string;
  slots?: Record<string, string>;
  /** Who the task talks to, for the unknown_contacts confirm policy. */
  recipient?: { name: string; known: boolean };
  call?: { name: string; number: string; goal: string };
  /** What Bobby says when it is done ("Sent it to Sam."). */
  doneSay?: string;
  /** Set when the task can't run at all (e.g. no number): Bobby says this instead. */
  failSay?: string;
};
