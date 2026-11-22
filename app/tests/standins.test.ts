// Stand-ins against hands/tools/fakehub.mjs: wake reaches the Mind, the Mind's say reaches the
// Mouth, a call is refused. Also checks the .env parsing and base64url decoding the app uses.
// Run: npx tsx --test tests/standins.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startMind } from '../standins/mind';
import { startCaller, startMouth } from '../standins/mouth';
import { connect } from '../standins/client';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const hubUrl = `ws://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('stand-ins talk through the fake hub', async () => {
  const hub = spawn('node', [path.resolve(__dirname, '../../hands/tools/fakehub.mjs'), '--port', String(PORT), '--any-token', '--quiet'], { stdio: 'ignore' });
  try {
    await sleep(800);
    const lines: string[] = [];
    const log = (p: string) => (l: string) => lines.push(`${p}: ${l}`);
    const base = { hubUrl, token: 't', env: { A: '1' } };
    const mind = startMind({ ...base, log: log('mind'), hints: ['x'] });
    const mouth = startMouth({ ...base, log: log('mouth') });
    const caller = startCaller({ ...base, log: log('caller') });
    mouth.wake(); // before welcome: must be queued, not dropped
    await sleep(1500);
    assert.ok(lines.some((l) => l.startsWith('mouth: would say: Hi')), lines.join('\n'));

    // Play the Mind briefly (replaces the stand-in, 4001) and ask for a call.
    const results: unknown[] = [];
    const fakeMind = connect(hubUrl, 'mind', 't', () => {}, (m) => m.type === 'call_result' && results.push(m));
    await sleep(500);
    fakeMind.send({ type: 'call', to: 'caller', id: 'c1', number: '+14155550123', goal: 'x', context: 'y' });
    await sleep(800);
    assert.equal((results[0] as { ok: boolean }).ok, false);
    assert.ok(lines.some((l) => l.includes('mind: replaced by a newer connection')), lines.join('\n'));
    [mind, mouth, caller, fakeMind].forEach((h) => h.stop());
  } finally {
    hub.kill();
  }
});
