// Replays the steps of a taught skill (see teach.ts). No model call: each step's control is found
// again on the live screen in code (resource id, label, class, position as a tie-break), acted on,
// and its `expect` checked before the next step. Anything that doesn't match stops the replay and
// reports how far it got, so the grounded executor can carry on from there with the demo as a guide.

import type { Check, DoneWhen, HandsAct, Msg, ScreenNode, ScriptStep, Want } from "./types";
import type { ActResult, SubgoalResult } from "./exec";
import { checkScreen } from "./screen";

export type ScriptDeps = {
  act(a: HandsAct, o: { fast: boolean }): Promise<ActResult>;
  read(): Promise<Msg | null>;
  /** The newest screen the Mind holds, if any. */
  screen(): Msg | null;
  narrate(t: string): void;
  gate(): Promise<"go" | "cancelled">;
  isDone(dw: DoneWhen, s: Msg | null): Promise<string | null>;
  log(l: string): void;
};

export type ScriptOutcome = SubgoalResult & {
  /** Steps that ran and passed their check before it stopped. */
  ran: number;
};

const MAX_SEEK = 6;
const SETTLE_TRIES = 3;
const SETTLE_MS = 400;
const FOLD = " · ";

/** Fills `{{slot}}` placeholders. Unknown slots are left as they are. */
export function fill(s: string, slots: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in slots ? slots[k] : m));
}

export function mapStrings<T>(o: T, f: (s: string) => string): T {
  if (typeof o === "string") return f(o) as any;
  if (Array.isArray(o)) return o.map((x) => mapStrings(x, f)) as any;
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) out[k] = mapStrings(v, f);
    return out;
  }
  return o;
}

const low = (s: unknown) => String(s ?? "").trim().toLowerCase();
const shortId = (id: unknown) => String(id ?? "").split("/").pop() ?? "";

function labels(n: any): string[] {
  return [n.text, n.desc, n.hint].map(low).filter(Boolean);
}

/**
 * Finds the control a step was recorded on. A match needs the same key, the same resource id, or
 * the same label; class and kind add confidence. An id shared by several nodes (list rows) only
 * counts when the label agrees too. Equal best matches are told apart by where the control was
 * on screen when recorded; if that can't decide either, nothing is returned (never a guess).
 */
export function locate(screen: { [k: string]: any } | null, w: Want): ScreenNode | null {
  const nodes: any[] = Array.isArray(screen?.nodes) ? screen!.nodes : [];
  // A field's own text is what was typed into it, so it never identifies the field.
  const wantLabels = (w.edit ? [w.hint, w.desc] : [w.text, w.desc, w.hint]).map(low).filter(Boolean);
  const wid = shortId(w.id);
  const scored: { n: any; s: number; strong: boolean }[] = [];
  for (const n of nodes) {
    const keyEq = !!w.key && n.key === w.key;
    const idEq = !!wid && shortId(n.id) === wid;
    const ls = labels(n);
    const labelEq = wantLabels.length > 0 && ls.some((l) => wantLabels.includes(l));
    // Part of a folded row label, or most of a longer label ("New project" in "New project (2)").
    // Not a word that merely occurs in another sentence ("Create" in "Project created").
    const labelPart =
      !labelEq && wantLabels.length > 0 && ls.some((l) => wantLabels.some((q) => l.split(FOLD).some((p) => p.trim() === q) || (q.length >= 4 && l.includes(q) && q.length >= l.length * 0.6)));
    if (!keyEq && !idEq && !labelEq && !labelPart) continue;
    let s = 0;
    if (keyEq) s += 3;
    if (idEq) s += 4;
    if (labelEq) s += 4;
    if (labelPart) s += 2;
    // Same id, different words: probably another row of the same list.
    if (idEq && !keyEq && !labelEq && !labelPart && wantLabels.length > 0 && ls.length > 0) s -= 2;
    if (w.cls && n.cls && shortCls(n.cls) === shortCls(w.cls)) s += 1;
    if (w.edit !== undefined && !!n.edit === !!w.edit) s += 1;
    if (n.disabled) s -= 1;
    scored.push({ n, s, strong: keyEq || labelEq || (idEq && (labelPart || wantLabels.length === 0 || ls.length === 0)) });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.s - a.s);
  const best = scored.filter((x) => x.s === scored[0].s);
  if (best.length === 1) return best[0].s >= 2 ? best[0].n : null;
  // Several equally good: the one nearest to where it was recorded, if that is clear-cut.
  if (!w.at) return null;
  const d = (n: any) => {
    const b = n.bounds;
    if (!Array.isArray(b) || b.length !== 4) return Number.MAX_SAFE_INTEGER;
    return Math.hypot((b[0] + b[2]) / 2 - w.at![0], (b[1] + b[3]) / 2 - w.at![1]);
  };
  best.sort((a, b) => d(a.n) - d(b.n));
  if (!best[0].strong) return null;
  return d(best[1].n) - d(best[0].n) >= 24 ? best[0].n : null;
}

