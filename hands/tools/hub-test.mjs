#!/usr/bin/env node
// Routing test for the hub (CONTRACT.md "Connecting", "Routing", "Watch").
//
//   node hands/tools/hub-test.mjs --fake                 # starts fakehub.mjs itself on a random port
//   adb forward tcp:8765 tcp:8765 && node hands/tools/hub-test.mjs     # the real hub on the phone
//   node hands/tools/hub-test.mjs --url ws://127.0.0.1:8765
//
// URL: --url, else HUB_URL, else ws://127.0.0.1:8765. Token: HUB_TOKEN env, root .env, else "dev".
// Against the phone this connects its own mind/mouth/caller, which replaces (4001) any real
// Mind or Mouth that is connected: they will not reconnect until restarted.
// The hands checks (screen, bad act) only read the screen; nothing is tapped.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { hubToken, roleUrl, sleep } from './common.mjs';

const args = process.argv.slice(2);
const useFake = args.includes('--fake');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const TOKEN = hubToken();
let BASE = urlArg || process.env.HUB_URL || 'ws://127.0.0.1:8765';
let fake = null;
const open = new Set();

/** A test client: buffers every frame; next(pred) waits for the first unseen match. */
function client(role, { token = TOKEN, hello = true } = {}) {
  const ws = new WebSocket(roleUrl(BASE, role, token));
  const frames = [];
  const waiters = [];
  let closeInfo = null;
  let closeWaiters = [];
  const c = {
    role, ws, frames,
    opened: new Promise((res, rej) => {
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error(`${role}: could not connect to ${BASE}`)));
    }),
    send(o) { ws.send(JSON.stringify(o)); },
    /** Resolves with the first frame (after any already consumed) that matches. */
    next(pred, ms = 3000, what = 'frame') {
      return new Promise((res, rej) => {
        const idx = frames.findIndex((f) => !f.__used && pred(f));
        if (idx >= 0) { frames[idx].__used = true; return res(frames[idx]); }
        const w = { pred, res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${role}: no ${what} within ${ms} ms; got ${JSON.stringify(frames.map(strip)).slice(0, 600)}`)); }, ms) };
        waiters.push(w);
      });
    },
    /** Asserts nothing matching arrives within ms. */
    async none(pred, ms = 700, what = 'frame') {
      await sleep(ms);
      const bad = frames.find((f) => !f.__used && pred(f));
      assert.equal(bad, undefined, `${role}: unexpected ${what}: ${JSON.stringify(strip(bad || {}))}`);
    },
    closed(ms = 3000) {
      return new Promise((res, rej) => {
        if (closeInfo) return res(closeInfo);
        const t = setTimeout(() => rej(new Error(`${role}: socket not closed within ${ms} ms`)), ms);
        closeWaiters.push((ci) => { clearTimeout(t); res(ci); });
      });
    },
    close() { try { ws.close(1000); } catch {} },
    get isClosed() { return !!closeInfo; },
  };
  ws.addEventListener('message', (ev) => {
    let o; try { o = JSON.parse(String(ev.data)); } catch { return; }
    frames.push(o);
    for (const w of [...waiters]) {
      if (!o.__used && w.pred(o)) { o.__used = true; clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.res(o); }
    }
  });
  ws.addEventListener('close', (ev) => {
    closeInfo = { code: ev.code, reason: ev.reason };
    open.delete(c);
    for (const f of closeWaiters) f(closeInfo);
    closeWaiters = [];
  });
  if (hello) ws.addEventListener('open', () => c.send({ type: 'hello', role, v: 1 }));
  open.add(c);
  return c;
}
const strip = (f) => { const { __used, ...rest } = f; return rest; };
const is = (type, extra = {}) => (f) => f.type === type && Object.entries(extra).every(([k, v]) => JSON.stringify(f[k]) === JSON.stringify(v));
const welcome = (c) => c.next(is('welcome'), 3000, 'welcome');

/** Connects role and waits for welcome (and, for mind/watch, the first peers). */
async function joined(role) {
  const c = client(role);
  await c.opened;
  await welcome(c);
  return c;
}

function closeAll() { for (const c of [...open]) c.close(); }

const uid = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  if (useFake) {
    const { startFakeHub } = await import('./fakehub.mjs');
    fake = await startFakeHub({ port: 0, token: TOKEN, settleMs: 50 });
    BASE = fake.url;
  }
  console.log(`# hub ${BASE}${useFake ? ' (fakehub)' : ''}, token ${TOKEN === 'dev' ? '"dev"' : '(from env)'}`);
  // Preflight with a harmless watch socket, so a missing hub fails with one clear message.
  const probe = client('watch');
  try {
    await probe.opened;
    await welcome(probe);
  } catch (e) {
    throw new Error(`no hub at ${BASE} (${e.message}). On the phone: Hands accessibility service on, then adb forward tcp:8765 tcp:8765. Or run with --fake.`);
  } finally { probe.close(); }
});

after(async () => {
  closeAll();
  await sleep(100);
  if (fake) await fake.close();
});

test('wrong token is closed with 4003', async () => {
  const c = client('mind', { token: `wrong-${uid()}` });
  const ci = await c.closed(5000);
  assert.equal(ci.code, 4003);
});

test('unknown role is closed with 4003', async () => {
  const c = client('nobody');
  const ci = await c.closed(5000);
  assert.equal(ci.code, 4003);
});

test('hello gets welcome v1, and mind gets peers straight after', async () => {
  const m = client('mind');
  await m.opened;
  const w = await welcome(m);
  assert.deepEqual(strip(w), { type: 'welcome', v: 1 });
  const p = await m.next(is('peers'), 3000, 'peers');
  assert.equal(p.mind, true);
  assert.equal(typeof p.hands, 'boolean');
  for (const k of ['mouth', 'caller']) assert.equal(typeof p[k], 'boolean', `peers.${k}`);
  m.close(); await m.closed();
});

test('frames before hello are ignored (no welcome until hello)', async () => {
  const m = client('mind', { hello: false });
  await m.opened;
  m.send({ type: 'screen', to: 'hands', id: `x${uid()}` });
  await m.none(() => true, 500, 'frame before hello');
  m.send({ type: 'hello', role: 'mind', v: 1 });
  await welcome(m);
  m.close(); await m.closed();
});

test('a second mind closes the first with 4001; peers follow', async () => {
  const a = await joined('mind');
  const b = await joined('mind');
  const ci = await a.closed(3000);
  assert.equal(ci.code, 4001);
  const p = await b.next(is('peers'), 3000, 'peers');
  assert.equal(p.mind, true);
  b.close(); await b.closed();
});

test('mind -> mouth delivered unchanged; mouth -> mind delivered; watch gets wire copies and peers', async () => {
  const watch = await joined('watch');
  await watch.next(is('peers'), 3000, 'peers after welcome');
  const mind = await joined('mind');
  await watch.next((f) => f.type === 'peers' && f.mind === true, 3000, 'peers with mind');
  const mouth = await joined('mouth');
  await mind.next((f) => f.type === 'peers' && f.mouth === true, 3000, 'peers with mouth');
  await watch.next((f) => f.type === 'peers' && f.mouth === true, 3000, 'watch peers with mouth');

  const id = `m${uid()}`;
  const sayFrame = { type: 'say', to: 'mouth', id, text: "I'm looking for the word 'Reply'.", extra: { nested: [1, 2] } };
  mind.send(sayFrame);
  const got = await mouth.next(is('say', { id }), 3000, 'say');
  assert.deepEqual(strip(got), sayFrame, 'delivered unchanged');
  const wire1 = await watch.next((f) => f.type === 'wire' && f.msg?.id === id, 3000, 'wire copy of say');
  assert.equal(wire1.from, 'mind'); assert.equal(wire1.to, 'mouth');
  assert.equal(typeof wire1.at, 'number');
  assert.deepEqual(wire1.msg, sayFrame);

  const reply = { type: 'say_done', re: id };
  mouth.send(reply);
  const got2 = await mind.next(is('say_done', { re: id }), 3000, 'say_done');
  assert.deepEqual(strip(got2), reply);
  const wire2 = await watch.next((f) => f.type === 'wire' && f.msg?.re === id, 3000, 'wire copy of say_done');
  assert.equal(wire2.from, 'mouth'); assert.equal(wire2.to, 'mind');
  assert.deepEqual(wire2.msg, reply);

  // The mouth leaving shows up in peers for mind and watch.
  mouth.close(); await mouth.closed();
  await mind.next((f) => f.type === 'peers' && f.mouth === false, 3000, 'peers without mouth');
  await watch.next((f) => f.type === 'peers' && f.mouth === false, 3000, 'watch peers without mouth');

  // Watch is read-only: what it sends goes nowhere.
  watch.send({ type: 'heard', text: 'from watch' });
  await mind.none(is('heard', { text: 'from watch' }), 500, 'frame from watch');
  watch.close(); mind.close();
  await Promise.all([watch.closed(), mind.closed()]);
});

test('caller frames route both ways too', async () => {
  const mind = await joined('mind');
  const caller = await joined('caller');
  const id = `c${uid()}`;
  const call = { type: 'call', to: 'caller', id, number: '+14155550123', goal: 'test only, do not dial', context: 'hub-test' };
  // A real Caller would dial: only send this to our own test caller socket, which just echoes.
  mind.send(call);
  assert.deepEqual(strip(await caller.next(is('call', { id }), 3000, 'call')), call);
  caller.send({ type: 'call_result', re: id, ok: false, error: 'not_allowed' });
  const r = await mind.next(is('call_result', { re: id }), 3000, 'call_result');
  assert.equal(r.error, 'not_allowed');
  caller.close(); mind.close();
  await Promise.all([caller.closed(), mind.closed()]);
});

test('frames to watch go to every watch, not mirrored; a new watch gets the remembered task and plan', async () => {
  const mind = await joined('mind');
  const w1 = await joined('watch');
  const t = `t${uid()}`;
  const task = { type: 'task', to: 'watch', task: t, title: 'hub-test task', status: 'started' };
  const plan = { type: 'plan', to: 'watch', task: t, steps: [{ n: 1, do: 'Open Gmail', why: 'test' }] };
  const stepF = { type: 'step', to: 'watch', task: t, n: 1, status: 'running' };
  mind.send(task); mind.send(plan); mind.send(stepF);
  assert.deepEqual(strip(await w1.next(is('task', { task: t }), 3000, 'task')), task);
  assert.deepEqual(strip(await w1.next(is('plan', { task: t }), 3000, 'plan')), plan);
  assert.deepEqual(strip(await w1.next(is('step', { task: t }), 3000, 'step')), stepF);
  await w1.none((f) => f.type === 'wire' && f.msg?.task === t, 400, 'wire copy of a watch frame');

  const w2 = await joined('watch');
  const t2 = await w2.next(is('task', { task: t }), 3000, 'remembered task');
  assert.deepEqual(strip(t2), task);
  assert.deepEqual(strip(await w2.next(is('plan', { task: t }), 3000, 'remembered plan')), plan);
  await w2.next(is('peers'), 3000, 'peers');
  // Order: welcome, task, plan (then peers).
  const order = w2.frames.map((f) => f.type).filter((x) => ['welcome', 'task', 'plan'].includes(x));
  assert.deepEqual(order.slice(0, 3), ['welcome', 'task', 'plan']);

  // Once the task is done, a new watch gets nothing remembered.
  mind.send({ ...task, status: 'done' });
  await w1.next((f) => f.type === 'task' && f.task === t && f.status === 'done', 3000, 'task done');
  const w3 = await joined('watch');
  await w3.next(is('peers'), 3000, 'peers');
  await w3.none((f) => f.type === 'task' || f.type === 'plan', 400, 'remembered task after done');
  for (const c of [w1, w2, w3, mind]) c.close();
  await Promise.all([w1, w2, w3, mind].map((c) => c.closed()));
});

test('frames to a part that is not connected are dropped (no wire copy, no late delivery)', async () => {
  const watch = await joined('watch');
  const mind = await joined('mind');
  await mind.next(is('peers'), 3000, 'peers');
  const peers = await (async () => { await sleep(200); return [...mind.frames].reverse().find(is('peers')); })();
  if (peers.caller) {
    // A real Caller is connected; it would receive this. Skip rather than message it.
    console.log('# caller is connected on this hub: skipping the dropped-frame check for caller');
  } else {
    const id = `d${uid()}`;
    mind.send({ type: 'call', to: 'caller', id, number: '+10000000000', goal: 'must be dropped' });
    await watch.none((f) => f.type === 'wire' && f.msg?.id === id, 500, 'wire copy of a dropped frame');
    const caller = await joined('caller');
    await caller.none((f) => f.type === 'call' && f.id === id, 500, 'late delivery of a dropped frame');
    caller.close(); await caller.closed();
  }
  // From a part to a missing mind: dropped too.
  mind.close(); await mind.closed();
  const mouth = await joined('mouth');
  const id2 = `h${uid()}`;
  mouth.send({ type: 'heard', text: id2 });
  await watch.none((f) => f.type === 'wire' && f.msg?.text === id2, 500, 'wire copy of a frame to a missing mind');
  const mind2 = await joined('mind');
  await mind2.none((f) => f.type === 'heard' && f.text === id2, 500, 'late delivery to mind');
  // Unknown `to` is dropped as well.
  mind2.send({ type: 'whatever', to: 'nowhere', id: id2 });
  await watch.none((f) => f.type === 'wire' && f.msg?.to === 'nowhere', 400, 'wire copy for unknown to');
  for (const c of [mouth, mind2, watch]) c.close();
  await Promise.all([mouth, mind2, watch].map((c) => c.closed()));
});

test('mind -> hands screen gets a screen_result with the same re (and both are mirrored)', async () => {
  const watch = await joined('watch');
  const mind = await joined('mind');
  const p = await mind.next(is('peers'), 3000, 'peers');
  assert.equal(p.hands, true, 'hands must be on (accessibility service enabled)');
  const id = `s${uid()}`;
  mind.send({ type: 'screen', to: 'hands', id });
  const r = await mind.next(is('screen_result', { re: id }), 10000, 'screen_result');
  assert.equal(typeof r.app, 'string');
  assert.ok(Array.isArray(r.size) && r.size.length === 2, 'size is [w, h]');
  assert.ok(Array.isArray(r.nodes), 'nodes is a list');
  for (const n of r.nodes.slice(0, 50)) {
    assert.equal(typeof n.n, 'number');
    for (const k of ['text', 'desc', 'cls']) assert.equal(typeof n[k], 'string', `node.${k}`);
    assert.ok(Array.isArray(n.bounds) && n.bounds.length === 4, 'bounds');
    for (const k of ['tap', 'edit', 'scroll']) assert.equal(typeof n[k], 'boolean', `node.${k}`);
  }
  const wIn = await watch.next((f) => f.type === 'wire' && f.msg?.id === id, 3000, 'wire mind->hands');
  assert.equal(wIn.from, 'mind'); assert.equal(wIn.to, 'hands');
  const wOut = await watch.next((f) => f.type === 'wire' && f.msg?.re === id, 3000, 'wire hands->mind');
  assert.equal(wOut.from, 'hands'); assert.equal(wOut.to, 'mind');
  assert.equal(wOut.msg.type, 'screen_result');
  watch.close(); mind.close();
  await Promise.all([watch.closed(), mind.closed()]);
});

test('act with an unknown do gets act_result ok:false error bad_request', async () => {
  const mind = await joined('mind');
  const id = `a${uid()}`;
  mind.send({ type: 'act', to: 'hands', id, do: 'fly', on: { text: 'Reply' } });
  const r = await mind.next(is('act_result', { re: id }), 10000, 'act_result');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_request');
  // A malformed target is a bad_request too (point would touch nothing anyway).
  const id2 = `b${uid()}`;
  mind.send({ type: 'act', to: 'hands', id: id2, do: 'point', on: {} });
  const r2 = await mind.next(is('act_result', { re: id2 }), 10000, 'act_result');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'bad_request');
  mind.close(); await mind.closed();
});
