// Turns a `screen_result` into a few compact lines for the model, and small helpers around it.

import type { Check, ScreenNode, Target } from "./types";

/** Friendly names for common packages, so the model and Bobby see "Gmail", not a package id. */
export const APP_LABELS: Record<string, string> = {
  "com.google.android.gm": "Gmail",
  "com.google.android.apps.nexuslauncher": "Home screen",
  "com.android.launcher3": "Home screen",
  "com.sec.android.app.launcher": "Home screen",
  "com.android.systemui": "Notification shade",
  "com.whatsapp": "WhatsApp",
  "com.google.android.apps.messaging": "Messages",
  "com.android.chrome": "Chrome",
  "com.google.android.apps.maps": "Maps",
  "com.spotify.music": "Spotify",
  "com.android.settings": "Settings",
  "com.google.android.dialer": "Phone",
  "com.google.android.calendar": "Calendar",
  "com.google.android.youtube": "YouTube",
  "com.android.vending": "Play Store",
  "com.google.android.googlequicksearchbox": "Google",
};

export function appLabel(pkg: string | undefined): string {
  if (!pkg) return "unknown app";
  if (APP_LABELS[pkg]) return APP_LABELS[pkg];
  const last = pkg.split(".").pop() ?? pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function clip(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Most node lines sent to the model for one screen. */
const MAX_LINES = 90;

/**
 * One line per useful node: `[n] "label" (Button) tap @540,1200`.
 * Nodes with neither a label nor a flag are dropped; long labels are clipped. `hint` is Hands'
 * extra field for an empty text field's placeholder. On a crowded screen, everything that can
 * be tapped, typed into or scrolled is kept and plain text is what gets trimmed, so a button
 * at the bottom of a long page is never lost.
 */
export function describeScreen(r: { [k: string]: any }): string {
  const nodes = Array.isArray(r.nodes) ? r.nodes : [];
  const head = `App: ${appLabel(r.app)} (${r.app ?? "?"})${r.size ? `, screen ${r.size[0]}x${r.size[1]}` : ""}`;
  const rows: { line: string; active: boolean }[] = [];
  for (const nd of nodes) {
    const text = clip(String(nd.text ?? ""), 120);
    const desc = clip(String(nd.desc ?? ""), 120);
    const hint = clip(String(nd.hint ?? ""), 80);
    const flags = [nd.tap && "tap", nd.edit && "edit", nd.scroll && "scroll"].filter(Boolean).join(" ");
    if (!text && !desc && !hint && !flags) continue;
    const parts: string[] = [];
    if (text) parts.push(`"${text}"`);
    if (desc && desc !== text) parts.push(text ? `desc="${desc}"` : `"${desc}"`);
    if (hint && hint !== text && hint !== desc) parts.push(`hint="${hint}"`);
    const label = parts.join(" ") || "(no label)";
    const cls = nd.cls ? ` (${String(nd.cls).split(".").pop()})` : "";
    const b = nd.bounds;
    const at = Array.isArray(b) && b.length === 4 ? ` @${Math.round((b[0] + b[2]) / 2)},${Math.round((b[1] + b[3]) / 2)}` : "";
    rows.push({ line: `[${nd.n}] ${label}${cls}${flags ? " " + flags : ""}${at}`, active: !!flags });
  }
  if (rows.length === 0) return `${head}\n(nothing readable on screen)`;
  let dropped = 0;
  let shown = rows;
  if (rows.length > MAX_LINES) {
    // Keep every actionable node; give what room is left to plain text, top of the screen first.
    let room = Math.max(0, MAX_LINES - rows.filter((x) => x.active).length);
    shown = rows.filter((x) => x.active || room-- > 0).slice(0, Math.max(MAX_LINES, 140));
    dropped = rows.length - shown.length;
  }
  const lines = [head, ...shown.map((x) => x.line)];
  if (dropped > 0) lines.push(`… ${dropped} more nodes not shown (plain text first)`);
  return lines.join("\n");
}

/** A short fingerprint of a screen, to notice when an action changed nothing. */
export function screenKey(r: { [k: string]: any }): string {
  const nodes = Array.isArray(r.nodes) ? r.nodes : [];
  return (r.app ?? "") + "|" + nodes.map((n: any) => `${n.text ?? ""}/${n.desc ?? ""}/${n.hint ?? ""}`).join("|");
}

// ---------- v2: compact screens, fingerprints, code checks, stable targets ----------

const LABEL = (nd: any): string[] => [nd.text, nd.desc, nd.hint].map((s) => String(s ?? "")).filter(Boolean);

/** Hands' `hash`, or our own fingerprint of app + labels + flags (old Hands send none). */
export function fingerprint(r: { [k: string]: any }): string {
  if (typeof r.hash === "string" && r.hash) return r.hash;
  const nodes: any[] = Array.isArray(r.nodes) ? r.nodes : [];
  const s = screenKey(r) + "|" + nodes.map((n) => `${n.tap ? 1 : 0}${n.edit ? 1 : 0}${n.checked ? 1 : 0}`).join("");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return "f" + (h >>> 0).toString(16);
}

/** True when the tree has nothing the executor can use (web view, canvas, empty). */
export function unreadable(r: { [k: string]: any }): boolean {
  if (r.locked) return false;
  const nodes: any[] = Array.isArray(r.nodes) ? r.nodes : [];
  const labelled = nodes.filter((n) => LABEL(n).length > 0 && !/^\d{1,2}:\d{2}$/.test(String(n.text ?? "")));
  return labelled.length === 0;
}

/**
 * The executor's view of a screen: one line per useful node, no pixel coordinates (the model
 * can't use them), v2 state flags when Hands sends them.
 *   [3] "Reply" (Button) tap     [7] hint="Compose email" (EditText) edit focused
 */
export function describeCompact(r: { [k: string]: any }, maxLines = 80): string {
  const nodes: any[] = Array.isArray(r.nodes) ? r.nodes : [];
  const head = `App: ${appLabel(r.app)} (${r.app ?? "?"})`;
  const rows: { line: string; active: boolean }[] = [];
  for (const nd of nodes) {
    const text = clip(String(nd.text ?? ""), 100);
    const desc = clip(String(nd.desc ?? ""), 100);
    const hint = clip(String(nd.hint ?? ""), 60);
    const flags = [
      nd.tap && "tap",
      nd.edit && "edit",
      nd.scroll && (Array.isArray(nd.scrollDirs) && nd.scrollDirs.length ? `scroll:${nd.scrollDirs.join("/")}` : "scroll"),
      nd.checked === true && "checked",
      nd.selected && "selected",
      nd.focused && "focused",
      nd.disabled && "disabled",
      nd.password && "password",
    ]
      .filter(Boolean)
      .join(" ");
    if (!text && !desc && !hint && !flags) continue;
    const parts: string[] = [];
    if (text) parts.push(`"${text}"`);
    if (desc && desc !== text) parts.push(text ? `desc="${desc}"` : `"${desc}"`);
    if (hint && hint !== text && hint !== desc) parts.push(`hint="${hint}"`);
    const cls = nd.cls ? ` (${String(nd.cls).split(".").pop()})` : "";
    rows.push({ line: `[${nd.n}] ${parts.join(" ") || "(no label)"}${cls}${flags ? " " + flags : ""}`, active: /tap|edit|scroll/.test(flags) });
  }
  if (rows.length === 0) return `${head}\n(nothing readable on screen)`;
  let shown = rows;
  let dropped = 0;
  if (rows.length > maxLines) {
    let room = Math.max(0, maxLines - rows.filter((x) => x.active).length);
    shown = rows.filter((x) => x.active || room-- > 0);
    dropped = rows.length - shown.length;
  }
  return [head, ...shown.map((x) => x.line), ...(dropped ? [`… ${dropped} plain-text nodes not shown`] : [])].join("\n");
}

function visibleLabels(r: { [k: string]: any }): string[] {
  const nodes: any[] = Array.isArray(r.nodes) ? r.nodes : [];
  return nodes.flatMap((n) => LABEL(n).map((s) => s.toLowerCase()));
}

/** Is `want` (package or label) the app in front? */
export function appMatches(app: string | undefined, want: string): boolean {
  if (!app) return false;
  const w = want.trim().toLowerCase();
  if (!w) return true;
  const label = appLabel(app).toLowerCase();
  return app.toLowerCase().includes(w) || label === w || label.includes(w);
}

/** Finds a node by a stable selector (key, id, label). */
export function findNode(r: { [k: string]: any }, sel: { key?: string; id?: string; text?: string }): ScreenNode | null {
  const nodes: any[] = Array.isArray(r.nodes) ? r.nodes : [];
  if (sel.key) return nodes.find((n) => n.key === sel.key) ?? null;
  if (sel.id) {
    const id = sel.id;
    return nodes.find((n) => n.id === id || String(n.id ?? "").endsWith(`:id/${id}`)) ?? null;
  }
  if (sel.text) {
    const q = sel.text.toLowerCase();
    return (
      nodes.find((n) => LABEL(n).some((s) => s.toLowerCase() === q)) ??
      nodes.find((n) => LABEL(n).some((s) => s.toLowerCase().includes(q))) ??
      null
    );
  }
  return null;
}

/**
 * Checks a condition in code. Returns null when it holds, else a short reason. Returns
 * "unknown" when the check has nothing code can test (then a cheap model call decides).
 */
export function checkScreen(c: Check | undefined, r: { [k: string]: any } | null, actApp?: string): string | null {
  if (!c) return null;
  const has = (c.app ? 1 : 0) + (c.text_present?.length ? 1 : 0) + (c.text_absent?.filter(Boolean).length ? 1 : 0) + (c.field ? 1 : 0);
  if (has === 0) return "unknown";
  if (!r) return "no screen";
  if (r.locked) return "the phone is locked";
  const app = r.app ?? actApp;
  if (c.app && !appMatches(app, c.app)) return `expected ${c.app} in front, got ${appLabel(app)}`;
  const seen = visibleLabels(r);
  const wants = (c.text_present ?? []).map((t) => t.toLowerCase()).filter(Boolean);
  if (wants.length && !wants.some((w) => seen.some((s) => s.includes(w)))) return `"${c.text_present![0]}" is not on screen`;
  for (const t of c.text_absent ?? []) {
    if (t && seen.some((s) => s.includes(t.toLowerCase()))) return `"${t}" is still on screen`;
  }
  if (c.field) {
    const nd: any = findNode(r, c.field);
    if (!nd) return `field ${c.field.key ?? c.field.id ?? c.field.text} not found`;
    const val = String(nd.text ?? "").trim().toLowerCase();
    const want = c.field.value.trim().toLowerCase();
    if (val !== want && !(want && val.includes(want))) return `field holds "${nd.text ?? ""}", not "${c.field.value}"`;
  }
  return null;
}

/**
 * A selector for node `n` of `screen` that survives the next screen read: key, then resource
 * id, then a label that is unique on the screen. Null when the node can only be named by `n`.
 */
export function stableTarget(screen: { [k: string]: any }, n: number): Target | null {
  const nodes: any[] = Array.isArray(screen.nodes) ? screen.nodes : [];
  const nd = nodes.find((x) => x.n === n);
  if (!nd) return null;
  if (nd.key) return { key: nd.key };
  if (nd.id) return { id: nd.id };
  for (const label of LABEL(nd)) {
    const same = nodes.filter((x) => LABEL(x).some((s) => s.toLowerCase() === label.toLowerCase()));
    if (same.length === 1) return { text: label };
  }
  return null;
}

/** Label of node n, for logs and recipes. */
export function nodeLabel(screen: { [k: string]: any }, n: number): string {
  const nodes: any[] = Array.isArray(screen.nodes) ? screen.nodes : [];
  const nd = nodes.find((x) => x.n === n);
  return nd ? LABEL(nd)[0] ?? String(nd.cls ?? "") : "";
}
