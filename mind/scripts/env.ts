// Laptop-only helpers: read the root .env and the hint files. Never imported by src/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = path.resolve(MIND_DIR, "..");

/** Parses KEY=VALUE lines. Process env wins over the file. */
export function loadEnv(file = path.join(ROOT_DIR, ".env")): Record<string, string> {
  const out: Record<string, string> = {};
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[line.slice(0, i).trim()] = v;
    }
  }
  for (const k of ["ANTHROPIC_API_KEY", "MIND_MODEL", "MIND_EFFORT", "CONTACTS", "HUB_TOKEN", "HINTS_DIR"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

/** Every *.md file in HINTS_DIR (default ../stage/hints), skipping TO-CHECK notes. */
export function loadHints(dir?: string): string[] {
  const d = dir ? path.resolve(MIND_DIR, dir) : path.join(ROOT_DIR, "stage", "hints");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".md") && !/^to-check/i.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(d, f), "utf8"));
}

/** A log file under mind/logs/ and a function that appends timestamped lines to it. */
export function openLog(name: string, echo: (line: string) => boolean = () => false) {
  const dir = path.join(MIND_DIR, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${name}-${stamp}.log`);
  const fd = fs.openSync(file, "a");
  const log = (line: string) => {
    const l = `${new Date().toISOString().slice(11, 23)} ${line}`;
    fs.writeSync(fd, l + "\n");
    if (echo(line)) console.log(l);
  };
  return { file, log };
}

/** A key shown safely: first 10 characters only. */
export function redact(v: string | undefined): string {
  return v ? `${v.slice(0, 10)}…` : "(missing)";
}
