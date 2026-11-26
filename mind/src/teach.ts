// Teaching by showing. The user says "I'm going to show you how to add a project", does it on the
// phone, and says "done". While they do it, Hands streams what it sees through its accessibility
// service (`observed` frames: taps, typed text, scrolls, and the settled screen between them).
// This file turns that stream into a skill:
//   readDemo()    events -> ordered steps, each with the screen before and after it
//   buildSkill()  steps + what the model made of them (title, slots, trigger words) -> a Skill:
//                 a script of steps with `{{slot}}` placeholders, each with a way to find its
//                 control again and a check of what the screen shows afterwards
//   SkillBook     keeps skills in the store and registers each as a shortcut, so a later request
//                 matches it locally (no model call) or through the router's catalogue
// Running a skill: script.ts replays the steps in code; if the screen no longer matches, the
// grounded executor takes over with the same steps as a written guide (brain.ts).

import type { Check, DoneWhen, HandsAct, Msg, Risk, ScriptStep, SubgoalSpec, TaskPlan, Want } from "./types";
import type { KeyValueStore } from "./memory";
import type { LocalMatch, Shortcut, ShortcutIndex, SlotDef } from "./shortcuts";
import { appLabel } from "./screen";
import { IRREVERSIBLE_LABEL } from "./exec";
import { escapeRe } from "./contacts";
import { fill, labelOf, locate, mapStrings } from "./script";

// ---------- what the user says ----------

