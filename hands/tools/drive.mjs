#!/usr/bin/env node
// drive.mjs: plays the Mind so you can drive the phone by typing.
//
//   node hands/tools/drive.mjs                       # adb forward, connect, interactive prompt
//   node hands/tools/drive.mjs --no-adb --url ws://127.0.0.1:8765   # against fakehub.mjs
//   node hands/tools/drive.mjs --script steps.txt    # run commands from a file, exit 1 on first failure
//   node hands/tools/drive.mjs -e screen -e "point Gmail"            # run commands from the command line
//   node hands/tools/drive.mjs --screenshot shots/   # save adb screencap after every action
//
// Token: HUB_TOKEN from the environment, else the repo-root .env, else "dev".
// Type `help` at the prompt for the command list.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { hubToken, roleUrl, setting, sleep } from './common.mjs';

const HELP = `commands:
  screen                       read the screen, print a table (flags t=tap e=edit s=scroll)
  tap <target>                 target: Reply | "Reply all" | 540 1200 | #12 (node n from last screen)
  long <target>                long press
  point <target>               glide the cursor there, touch nothing
  type <text>                  type into the focused field
  type @<target> <text>        type into a target: @#12, @"Search mail", @Search, @540,1200
  swipe left|right|up|down [target]
  home | back | recents | notifications | enter     (or: key <name>)
  launch <app>                 open an app by label or package
  wait <ms>                    Hands waits that long
  cursor on|off                show or hide the cursor now (no reply expected)
  peers                        print the last peers frame
  raw <json>                   send any frame (add "id" to wait for its reply)
  demo [--dry] [sender]        scenic route to Gmail and reply to the newest email from sender
                               (sender defaults to HANDS_TEST_SENDER; --dry stops before Send and discards)
  quit`;

// ------------------------------------------------------------ args

