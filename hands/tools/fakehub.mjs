#!/usr/bin/env node
// A laptop fake of the phone hub, so drive.mjs and hub-test.mjs run with no phone.
//
//   node hands/tools/fakehub.mjs [--port 8765] [--token dev] [--any-token] [--sender "Sarah Chen"] [--quiet]
//
// The routing is a line-by-line port of hands/android/.../HubCore.kt (token check 4003,
// hello/welcome, 4001 replacement, delivery by `to`, peers, wire copies, remembered task/plan).
// Behind it sits a fake Hands with a small stateful phone: three Samsung-like home pages,
// a "Google" folder holding Gmail, a Gmail inbox, an open email, a reply compose screen with
// Send / More options / Discard. `act` replies after ~200 ms; text it can't find is not_found.
// Type `notify <title>: <text>` on stdin to push a notification to the Mind.
// Also speaks the protocol additions (hands/README.md "Protocol additions"): `caps`, `open`,
// `{id}`/`{key}` targets, `hash`/`since`/`compact` on screen, `then_screen`/`fast` on acts, `why`.
import { WebSocketServer } from 'ws';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- HubCore port

export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_TOKEN = 4003;
const ROLES = new Set(['mind', 'mouth', 'caller', 'watch']);

export function parsePath(path) {
  const noFrag = path.split('#')[0];
  const p = noFrag.split('?')[0].replace(/^\/+|\/+$/g, '');
  const q = noFrag.includes('?') ? noFrag.slice(noFrag.indexOf('?') + 1) : '';
  let token = null;
  for (const kv of q.split('&')) {
    if (kv.startsWith('token=')) {
      try { token = decodeURIComponent(kv.slice(6).replace(/\+/g, ' ')); } catch { token = kv.slice(6); }
    }
  }
  return [p, token];
}

/** Routing rules with no networking. conn = {send(text), close(code, reason)}. */
export class HubCore {
  constructor({ token, anyToken = false, toHands, clock = () => Date.now(), log = () => {} }) {
    this.token = token;
    this.anyToken = anyToken;
    this.toHands = toHands;
    this.clock = clock;
    this.log = log;
    this.clients = new Map(); // conn -> {conn, role, helloed}
    this.current = new Map(); // mind/mouth/caller -> client
    this.watches = new Set();
    this.lastTask = null;
    this.lastPlan = null;
    this._handsOn = true;
  }

  get handsOn() { return this._handsOn; }
  set handsOn(v) { this._handsOn = v; this.broadcastPeers(); }

  onOpen(conn, path) {
    const [role, tok] = parsePath(path);
    if (!this.anyToken && (!this.token || tok !== this.token)) {
      this.log(`refused ${role}: bad token`);
      conn.close(CLOSE_BAD_TOKEN, 'bad token');
      return false;
    }
    if (!ROLES.has(role)) {
      this.log(`refused unknown role '${role}'`);
      conn.close(CLOSE_BAD_TOKEN, 'unknown role');
      return false;
    }
    this.clients.set(conn, { conn, role, helloed: false });
    return true;
  }

  onMessage(conn, text) {
    const c = this.clients.get(conn);
    if (!c) return;
    const o = parseObj(text);
    if (!o) return;
    if (!c.helloed) {
      if (o.type !== 'hello') return;
      c.helloed = true;
      this.register(c);
      return;
    }
    if (o.type === 'hello') return;
    if (c.role === 'watch') return; // read-only
    if (c.role === 'mind') this.fromMind(o, text);
    else this.deliverToMind(c.role, o, text);
  }

  onClose(conn) {
    const c = this.clients.get(conn);
    if (!c) return;
    this.clients.delete(conn);
    if (!c.helloed) return;
    let changed = false;
    if (c.role === 'watch') changed = this.watches.delete(c);
    else if (this.current.get(c.role) === c) { this.current.delete(c.role); changed = true; }
    if (changed) { this.log(`${c.role} left`); this.broadcastPeers(); }
  }

  /** A frame produced by Hands itself (act_result, screen_result, notification). */
  fromHands(text) {
    const o = parseObj(text);
    if (!o) return;
    this.deliverToMind('hands', o, text);
  }

  peers() {
    return {
      type: 'peers',
      hands: this._handsOn,
      mind: this.current.has('mind'),
      mouth: this.current.has('mouth'),
      caller: this.current.has('caller'),
      watch: this.watches.size,
    };
  }

