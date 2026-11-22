// STAND-IN for bobby-mouth, until mouth/ exports startMouth and startCaller. No voice:
// wake() tells the Mind Bobby is awake, every `say` is answered with say_done spoken:false,
// and every `call` fails, so nothing real is ever dialled.
import type { MouthHandle, PartConfig, Stoppable } from '../src/types';
import { connect } from './client';

export function startMouth(config: PartConfig): MouthHandle {
  const { log } = config;
  log('stand-in Mouth starting (no voice)');
  let awake = false;
  const hub = connect(config.hubUrl, 'mouth', config.token, log, (m, send) => {
    if (m.type === 'say') {
      log(`would say: ${String(m.text)}`);
      send({ type: 'say_done', re: m.id, spoken: false });
    } else if (m.type === 'sleep') {
      awake = false;
      send({ type: 'asleep' });
      log('asleep');
    } else if (m.type === 'whisper' || m.type === 'correct' || m.type === 'hush') {
      log(`got ${m.type}`);
    }
  });
  return {
    wake() {
      awake = true;
      log('wake');
      hub.send({ type: 'wake' });
    },
    stop() {
      if (awake) hub.send({ type: 'asleep' });
      hub.stop();
    },
  };
}

export function startCaller(config: PartConfig): Stoppable {
  const { log } = config;
  log('stand-in Caller starting (never dials)');
  const hub = connect(config.hubUrl, 'caller', config.token, log, (m, send) => {
    if (m.type === 'call') {
      log(`call request for ${String(m.number)}: refused (stand-in)`);
      send({ type: 'call_status', re: m.id, status: 'failed' });
      send({ type: 'call_result', re: m.id, ok: false, error: 'failed', summary: 'The Caller is a stand-in.' });
    }
  });
  return { stop: () => hub.stop() };
}