const WAKE_RE = /^[\s,]*(?:(?:hey|hi|ok(?:ay)?|yo|so|alright|all right|now)[\s,]+)*(?:(?:tibby|bobby)[\s,.!]+)?(?:(?:ok(?:ay)?|so|alright|now)[\s,]+)*/i;
const TEACH_RE =
  /^(?:(?:i(?:'m| am|'ll| will|'d like to| would like to| want to| wanna)?\s+(?:(?:going to|gonna|about to|want to|wanna)\s+)?|let me\s+|(?:can|could|may) i\s+|let's\s+)?(?:show(?:ing)?|teach(?:ing)?|demonstrat(?:e|ing))\s+you\b|watch (?:me|how i|this)\b|learn (?:this|how to|a new skill)\b|here'?s how (?:to|you|i)\b)\s*(.*)$/i;
const TEACH_DONE_RE =
  /\b(done|finished|that'?s (?:it|all|everything|how)|that is (?:it|all|how)|all set|save (?:it|that|this)|stop(?: (?:watching|recording|teaching|now))?|end (?:it|recording|teaching)|(?:you )?got (?:it|that)|did you (?:get|see) (?:it|that)|learn(?:ed)? (?:it|that))\b/i;
const TEACH_CANCEL_RE = /\b(cancel|never ?mind|forget (?:it|that|this)|discard|scrap (?:it|that)|don'?t save|do not save|abort|throw (?:it|that) away|start over)\b/i;
const FORGET_RE = /^(?:please\s+)?(?:forget|unlearn|delete|remove)\s+(?:how to\s+|how i\s+|the skill\s*(?:for|to|of|called|named)?\s*|what i (?:taught|showed) you about\s+)(.+)$/i;

const strip = (text: string) => text.replace(WAKE_RE, "").trim();

/** "I'm going to show you how to add a new project. I'll type test test." -> { name: "add a new project" }. */
export function teachIntent(text: string): { name: string } | null {
  const m = TEACH_RE.exec(strip(text));
  if (!m) return null;
  let r = (m[1] ?? "").trim();
  r = r.replace(/^(?:a|one|some|this|my)\s+(?:new\s+)?(?:skill|thing|trick)\b[\s,:.\-]*/i, "").replace(/^something(?:\s+new)?\b[\s,:.\-]*/i, "");
  r = r.replace(/^(?:and\s+)?(?:it'?s\s+|that'?s\s+|which is\s+)?/i, "");
  const how = /^(?:how\s+(?:to|i|you(?:\s+can)?|we)\s+|to\s+)(.+)$/i.exec(r);
  if (how) r = how[1];
  r = r.split(/[.!?;]|,\s*(?:i'?m|i am|i'?ll|i will|so|and i|watch|by)\b|\s+(?:i'?m going to|i am going to|i'?ll (?:do|show)|watch me|by doing)\b/i)[0] ?? "";
  return { name: r.trim().replace(/[,\s]+$/, "") };
}

/** While a demo is being watched: did the user say they are finished, or to throw it away? */
export function teachEnd(text: string): "done" | "cancel" | null {
  const t = strip(text);
  if (!t || t.split(/\s+/).length > 10) return null;
  if (TEACH_CANCEL_RE.test(t)) return "cancel";
  if (TEACH_DONE_RE.test(t)) return "done";
  return null;
}

/** "forget how to add a project" -> "add a project". */
export function forgetIntent(text: string): string | null {
  const m = FORGET_RE.exec(strip(text).replace(/[.!?]+$/, ""));
  return m ? m[1].trim() : null;
}

// ---------- the recorded demo ----------

export type DemoStep = {
  kind: "tap" | "long_press" | "type" | "key";
  app: string;
  node: any | null;
  /** Typed text (`type`) or key name (`key`). */
  text?: string;
  pre: Msg | null;
  post: Msg | null;
  seek?: ScriptStep["seek"];
};

export type Demo = {
  steps: DemoStep[];
  /** The demo ran into a password field: recording stopped there. */
  secret: boolean;
  last: Msg | null;
};

const SYSTEMUI = "com.android.systemui";

function isLauncher(pkg: string, launcher?: string): boolean {
  if (!pkg) return true;
  if (launcher && pkg === launcher) return true;
  return /launcher/i.test(pkg) || appLabel(pkg) === "Home screen";
}

const isOwn = (pkg: string) => pkg.startsWith("dev.bobby.");

/** A system navigation button (three-button navigation) -> the key it stands for. */
function navKey(node: any): string | null {
  const l = labelOf(node).toLowerCase();
  const id = String(node?.id ?? "").split("/").pop();
  if (l === "back" || id === "back") return "back";
  if (l === "home" || id === "home" || /^(overview|recents?|recent apps)$/.test(l) || id === "recent_apps") return "leave";
  return null;
}

function sameField(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.key && b.key) return a.key === b.key;
  if (a.id && b.id && a.id === b.id) return true;
  return Array.isArray(a.bounds) && Array.isArray(b.bounds) && a.bounds.join() === b.bounds.join();
}

/** How to find a recorded node again (see locate()). */
export function wantOf(node: any): Want {
  const w: Want = {};
  if (!node) return w;
  if (node.id) w.id = String(node.id);
  if (node.key) w.key = String(node.key);
  if (node.text && !node.edit) w.text = String(node.text);
  if (node.desc) w.desc = String(node.desc);
  if (node.hint) w.hint = String(node.hint);
  if (node.cls) w.cls = String(node.cls);
  if (node.edit) w.edit = true;
  if (Array.isArray(node.bounds) && node.bounds.length === 4) w.at = [Math.round((node.bounds[0] + node.bounds[2]) / 2), Math.round((node.bounds[1] + node.bounds[3]) / 2)];
  return w;
}

/**
 * Orders the `observed` frames into steps. Taps on the home screen become "open the app" (see
 * buildSkill); a tap into a field followed by typing is one `type`; typing that ends with the
 * field gone and no tap in between was the keyboard's enter; a scroll only matters when the next
 * control wasn't on screen before it.
 */
export function readDemo(events: Msg[], opts: { launcher?: string; initial?: Msg | null } = {}): Demo {
  const screens = new Map<string, Msg>();
  let last: Msg | null = opts.initial ?? null;
  if (last?.hash) screens.set(String(last.hash), last);
  const acts: { e: Msg; pre: Msg | null; post: Msg | null }[] = [];
  const sorted = [...events].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  for (const e of sorted) {
    if (e.kind === "screen") {
      const s = e.screen;
      if (!s || typeof s !== "object" || isOwn(String(s.app ?? ""))) continue;
      if (s.hash) screens.set(String(s.hash), s);
      last = s;
      if (acts.length) acts[acts.length - 1].post = s;
      continue;
    }
    if (!["tap", "long_press", "type", "scroll"].includes(String(e.kind))) continue;
    acts.push({ e, pre: (e.hash && screens.get(String(e.hash))) || last, post: null });
  }
  for (let i = 0; i < acts.length; i++) if (!acts[i].post) acts[i].post = acts[i + 1]?.pre ?? last;

  const steps: DemoStep[] = [];
  let secret = false;
  let scroll: { dir: ScriptStep["seek"]; pre: Msg | null } | null = null;
  for (const a of acts) {
    const e = a.e;
    const app = String(e.app ?? a.pre?.app ?? "");
    if (isOwn(app)) continue;
    if (e.kind === "scroll") {
      if (!isLauncher(app, opts.launcher) && !scroll) scroll = { dir: ["up", "down", "left", "right"].includes(e.dir) ? e.dir : "any", pre: a.pre };
      continue;
    }
    if (app === SYSTEMUI && e.kind === "tap") {
      const nav = navKey(e.node);
      if (nav) {
        const prev = steps[steps.length - 1];
        if (nav === "back" && prev) steps.push({ kind: "key", app: prev.app, node: null, text: "back", pre: a.pre, post: a.post });
        scroll = null;
        continue;
      }
    }
    if (isLauncher(app, opts.launcher)) {
      scroll = null;
      continue;
    }
    const prev = steps[steps.length - 1];
    if (e.kind === "type") {
      if (e.password) {
        secret = true;
        break;
      }
      const text = String(e.text ?? "");
      if (prev && prev.kind === "type" && sameField(prev.node, e.node)) {
        prev.text = text;
        prev.post = a.post;
      } else if (prev && prev.kind === "tap" && prev.app === app && sameField(prev.node, e.node)) {
        steps[steps.length - 1] = { kind: "type", app, node: prev.node ?? e.node, text, pre: prev.pre, post: a.post, seek: prev.seek };
      } else steps.push({ kind: "type", app, node: e.node ?? null, text, pre: a.pre, post: a.post });
      scroll = null;
      continue;
    }
    const step: DemoStep = { kind: e.kind === "long_press" ? "long_press" : "tap", app, node: e.node ?? null, pre: a.pre, post: a.post };
    if (scroll && scroll.pre && e.node && !locate(scroll.pre, wantOf(e.node))) step.seek = scroll.dir;
    scroll = null;
    steps.push(step);
  }

  // The keyboard's enter leaves no event: typing, then the field is gone with no tap in between.
  const out: DemoStep[] = [];
  for (const s of steps) {
    if (s.kind === "type" && s.text && s.node && s.post && s.pre && s.post.hash !== s.pre.hash && !locate(s.post, wantOf(s.node))) {
      out.push({ ...s, post: null });
      out.push({ kind: "key", app: s.app, node: null, text: "enter", pre: s.pre, post: s.post });
    } else out.push(s);
  }
  // Empty typing (a field tapped, typed in and cleared) teaches nothing.
  return { steps: out.filter((s) => !(s.kind === "type" && !s.text)), secret, last };
}

// ---------- checks computed from the screens ----------

const lc = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Every label on a screen. What a text field holds is its content, not a label, so it is left out. */
function screenLabels(s: Msg | null): { label: string; active: boolean }[] {
  const nodes: any[] = Array.isArray(s?.nodes) ? s!.nodes : [];
  const out: { label: string; active: boolean }[] = [];
  for (const n of nodes) for (const l of [n.edit ? "" : n.text, n.desc, n.hint]) if (l) out.push({ label: String(l).replace(/\s+/g, " ").trim(), active: !!(n.tap || n.edit) });
  return out;
}

const looksLive = (l: string) => /\d/.test(l) || l.length > 48 || l.length < 2;

/**
 * What must be true after a step, from the screens recorded around it: the app that came to the
 * front, else a label or two that appeared (short, no numbers, or holding something the user
 * typed), else a label that went away. Empty when the step changed nothing that can be named.
 */
export function expectFor(step: DemoStep, typed: string[]): Check {
  const { pre, post } = step;
  if (!post) return {};
  if (step.kind === "type") return step.text ? { text_present: [step.text] } : {};
  return changeBetween(pre, post, typed);
}

/**
 * What tells `post` apart from `pre`. A label that holds something the user typed is the best
 * evidence there is (the new project's name in the list), so when one appeared nothing weaker is
 * accepted in its place; otherwise any one of two new labels will do.
 */
export function changeBetween(pre: Msg | null, post: Msg | null, typed: string[]): Check {
  const c: Check = {};
  if (!post) return c;
  if (pre?.app && post.app && pre.app !== post.app) c.app = String(post.app);
  if (pre && pre.hash && pre.hash === post.hash) return c;
  const before = new Set(screenLabels(pre).map((x) => lc(x.label)));
  const seen = new Set<string>();
  const ranked: { label: string; rank: number }[] = [];
  for (const x of screenLabels(post)) {
    const k = lc(x.label);
    if (before.has(k) || seen.has(k)) continue;
    seen.add(k);
    const holdsTyped = typed.some((t) => t.length >= 2 && k.includes(lc(t)));
    if (holdsTyped && x.label.length <= 80) ranked.push({ label: x.label, rank: 0 });
    else if (!looksLive(x.label)) ranked.push({ label: x.label, rank: x.active ? 1 : 2 });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const strong = ranked.filter((x) => x.rank === 0);
  if (ranked.length) c.text_present = (strong.length ? strong : ranked).slice(0, 2).map((x) => x.label);
  else if (!c.app) {
    const after = screenLabels(post).map((x) => lc(x.label));
    const gone = screenLabels(pre).find((x) => !looksLive(x.label) && !after.some((l) => l.includes(lc(x.label))));
    if (gone) c.text_absent = [gone.label];
  }
  return c;
}

// ---------- what the model (or a fallback) makes of a demo ----------

export type SkillSlot = SlotDef & { example: string };

export type SkillMeta = {
  title: string;
  intent: string;
  say: string;
  done_say: string;
  keywords: string[][];
  slots: SkillSlot[];
  /** 1-based numbers of steps that send, post, call, pay, buy or delete. */
  irreversible: number[];
  /** 1-based numbers of steps to leave out (mistakes). */
  drop: number[];
};

/** One step in words: `tap "Create"`, `type "test" into "Project name"`, `press enter`. */
export function stepLabel(s: DemoStep): string {
  const l = labelOf(s.node) || String(s.node?.id ?? "").split("/").pop() || "";
  switch (s.kind) {
    case "type":
      return `type "${s.text ?? ""}"${l ? ` into "${l}"` : ""}`;
    case "key":
      return `press ${s.text}`;
    case "long_press":
      return `long-press "${l || "the control"}"`;
    default:
      return `tap "${l || "the control"}"`;
  }
}

/** The changing part of the teach call: what was said and the recorded steps. */
export function teachInput(demo: Demo, said: { name: string; heard: string; notes: string[] }): string {
  const lines: string[] = [];
  lines.push(`The user said, when starting: "${said.heard}"`);
  if (said.notes.length) lines.push(`Things they said while showing it:\n${said.notes.map((n) => `- ${n}`).join("\n")}`);
  lines.push(`Skill name as heard: "${said.name || "(none given)"}"`);
  const apps = [...new Set(demo.steps.map((s) => s.app))];
  lines.push(`App${apps.length > 1 ? "s" : ""}: ${apps.map((a) => `${appLabel(a)} (${a})`).join(", ")}`);
  lines.push("");
  lines.push("Recorded steps:");
  demo.steps.forEach((s, i) => lines.push(`${i + 1}. ${stepLabel(s)}${s.node?.cls ? ` (${String(s.node.cls).split(".").pop()})` : ""}`));
  const end = screenLabels(demo.last).map((x) => x.label).filter((l) => l.length <= 60);
  if (end.length) lines.push("", `Screen at the end shows: ${[...new Set(end)].slice(0, 25).map((l) => `"${l}"`).join(", ")}`);
  if (demo.secret) lines.push("", "The demo stopped at a password field; nothing after it was recorded.");
  return lines.join("\n");
}

const SYNONYMS = [
  ["add", "create", "make", "new", "start"],
  ["delete", "remove", "erase", "trash"],
  ["open", "show", "view", "go"],
  ["send", "post", "share", "submit"],
  ["search", "find", "look"],
  ["turn", "switch", "toggle", "set", "enable", "disable"],
  ["log", "record", "track", "enter"],
  ["edit", "change", "update", "rename"],
  ["buy", "order", "purchase"],
  ["play", "put"],
];

const STOP = new Set(
  "a an the my me new please can could would will you i want wanna need like to for with in on of at and just quickly go ahead lets let's let us it that this some one another app application name named title titled hey ok okay so now up into using use via do".split(
    " ",
  ),
);

const singular = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function keywordGroups(name: string): string[][] {
  const out: string[][] = [];
  for (const w of words(name).map(singular)) {
    if (STOP.has(w) && !SYNONYMS.some((g) => g.includes(w))) continue;
    if (w === "new" && out.length > 0) continue;
    const syn = SYNONYMS.find((g) => g.includes(w));
    if (out.some((g) => g.includes(w))) continue;
    out.push(syn ? [...syn] : [w]);
    if (out.length === 3) break;
  }
  return out;
}

function slotNameFrom(label: string, taken: Set<string>): string {
  const ws = words(label).filter((w) => !STOP.has(w) || w === "name" || w === "title");
  let base = ws[ws.length - 1] || "text";
  if (!/^[a-z]/.test(base)) base = "text";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

/** With no model: named from what was said, every typed text a slot named after its field. */
export function fallbackMeta(demo: Demo, said: { name: string }): SkillMeta {
  const app = appLabel(demo.steps[0]?.app);
  const name = said.name || `the ${app} thing you showed me`;
  const taken = new Set<string>();
  const slots: SkillSlot[] = demo.steps
    .filter((s) => s.kind === "type" && s.text)
    .map((s) => {
      const field = labelOf(s.node);
      const n = slotNameFrom(field, taken);
      return { name: n, required: true, desc: field ? field.toLowerCase() : "the text to type", example: s.text! };
    });
  return {
    title: cap(name),
    intent: `${cap(name)} in ${app}.`,
    say: "Doing it the way you showed me.",
    done_say: `Done: ${name}.`,
    keywords: keywordGroups(said.name),
    slots,
    irreversible: [],
    drop: [],
  };
}

/** Checks the model's reply against the demo; null when it can't be used. */
export function cleanMeta(j: any, demo: Demo, said: { name: string }): SkillMeta | null {
  if (!j || typeof j !== "object" || !String(j.title ?? "").trim()) return null;
  const fb = fallbackMeta(demo, said);
  const hay = demo.steps.flatMap((s) => [s.text ?? "", labelOf(s.node)]).map(lc);
  const taken = new Set<string>();
  const slots: SkillSlot[] = [];
  for (const s of Array.isArray(j.slots) ? j.slots : []) {
    const example = String(s?.example ?? "").trim();
    const name = String(s?.name ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!example || !name || taken.has(name)) continue;
    // A slot must stand for something that was actually typed or tapped.
    if (!hay.some((h) => h.includes(lc(example)))) continue;
    taken.add(name);
    slots.push({ name, required: s.required !== false, desc: String(s.desc ?? name), example });
  }
  const groups: string[][] = (Array.isArray(j.keywords) ? j.keywords : [])
    .map((g: any) => (Array.isArray(g) ? g : [g]).map((w: any) => singular(lc(w))).filter((w: string) => /^[a-z0-9']+$/.test(w)))
    .filter((g: string[]) => g.length > 0)
    .slice(0, 3);
  const nums = (a: any) => (Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= demo.steps.length) : []);
  const drop = nums(j.drop);
  return {
    title: String(j.title).trim(),
    intent: String(j.intent || fb.intent).trim(),
    say: String(j.say || fb.say).trim(),
    done_say: String(j.done_say || fb.done_say).trim(),
    keywords: groups.length ? groups : fb.keywords,
    slots,
    irreversible: nums(j.irreversible),
    drop: drop.length < demo.steps.length ? drop : [],
  };
}

// ---------- the skill ----------

export type SkillPart = {
  app: string;
  /** How to get to the app before the steps (null when the step before brought it up). */
  open: HandsAct | null;
  steps: ScriptStep[];
  risk: Risk;
  done_when: DoneWhen;
};

export type TeachMode = "hybrid" | "script" | "guided" | "pixels";

export type Skill = {
  id: string;
  title: string;
  intent: string;
  app: string;
  say: string;
  doneSay: string;
  keywords: string[][];
  slots: SkillSlot[];
  parts: SkillPart[];
  heard: string;
  taughtAt: number;
  /** Script health: runs that finished from the script alone, and failures in a row. */
  ok: number;
  fails: number;
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "skill";

/** Swaps each slot's example for `{{name}}`, whole words only, longest example first. */
function slotter(slots: SkillSlot[]): (s: string) => string {
  const res = [...slots]
    .filter((s) => s.example)
    .sort((a, b) => b.example.length - a.example.length)
    .map((s) => ({ re: new RegExp(`(^|[^A-Za-z0-9])${escapeRe(s.example)}(?![A-Za-z0-9])`, "gi"), to: `{{${s.name}}}` }));
  return (str) => res.reduce((acc, r) => acc.replace(r.re, (_m, lead) => `${lead}${r.to}`), str);
}

export function buildSkill(demo: Demo, meta: SkillMeta, opts: { heard: string; now?: number; pixels?: boolean }): Skill {
  const typed = demo.steps.filter((s) => s.kind === "type" && s.text).map((s) => s.text!);
  const sub = slotter(meta.slots);
  const parts: SkillPart[] = [];
  let part: SkillPart | null = null;
  let prev: DemoStep | null = null;
  /** The screen the current part started from, and the one its last step left. */
  let span: { from: Msg | null; to: Msg | null } = { from: null, to: null };
  const close = () => {
    if (!part || part.steps.length === 0) return;
    // Finished means the screen shows what the whole part changed, not just its last tap: a list
    // that was there all along must not count as "the new project is in the list".
    const change = opts.pixels ? {} : mapStrings(changeBetween(span.from, span.to, typed), sub);
    part.done_when = { ...change, describe: `${meta.title}: the steps the user showed are finished` };
    parts.push(part);
  };
  demo.steps.forEach((s, i) => {
    const n = i + 1;
    if (meta.drop.includes(n)) return;
    const label = stepLabel(s);
    const irreversible = meta.irreversible.includes(n) || ((s.kind === "tap" || s.kind === "long_press") && IRREVERSIBLE_LABEL.test(labelOf(s.node)));
    const cameFromStep: boolean = !!prev && prev.app !== s.app && prev.post?.app === s.app;
    if (!part || part.app !== s.app || irreversible || part.risk === "irreversible") {
      close();
      const open: HandsAct | null = part && part.app === s.app ? null : cameFromStep ? null : s.app === SYSTEMUI ? { do: "key", name: "notifications" } : { do: "launch", app: s.app };
      part = { app: s.app, open, steps: [], risk: irreversible ? "irreversible" : "safe", done_when: { describe: "" } };
      span = { from: s.pre, to: null };
    }
    span.to = s.post ?? span.to;
    const act: HandsAct = s.kind === "type" ? { do: "type", text: sub(s.text ?? "") } : s.kind === "key" ? { do: "key", name: s.text } : { do: s.kind };
    const step: ScriptStep = { act, expect: opts.pixels ? {} : mapStrings(expectFor(s, typed), sub), label: sub(label) };
    if (s.node) {
      const w = mapStrings(wantOf(s.node), sub);
      // A label holding a slot names a different control each time: its key (a hash of the old
      // label) can't match. A label with numbers in it changes by itself: go by id or key.
      if (/\{\{\w+\}\}/.test(JSON.stringify([w.text, w.desc, w.hint]))) delete w.key;
      else if ((w.id || w.key) && w.text && looksLive(w.text)) delete w.text;
      step.want = w;
    }
    if (s.seek) step.seek = s.seek;
    if (opts.pixels) step.pixel = true;
    part.steps.push(step);
    prev = s;
  });
  close();
  return {
    id: `skill.${slug(meta.title)}`,
    title: meta.title,
    intent: meta.intent,
    app: demo.steps[0]?.app ?? "",
    say: meta.say,
    doneSay: meta.done_say,
    keywords: meta.keywords,
    slots: meta.slots,
    parts,
    heard: opts.heard,
    taughtAt: opts.now ?? Date.now(),
    ok: 0,
    fails: 0,
  };
}

/** The steps of a part in words, numbered, with the slots filled in. */
export function guideOf(part: SkillPart, slots: Record<string, string>): string {
  return part.steps.map((s, i) => `${i + 1}. ${fill(s.label, slots)}`).join("\n");
}

/** A skill and its slot values -> the task the brain runs. */
export function planSkill(skill: Skill, given: Record<string, string>, mode: TeachMode = "hybrid"): TaskPlan {
  const slots: Record<string, string> = {};
  const missing: SkillSlot[] = [];
  for (const s of skill.slots) {
    const v = String(given[s.name] ?? "").trim();
    if (v) slots[s.name] = v;
    else if (s.required) missing.push(s);
    else slots[s.name] = s.example;
  }
  const detail = Object.entries(slots).map(([k, v]) => `${k}: ${v}`).join(", ");
  const goal = `${skill.intent.replace(/[.\s]+$/, "")}${detail ? ` (${detail})` : ""}`;
  const base = { kind: "phone" as const, title: skill.title, goal, shortcut: skill.id, slots };
  if (missing.length) {
    return { ...base, subgoals: [], failSay: `I need ${missing.map((m) => m.desc).join(" and ")} for that. Ask me again with it.` };
  }
  const subgoals: SubgoalSpec[] = [];
  skill.parts.forEach((p, i) => {
    const label = appLabel(p.app);
    if (p.open?.do === "launch") {
      subgoals.push({ goal: `Open ${label}`, done_when: { app: p.app, describe: `${label} is on screen` }, risk: "safe", direct: [p.open], say: i === 0 ? `Opening ${label}.` : undefined });
    } else if (p.open) {
      subgoals.push({ goal: "Open the notification shade", done_when: { app: p.app, describe: "The notification shade is open" }, risk: "safe", direct: [p.open] });
    }
    const guide = guideOf(p, slots);
    const sg: SubgoalSpec = {
      goal: `${skill.title}${skill.parts.length > 1 ? `, part ${i + 1}` : ""}${detail ? ` (${detail})` : ""}`,
      done_when: mapStrings(p.done_when, (s) => fill(s, slots)),
      risk: p.risk,
      guide,
      say: p.risk === "safe" && !subgoals.some((x) => x.script || x.guide) ? skill.say : undefined,
    };
    if (p.risk === "irreversible") sg.confirm = `${cap(fill(p.steps[0].label, slots))} (${skill.title}${detail ? `, ${detail}` : ""})`;
    if (mode !== "guided") {
      sg.script = p.steps;
      if (p.open?.do === "launch") sg.scriptApp = p.app;
      if (mode === "script" || mode === "pixels") sg.scriptOnly = true;
    }
    subgoals.push(sg);
  });
  return { ...base, subgoals, doneSay: skill.doneSay };
}

/**
 * Local match of a request against a taught skill, with no model call. Deliberately strict: every
 * trigger group must be hit, every other word must be filler or the app's name, and a skill with
 * a slot needs "called X" / "named X" (and the like) to say what goes in it. Anything else goes
 * to the router, which sees the skill in its catalogue.
 */
export function matchSkill(skill: Skill, text: string): LocalMatch | null {
  if (skill.slots.length > 1 || skill.keywords.length === 0) return null;
  const t = strip(text).replace(/[.!?]+$/, "");
  let head = t;
  const slots: Record<string, string> = {};
  if (skill.slots.length === 1) {
    const m = /^(.*?)(?:\b(?:called|named|titled|labell?ed|saying|that says)\b|:)\s*(.+)$/i.exec(t);
    if (m) {
      const value = m[2].trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
      if (!value) return null;
      head = m[1];
      slots[skill.slots[0].name] = value;
    } else if (skill.slots[0].required) return null;
  }
  const tokens = words(head).map(singular);
  if (tokens.length === 0) return null;
  const appWords = words(appLabel(skill.app));
  const inGroup = (w: string) => skill.keywords.some((g) => g.includes(w));
  if (!skill.keywords.every((g) => tokens.some((w) => g.includes(w)))) return null;
  if (!tokens.every((w) => inGroup(w) || STOP.has(w) || appWords.includes(w))) return null;
  return { id: skill.id, slots, confidence: "high" };
}

// ---------- the book ----------

const KEY = "bobby-mind/skills/v1";
const MAX_SKILLS = 40;

export class SkillBook {
  private skills = new Map<string, Skill>();
  loaded: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  /** Called whenever the set of skills changes (the router's catalogue is rebuilt). */
  onChange: () => void = () => {};

  constructor(
    private store: KeyValueStore,
    private index: ShortcutIndex,
    private log: (l: string) => void,
    private mode: TeachMode = "hybrid",
  ) {
    this.loaded = this.load();
  }

  private async load() {
    try {
      const raw = await this.store.getItem(KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      for (const s of Array.isArray(list) ? list : []) {
        if (s && typeof s.id === "string" && Array.isArray(s.parts)) this.register(s as Skill);
      }
      if (this.skills.size) {
        this.log(`skills: loaded ${this.skills.size} (${this.all().map((s) => s.title).join(", ")})`);
        this.onChange();
      }
    } catch (e) {
      this.log(`skills: load failed (${String(e)}); starting with none`);
    }
  }

  private register(skill: Skill) {
    this.skills.set(skill.id, skill);
    const shortcut: Shortcut = {
      id: skill.id,
      intent: `${skill.intent.replace(/[.\s]+$/, "")}. Taught by the user.`,
      slots: skill.slots.map(({ name, required, desc }) => ({ name, required, desc })),
      keywords: skill.keywords.flat(),
      match: (text) => matchSkill(skill, text),
      plan: (slots) => planSkill(skill, slots, this.mode),
    };
    this.index.add(shortcut);
  }

  all(): Skill[] {
    return [...this.skills.values()];
  }

  get(id: string | undefined): Skill | null {
    return (id && this.skills.get(id)) || null;
  }

  /** Adds a skill, or replaces the one with the same name. */
  add(skill: Skill) {
    this.register(skill);
    const extra = this.all().sort((a, b) => a.taughtAt - b.taughtAt).slice(0, Math.max(0, this.skills.size - MAX_SKILLS));
    for (const old of extra) this.drop(old.id);
    this.log(`skills: learned "${skill.title}" (${skill.id}): ${skill.parts.map((p) => `${appLabel(p.app)}: ${p.steps.map((s) => s.label).join("; ")}`).join(" | ")}`);
    this.persist();
    this.onChange();
  }

  private drop(id: string) {
    this.skills.delete(id);
    this.index.remove(id);
  }

  remove(id: string): boolean {
    if (!this.skills.has(id)) return false;
    this.drop(id);
    this.persist();
    this.onChange();
    return true;
  }

  /** The skill a few words most likely mean ("add a project"), for forgetting one. */
  find(query: string): Skill | null {
    const q = new Set(words(query).map(singular).filter((w) => !STOP.has(w)));
    let best: { s: Skill; n: number } | null = null;
    for (const s of this.skills.values()) {
      const own = new Set([...words(s.title).map(singular), ...s.keywords.flat()]);
      const n = [...q].filter((w) => own.has(w)).length;
      if (n > 0 && (!best || n > best.n)) best = { s, n };
    }
    return best?.s ?? null;
  }

  /** Records how a script run went. */
  note(id: string | undefined, ok: boolean) {
    const s = this.get(id);
    if (!s) return;
    if (ok) {
      s.ok += 1;
      s.fails = 0;
    } else s.fails += 1;
    this.persist();
  }

  private persist() {
    this.saving = this.saving.then(async () => {
      try {
        await this.store.setItem(KEY, JSON.stringify(this.all()));
      } catch (e) {
        this.log(`skills: save failed: ${String(e)}`);
      }
    });
  }

  flush(): Promise<void> {
    return this.saving;
  }
}