function shortCls(c: string) {
  return String(c).split(".").pop() ?? "";
}

const DISMISS_RE = /^(close|close popup window|close tooltip|dismiss|got it|not now|no,? thanks|skip|maybe later|remind me later)$/i;

/**
 * A tip, coach mark or "rate us" sheet: a handful of nodes, one of which only closes it. While
 * one is up, Android shows accessibility nothing of the app underneath, so a replay can neither
 * find its next control nor check its last step. Returns the control that closes it, or null.
 * "OK", "Cancel", "Allow" and the like are never treated as a way out: those are decisions.
 */
export function overlayExit(screen: { [k: string]: any } | null): ScreenNode | null {
  const nodes: any[] = Array.isArray(screen?.nodes) ? screen!.nodes : [];
  const labelled = nodes.filter((n) => labels(n).length > 0);
  if (labelled.length === 0 || labelled.length > 6) return null;
  const exits = labelled.filter((n) => n.tap && !n.edit && labels(n).some((l) => DISMISS_RE.test(l)));
  return exits.length === 1 ? exits[0] : null;
}

/** A screen caught between two pages: nothing on it has a label. Never something to check against. */
export function blank(screen: { [k: string]: any } | null): boolean {
  const nodes: any[] = Array.isArray(screen?.nodes) ? screen!.nodes : [];
  return !screen?.locked && nodes.filter((n) => labels(n).length > 0).length < 2;
}

/** The target Hands should act on for a located node: its key when it has one, else its number. */
function targetOf(n: any) {
  return n.key ? { key: String(n.key) } : { n: Number(n.n) };
}

/** Is the first control of a script on this screen? (Used before deciding to relaunch the app.) */
export function firstTargetVisible(steps: ScriptStep[], slots: Record<string, string>, screen: Msg | null): boolean {
  // A step that only closes a tip says nothing about where the app is.
  const first = steps.find((s) => (s.want || s.pixel) && !s.optional);
  if (!first || first.pixel || !first.want) return true;
  if (first.seek) return true;
  return !!locate(screen, mapStrings(first.want, (s) => fill(s, slots)));
}

