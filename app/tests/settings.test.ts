// Pure helpers from src/settings.ts (secure-store calls are not exercised here).
// Run: npx tsx --test tests/settings.test.ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// expo-secure-store / expo-crypto are native; stub them so the module loads in Node.
const load = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
mock.method(Module as never, '_load', (req: string, ...a: unknown[]) =>
  req === 'expo-secure-store' || req === 'expo-crypto' ? {} : load(req, ...a),
);

test('parseEnv and decodeBase64Url', async () => {
  const { parseEnv, decodeBase64Url } = await import('../src/settings');
  const text = '# c\nA=1\nexport B="two words"\nC=x # note\n\nD=é✓\nbad line\n';
  const env = parseEnv(decodeBase64Url(Buffer.from(text).toString('base64url')));
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: 'é✓' });
});