  closeAll() {
    for (const c of [...this.clients.values()]) { try { c.conn.close(1001, 'hub stopping'); } catch {} }
    this.clients.clear(); this.current.clear(); this.watches.clear();
  }

  register(c) {
    this.send(c, JSON.stringify({ type: 'welcome', v: 1 }));
    if (c.role === 'watch') {
      this.watches.add(c);
      const task = this.lastTask;
      if (task && str(task.status) === 'started') {
        this.send(c, JSON.stringify(task));
        if (this.lastPlan && str(this.lastPlan.task) === str(task.task)) this.send(c, JSON.stringify(this.lastPlan));
      }
    } else {
      const old = this.current.get(c.role);
      this.current.set(c.role, c);
      if (old && old !== c) {
        this.log(`${c.role} replaced; closing the older socket with 4001`);
        this.clients.delete(old.conn);
        try { old.conn.close(CLOSE_REPLACED, 'replaced'); } catch {}
      }
    }
    this.log(`${c.role} joined`);
    this.broadcastPeers();
  }

  fromMind(o, text) {
    const to = str(o.to);
    switch (to) {
      case 'watch': {
        if (o.type === 'task') {
          if (str(this.lastTask?.task) !== str(o.task)) this.lastPlan = null;
          this.lastTask = o;
        } else if (o.type === 'plan') {
          this.lastPlan = o;
        }
        for (const w of [...this.watches]) this.send(w, text);
        return;
      }
      case 'hands': {
        if (!this._handsOn) return;
        this.mirror('mind', 'hands', o);
        try { this.toHands(text); } catch (e) { this.log(`hands handler failed: ${e.message}`); }
        return;
      }
      case 'mouth':
      case 'caller': {
        const target = this.current.get(to);
        if (!target) return;
        this.send(target, text);
        this.mirror('mind', to, o);
        return;
      }
      default:
        return;
    }
  }

  deliverToMind(from, o, text) {
    const mind = this.current.get('mind');
    if (!mind) return;
    this.send(mind, text);
    this.mirror(from, 'mind', o);
  }

  mirror(from, to, msg) {
    if (this.watches.size === 0) return;
    const wire = JSON.stringify({ type: 'wire', from, to, at: this.clock(), msg });
    for (const w of [...this.watches]) this.send(w, wire);
  }

  broadcastPeers() {
    const p = JSON.stringify(this.peers());
    const mind = this.current.get('mind');
    if (mind) this.send(mind, p);
    for (const w of [...this.watches]) this.send(w, p);
  }

  send(c, text) {
    try { c.conn.send(text); } catch (e) { this.log(`send to ${c.role} failed: ${e.message}`); }
  }
}

