// Settings stored on the phone in secure storage. Keys are never in the build:
// tools/push-config.mjs sends the root .env over USB as a bobby://config deep link.
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { Part } from './types';

const NAMES_KEY = 'env_names';
const valueKey = (name: string) => `env_${name}`;
const switchKey = (part: Part) => `switch_${part}`;

export type Switches = Record<Part, boolean>;

/** Parses .env text: NAME=value lines; blank lines and # comments are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[m[1]] = value;
  }
  return env;
}

export async function loadEnv(): Promise<Record<string, string>> {
  const names: string[] = JSON.parse((await SecureStore.getItemAsync(NAMES_KEY)) || '[]');
  const env: Record<string, string> = {};
  for (const n of names) {
    const v = await SecureStore.getItemAsync(valueKey(n));
    if (v !== null) env[n] = v;
  }
  return env;
}

/** Replaces the stored env with `next`. Keeps the current HUB_TOKEN if `next` has none. */
export async function saveEnv(next: Record<string, string>): Promise<Record<string, string>> {
  const old = await loadEnv();
  const env = { ...next };
  if (!env.HUB_TOKEN && old.HUB_TOKEN) env.HUB_TOKEN = old.HUB_TOKEN;
  for (const n of Object.keys(old)) {
    if (!(n in env)) await SecureStore.deleteItemAsync(valueKey(n));
  }
  for (const [n, v] of Object.entries(env)) await SecureStore.setItemAsync(valueKey(n), v);
  await SecureStore.setItemAsync(NAMES_KEY, JSON.stringify(Object.keys(env).sort()));
  return env;
}

/** Makes sure HUB_TOKEN exists; generates a random one if not. */
export async function ensureToken(env: Record<string, string>): Promise<Record<string, string>> {
  if (env.HUB_TOKEN) return env;
  const bytes = await Crypto.getRandomBytesAsync(24);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return saveEnv({ ...env, HUB_TOKEN: token });
}

export async function loadSwitches(): Promise<Switches> {
  const get = async (p: Part) => (await SecureStore.getItemAsync(switchKey(p))) !== 'off';
  return { mind: await get('mind'), mouth: await get('mouth'), caller: await get('caller') };
}

export async function saveSwitch(part: Part, on: boolean): Promise<void> {
  await SecureStore.setItemAsync(switchKey(part), on ? 'on' : 'off');
}

/** base64url -> UTF-8 text, without relying on TextDecoder. */
export function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  let out = '';
  for (let i = 0; i < bin.length; ) {
    const c = bin.charCodeAt(i++);
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bin.charCodeAt(i++) & 0x3f));
    else if (c < 0xf0) {
      out += String.fromCharCode(
        ((c & 0x0f) << 12) | ((bin.charCodeAt(i++) & 0x3f) << 6) | (bin.charCodeAt(i++) & 0x3f),
      );
    } else {
      const cp =
        ((c & 0x07) << 18) |
        ((bin.charCodeAt(i++) & 0x3f) << 12) |
        ((bin.charCodeAt(i++) & 0x3f) << 6) |
        (bin.charCodeAt(i++) & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/** The Mind's memory and recipes (bobby-mind KeyValueStore), in secure storage. SecureStore keys
 *  allow only letters, digits, ".", "-" and "_". Values are small (facts, outcomes, <= 60 recipes). */
const mindKey = (k: string) => `mind_${k.replace(/[^A-Za-z0-9._-]/g, '_')}`;
export const mindStorage = {
  getItem: (k: string) => SecureStore.getItemAsync(mindKey(k)),
  setItem: (k: string, v: string) => SecureStore.setItemAsync(mindKey(k), v),
};