const argv = process.argv.slice(2);
const flags = { adb: true, url: null, script: null, shots: null, exec: [], timeout: 15000, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-adb') flags.adb = false;
  else if (a === '--url') flags.url = argv[++i];
  else if (a === '--script') flags.script = argv[++i];
  else if (a === '--screenshot') flags.shots = argv[++i];
  else if (a === '-e' || a === '--exec') flags.exec.push(argv[++i]);
  else if (a === '--timeout') flags.timeout = Number(argv[++i]);
  else if (a === '-h' || a === '--help') { console.log(`usage: drive.mjs [--no-adb] [--url ws://127.0.0.1:8765] [--script file] [-e cmd]... [--screenshot dir] [--timeout ms]\n\n${HELP}`); process.exit(0); }
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
const BASE = flags.url || 'ws://127.0.0.1:8765';
const TOKEN = hubToken();
const batch = !!(flags.script || flags.exec.length);

// ------------------------------------------------------------ output

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let rl = null;
function out(line) {
  if (rl && !batch) { process.stdout.write('\r\x1b[K'); console.log(line); rl.prompt(true); }
  else console.log(line);
}

// ------------------------------------------------------------ adb

function adbArgs(args) { return args; } // ANDROID_SERIAL is honoured by adb itself

function adbForward() {
  try {
    execFileSync('adb', adbArgs(['forward', 'tcp:8765', 'tcp:8765']), { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('adb forward tcp:8765 tcp:8765: ok');
  } catch (e) {
    console.error(`adb forward failed: ${(e.stderr || e.message || '').toString().trim()}`);
    console.error('Is the phone connected (adb devices)? Use --no-adb to skip.');
    process.exit(1);
  }
}

let shotN = 0;
async function screenshot(label) {
  if (!flags.shots) return;
  mkdirSync(flags.shots, { recursive: true });
  shotN++;
  const name = `${String(shotN).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_').slice(0, 40)}.png`;
  const file = join(flags.shots, name);
  await new Promise((res) => {
    execFile('adb', adbArgs(['exec-out', 'screencap', '-p']), { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout || stdout.length < 100) out(`  screenshot failed: ${err ? err.message.split('\n')[0] : 'empty'}`);
      else { writeFileSync(file, stdout); out(`  screenshot ${file}`); }
      res();
    });
  });
}

// ------------------------------------------------------------ hub connection

let ws = null;
let connected = null; // promise resolved on welcome (of the current socket)
let up = false; // true between welcome and close
let lastPeers = null;
let lastScreen = null;
let stopping = false;
let backoff = 0;
const BACKOFF = [1000, 2000, 5000];
const pending = new Map(); // id -> {resolve, timer}
const idBase = Date.now().toString(36);
let idN = 0;
const nextId = () => `d${idBase}-${++idN}`;

function connect() {
  const url = roleUrl(BASE, 'mind', TOKEN);
  let welcomed;
  connected = new Promise((r) => { welcomed = r; });
  const sock = new WebSocket(url);
  ws = sock;
  let opened = false, gone = false;
  sock.addEventListener('open', () => { opened = true; sock.send(JSON.stringify({ type: 'hello', role: 'mind', v: 1 })); });
  sock.addEventListener('message', (ev) => {
    let o;
    try { o = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (!o || typeof o !== 'object') return;
    if (o.type === 'welcome') { backoff = 0; out(`${stamp()} connected to ${BASE} as mind (welcome v${o.v})`); up = true; welcomed(); return; }
    if (o.type === 'peers') { lastPeers = o; out(`${stamp()} peers ${fmtPeers(o)}`); return; }
    if (o.type === 'notification') { out(`${stamp()} NOTIFICATION [${o.app}] ${o.title}: ${o.text}`); return; }
    if (o.re != null && pending.has(String(o.re))) {
      const p = pending.get(String(o.re));
      pending.delete(String(o.re));
      clearTimeout(p.timer);
      p.resolve(o);
      return;
    }
    out(`${stamp()} << ${JSON.stringify(o).slice(0, 300)}`);
  });
  // Node's WebSocket fires only 'error' (no 'close') when it can't connect at all.
  sock.addEventListener('error', () => { if (!opened) setTimeout(() => onGone({ code: 1006, reason: 'could not connect' }), 0); });
  sock.addEventListener('close', (ev) => onGone(ev));
  function onGone(ev) {
    if (gone || ws !== sock) return;
    gone = true;
    up = false;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ type: 'closed', re: id, ok: false, error: 'disconnected' }); }
    pending.clear();
    if (stopping) return;
    if (ev.code === 4001) {
      out(`${stamp()} closed 4001: another mind connected and replaced this one (the real Mind app, or another drive.mjs). Not reconnecting.`);
      process.exit(3);
    }
    if (ev.code === 4003) {
      out(`${stamp()} closed 4003: the hub refused the token (or the role). HUB_TOKEN here is ${JSON.stringify(mask(TOKEN))}; the phone's hub must use the same one (the Hands test app uses "dev").`);
      process.exit(3);
    }
    if (batch) {
      out(`${stamp()} connection closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''}). Is the hub running? (phone: accessibility service on + adb forward; laptop: fakehub.mjs)`);
      process.exit(1);
    }
    const wait = BACKOFF[Math.min(backoff, BACKOFF.length - 1)] ?? 5000;
    backoff++;
    out(`${stamp()} connection closed (${ev.code}); reconnecting in ${wait / 1000}s`);
    setTimeout(connect, wait);
  }
}

function mask(t) { return t.length <= 4 ? t : `${t.slice(0, 2)}…${t.slice(-1)}`; }
function fmtPeers(p) { return ['hands', 'mind', 'mouth', 'caller'].map((k) => `${k}:${p[k] ? 'yes' : 'no'}`).join(' ') + (p.watch != null ? ` watch:${p.watch}` : ''); }

/** Sends a frame with a fresh id and waits for its reply. Resolves {reply, ms}. */
async function waitUp(ms = flags.timeout) {
  const end = Date.now() + ms;
  while (!up) {
    if (Date.now() > end) return false;
    await sleep(100);
  }
  return true;
}

