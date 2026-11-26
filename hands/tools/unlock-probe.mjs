#!/usr/bin/env node
// hands/tools/unlock-probe.mjs: asks Hands whether it can see the lock screen's PIN keypad.
// Read-only: Hands wakes the screen and may swipe up to show the keypad, but never types,
// never reads the stored PIN and never uses the lock session's unlock attempt.
//
//   node hands/tools/unlock-probe.mjs [--url ws://127.0.0.1:8765]
//
// Connects as the Mind (so stop the app's Mind first, or it gets replaced), after
// `adb forward tcp:8765 tcp:8765`. Prints the `unlock_probe_result` and exits 0 when a full
// keypad was found on a locked phone.
import { hubToken, roleUrl } from './common.mjs';

const i = process.argv.indexOf('--url');
const BASE = i > 0 ? process.argv[i + 1] : 'ws://127.0.0.1:8765';
const ws = new WebSocket(roleUrl(BASE, 'mind', hubToken()));
const give = setTimeout(() => { console.log('no answer in 15 s'); process.exit(1); }, 15000);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'mind', v: 1 }));
  setTimeout(() => ws.send(JSON.stringify({ type: 'unlock_probe', to: 'hands', id: 'probe-1' })), 300);
});
ws.addEventListener('message', (ev) => {
  let o;
  try { o = JSON.parse(String(ev.data)); } catch { return; }
  if (o.type !== 'unlock_probe_result') return;
  clearTimeout(give);
  console.log(JSON.stringify(o));
  ws.close();
  process.exit(o.locked && o.keypad ? 0 : 1);
});
ws.addEventListener('close', (ev) => {
  if (ev.code === 4003) { console.log('hub refused the token'); process.exit(2); }
});
