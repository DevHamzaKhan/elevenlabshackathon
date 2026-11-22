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

/**
 * One line per useful node: `[n] "label" (Button) tap @540,1200`.
 * Nodes with neither a label nor a flag are dropped; long labels are clipped.
 */
export function describeScreen(r: { [k: string]: any }): string {
  const nodes = Array.isArray(r.nodes) ? r.nodes : [];
  const lines: string[] = [];
  lines.push(`App: ${appLabel(r.app)} (${r.app ?? "?"})${r.size ? `, screen ${r.size[0]}x${r.size[1]}` : ""}`);
  let kept = 0;
  for (const nd of nodes) {
    const text = clip(String(nd.text ?? ""), 120);
    const desc = clip(String(nd.desc ?? ""), 120);
    const flags = [nd.tap && "tap", nd.edit && "edit", nd.scroll && "scroll"].filter(Boolean).join(" ");
    if (!text && !desc && !flags) continue;
    let label = text ? `"${text}"` : "";
    if (desc && desc !== text) label += label ? ` desc="${desc}"` : `"${desc}"`;
    if (!label) label = "(no label)";
    const cls = nd.cls ? ` (${String(nd.cls).split(".").pop()})` : "";
    const b = nd.bounds;
    const at = Array.isArray(b) && b.length === 4 ? ` @${Math.round((b[0] + b[2]) / 2)},${Math.round((b[1] + b[3]) / 2)}` : "";
    lines.push(`[${nd.n}] ${label}${cls}${flags ? " " + flags : ""}${at}`);
    kept += 1;
    if (kept >= 80) {
      lines.push(`… ${nodes.length - kept} more nodes not shown`);
      break;
    }
  }
  if (kept === 0) lines.push("(nothing readable on screen)");
  return lines.join("\n");
}

/** A short fingerprint of a screen, to notice when an action changed nothing. */
export function screenKey(r: { [k: string]: any }): string {
  const nodes = Array.isArray(r.nodes) ? r.nodes : [];
  return (r.app ?? "") + "|" + nodes.map((n) => `${n.text ?? ""}/${n.desc ?? ""}`).join("|");
}