async function request(frame) {
  if (!(await waitUp())) return { reply: { type: 'timeout', ok: false, error: 'not connected to the hub' }, ms: 0 };
  const id = frame.id ?? nextId();
  const msg = { ...frame, id };
  const started = Date.now();
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ type: 'timeout', re: id, ok: false, error: 'timeout (no reply in 15 s)' }); }, flags.timeout);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
  return { reply, ms: Date.now() - started };
}

// ------------------------------------------------------------ screen helpers

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function screenTable(r) {
  const lines = [`app ${r.app}  size ${(r.size || []).join('x')}  ${r.nodes.length} nodes`];
  lines.push('   n tes cls            label                                                  bounds');
  for (const n of r.nodes) {
    const f = `${n.tap ? 't' : '-'}${n.edit ? 'e' : '-'}${n.scroll ? 's' : '-'}`;
    let label = n.text && n.desc && n.text !== n.desc ? `${n.text} | ${n.desc}` : (n.text || (n.desc ? `[${n.desc}]` : ''));
    if (!label && n.hint) label = `(hint: ${n.hint})`;
    lines.push(`${String(n.n).padStart(4)} ${f} ${trunc(n.cls || '', 14).padEnd(14)} ${trunc(label, 54).padEnd(54)} ${JSON.stringify(n.bounds)}`);
  }
  return lines.join('\n');
}

async function getScreen(image = false) {
  const { reply, ms } = await request({ type: 'screen', to: 'hands', ...(image ? { image: true } : {}) });
  if (reply.type !== 'screen_result') throw new Error(`screen failed: ${reply.error || reply.type} (${ms} ms)`);
  lastScreen = reply;
  return { r: reply, ms };
}

// ------------------------------------------------------------ parsing

/** "Reply" | "540 1200" | "#12" | '"Reply all"' -> on object */
function parseTarget(s) {
  s = s.trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^#(\d+)$/))) return { n: Number(m[1]) };
  if ((m = s.match(/^(-?\d+)[\s,]+(-?\d+)$/))) return { x: Number(m[1]), y: Number(m[2]) };
  if ((m = s.match(/^"(.*)"$/)) || (m = s.match(/^'(.*)'$/))) return { text: m[1] };
  return { text: s };
}