/** Runs the steps in order. Stops at the first control it can't find or check that doesn't hold. */
export async function runScript(
  steps: ScriptStep[],
  slots: Record<string, string>,
  spec: { say?: string; done_when: DoneWhen },
  history: string[],
  d: ScriptDeps,
): Promise<ScriptOutcome> {
  let screen: Msg | null = d.screen() ?? (await d.read());
  let ran = 0;
  const stop = (reason: string): ScriptOutcome => ({ ok: false, reason: `script: ${reason}`, say: "", ran });
  for (const [i, step] of steps.entries()) {
    if ((await d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "", ran };
    const act: HandsAct = mapStrings(step.act, (s) => fill(s, slots));
    const expect: Check = mapStrings(step.expect, (s) => fill(s, slots));
    const label = fill(step.label, slots);
    if (/\{\{\w+\}\}/.test(JSON.stringify(act))) return stop(`"${label}" needs a value that wasn't given`);
    let on: HandsAct["on"];
    if (step.pixel && step.want?.at) on = { x: step.want.at[0], y: step.want.at[1] };
    else if (step.want) {
      const want: Want = mapStrings(step.want, (s) => fill(s, slots));
      let node = locate(screen, want);
      if (!node && step.seek) {
        const dirs = step.seek === "any" ? ["up", "down"] : [step.seek];
        seek: for (const dir of dirs) {
          for (let k = 0; k < MAX_SEEK; k++) {
            const before = screen?.hash;
            const r = await d.act({ do: "swipe", dir }, { fast: true });
            if (!r.ok) break;
            screen = r.screen;
            node = locate(screen, want);
            if (node) break seek;
            if (before && screen?.hash === before) break; // the end of the list
          }
        }
      }
      if (!node) {
        // What the Mind holds may be older than the phone: look once more before giving up.
        screen = await d.read();
        node = locate(screen, want);
      }
      if (!node && !step.optional) {
        // A tip that wasn't there during the demo may be covering the app: close it and look again.
        const cleared = await closeOverlay(screen, d, history);
        if (cleared) {
          screen = cleared;
          node = locate(screen, want);
        }
      }
      if (!node && step.optional) {
        history.push(`${label} -> skipped (it isn't showing this time)`);
        ran += 1;
        continue;
      }
      if (!node) return stop(`can't find ${describeWant(want)} for "${label}"`);
      on = targetOf(node);
    }
    if (i === 0 && spec.say) d.narrate(spec.say);
    let res = await d.act(on ? { ...act, on } : act, { fast: true });
    if (!res.ok && res.error === "not_found" && step.want && !step.pixel) {
      // The screen moved between the read and the act: find it again and try once more.
      screen = await d.read();
      const again = locate(screen, mapStrings(step.want, (s) => fill(s, slots)));
      if (again) res = await d.act({ ...act, on: targetOf(again) }, { fast: true });
    }
    if (!res.ok) return stop(`${label} failed: ${res.error ?? "unknown"}${res.why ? ` (${res.why})` : ""}`);
    screen = res.screen;
    // Read mid-transition, a screen can come back empty: wait for the real one before judging.
    for (let t = 0; blank(screen) && t < SETTLE_TRIES; t++) {
      const w = await d.act({ do: "wait", ms: SETTLE_MS }, { fast: true });
      if (w.screen) screen = w.screen;
    }
    let why = verdict(expect, screen, res.app);
    const last = i === steps.length - 1;
    // A tip popped up over the result (or over the end of the whole thing): close it first.
    if ((why || (last && Object.keys(expect).length === 0)) && !step.optional) {
      const cleared = await closeOverlay(screen, d, history);
      if (cleared) {
        screen = cleared;
        why = verdict(expect, screen, res.app);
      }
    }
    // A check can fail only because the app hasn't caught up yet (a list still loading).
    for (let t = 0; why && t < SETTLE_TRIES; t++) {
      if ((await d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "", ran };
      const w = await d.act({ do: "wait", ms: SETTLE_MS }, { fast: true });
      if (w.screen) screen = w.screen;
      why = verdict(expect, screen, res.app);
    }
    if (why && last && spec.done_when.describe) {
      // Every step ran and only the last check is off. The check was made from one demo, and what
      // showed after it may have been a one-off (a tip, a banner). Before calling it a failure,
      // and risking the last step being done twice, ask the cheap model check whether the screen
      // shows the job finished.
      const second = await d.isDone({ describe: spec.done_when.describe }, screen);
      if (second === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "", ran };
      if (second === null) {
        d.log(`script: after ${label} the recorded check didn't hold (${why}), but the screen shows it finished`);
        why = null;
      }
    }
    if (why) {
      history.push(`${label} -> MISMATCH: ${why}`);
      return stop(`after ${label}: ${why}`);
    }
    history.push(`${label} -> ok`);
    ran += 1;
  }
  // Every step's own check held. Only when the last one that ran had nothing to check is the
  // sub-goal's `done_when` consulted (code first, the cheap model check when code can't tell).
  const final = [...steps].reverse().find((s) => !s.optional);
  const unchecked = !final || Object.keys(final.expect ?? {}).length === 0;
  if (unchecked && !steps.some((s) => s.pixel)) {
    // Nothing was recorded to check the end against (the demo ended under a tip). Let the screen
    // come to rest first: a check made mid-transition sees an empty page.
    for (let k = 0; k < 4; k++) {
      if ((await d.gate()) === "cancelled") return { ok: false, cancelled: true, reason: "cancelled", say: "", ran };
      const r = await d.act({ do: "wait", ms: SETTLE_MS }, { fast: true });
      const next: Msg | null = r.screen ?? screen;
      const still = !!next?.hash && next.hash === screen?.hash;
      screen = next;
      if (still) break;
    }
    screen = (await closeOverlay(screen, d, history)) ?? screen;
    if (!leftItsMark(steps, slots, final, screen)) {
      const why = await d.isDone(spec.done_when, screen);
      if (why) return stop(`steps ran but: ${why}`);
    }
  }
  return { ok: true, trace: [], how: "script", ran };
}

/**
 * Evidence, in code, that an unchecked last step took: the control it acted on is gone, and
 * something the script typed now shows as plain text (the saved contact's name on its page),
 * not just inside the field it was typed into. Without both, the model check decides.
 */
function leftItsMark(steps: ScriptStep[], slots: Record<string, string>, final: ScriptStep | undefined, screen: Msg | null): boolean {
  if (!final?.want || !screen || locate(screen, mapStrings(final.want, (s) => fill(s, slots)))) return false;
  const typed = steps.filter((s) => s.act.do === "type" && s.act.text).map((s) => low(fill(String(s.act.text), slots))).filter((t) => t.length >= 2);
  const nodes: any[] = Array.isArray(screen.nodes) ? screen.nodes : [];
  return typed.some((t) => nodes.some((n) => !n.edit && labels(n).some((l) => l.includes(t))));
}

/** Closes a tip that is covering the app (see overlayExit). Returns the screen after, or null when there was none. */
export async function closeOverlay(screen: Msg | null, d: Pick<ScriptDeps, "act" | "log">, history?: string[]): Promise<Msg | null> {
  let out: Msg | null = null;
  let cur = screen;
  for (let k = 0; k < 2; k++) {
    const exit = overlayExit(cur);
    if (!exit) break;
    const name = labelOf(exit);
    d.log(`script: a tip is covering the app; closing it ("${name}")`);
    const r = await d.act({ do: "tap", on: targetOf(exit) }, { fast: true });
    if (!r.ok || !r.screen) break;
    history?.push(`closed a tip that was in the way ("${name}") -> ok`);
    out = cur = r.screen;
  }
  return out;
}

function verdict(expect: Check, screen: Msg | null, app?: string): string | null {
  const why = checkScreen(expect, screen, app);
  return why === "unknown" ? null : why;
}

function describeWant(w: Want): string {
  const l = w.text || w.desc || w.hint;
  return l ? `"${l}"` : w.id ? `the control "${shortId(w.id)}"` : "the control";
}

/** Label of a node for step descriptions: its text, description, or hint. */
export function labelOf(n: Partial<ScreenNode> | null | undefined): string {
  if (!n) return "";
  return String(n.text || n.desc || n.hint || "").replace(/\s+/g, " ").trim();
}
