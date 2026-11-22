// Shared helpers for the laptop tools: reading the root .env and the hub token.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(TOOLS_DIR, '..', '..');

/** Parses the repo-root .env (KEY=value lines, optional quotes, # comments). Missing file -> {}. */
export function readRootEnv(path = join(REPO_ROOT, '.env')) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return {}; }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** A setting from the process environment first, then the root .env, then the fallback. */
export function setting(name, fallback = '') {
  const v = process.env[name];
  if (v != null && v !== '') return v;
  const e = readRootEnv()[name];
  if (e != null && e !== '') return e;
  return fallback;
}

export const hubToken = () => setting('HUB_TOKEN', 'dev');

/** ws://host:port/<role>?token=<t> from a base like ws://localhost:8765 */
export function roleUrl(base, role, token) {
  const b = base.replace(/\/+$/, '');
  return `${b}/${role}?token=${encodeURIComponent(token)}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