/** "@#12 rest" | '@"Search mail" rest' | "@Search rest" | "@540,1200 rest" -> [on, rest] */
function splitAtTarget(s) {
  let m;
  if ((m = s.match(/^@"([^"]*)"\s?(.*)$/s)) || (m = s.match(/^@'([^']*)'\s?(.*)$/s))) return [{ text: m[1] }, m[2]];
  if ((m = s.match(/^@(-?\d+),(-?\d+)\s?(.*)$/s))) return [{ x: Number(m[1]), y: Number(m[2]) }, m[3]];
  if ((m = s.match(/^@(\S+)\s?(.*)$/s))) return [parseTarget(m[1]), m[2]];
  return [null, s];
}

const KEYS = ['home', 'back', 'recents', 'notifications', 'enter'];

/** Turns one command line into a frame, or a local action. */
function parseCommand(line) {
  const m = line.trim().match(/^(\S+)\s*(.*)$/s);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = m[2];
  const need = (on) => { if (!on) throw new Error(`${cmd} needs a target`); return on; };
  switch (cmd) {
    case 'screen': case 's': return { kind: 'screen', image: /^\s*(image|img)\b/i.test(rest || ''), file: (rest || '').trim().split(/\s+/)[1] };
    case 'tap': return { kind: 'act', frame: { do: 'tap', on: need(parseTarget(rest)) } };
    case 'long': case 'long_press': return { kind: 'act', frame: { do: 'long_press', on: need(parseTarget(rest)) } };
    case 'point': return { kind: 'act', frame: { do: 'point', on: need(parseTarget(rest)) } };
    case 'type': {
      const [on, text] = rest.startsWith('@') ? splitAtTarget(rest) : [null, rest];
      return { kind: 'act', frame: on ? { do: 'type', on, text } : { do: 'type', text } };
    }
    case 'swipe': {
      const mm = rest.match(/^(left|right|up|down)\b\s*(.*)$/i);
      if (!mm) throw new Error('swipe needs left, right, up or down');
      const on = parseTarget(mm[2]);
      return { kind: 'act', frame: on ? { do: 'swipe', dir: mm[1].toLowerCase(), on } : { do: 'swipe', dir: mm[1].toLowerCase() } };
    }
    case 'key': return { kind: 'act', frame: { do: 'key', name: rest.trim() } };
    case 'launch': if (!rest.trim()) throw new Error('launch needs an app'); return { kind: 'act', frame: { do: 'launch', app: rest.trim() } };
    case 'wait': {
      const ms = Number(rest.trim());
      if (!Number.isFinite(ms)) throw new Error('wait needs a number of ms');
      return { kind: 'act', frame: { do: 'wait', ms } };
    }
    case 'cursor': {
      const v = rest.trim().toLowerCase();
      if (v !== 'on' && v !== 'off') throw new Error('cursor on|off');
      return { kind: 'cursor', show: v === 'on' };
    }
    case 'peers': return { kind: 'peers' };
    case 'raw': return { kind: 'raw', obj: JSON.parse(rest) };
    case 'demo': {
      const words = rest.trim();
      const dry = /(^|\s)--dry(\s|$)/.test(words);
      const sender = words.replace(/(^|\s)--dry(\s|$)/, ' ').trim().replace(/^"(.*)"$/, '$1');
      return { kind: 'demo', dry, sender };
    }
    case 'drawer-gmail': return { kind: 'drawer-gmail' };
    case 'help': case '?': return { kind: 'help' };
    case 'quit': case 'exit': case 'q': return { kind: 'quit' };
    default:
      if (KEYS.includes(cmd)) return { kind: 'act', frame: { do: 'key', name: cmd } };
      throw new Error(`unknown command '${cmd}' (try help)`);
  }
}

// ------------------------------------------------------------ running commands

/** Sends one act. Returns the act_result (prints a line). */
async function act(frame, label) {
  const { reply, ms } = await request({ type: 'act', to: 'hands', ...frame });
  const ok = reply.ok === true;
  out(`${stamp()} ${label ?? describe(frame)}: ${ok ? 'ok' : `ERROR ${reply.error}${reply.detail ? ` (${reply.detail})` : ''}`}  ${ms} ms`);
  await screenshot(label ?? describe(frame));
  return reply;
}

function describe(f) {
  const t = (on) => (!on ? '' : 'n' in on ? ` #${on.n}` : 'text' in on ? ` "${on.text}"` : ` (${on.x},${on.y})`);
  switch (f.do) {
    case 'type': return `type${f.on ? ' @' + t(f.on).trim() : ''} ${JSON.stringify(f.text)}`;
    case 'swipe': return `swipe ${f.dir}${t(f.on)}`;
    case 'key': return `key ${f.name}`;
    case 'launch': return `launch ${f.app}`;
    case 'wait': return `wait ${f.ms}`;
    default: return `${f.do}${t(f.on)}`;
  }
}

/** Runs one command line. Returns true on success. */
async function run(line) {
  let c;
  try { c = parseCommand(line); } catch (e) { out(`  ${e.message}`); return false; }
  if (!c) return true;
  switch (c.kind) {
    case 'help': out(HELP); return true;
    case 'quit': await quit(0); return true;
    case 'peers': out(lastPeers ? `peers ${fmtPeers(lastPeers)}` : 'no peers frame yet'); return true;
    case 'cursor':
      if (!(await waitUp())) { out('not connected'); return false; }
      ws.send(JSON.stringify({ type: 'cursor', to: 'hands', show: c.show }));
      out(`${stamp()} cursor ${c.show ? 'on' : 'off'}: sent (no reply in the contract)`);
      return true;
    case 'screen': {
      try {
        const { r, ms } = await getScreen(c.image);
        out(`${stamp()} screen: ok  ${ms} ms\n${screenTable(r)}`);
        if (c.image) {
          if (r.image) {
            const file = c.file || `screen-${Date.now()}.jpg`;
            (await import('node:fs')).writeFileSync(file, Buffer.from(r.image, 'base64'));
            out(`${stamp()} image: ${Math.round(r.image.length * 3 / 4 / 1024)} KB -> ${file}`);
          } else out(`${stamp()} image: none (${r.image_error || 'not supported'})`);
        }
        await screenshot('screen');
        return true;
      } catch (e) { out(`${stamp()} ${e.message}`); return false; }
    }
    case 'act': return (await act(c.frame)).ok === true;
    case 'raw': {
      if (!(await waitUp())) { out('not connected'); return false; }
      if (c.obj.id == null) { ws.send(JSON.stringify(c.obj)); out(`${stamp()} raw sent`); return true; }
      const { reply, ms } = await request(c.obj);
      out(`${stamp()} raw reply (${ms} ms): ${JSON.stringify(reply).slice(0, 2000)}`);
      return reply.ok !== false && reply.type !== 'timeout';
    }
    case 'drawer-gmail': {
      try {
        const g = await findGmailInDrawer();
        if (!g) { out(`${stamp()} Gmail not in the drawer`); return false; }
        await mustAct({ do: 'point', on: { n: g.n } }, `point Gmail #${g.n}`);
        return true;
      } catch (e) { out(`${stamp()} STOPPED: ${e.message}`); return false; }
    }
    case 'demo': {
      try { await demo(c.sender, c.dry); return true; } catch (e) { out(`${stamp()} DEMO STOPPED: ${e.message}`); return false; }
    }
  }
  return false;
}

// ------------------------------------------------------------ demo: the scenic route

const norm = (s) => String(s || '').trim().toLowerCase();
const label = (n) => `${n.text || ''} ${n.desc || ''}`.trim();
const sig = (r) => r.nodes.map((n) => `${n.text}|${n.desc}`).join('\n');
const isGmailIcon = (n) => {
  const t = norm(n.text), d = norm(n.desc);
  return t === 'gmail' || d === 'gmail' || /^gmail\b[,:]/.test(t) || /^gmail\b[,:]/.test(d);
};
const FOLDER_GUESS = /google|gmail|mail|email|work|productivity|office|communicat|social|tools|apps/i;

function step(msg) { out(`${stamp()} [demo] ${msg}`); }

async function mustAct(frame, what) {
  const r = await act(frame, `[demo] ${what}`);
  if (!r.ok) throw new Error(`${what} failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`);
  return r;
}

async function demoScreen(why) {
  const { r } = await getScreen();
  step(`screen (${why}): ${r.app}, ${r.nodes.length} nodes`);
  return r;
}

async function pollScreen(why, pred, tries = 10, gapMs = 700) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await demoScreen(why);
    if (pred(r)) return r;
    await sleep(gapMs);
  }
  return null;
}

