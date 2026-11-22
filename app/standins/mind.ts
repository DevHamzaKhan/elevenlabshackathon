// STAND-IN for bobby-mind, until mind/ exports startMind(config). It only proves the wiring:
// on wake it has Bobby say hello, and it echoes what it heard.
import type { MindConfig, Stoppable } from '../src/types';
import { connect } from './client';

export function startMind(config: MindConfig): Stoppable {
  const { log } = config;
  log(`stand-in Mind starting (${config.hints.length} hints, ${Object.keys(config.env).length} env vars)`);
  let n = 0;
  const hub = connect(config.hubUrl, 'mind', config.token, log, (m, send) => {
    if (m.type === 'peers') {
      log(`peers ${JSON.stringify(m)}`);
    } else if (m.type === 'wake') {
      send({ type: 'say', to: 'mouth', id: `s${++n}`, text: "Hi, I'm Bobby. My brain is a stand-in today." });
    } else if (m.type === 'heard') {
      send({ type: 'say', to: 'mouth', id: `s${++n}`, text: `You said: ${String(m.text)}` });
    } else {
      log(`got ${m.type}`);
    }
  });
  return { stop: () => hub.stop() };
}
