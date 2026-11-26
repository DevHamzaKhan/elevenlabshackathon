// Runs one sub-goal: direct shortcut acts first, then grounded multi-action batches from the exec
// model with every action's `expect` checked in code, escalation to the vision model when stuck,
// and a `done_when` check (code first, cheap model second) before anything counts as done.

import type { Check, DoneWhen, HandsAct, ModelFn, Msg, Risk, SubgoalSpec, Target } from "./types";
import { CHECK_SCHEMA, ESCALATE_SCHEMA, EXEC_SCHEMA } from "./prompts";
import { checkScreen, describeCompact, findNode, nodeLabel, stableTarget, unreadable } from "./screen";
import { cleanQuestion, type Question } from "./ask";

export type ActResult = { ok: boolean; error?: string; why?: string; app?: string; screen: Msg | null };

/** One step of a successful grounded run, with a stable target: what a recipe replays. */
export type TraceStep = { act: HandsAct; expect: Check; label: string };

/** How a question to the user ended: something to note and carry on with, or the task changed under us. */
export type AskOutcome = { kind: "note"; note: string } | { kind: "cancelled" } | { kind: "amended" };

export type ExecDeps = {
  model: ModelFn;
  log: (l: string) => void;
  systems: { exec: string; escalate: string; check: string };
  readScreen(opts?: { image?: boolean }): Promise<Msg | null>;
  act(a: HandsAct, opts: { fast: boolean }): Promise<ActResult>;
  narrate(text: string): void;
  /** Waits while paused (barge-in); "cancelled" when the task was stopped. */
  gate(): Promise<"go" | "cancelled">;
  /** Asks the user before an irreversible action the sub-goal didn't announce. */
  confirm(summary: string): Promise<boolean>;
  /** Asks the user a question the screen raised. Always comes back with something to go on. */
  ask(q: Question): Promise<AskOutcome>;
  /** False once this task has used its questions: the model is told to decide by itself. */
  canAsk(): boolean;
  /** Escalations left for this task; take() uses one. */
  escalations: { left(): number; take(): void };
  counters: { exec: number; escalate: number; check: number };
  /** Races a wait against the task being cancelled (null when cancelled first). */
  race<T>(p: Promise<T>): Promise<T | null>;
};

export type SubgoalRun = {
  spec: SubgoalSpec;
  taskGoal: string;
  /** Facts carried forward between sub-goals ("Sarah proposed 3pm"). */
  scratch: string[];
  /** The user already confirmed this sub-goal's irreversible step. */
  confirmed: boolean;
  /** Most actions for this sub-goal. */
  budget: number;
  /** A taught sub-goal nothing has been done for yet: the screen can't already show it finished. */
  mustAct?: boolean;
  /** Answers the user gave to earlier questions ("Which Alex? -> Alex Kim"), so they aren't asked again. */
  known?: string[];
};

export type SubgoalResult =
  | { ok: true; trace: TraceStep[]; how: "already" | "direct" | "grounded" | "recipe" | "script" }
  | { ok: false; cancelled?: boolean; reason: string; say: string; replan?: SubgoalSpec[]; degrade?: boolean };

const MAX_BATCH = 4;
export const IRREVERSIBLE_LABEL = /^\s*(send|send sms|send message|post|publish|pay|buy|purchase|place order|delete|remove|call|submit|confirm purchase)\b/i;

export class Executor {
  constructor(private d: ExecDeps) {}

  /** Is the sub-goal finished on this screen? Code first; the cheap model only when code can't tell. */
  async isDone(dw: DoneWhen, screen: Msg | null, actApp?: string): Promise<string | null> {
    const why = checkScreen(dw, screen, actApp);
    if (why !== "unknown") return why;
    if (!screen) return "no screen";
    this.d.counters.check += 1;
    const r = await this.d.race(this.d.model({
      purpose: "check",
      role: "check",
      system: this.d.systems.check,
      user: `Step: ${dw.describe}\n\nCurrent screen:\n${describeCompact(screen)}`,
      schema: CHECK_SCHEMA,
      maxTokens: 200,
      timeoutMs: 10_000,
    }));
    if (!r) return "cancelled";
    if (r.json?.done === true) return null;
    return r.json ? `not done: ${r.json.why}` : "check failed";
  }