async function findGmailOnHome() {
  step('go home');
  await mustAct({ do: 'key', name: 'home' }, 'key home');
  await mustAct({ do: 'key', name: 'home' }, 'key home (again, to land on the first page)');
  const seen = [];
  const triedFolders = new Set();
  for (let page = 1; page <= 7; page++) {
    let r = await demoScreen(`home page ${page}`);
    const s = sig(r);
    if (seen.includes(s)) { step(s === seen[seen.length - 1] ? 'swipe changed nothing: that was the last page' : 'wrapped around to a page already seen: no more pages'); break; }
    seen.push(s);
    let g = r.nodes.find(isGmailIcon);
    if (g) { step(`Gmail is on page ${page} (#${g.n})`); return g; }
    // Folders: likely ones first (names that could hold Gmail, or nodes described as a folder).
    const folders = r.nodes
      .filter((n) => n.tap && !n.edit && !/search|widget/i.test(label(n)) && (/folder/i.test(label(n)) || FOLDER_GUESS.test(label(n))))
      .filter((n) => !triedFolders.has(norm(label(n))))
      .sort((a, b) => score(b) - score(a));
    for (const f of folders) {
      triedFolders.add(norm(label(f)));
      step(`page ${page}: opening folder-like "${label(f)}" (#${f.n}) to look for Gmail`);
      await mustAct({ do: 'tap', on: { n: f.n } }, `tap #${f.n} "${trunc(label(f), 30)}"`);
      const inside = await demoScreen('inside folder');
      g = inside.nodes.find(isGmailIcon);
      if (g) { step(`Gmail is inside "${label(f)}" (#${g.n})`); return g; }
      if (inside.app !== r.app || sig(inside) !== s) {
        step('not in there; closing it');
        await mustAct({ do: 'key', name: 'back' }, 'key back');
        const after = await demoScreen('after closing folder');
        if (sig(after) !== s) {
          // Back left the home screen (an app opened): go home and come back to this page.
          step('back did not return to the same page; going home and swiping to it again');
          await mustAct({ do: 'key', name: 'home' }, 'key home');
          for (let k = 1; k < page; k++) await mustAct({ do: 'swipe', dir: 'left' }, 'swipe left');
        }
      }
    }
    step(`page ${page}: no Gmail; swiping left to the next page`);
    await mustAct({ do: 'swipe', dir: 'left' }, 'swipe left');
  }
  const d = await findGmailInDrawer();
  if (d) return d;
  throw new Error('Gmail not found on any home screen page, folder or the app drawer (try "launch Gmail" to check the app exists)');
}

