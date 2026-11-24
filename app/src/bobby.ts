// Bobby's runtime: settings, the three parts, waking, and deep links.
import { hints } from '../generated/hints';
import { hands } from './hands';
import { log, logFor } from './log';
import { startCaller, startMind, startMouth } from './packages';
import {
  decodeBase64Url,
  ensureToken,
  loadEnv,
  loadSwitches,
  parseEnv,
  saveEnv,
  saveSwitch,
  type Switches,
} from './settings';
import type { MouthHandle, Part, Stoppable } from './types';

export const HUB_URL = 'ws://127.0.0.1:8765';

type State = {
  ready: boolean;
  env: Record<string, string>;
  switches: Switches;
  running: Record<Part, boolean>;
};

let state: State = {
  ready: false,
  env: {},
  switches: { mind: true, mouth: true, caller: true },
  running: { mind: false, mouth: false, caller: false },
};
const handles: { mind?: Stoppable; mouth?: MouthHandle; caller?: Stoppable } = {};
const listeners = new Set<() => void>();

export const getState = () => state;
export function onState(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function partConfig(part: Part) {
  return { hubUrl: HUB_URL, token: state.env.HUB_TOKEN, env: { ...state.env }, log: logFor(part) };
}

function startPart(part: Part) {
  if (handles[part]) return;
  try {
    if (part === 'mind') handles.mind = startMind({ ...partConfig('mind'), hints });
    if (part === 'mouth') handles.mouth = startMouth(partConfig('mouth'));
    if (part === 'caller') handles.caller = startCaller(partConfig('caller'));
  } catch (e) {
    log(`${part}: failed to start: ${String(e)}`);
  }
  set({ running: { ...state.running, [part]: !!handles[part] } });
}

function stopPart(part: Part) {
  const h = handles[part];
  delete handles[part];
  try {
    h?.stop();
  } catch (e) {
    log(`${part}: stop failed: ${String(e)}`);
  }
  set({ running: { ...state.running, [part]: false } });
}

const PARTS: Part[] = ['mind', 'mouth', 'caller'];

function restartParts() {
  PARTS.forEach(stopPart);
  PARTS.forEach((p) => state.switches[p] && startPart(p));
}

let initPromise: Promise<void> | null = null;
export function init(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const env = await ensureToken(await loadEnv());
      const switches = await loadSwitches();
      set({ env, switches });
      hands.configure(env.HUB_TOKEN);
      log(`settings loaded: ${Object.keys(env).length} stored, hints: ${hints.length}`);
      restartParts();
      set({ ready: true });
    })().catch((e) => log(`init failed: ${String(e)}`));
  }
  return initPromise;
}

export async function setSwitch(part: Part, on: boolean) {
  await saveSwitch(part, on);
  set({ switches: { ...state.switches, [part]: on } });
  if (on) startPart(part);
  else stopPart(part);
  log(`${part} switched ${on ? 'on' : 'off'}`);
}

/** Settings the real packages read (by name; see mind/MERGE.md and mouth/MERGE.md). Shown as a
 *  warning on the settings screen when not stored; they don't block waking. */
export const EXPECTED_ENV = ['OPENAI_API_KEY', 'HUB_TOKEN'];

/** Which required settings are missing (empty means complete). */
export function missing(): string[] {
  const s = hands.status();
  const out: string[] = [];
  if (!s.accessibility) out.push('accessibility');
  if (!s.microphone) out.push('microphone');
  if (Object.keys(state.env).filter((n) => n !== 'HUB_TOKEN').length === 0) out.push('config (run push-config)');
  return out;
}

/** Wakes Bobby: keep-alive service, Mouth wake(), then back to whatever was on screen. */
export function wake(reason: string): boolean {
  const miss = missing();
  if (miss.length) {
    log(`not waking (${reason}): missing ${miss.join(', ')}`);
    return false;
  }
  const mouth = handles.mouth;
  if (!mouth) {
    log(`not waking (${reason}): the Mouth is switched off`);
    return false;
  }
  hands.startKeepAlive('Bobby is listening');
  try {
    mouth.wake();
  } catch (e) {
    log(`mouth: wake failed: ${String(e)}`);
  }
  const moved = hands.moveToBack();
  log(`woke (${reason})${moved ? ', moved to back' : ''}`);
  return true;
}

export function stopBobby() {
  hands.stopKeepAlive();
  log('keep-alive stopped');
}

// ---- deep links: bobby://config, bobby://switch, bobby://settings ----

function query(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const i = url.indexOf('?');
  if (i < 0) return q;
  for (const kv of url.slice(i + 1).split('&')) {
    const j = kv.indexOf('=');
    const k = decodeURIComponent(j < 0 ? kv : kv.slice(0, j));
    q[k] = j < 0 ? '' : decodeURIComponent(kv.slice(j + 1));
  }
  return q;
}

const chunks: { id: string; parts: string[] } = { id: '', parts: [] };

/** Handles a bobby:// link. Returns true if it was one (so the app shouldn't wake). */
export async function handleUrl(url: string | null): Promise<boolean> {
  if (!url || !url.startsWith('bobby://')) return false;
  const path = url.slice('bobby://'.length).split(/[?#]/)[0].replace(/\/$/, '');
  const q = query(url);
  if (path === 'config') {
    const of = Number(q.of || 1);
    const part = Number(q.part || 1);
    if (q.id !== chunks.id) {
      chunks.id = q.id || '';
      chunks.parts = [];
    }
    chunks.parts[part - 1] = q.data || '';
    const have = chunks.parts.filter((p) => p !== undefined).length;
    if (have < of) {
      log(`config: got part ${part} of ${of}`);
      return true;
    }
    const text = decodeBase64Url(chunks.parts.join(''));
    chunks.id = '';
    chunks.parts = [];
    await init();
    const env = await ensureToken(await saveEnv(parseEnv(text)));
    set({ env });
    hands.configure(env.HUB_TOKEN);
    log(`config: stored ${Object.keys(env).length} settings; restarting parts`);
    restartParts();
    return true;
  }
  if (path === 'switch') {
    await init();
    for (const p of PARTS) {
      if (p in q) await setSwitch(p, !['0', 'off', 'false'].includes(q[p]));
    }
    return true;
  }
  // bobby://settings or anything else: just show the settings screen.
  return true;
}
