#!/usr/bin/env node
// Sends every line of the root .env to the Bobby app over USB. No typing on the phone.
// The app stores the values in secure storage on the phone; nothing goes into the build.
//
//   node tools/push-config.mjs                 # uses ../.env and the only/first adb device
//   node tools/push-config.mjs --env path/.env --serial R3CR704ZX1K
//   node tools/push-config.mjs --dry           # print the names it would send, send nothing
//
// How: the .env text is base64url-encoded and sent as one or more bobby://config deep links
// with `adb shell am start`. Values are never printed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const envPath = path.resolve(opt('--env') || path.join(here, '../../.env'));
const serial = opt('--serial') || process.env.ANDROID_SERIAL;
const dry = args.includes('--dry');
const CHUNK = 1800; // keeps each adb shell command well under the length limits

if (!fs.existsSync(envPath)) {
  console.error(`push-config: no ${envPath}`);
  process.exit(1);
}
let text = fs.readFileSync(envPath, 'utf8');
// Laptop tools (drive.mjs, the dashboard) and the phone must share HUB_TOKEN, so make sure
// the root .env has one before sending it.
if (!/^\s*(?:export\s+)?HUB_TOKEN\s*=\s*\S/m.test(text) && !dry) {
  const token = crypto.randomBytes(24).toString('hex');
  text = `${text.replace(/\n?$/, '\n')}HUB_TOKEN=${token}\n`;
  fs.writeFileSync(envPath, text);
  console.log(`push-config: added a new HUB_TOKEN to ${envPath}`);
}
const names = text
  .split(/\r?\n/)
  .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
  .filter(Boolean);
console.log(`push-config: ${names.length} settings from ${envPath}: ${names.join(', ')}`);
if (dry) process.exit(0);

const data = Buffer.from(text, 'utf8').toString('base64url');
const parts = [];
for (let i = 0; i < data.length; i += CHUNK) parts.push(data.slice(i, i + CHUNK));
if (parts.length === 0) parts.push('');
const id = crypto.randomBytes(4).toString('hex');

const adb = (...a) => execFileSync('adb', [...(serial ? ['-s', serial] : []), ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < parts.length; i++) {
  const url = `bobby://config?id=${id}&part=${i + 1}&of=${parts.length}&data=${parts[i]}`;
  // The remote shell parses the command line: quote the URL so & is not a shell operator.
  const out = adb(
    'shell',
    `am start -W -a android.intent.action.VIEW -n dev.bobby.app/.MainActivity -d '${url}'`,
  );
  if (/Error/i.test(out)) {
    console.error(out.trim());
    process.exit(1);
  }
  await sleep(800);
}
console.log(`push-config: sent in ${parts.length} link(s). The app's settings screen lists the names.`);