/** Second route: the app drawer (swipe up from home), its pages and folders. */
async function findGmailInDrawer() {
  step('not on the home screens: trying the app drawer');
  await mustAct({ do: 'key', name: 'home' }, 'key home');
  await mustAct({ do: 'swipe', dir: 'up' }, 'swipe up (open the app drawer)');
  const seen = [];
  for (let page = 1; page <= 6; page++) {
    const r = await demoScreen(`drawer page ${page}`);
    const s = sig(r);
    if (seen.includes(s)) { step('no more drawer pages'); break; }
    seen.push(s);
    let g = r.nodes.find(isGmailIcon);
    if (g) { step(`Gmail is in the drawer, page ${page} (#${g.n})`); return g; }
    const folders = r.nodes.filter((n) => n.tap && /folder/i.test(label(n))).sort((a, b) => score(b) - score(a));
    for (const f of folders) {
      step(`drawer page ${page}: opening "${label(f)}" (#${f.n})`);
      await mustAct({ do: 'tap', on: { n: f.n } }, `tap #${f.n} "${trunc(label(f), 30)}"`);
      const inside = await demoScreen('inside drawer folder');
      g = inside.nodes.find(isGmailIcon);
      if (g) { step(`Gmail is inside drawer folder "${label(f)}" (#${g.n})`); return g; }
      await mustAct({ do: 'key', name: 'back' }, 'key back (close folder)');
    }
    await mustAct({ do: 'swipe', dir: 'left' }, 'swipe left (next drawer page)');
  }
  return null;
}
function score(n) {
  const l = label(n);
  return (/google/i.test(l) ? 4 : 0) + (/mail/i.test(l) ? 3 : 0) + (/folder/i.test(l) ? 2 : 0) + (FOLDER_GUESS.test(l) ? 1 : 0);
}

const GMAIL = 'com.google.android.gm';

/** True when the label starts with the sender's name, after Gmail's "Unread, " / "Starred, " prefixes. */
function startsWithSender(str, sender) {
  const t = norm(str).replace(/^((unread|starred|important|read)[,.]?\s*)+/, '');
  const s = norm(sender);
  return t === s || t.startsWith(s + ',') || t.startsWith(s + ' ') || t.startsWith(s + '<') || t.startsWith(s + '(');
}

function findSenderRow(r, sender) {
  const s = norm(sender);
  const hits = r.nodes.filter((n) => !n.edit && (norm(n.text).includes(s) || norm(n.desc).includes(s)))
    .filter((n) => !/^search/i.test(n.text) && !/^search/i.test(n.desc));
  if (!hits.length) return null;
  // Prefer rows that start with the sender (not a subject that mentions them), then tappable
  // ones; the newest is the one nearest the top.
  const strong = (n) => startsWithSender(n.text, sender) || startsWithSender(n.desc, sender);
  const rank = (n) => (strong(n) ? 0 : 2) + (n.tap ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b) || a.bounds[1] - b.bounds[1])[0];
}