  /** Runs a shortcut's deterministic acts, then checks done_when. */
  async runDirect(run: SubgoalRun): Promise<SubgoalResult> {
    const spec = run.spec;
    let screen: Msg | null = null;
    let app: string | undefined;
    for (const [i, a] of (spec.direct ?? []).entries()) {
      if ((await this.d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "" };
      if (i === 0 && spec.say) this.d.narrate(spec.say);
      const res = await this.d.act(a, { fast: i > 0 });
      if (!res.ok) {
        const degrade = res.error === "bad_request" || (a.do === "open" && res.error === "not_found");
        this.d.log(`exec: direct ${a.do} failed (${res.error}${res.why ? `/${res.why}` : ""})${degrade ? ", falling back to the screen" : ""}`);
        return { ok: false, reason: `direct ${a.do} failed: ${res.error}`, say: "", degrade: true };
      }
      screen = res.screen;
      app = res.app;
    }
    const why = await this.isDone(spec.done_when, screen, app);
    if (why === null) return { ok: true, trace: [], how: "direct" };
    this.d.log(`exec: direct acts ran but "${spec.done_when.describe}" isn't true yet (${why})`);
    return { ok: false, reason: why, say: "", degrade: true };
  }

  /** Grounded loop: exec-model batches with per-action checks, escalation when stuck. */
  async runGrounded(run: SubgoalRun, history: string[]): Promise<SubgoalResult> {
    const spec = run.spec;
    const trace: TraceStep[] = [];
    let steps = 0;
    let mismatches = 0;
    let modelFails = 0;
    let blind = 0;
    let escalatedHere = 0;
    // A run the user steered isn't a recipe: next time the screen may offer different choices.
    let asked = false;
    const done = (): SubgoalResult => ({ ok: true, trace: asked ? [] : trace, how: "grounded" });
    while (steps < run.budget) {
      if ((await this.d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "" };
      const unreadableNow = (s: Msg | null) => !!s && unreadable(s);
      let screen = await this.d.race(this.d.readScreen());
      if ((await this.d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "" };
      if (!screen) {
        if (++blind >= 3) return { ok: false, reason: "no screen", say: "I can't see the phone's screen right now, so I've stopped." };
        continue;
      }
      if (screen.locked) return { ok: false, reason: "locked", say: "Your phone is locked, so I can't do that. Unlock it and ask me again." };
      const doneWhy = checkScreen(spec.done_when, screen);
      if (doneWhy === null && !(run.mustAct && steps === 0)) return done();

      const stuck = mismatches >= 2 || unreadableNow(screen);
      let reply: any = null;
      let escalated = false;
      if (stuck) {
        if (this.d.escalations.left() <= 0) {
          return { ok: false, reason: "stuck", say: unreadableNow(screen) ? "I can't read this screen well enough to do that, so I've stopped." : "I keep getting stuck on this screen, so I've stopped." };
        }
        this.d.escalations.take();
        escalatedHere += 1;
        escalated = true;
        const shot = (await this.d.readScreen({ image: true })) ?? screen;
        screen = shot;
        this.d.counters.escalate += 1;
        const r = await this.d.race(this.d.model({
          purpose: "escalate",
          role: "escalate",
          system: this.d.systems.escalate,
          user: this.input(run, history, screen, mismatches >= 2 ? "The executor's last actions didn't do what it expected." : "The element list has nothing readable."),
          schema: ESCALATE_SCHEMA,
          images: typeof screen.image === "string" && screen.image ? [screen.image] : undefined,
          maxTokens: 3000,
          timeoutMs: 30_000,
        }));
        if (!r) return { ok: false, cancelled: true, reason: "cancelled", say: "" };
        reply = r.json;
        mismatches = 0;
        if (reply?.status === "replan" && Array.isArray(reply.replan) && reply.replan.length) {
          const replan = reply.replan.map(toSpec);
          history.push(`escalation re-planned this step into: ${replan.map((s: SubgoalSpec) => s.goal).join("; ")}`);
          return { ok: false, reason: "replan", say: "", replan };
        }
        if (reply?.status === "failed") return { ok: false, reason: "escalation gave up", say: String(reply.say || "I couldn't find a way to do that, so I've stopped.") };
      } else {
        this.d.counters.exec += 1;
        const r = await this.d.race(this.d.model({
          purpose: "exec",
          role: "exec",
          system: this.d.systems.exec,
          user: this.input(run, history, screen, ""),
          schema: EXEC_SCHEMA,
          maxTokens: 1500,
          timeoutMs: 15_000,
        }));
        if (!r) return { ok: false, cancelled: true, reason: "cancelled", say: "" };
        reply = r.json;
      }
      if (!reply) {
        if (++modelFails >= 3) return { ok: false, reason: "model", say: "I'm having trouble thinking this through, so I've stopped." };
        continue;
      }
      modelFails = 0;
      if (reply.note) run.scratch.push(String(reply.note));

      if (reply.status === "ask") {
        steps += 1;
        const q = cleanQuestion(reply);
        if (!q) {
          history.push("asked the user an empty question");
          mismatches += 1;
          continue;
        }
        const a = await this.d.ask(q);
        if (a.kind === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "" };
        if (a.kind === "amended") return { ok: false, reason: "amended", say: "" };
        asked = true;
        run.scratch.push(a.note);
        continue;
      }

      if (reply.status === "done" || (!escalated && reply.status === "act" && (!reply.actions || reply.actions.length === 0))) {
        const why = await this.isDone(spec.done_when, screen);
        if (why === null) return done();
        history.push(`claimed done, but the check says: ${why}`);
        mismatches += 1;
        steps += 1;
        continue;
      }
      if (reply.status === "failed") {
        history.push(`executor gave up: ${reply.say || "no reason"}`);
        mismatches = 2; // next round escalates, if any are left
        steps += 1;
        continue;
      }

      // Run the batch one action at a time, checking each expect.
      const actions: any[] = (reply.actions ?? []).slice(0, MAX_BATCH);
      let current: Msg = screen;
      let batchOk = true;
      for (let i = 0; i < actions.length; i++) {
        if ((await this.d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "" };
        const a = actions[i];
        const built = buildAct(a, screen, i, escalated);
        if ("error" in built) {
          history.push(`${describe(a, screen)} -> not done: ${built.error}`);
          batchOk = false;
          mismatches += 1;
          break;
        }
        const label = built.label;
        const irreversible = !!a.irreversible || ((a.do === "tap" || a.do === "long_press") && IRREVERSIBLE_LABEL.test(label));
        if (irreversible && !(spec.risk === "irreversible" && run.confirmed)) {
          const ok = await this.d.confirm(`${label || "This step"} (${run.taskGoal})`);
          if (!ok) return { ok: false, cancelled: true, reason: "declined", say: "" };
          run.confirmed = true;
        }
        if (i === 0 && reply.say) this.d.narrate(String(reply.say));
        const res = await this.d.act(built.act, { fast: i > 0 || !reply.say });
        steps += 1;
        const expect = toCheck(a.expect);
        let why: string | null;
        if (!res.ok) why = `failed: ${res.error ?? "unknown"}${res.why ? ` (${res.why})` : ""}`;
        else {
          why = checkScreen(expect, res.screen, res.app);
          if (why === "unknown") why = null;
        }
        history.push(`${describe(a, current)} -> ${why ? `MISMATCH: ${why}` : "ok"}`);
        if (res.screen) current = res.screen;
        if (why) {
          batchOk = false;
          mismatches += 1;
          break;
        }
        trace.push({ act: built.stable, expect, label });
      }
      if (batchOk) mismatches = 0;
      if (batchOk && current !== screen) {
        const why = checkScreen(spec.done_when, current);
        if (why === null) return done();
      }
      void escalatedHere;
    }
    return { ok: false, reason: "budget", say: "This is taking too many steps, so I've stopped. Sorry about that." };
  }

  private input(run: SubgoalRun, history: string[], screen: Msg, note: string): string {
    const dw = run.spec.done_when;
    const lines: string[] = [];
    lines.push(`Task: ${run.taskGoal}`);
    lines.push(`Sub-goal: ${run.spec.goal}`);
    const checks = [dw.app && `app ${dw.app} in front`, dw.text_present?.length && `"${dw.text_present.join('" or "')}" visible`, dw.text_absent?.length && `"${dw.text_absent.join('", "')}" gone`].filter(Boolean);
    lines.push(`Done when: ${dw.describe}${checks.length ? ` (${checks.join(", ")})` : ""}`);
    if (run.spec.risk === "irreversible") lines.push(run.confirmed ? "This sub-goal is the irreversible step; the user has confirmed it." : "This sub-goal is irreversible.");
    if (run.spec.guide) lines.push(`How the user showed this, step by step (do the same where the screen allows; adapt when it differs):\n${run.spec.guide}`);
    if (run.scratch.length) lines.push(`Notes from earlier steps:\n${run.scratch.slice(-6).map((s) => `- ${s}`).join("\n")}`);
    if (run.known?.length) lines.push(`The user's answers to earlier questions:\n${run.known.map((s) => `- ${s}`).join("\n")}`);
    if (!this.d.canAsk()) lines.push("You can't ask the user anything now: decide yourself.");
    if (history.length) {
      const start = Math.max(0, history.length - 8);
      lines.push(`Tried so far${start ? ` (last ${history.length - start})` : ""}:`);
      history.slice(start).forEach((h) => lines.push(`- ${h}`));
    } else lines.push("Tried so far: nothing.");
    if (note) lines.push(`Note: ${note}`);
    lines.push("");
    lines.push(`Current screen${Array.isArray(screen.size) ? ` (${screen.size[0]}x${screen.size[1]})` : ""}:`);
    lines.push(describeCompact(screen));
    return lines.join("\n");
  }
}

// ---------- helpers ----------

function toSpec(s: any): SubgoalSpec {
  const dw = s?.done_when ?? {};
  return {
    goal: String(s?.goal ?? ""),
    risk: (s?.risk === "irreversible" ? "irreversible" : "safe") as Risk,
    done_when: {
      describe: String(dw.describe ?? s?.goal ?? ""),
      ...(dw.app ? { app: String(dw.app) } : {}),
      ...(dw.text_present ? { text_present: [String(dw.text_present)] } : {}),
      ...(dw.text_absent ? { text_absent: [String(dw.text_absent)] } : {}),
    },
  };
}
export { toSpec as subgoalFromModel };

export function toCheck(e: any): Check {
  if (!e || typeof e !== "object") return {};
  const c: Check = {};
  if (e.app) c.app = String(e.app);
  if (e.text_present) c.text_present = [String(e.text_present)];
  if (e.text_absent) c.text_absent = [String(e.text_absent)];
  if (e.field_label && typeof e.field_value === "string") c.field = { text: String(e.field_label), value: String(e.field_value) };
  return c;
}

type Built = { act: HandsAct; stable: HandsAct; label: string } | { error: string };

/**
 * Model action -> Hands act. Node numbers are valid only for the screen the model saw, i.e. only
 * for the first action of a batch; later ones use a stable selector of that node or the label the
 * model gave. Recipes always get the stable form (never `n`).
 */
export function buildAct(a: any, screen: Msg, index: number, allowXY: boolean): Built {
  const n = Number.isInteger(a.n) ? a.n : -1;
  const nodes: any[] = Array.isArray(screen.nodes) ? screen.nodes : [];
  const node = n >= 0 ? nodes.find((x) => x.n === n) : undefined;
  if (n >= 0 && !node) return { error: `there is no node ${n} on this screen` };
  const stableOf = (): Target | null => {
    if (node) return stableTarget(screen, n);
    if (a.target_text) return { text: String(a.target_text) };
    if (allowXY && Number(a.x) >= 0 && Number(a.y) >= 0) return { x: Number(a.x), y: Number(a.y) };
    return null;
  };
  const stable = stableOf();
  const on: Target | null = node ? (index === 0 ? { n } : stable) : stable;
  const label = node ? nodeLabel(screen, n) : String(a.target_text ?? "");
  const both = (base: HandsAct, withOn: boolean): Built => {
    if (!withOn) return { act: base, stable: base, label };
    if (!on) return { error: node ? `node ${n} has no stable label for a later action; act on it first` : `${a.do} needs a node` };
    return { act: { ...base, on }, stable: { ...base, on: stable ?? on }, label };
  };
  switch (a.do) {
    case "tap":
    case "long_press":
      return both({ do: a.do }, true);
    case "type":
      if (typeof a.text !== "string" || !a.text) return { error: "type needs text" };
      return both({ do: "type", text: a.text }, !!(node || a.target_text));
    case "swipe":
      if (!["left", "right", "up", "down"].includes(a.dir)) return { error: "swipe needs a direction" };
      return both({ do: "swipe", dir: a.dir }, !!(node || a.target_text));
    case "key":
      if (!["home", "back", "recents", "notifications", "enter"].includes(a.key)) return { error: "key needs a name" };
      return both({ do: "key", name: a.key }, false);
    case "launch":
      if (!a.app) return { error: "launch needs an app" };
      return both({ do: "launch", app: String(a.app) }, false);
    case "wait":
      return both({ do: "wait", ms: Math.max(100, Math.min(5000, Number(a.ms) || 1000)) }, false);
    default:
      return { error: `unknown action "${a.do}"` };
  }
}

function describe(a: any, screen: Msg): string {
  const n = Number.isInteger(a.n) ? a.n : -1;
  const label = n >= 0 ? nodeLabel(screen, n) : a.target_text || (a.x >= 0 ? `pixel ${a.x},${a.y}` : "");
  switch (a.do) {
    case "tap":
    case "long_press":
      return `${a.do} "${label}"`;
    case "type":
      return `type "${a.text}"${label ? ` into "${label}"` : ""}`;
    case "swipe":
      return `swipe ${a.dir}`;
    case "key":
      return `press ${a.key}`;
    case "launch":
      return `launch ${a.app}`;
    case "wait":
      return `wait ${a.ms} ms`;
    default:
      return String(a.do);
  }
}

export { findNode };