// optString semantics: missing/null -> "", otherwise String(v)
function str(v) { return v == null ? '' : String(v); }
function parseObj(text) {
  try { const o = JSON.parse(text); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

// ---------------------------------------------------------------- fake phone

const W = 1080, H = 2400;
const LAUNCHER = 'com.sec.android.app.launcher';
const GMAIL = 'com.google.android.gm';
const DOS = new Set(['tap', 'long_press', 'point', 'type', 'swipe', 'key', 'launch', 'wait', 'open']);
/** `open`: which fake app handles a scheme or action (package, label). */
const OPEN_HANDLERS = {
  mailto: [GMAIL, 'Gmail compose'], sms: ['com.google.android.apps.messaging', 'Messages'], smsto: ['com.google.android.apps.messaging', 'Messages'],
  tel: ['com.google.android.dialer', 'Phone'], https: ['com.android.chrome', 'Chrome'], http: ['com.android.chrome', 'Chrome'],
  geo: ['com.google.android.apps.maps', 'Maps'], 'google.navigation': ['com.google.android.apps.maps', 'Maps navigation'],
  'android.intent.action.SET_ALARM': ['com.google.android.deskclock', 'Clock'], 'android.intent.action.SET_TIMER': ['com.google.android.deskclock', 'Clock'],
  'android.intent.action.WEB_SEARCH': ['com.google.android.googlequicksearchbox', 'Google'],
  'android.intent.action.INSERT': ['com.google.android.calendar', 'Calendar event'],
};
const defaultAction = (scheme) => ({ mailto: 'android.intent.action.SENDTO', sms: 'android.intent.action.SENDTO', smsto: 'android.intent.action.SENDTO', tel: 'android.intent.action.DIAL' })[scheme] || 'android.intent.action.VIEW';

function fnv32(str) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(str, 'utf8')) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const DIRS = new Set(['left', 'right', 'up', 'down']);
const KEYS = new Set(['home', 'back', 'recents', 'notifications', 'enter']);

function N(text, desc, cls, bounds, opts = {}) {
  return { text, desc, cls, bounds, tap: !!opts.tap, edit: !!opts.edit, scroll: !!opts.scroll, hint: opts.hint || '', act: opts.act || null, focused: !!opts.focused, viewId: opts.id || '' };
}
function icon(label, col, row, act, desc = '') {
  const l = 40 + col * 250, t = 300 + row * 330;
  return N(label, desc, 'TextView', [l, t, l + 250, t + 300], { tap: true, act: act || `open:${label}` });
}

export class FakePhone {
  constructor({ sender = 'Sarah Chen', log = () => {} } = {}) {
    this.sender = sender;
    this.log = log;
    this.state = { s: 'home', page: 0 };
    this.stack = [];
    this.lastNodes = [];
    this.body = '';
    this.sent = [];
    this.drafts = 0;
    this.toast = '';
  }

  pages() {
    return [
      [N('10:42', 'Clock', 'TextView', [60, 160, 1020, 280]), icon('Play Store', 0, 1), icon('Galaxy Store', 1, 1), icon('Settings', 2, 1), icon('Social', 3, 1, 'folder:Social', 'Folder, Social, 3 apps')],
      [icon('Google', 0, 0, 'folder:Google', 'Folder, Google, 5 apps'), icon('Spotify', 1, 0), icon('Calendar', 2, 0)],
      [icon('Photos', 0, 0), icon('Notes', 1, 0)],
    ];
  }

  inboxRows() {
    const s = this.sender;
    return [
      { from: 'Alex Kim', subject: `Photos from ${s}'s party`, snippet: 'Here are the photos!', when: '10:40 AM', unread: true },
      { from: s, subject: 'Lunch tomorrow', snippet: 'Are we still on for 12:30?', when: '10:31 AM', unread: true },
      { from: 'Alex Kim', subject: 'Weekend plans', snippet: 'Hey! What are you up to on Saturday?', when: '9:02 AM' },
      { from: s, subject: 'Old thread', snippet: 'Thanks for the notes from last week.', when: 'Nov 20' },
    ];
  }

  view() {
    const st = this.state;
    let app = LAUNCHER, nodes = [];
    const toast = this.toast ? [N(this.toast, '', 'TextView', [300, 2050, 780, 2130])] : [];
    switch (st.s) {
      case 'home': {
        const pages = this.pages();
        nodes = [
          N('', '', 'PagedView', [0, 120, W, 1900], { scroll: true }),
          ...pages[st.page],
          N('', `Page ${st.page + 1} of ${pages.length}`, 'View', [440, 1900, 640, 1950]),
          icon('Phone', 0, 5), icon('Messages', 1, 5), icon('Internet', 2, 5), icon('Camera', 3, 5),
        ];
        break;
      }
      case 'folder': {
        const apps = st.name === 'Google' ? ['Gmail', 'Drive', 'Maps', 'YouTube', 'Photos'] : ['WhatsApp', 'Instagram', 'X'];
        nodes = [N(st.name, '', 'EditText', [200, 600, 880, 700], { edit: true, act: 'noop' }), ...apps.map((a, i) => icon(a, i % 3, 1 + Math.floor(i / 3)))];
        break;
      }
      case 'inbox': {
        app = GMAIL;
        nodes = [
          N('', 'Open navigation drawer', 'ImageButton', [30, 130, 150, 250], { tap: true, act: 'noop' }),
          N('Search in mail', '', 'TextView', [160, 130, 900, 250], { tap: true, act: 'noop' }),
          N('Primary', '', 'TextView', [40, 290, 400, 360]),
          N('', '', 'RecyclerView', [0, 380, W, 2200], { scroll: true }),
          ...this.inboxRows().map((r, i) => N('', `${r.unread ? 'Unread, ' : ''}${r.from}, ${r.subject}, ${r.snippet}, ${r.when}`, 'ViewGroup', [0, 400 + i * 260, W, 640 + i * 260], { tap: true, act: `row:${i}` })),
          N('Compose', '', 'Button', [640, 2050, 1040, 2180], { tap: true, act: 'noop', id: 'com.google.android.gm:id/compose_button' }),
        ];
        break;
      }
      case 'email':
      case 'compose':
      case 'menu':
      case 'confirm': {
        app = GMAIL;
        const r = this.inboxRows()[st.row];
        if (st.s === 'email') {
          nodes = [
            N('', 'Navigate up', 'ImageButton', [20, 130, 150, 250], { tap: true, act: 'back' }),
            N(r.subject, '', 'TextView', [40, 300, 1000, 400]),
            N(r.from, '', 'TextView', [180, 450, 700, 520], { tap: true, act: 'noop' }),
            N('to me', '', 'TextView', [180, 520, 500, 580]),
            N('', 'Reply', 'ImageButton', [820, 450, 920, 550], { tap: true, act: 'reply' }),
            N(r.snippet, '', 'TextView', [40, 650, 1040, 900]),
            N('Reply', '', 'Button', [40, 2050, 360, 2180], { tap: true, act: 'reply' }),
            N('Reply all', '', 'Button', [380, 2050, 700, 2180], { tap: true, act: 'reply' }),
            N('Forward', '', 'Button', [720, 2050, 1040, 2180], { tap: true, act: 'noop' }),
          ];
        } else {
          nodes = [
            N('', 'Navigate up', 'ImageButton', [20, 130, 150, 250], { tap: true, act: 'back' }),
            N('', 'Attach file', 'ImageButton', [700, 130, 800, 250], { tap: true, act: 'noop' }),
            N('', 'Send', 'ImageButton', [820, 130, 920, 250], { tap: true, act: 'send' }),
            N('', 'More options', 'ImageButton', [940, 130, 1060, 250], { tap: true, act: 'menu' }),
            N('me@example.com', '', 'TextView', [180, 300, 1000, 380]),
            N(r.from, '', 'EditText', [180, 400, 1000, 480], { edit: true, tap: true, act: 'noop' }),
            N(`Re: ${r.subject}`, '', 'EditText', [40, 500, 1040, 580], { edit: true, tap: true, act: 'noop' }),
            N(this.body, '', 'EditText', [40, 600, 1040, 1100], { edit: true, tap: true, hint: this.body ? '' : 'Compose email', act: 'noop', focused: true }),
          ];
          if (st.s === 'menu') {
            nodes.unshift(
              N('Save draft', '', 'TextView', [600, 150, 1060, 260], { tap: true, act: 'savedraft' }),
              N('Discard', '', 'TextView', [600, 260, 1060, 370], { tap: true, act: 'discard' }),
              N('Settings', '', 'TextView', [600, 370, 1060, 480], { tap: true, act: 'noop' }),
            );
          } else if (st.s === 'confirm') {
            nodes.unshift(
              N('Discard draft?', '', 'TextView', [140, 1000, 940, 1100]),
              N('Cancel', '', 'Button', [400, 1200, 640, 1300], { tap: true, act: 'back' }),
              N('Discard', '', 'Button', [680, 1200, 940, 1300], { tap: true, act: 'reallydiscard' }),
            );
          }
        }
        break;
      }
      case 'app':
        app = st.pkg || `fake.app.${st.name.toLowerCase().replace(/\W+/g, '')}`;
        nodes = [N(st.name, '', 'TextView', [40, 200, 1040, 300])];
        break;
      case 'recents':
        app = LAUNCHER;
        nodes = [N('Close all', '', 'Button', [340, 2000, 740, 2120], { tap: true, act: 'home' })];
        break;
      case 'shade':
        app = 'com.android.systemui';
        nodes = [N('', 'Wi-Fi,On', 'Switch', [40, 200, 300, 320], { tap: true, act: 'noop' }), N('Notification settings', '', 'Button', [40, 1800, 600, 1900], { tap: true, act: 'noop' })];
        break;
    }
    const seen = {};
    nodes = [...toast, ...nodes].map((n, i) => {
      const label = (n.edit ? n.hint || n.desc : n.text || n.desc).slice(0, 24);
      const cxb = Math.floor((n.bounds[0] + n.bounds[2]) / 2 / (W / 8)), cyb = Math.floor((n.bounds[1] + n.bounds[3]) / 2 / (H / 16));
      const base = 'k' + fnv32(`${app}|${n.viewId}|${n.cls}|${label}|${cxb},${cyb}`);
      seen[base] = (seen[base] || 0) + 1;
      return { ...n, n: i, key: seen[base] === 1 ? base : `${base}-${seen[base]}` };
    });
    return { app, nodes };
  }

  backToEmail(row) {
    while (this.stack.length && ['email', 'compose', 'menu', 'confirm'].includes(this.stack[this.stack.length - 1].s)) this.stack.pop();
    this.state = { s: 'email', row };
  }

  go(state) { this.stack.push(this.state); this.state = state; this.toast = ''; }

  /** opts: {since, compact} from the request. Always carries `hash`. */
  screen(re, opts = {}) {
    const { app, nodes } = this.view();
    this.lastNodes = nodes;
    const pub = nodes.map((n) => publicNode(n, false));
    const hash = createHash('sha1').update(JSON.stringify([app, pub.map(({ n, key, ...rest }) => rest)])).digest('hex').slice(0, 16);
    const head = { type: 'screen_result', ...(re != null ? { re } : {}) };
    if (opts.since && opts.since === hash) return { ...head, same: true, hash, app, size: [W, H] };
    return { ...head, app, size: [W, H], hash, nodes: nodes.map((n) => publicNode(n, !!opts.compact)) };
  }

  caps(re) {
    return { type: 'caps_result', ...(re != null ? { re } : {}), sdk: 35, release: '15', oem: 'samsung', brand: 'samsung', model: 'FAKE-S21',
      locale: 'en-US', size: [W, H], density: 2.625, orientation: 'portrait', launcher: LAUNCHER, ime: 'com.samsung.android.honeyboard',
      secureLock: false, locked: false, gestureNav: true, imeTyping: true, screenshot: false, displays: 1,
      features: ['open', 'since', 'compact', 'then_screen', 'fast', 'target_id', 'target_key', 'locked', 'caps'], fake: true };
  }

  /** The package in front (act_result `app` after launch/open). */
  front() { return this.view().app; }

  /** Resolves a target to {x, y, node}. Returns null when not found. */
  resolve(on, nodes) {
    if ('n' in on) {
      const n = this.lastNodes[on.n];
      if (!n) return null;
      return { x: cx(n), y: cy(n), node: n };
    }
    if ('text' in on) {
      const n = byText(nodes, on.text);
      return n ? { x: cx(n), y: cy(n), node: n } : null;
    }
    if ('id' in on) {
      const q = String(on.id);
      const n = nodes.find((x) => x.viewId && (q.includes(':') ? x.viewId === q : x.viewId.split('/').pop() === q.split('/').pop()));
      return n ? { x: cx(n), y: cy(n), node: n } : null;
    }
    if ('key' in on) {
      const n = nodes.find((x) => x.key === on.key);
      return n ? { x: cx(n), y: cy(n), node: n } : null;
    }
    return { x: on.x, y: on.y, node: null };
  }

  /** Performs one act. Returns null on success or [error, detail]. */
  act(a) {
    const { nodes } = this.view();
    let target = null;
    if (a.on) {
      target = this.resolve(a.on, nodes);
      if (!target) return ['not_found', `nothing matches ${JSON.stringify(a.on)}`];
    }
    switch (a.do) {
      case 'point': case 'long_press': return null;
      case 'tap': {
        // What is under the finger now (like a real tap).
        const hit = atPoint(nodes, target.x, target.y, (n) => n.tap && n.act);
        if (hit) this.handle(hit.act);
        return null;
      }
      case 'type': {
        let field;
        if (target) {
          field = atPoint(nodes, target.x, target.y, (n) => n.edit) || null;
          if (!field) return ['not_editable', "the target isn't a text field"];
        } else {
          field = nodes.find((n) => n.focused);
          if (!field) return ['not_found', 'no text field has focus'];
        }
        if (field.focused) this.body = String(a.text);
        return null;
      }
      case 'swipe': {
        if (this.state.s === 'home') {
          const last = this.pages().length - 1;
          if (a.dir === 'left' && this.state.page < last) this.state = { s: 'home', page: this.state.page + 1 };
          if (a.dir === 'right' && this.state.page > 0) this.state = { s: 'home', page: this.state.page - 1 };
        }
        return null;
      }
      case 'key':
        switch (a.name) {
          case 'home': this.stack = []; this.state = { s: 'home', page: 0 }; this.toast = ''; break;
          case 'back': this.handle('back'); break;
          case 'recents': this.go({ s: 'recents' }); break;
          case 'notifications': this.go({ s: 'shade' }); break;
        }
        return null;
      case 'launch': {
        const app = String(a.app).toLowerCase();
        if (app === 'gmail' || app === GMAIL) { this.go({ s: 'inbox' }); return null; }
        const all = this.pages().flat().map((n) => n.text).concat(['Phone', 'Messages', 'Internet', 'Camera', 'Drive', 'Maps', 'YouTube']);
        const hit = all.find((t) => t && t.toLowerCase() === app);
        if (!hit) return ['not_found', `no app called '${a.app}'`];
        this.go({ s: 'app', name: hit });
        return null;
      }
      case 'wait': return null;
      case 'open': {
        const scheme = a.uri && /^[a-z][\w+.-]*:/i.test(a.uri) ? a.uri.slice(0, a.uri.indexOf(':')).toLowerCase() : null;
        const h = OPEN_HANDLERS[a.action] || (scheme && OPEN_HANDLERS[scheme]);
        if (!h) return ['not_found', `no app handles ${scheme ? scheme + ':' : a.action}`];
        if (h[0] === GMAIL && scheme === 'mailto') this.log(`fake phone: open ${a.uri} (compose, not sent)`);
        this.go({ s: 'app', name: h[1], pkg: h[0] });
        return null;
      }
    }
    return null;
  }

  handle(act) {
    const st = this.state;
    if (act === 'noop') return;
    if (act === 'home') { this.stack = []; this.state = { s: 'home', page: 0 }; return; }
    if (act.startsWith('folder:')) return this.go({ s: 'folder', name: act.slice(7), page: st.page });
    if (act.startsWith('open:')) {
      const name = act.slice(5);
      if (name === 'Gmail') return this.go({ s: 'inbox' });
      return this.go({ s: 'app', name });
    }
    if (act.startsWith('row:')) return this.go({ s: 'email', row: Number(act.slice(4)) });
    switch (act) {
      case 'reply': this.body = ''; return this.go({ s: 'compose', row: st.row });
      case 'menu': return this.go({ s: 'menu', row: st.row });
      case 'discard': this.state = { s: 'confirm', row: st.row }; return;
      case 'reallydiscard':
        this.log('fake phone: draft DISCARDED');
        this.body = ''; this.backToEmail(st.row); return;
      case 'savedraft':
        this.drafts++; this.log('fake phone: draft SAVED');
        this.backToEmail(st.row); this.toast = 'Draft saved'; return;
      case 'send': {
        const r = this.inboxRows()[st.row];
        this.sent.push({ to: r.from, subject: `Re: ${r.subject}`, body: this.body });
        this.log(`fake phone: SENT reply to ${r.from}: ${JSON.stringify(this.body)}`);
        this.body = ''; this.backToEmail(st.row); this.toast = 'Sending…';
        return;
      }
      case 'back': {
        if (st.s === 'compose' && this.body) {
          // Gmail saves a draft silently when you back out of a compose with text in it.
          this.drafts++; this.log('fake phone: back out of compose, draft SAVED');
          this.body = ''; this.backToEmail(st.row); this.toast = 'Draft saved';
          return;
        }
        if (st.s === 'confirm') { this.state = { s: 'compose', row: st.row }; return; }
        if (st.s === 'home') return;
        this.state = this.stack.pop() || { s: 'home', page: 0 };
        this.toast = '';
        return;
      }
    }
  }
}

function publicNode(n, compact = false) {
  const o = { n: n.n, text: n.text, desc: n.desc, cls: n.cls, bounds: n.bounds, tap: n.tap, edit: n.edit, scroll: n.scroll };
  if (compact) for (const k of ['text', 'desc', 'cls', 'tap', 'edit', 'scroll']) if (o[k] === '' || o[k] === false) delete o[k];
  if (n.hint) o.hint = n.hint;
  if (n.focused) o.focused = true;
  if (n.viewId) o.id = n.viewId.split('/').pop();
  if (n.key) o.key = n.key;
  return o;
}
const cx = (n) => Math.floor((n.bounds[0] + n.bounds[2]) / 2);
const cy = (n) => Math.floor((n.bounds[1] + n.bounds[3]) / 2);
const norm = (s) => String(s || '').trim().toLowerCase();
function byText(nodes, query) {
  const q = norm(query);
  if (!q) return null;
  return nodes.find((n) => norm(n.text) === q || norm(n.desc) === q)
    || nodes.find((n) => norm(n.text).includes(q) || norm(n.desc).includes(q))
    || nodes.find((n) => norm(n.hint) === q)
    || nodes.find((n) => norm(n.hint).includes(q))
    || null;
}
function atPoint(nodes, x, y, pred = () => true) {
  let best = null, area = Infinity;
  for (const n of nodes) {
    const [l, t, r, b] = n.bounds;
    if (x >= l && x < r && y >= t && y < b && pred(n)) {
      const a = (r - l) * (b - t);
      if (a < area) { best = n; area = a; }
    }
  }
  return best;
}

/** Validates an act frame the way Protocol.parseAct does. Returns [act, null] or [null, detail]. */
export function parseAct(o) {
  const what = typeof o.do === 'string' ? o.do : '';
  if (!DOS.has(what)) return [null, `unknown do: '${what}'`];
  let on = null;
  if (o.on != null) {
    const t = o.on;
    if (typeof t !== 'object' || Array.isArray(t)) return [null, 'on must be an object'];
    if ('n' in t) { if (typeof t.n !== 'number') return [null, 'on.n must be a number']; on = { n: Math.trunc(t.n) }; }
    else if ('text' in t) { if (!String(t.text ?? '').trim()) return [null, 'on.text is empty']; on = { text: String(t.text) }; }
    else if ('x' in t && 'y' in t) { if (typeof t.x !== 'number' || typeof t.y !== 'number') return [null, 'on.x and on.y must be numbers']; on = { x: Math.trunc(t.x), y: Math.trunc(t.y) }; }
    else if ('id' in t) { if (!String(t.id ?? '').trim()) return [null, 'on.id is empty']; on = { id: String(t.id).trim() }; }
    else if ('key' in t) { if (!String(t.key ?? '').trim()) return [null, 'on.key is empty']; on = { key: String(t.key).trim() }; }
    else return [null, 'on needs n, text, x and y, id, or key'];
  }
  const s = (v) => (v == null || !String(v).trim() ? null : String(v).trim());
  const a = { do: what, on, text: o.text == null ? null : String(o.text), dir: o.dir || null, name: o.name || null, app: o.app || null, ms: o.ms,
    uri: s(o.uri), action: s(o.action), pkg: s(o.pkg), extras: o.extras ?? null, thenScreen: o.then_screen === true, compact: o.compact === true, fast: o.fast === true };
  if (what === 'open' && !a.uri && !a.action) return [null, 'open needs uri or action'];
  if (a.extras != null && (typeof a.extras !== 'object' || Array.isArray(a.extras))) return [null, 'extras must be an object'];
  if ('ms' in o && typeof o.ms !== 'number') return [null, 'ms must be a number'];
  if (['tap', 'long_press', 'point'].includes(what) && !on) return [null, `${what} needs on`];
  if (what === 'type' && a.text == null) return [null, 'type needs text'];
  if (what === 'swipe' && !DIRS.has(a.dir)) return [null, 'swipe needs dir: left, right, up or down'];
  if (what === 'key' && !KEYS.has(a.name)) return [null, `key needs name: ${[...KEYS].join(', ')}`];
  if (what === 'launch' && !String(a.app || '').trim()) return [null, 'launch needs app'];
  if (what === 'wait' && (typeof a.ms !== 'number' || a.ms < 0)) return [null, 'wait needs ms >= 0'];
  return [a, null];
}

/** The fake Hands: gets raw frames addressed to hands, answers through reply(text). */
export function makeFakeHands({ reply, phone, settleMs = 200, log = () => {} }) {
  let chain = Promise.resolve(); // one action at a time, like the real worker thread
  return (text) => {
    const o = parseObj(text);
    if (!o) return;
    const re = o.id == null ? undefined : String(o.id);
    if (o.type === 'cursor') { log(`fake hands: cursor ${o.show === false ? 'off' : 'on'}`); return; }
    if (o.type === 'screen') {
      const opts = { since: typeof o.since === 'string' ? o.since : null, compact: o.compact === true };
      chain = chain.then(() => new Promise((r) => setTimeout(() => { reply(JSON.stringify(phone.screen(re, opts))); r(); }, 30)));
      return;
    }
    if (o.type === 'caps') { setTimeout(() => reply(JSON.stringify(phone.caps(re))), 10); return; }
    if (o.type !== 'act') return;
    chain = chain.then(() => new Promise((r) => {
      let parsed = null;
      const res = (ok, error, detail) => {
        const out = { type: 'act_result', ...(re !== undefined ? { re } : {}), ok };
        if (!ok) out.error = error || 'bad_request';
        if (detail) { out.detail = detail; out.why = detail; }
        if (parsed && (parsed.do === 'launch' || parsed.do === 'open') && ok) out.app = phone.front();
        if (parsed?.thenScreen) { const { type, re: _re, ...body } = phone.screen(null, { compact: parsed.compact }); out.screen = body; }
        reply(JSON.stringify(out));
        r();
      };
      const [a, bad] = parseAct(o);
      if (!a) return setTimeout(() => res(false, 'bad_request', bad), 20);
      parsed = a;
      const delay = settleMs + (a.do === 'wait' ? a.ms : 0);
      setTimeout(() => {
        let err;
        try { err = phone.act(a); } catch (e) { err = ['timeout', String(e)]; }
        if (err) res(false, err[0], err[1]); else res(true);
      }, delay);
    }));
  };
}

// ---------------------------------------------------------------- server

/** Starts a fake hub. port 0 picks a free port. Resolves to {port, url, core, phone, close()}. */
export async function startFakeHub({ port = 8765, host = '127.0.0.1', token = 'dev', anyToken = false, sender, settleMs = 200, log = () => {} } = {}) {
  const phone = new FakePhone({ sender, log });
  let core;
  const hands = makeFakeHands({ reply: (t) => core.fromHands(t), phone, settleMs, log });
  core = new HubCore({ token, anyToken, toHands: hands, log });
  const wss = new WebSocketServer({ port, host });
  await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
  wss.on('connection', (ws, req) => {
    const conn = {
      send: (t) => ws.send(t),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.on('message', (data, isBinary) => { if (!isBinary) core.onMessage(conn, data.toString('utf8')); });
    ws.on('close', () => core.onClose(conn));
    ws.on('error', () => {});
    core.onOpen(conn, req.url || '/');
  });
  const actual = wss.address().port;
  return {
    port: actual,
    url: `ws://${host}:${actual}`,
    core,
    phone,
    notify(app, title, text) { core.fromHands(JSON.stringify({ type: 'notification', app, title, text, at: Date.now() })); },
    close: () => new Promise((res) => {
      core.closeAll();
      for (const c of wss.clients) { try { c.terminate(); } catch {} }
      wss.close(() => res());
    }),
  };
}

// ---------------------------------------------------------------- CLI

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
  const quiet = args.includes('--quiet');
  const log = (s) => { if (!quiet) console.log(`[fakehub ${new Date().toISOString().slice(11, 23)}] ${s}`); };
  const hub = await startFakeHub({
    port: Number(opt('--port', '8765')),
    token: opt('--token', process.env.HUB_TOKEN || 'dev'),
    anyToken: args.includes('--any-token'),
    sender: opt('--sender', process.env.HANDS_TEST_SENDER || 'Sarah Chen'),
    log,
  });
  console.log(`fakehub listening on ${hub.url} (token ${args.includes('--any-token') ? 'any' : JSON.stringify(hub.core.token)}); fake sender "${hub.phone.sender}"`);
  console.log('stdin: "notify <title>: <text>" pushes a Gmail notification; "state" prints the fake phone state');
  if (process.stdin.isTTY || !process.stdin.readableEnded) {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const l = line.trim();
      const m = l.match(/^notify\s+(.*?)(?::\s*(.*))?$/);
      if (m) { hub.notify(GMAIL, m[1], m[2] || ''); log(`notification pushed: ${m[1]}`); }
      else if (l === 'state') console.log(JSON.stringify({ state: hub.phone.state, sent: hub.phone.sent, drafts: hub.phone.drafts }));
    });
    rl.on('close', () => {}); // keep serving when stdin closes
  }
  const stop = async () => { await hub.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