const findReply = (r) => r.nodes.find((n) => n.tap && (norm(n.text) === 'reply' || norm(n.desc) === 'reply'));
const findSend = (r) => r.nodes.find((n) => norm(n.desc) === 'send' || (n.tap && norm(n.text) === 'send'));

async function demo(senderArg, dry) {
  const sender = senderArg || setting('HANDS_TEST_SENDER', '');
  if (!sender) throw new Error('no sender: give one (demo "Sarah Chen") or set HANDS_TEST_SENDER in the root .env');
  const reply = 'Thanks! Got it — sent by Bobby.';
  step(`scenic route to Gmail, reply to the newest email from "${sender}"${dry ? ' (DRY: stops before Send)' : ''}`);

  const g = await findGmailOnHome();
  await mustAct({ do: 'tap', on: { n: g.n } }, `tap Gmail #${g.n}`);
  let r = await pollScreen('waiting for Gmail', (x) => x.app === GMAIL, 12);
  if (!r) throw new Error(`Gmail didn't come to the front (app is ${lastScreen?.app})`);

  // The inbox: find the newest row from the sender. Gmail may reopen where it was left.
  let row = findSenderRow(r, sender);
  for (let i = 0; !row && i < 3; i++) {
    const up = r.nodes.find((n) => n.tap && /^(navigate up|back)$/i.test(n.desc));
    if (up) { step('not on the inbox; tapping Navigate up'); await mustAct({ do: 'tap', on: { n: up.n } }, 'tap Navigate up'); }
    else if (i === 0) { step('no row from the sender yet; waiting for the list to load'); await mustAct({ do: 'wait', ms: 1000 }, 'wait 1000'); }
    else { step('no row from the sender; scrolling to the top'); await mustAct({ do: 'swipe', dir: 'down' }, 'swipe down'); }
    r = await demoScreen('inbox');
    if (r.app !== GMAIL) throw new Error(`left Gmail (now ${r.app})`);
    row = findSenderRow(r, sender);
  }
  if (!row) throw new Error(`no email from "${sender}" visible in the inbox`);
  step(`newest row from "${sender}": #${row.n} "${trunc(label(row), 70)}"`);
  await mustAct({ do: 'tap', on: { n: row.n } }, `tap row #${row.n}`);

  // The open email must show the sender, and have a Reply button.
  r = await pollScreen('open email', (x) => x.app === GMAIL && !!findReply(x), 8);
  if (!r) throw new Error('the email did not open (no Reply button found)');
  const who = r.nodes.find((n) => !n.edit && (startsWithSender(n.text, sender) || startsWithSender(n.desc, sender)));
  if (!who) throw new Error(`the open email doesn't show "${sender}": stopping before anything is sent`);
  step(`email is from "${sender}" (#${who.n} "${trunc(label(who), 50)}")`);

  const rb = findReply(r);
  await mustAct({ do: 'tap', on: { n: rb.n } }, `tap Reply #${rb.n}`);
  r = await pollScreen('compose', (x) => x.app === GMAIL && !!findSend(x) && x.nodes.some((n) => n.edit), 8);
  if (!r) throw new Error('the reply compose screen did not open (no Send button and text field)');

  // Type into the body: the field whose hint/text says "Compose email", else whatever has focus.
  const body = r.nodes.find((n) => n.edit && (/compose email/i.test(n.hint || '') || /compose email/i.test(n.text)));
  await mustAct(body ? { do: 'type', on: { n: body.n }, text: reply } : { do: 'type', text: reply }, `type ${body ? `@#${body.n} ` : ''}${JSON.stringify(reply)}`);
  r = await demoScreen('check typed text');
  if (!r.nodes.some((n) => n.text.includes('Thanks! Got it'))) throw new Error("the typed reply isn't visible in any field: stopping before Send");
  const send = findSend(r);
  if (!send) throw new Error('no Send button');
  if (!findSenderRowLoose(r, sender)) step(`note: the compose screen doesn't show "${sender}" by name (the To field may show only an address)`);

  if (dry) {
    step(`DRY: would tap Send (#${send.n}) now. Discarding the draft instead.`);
    await discardDraft(r);
    step('DRY run finished: nothing sent, draft discarded');
    return;
  }
  await mustAct({ do: 'tap', on: { n: send.n } }, `tap Send #${send.n}`);
  r = await demoScreen('after send');
  const sent = r.nodes.find((n) => /sending|sent|message sent/i.test(label(n)));
  step(sent ? `Gmail says "${label(sent)}"` : 'Send tapped (no "Sent" toast seen; check the Sent folder)');
  step('DONE: reply sent');
}

function findSenderRowLoose(r, sender) {
  const s = norm(sender);
  const first = s.split(/\s+/)[0];
  return r.nodes.find((n) => norm(n.text).includes(s) || norm(n.desc).includes(s) || (first && (norm(n.text).includes(first) || norm(n.desc).includes(first))));
}

async function discardDraft(r) {
  const discard = (x) => x.nodes.find((n) => /^discard( draft)?$/i.test(n.text || n.desc));
  let d = discard(r);
  if (!d) {
    const more = r.nodes.find((n) => n.tap && /^more options$/i.test(n.desc));
    if (more) {
      await mustAct({ do: 'tap', on: { n: more.n } }, `tap More options #${more.n}`);
      r = await demoScreen('compose menu');
      d = discard(r);
    }
  }
  if (d) {
    await mustAct({ do: 'tap', on: { n: d.n } }, `tap Discard #${d.n}`);
    r = await demoScreen('after discard');
    const again = discard(r);
    if (again) { await mustAct({ do: 'tap', on: { n: again.n } }, `tap Discard (confirm) #${again.n}`); r = await demoScreen('after confirm'); }
    if (!findSend(r)) return;
  }
  // Fallback: back out, and discard if a dialog asks.
  step('no Discard in the menu; backing out');
  if (d == null && r.nodes.some((n) => /^(save draft|settings)$/i.test(n.text))) await mustAct({ do: 'key', name: 'back' }, 'key back (close menu)');
  await mustAct({ do: 'key', name: 'back' }, 'key back');
  r = await demoScreen('after back');
  const dd = discard(r);
  if (dd) await mustAct({ do: 'tap', on: { n: dd.n } }, `tap Discard #${dd.n}`);
  else if (r.nodes.some((n) => /draft saved/i.test(label(n)))) step('WARNING: Gmail saved a draft; delete it from Drafts by hand');
}

// ------------------------------------------------------------ main

async function quit(code) {
  stopping = true;
  try { ws?.close(1000, 'bye'); } catch {}
  await sleep(50);
  process.exit(code);
}

async function main() {
  if (flags.adb) adbForward();
  console.log(`hub ${BASE}, token ${JSON.stringify(mask(TOKEN))}`);
  connect();
  const ready = await waitUp(10000);
  if (!ready) {
    console.error('no welcome from the hub within 10 s');
    if (batch) process.exit(1);
  }
  await sleep(100); // let the first peers frame print

  if (batch) {
    const lines = [];
    if (flags.script) lines.push(...readFileSync(flags.script, 'utf8').split(/\r?\n/));
    lines.push(...flags.exec);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      out(`> ${line}`);
      if (!(await run(line))) { out(`FAILED at: ${line}`); await quit(1); }
    }
    await quit(0);
    return;
  }

  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'hands> ' });
  rl.prompt();
  let busy = Promise.resolve();
  rl.on('line', (line) => {
    busy = busy.then(async () => { if (line.trim()) await run(line); rl.prompt(); });
  });
  rl.on('close', () => { busy.then(() => quit(0)); });
}

main().catch((e) => { console.error(e); process.exit(1); });
