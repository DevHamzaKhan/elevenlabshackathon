// Turns a `screen_result` into a few compact lines for the model, and small helpers around it.

import type { ScreenNode } from "./types";

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
