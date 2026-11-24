// Saved recipes: when a grounded run of a sub-goal succeeds, its steps (stable selectors, never
// `n`) and expects are stored, parameterized by the task's slots, keyed by (app package, app
// version, normalized sub-goal intent). They sit in an in-memory Map next to the shortcut index;
// lookup order in the brain is shortcut -> recipe -> grounded executor. Replays are deterministic
// with every expect checked; a mismatch falls back to grounded execution and marks the recipe
// stale, and a second failure deletes it. Persisted through Memory (the injected store).

import type { Check, DoneWhen, HandsAct, Msg, SubgoalSpec, TaskPlan } from "./types";
import type { ActResult, SubgoalResult, SubgoalRun, TraceStep } from "./exec";
import { checkScreen } from "./screen";
import type { Memory } from "./memory";

export type Recipe = {
  key: string;
  app: string;
  appVersion: string;
  intent: string;
  steps: TraceStep[];
  ok: number;
  fails: number;
  stale: boolean;
  savedAt: number;
};

export type ReplayDeps = {
  act(a: HandsAct, o: { fast: boolean }): Promise<ActResult>;
  narrate(t: string): void;
  gate(): Promise<"go" | "cancelled">;
  isDone(dw: DoneWhen, s: Msg | null): Promise<string | null>;
};

const MAX_RECIPES = 60;

/** Sub-goal text with slot values swapped for {{name}}, lower-cased, punctuation dropped. */
export function normalizeIntent(goal: string, slots: Record<string, string> = {}, shortcut = ""): string {
  let g = goal;
  for (const [k, v] of Object.entries(slots).sort((a, b) => b[1].length - a[1].length)) {
    if (v && v.length >= 2) g = g.split(v).join(`{{${k}}}`);
  }
  g = g.toLowerCase().replace(/[^a-z0-9{} ]+/g, " ").replace(/\s+/g, " ").trim();
  return shortcut ? `${shortcut}: ${g}` : g;
}

function param(s: string, slots: Record<string, string>): string {
  let out = s;
  for (const [k, v] of Object.entries(slots).sort((a, b) => b[1].length - a[1].length)) {
    if (v && v.length >= 2) out = out.split(v).join(`{{${k}}}`);
  }
  return out;
}

function fill(s: string, slots: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in slots ? slots[k] : m));
}

function mapStrings<T>(o: T, f: (s: string) => string): T {
  if (typeof o === "string") return f(o) as any;
  if (Array.isArray(o)) return o.map((x) => mapStrings(x, f)) as any;
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) out[k] = mapStrings(v, f);
    return out;
  }
  return o;
}

export class RecipeBook {
  private index = new Map<string, Recipe>();

  constructor(
    private memory: Memory,
    private log: (l: string) => void,
  ) {
    void memory.loaded.then(() => {
      for (const r of memory.recipes as Recipe[]) if (r && typeof r.key === "string" && Array.isArray(r.steps)) this.index.set(r.key, r);
    });
  }

  static key(app: string, version: string, intent: string) {
    return `${app}|${version}|${intent}`;
  }

  size() {
    return this.index.size;
  }

  all(): Recipe[] {
    return [...this.index.values()];
  }

  lookup(app: string, sg: SubgoalSpec, plan: TaskPlan, version = ""): Recipe | null {
    if (!app) return null;
    const intent = normalizeIntent(sg.goal, plan.slots, plan.shortcut);
    return this.index.get(RecipeBook.key(app, version, intent)) ?? null;
  }

  save(app: string, sg: SubgoalSpec, plan: TaskPlan, trace: TraceStep[], version: unknown = "") {
    if (!app || trace.length === 0) return;
    if (trace.some((t) => t.act.on && typeof t.act.on.n === "number")) {
      this.log("recipes: not saved (a step can only be named by its node number)");
      return;
    }
    const slots = plan.slots ?? {};
    const intent = normalizeIntent(sg.goal, slots, plan.shortcut);
    const key = RecipeBook.key(app, String(version ?? ""), intent);
    const steps = trace.map((t) => mapStrings(t, (s) => param(s, slots)));
    const r: Recipe = { key, app, appVersion: String(version ?? ""), intent, steps, ok: 0, fails: 0, stale: false, savedAt: Date.now() };
    this.index.set(key, r);
    this.log(`recipes: saved "${intent}" on ${app} (${steps.length} steps)`);
    this.persist();
  }

  /** Deterministic replay, every expect checked. A mismatch marks it stale; a second one deletes it. */
  async replay(r: Recipe, run: SubgoalRun, plan: TaskPlan, d: ReplayDeps): Promise<SubgoalResult> {
    const slots = plan.slots ?? {};
    this.log(`recipes: replaying "${r.intent}" (${r.steps.length} steps${r.stale ? ", stale" : ""})`);
    let screen: Msg | null = null;
    let why: string | null = null;
    for (const [i, step] of r.steps.entries()) {
      if ((await d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "" };
      const act = mapStrings(step.act, (s) => fill(s, slots));
      const expect: Check = mapStrings(step.expect, (s) => fill(s, slots));
      if (i === 0 && run.spec.say) d.narrate(run.spec.say);
      const res = await d.act(act, { fast: true });
      screen = res.screen;
      why = !res.ok ? `failed: ${res.error}` : checkScreen(expect, res.screen, res.app);
      if (why === "unknown") why = null;
      if (why) break;
    }
    if (!why) why = await d.isDone(run.spec.done_when, screen);
    if (!why) {
      r.ok += 1;
      r.fails = 0;
      r.stale = false;
      this.persist();
      return { ok: true, trace: r.steps, how: "recipe" };
    }
    r.fails += 1;
    r.stale = true;
    if (r.fails >= 2) {
      this.index.delete(r.key);
      this.log(`recipes: "${r.intent}" failed twice (${why}); deleted`);
    } else this.log(`recipes: "${r.intent}" mismatched (${why}); marked stale, falling back to the screen`);
    this.persist();
    return { ok: false, reason: `recipe: ${why}`, say: "" };
  }

  private persist() {
    const list = this.all().sort((a, b) => a.savedAt - b.savedAt).slice(-MAX_RECIPES);
    this.memory.recipes = list;
    this.memory.save();
  }
}
