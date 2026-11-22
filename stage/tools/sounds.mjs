// Writes Bobby's sound effects as small 16-bit mono WAV files in stage/sounds/.
//   node tools/sounds.mjs
// Each sound is a few soft sine notes with a bell-like envelope, so there are no
// licensing questions and anyone can retune them here.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 22050;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "sounds");
mkdirSync(out, { recursive: true });
const hz = (note) => 440 * 2 ** ((note - 69) / 12);   // MIDI note number -> frequency

// notes: [midi, startSeconds, lengthSeconds, gain]
function render(notes, wave = "sine") {
  const total = Math.max(...notes.map(([, s, l]) => s + l)) + 0.05;
  const buf = new Float32Array(Math.ceil(total * RATE));
  for (const [note, start, len, gain = 1] of notes) {
    const f = hz(note), s0 = Math.floor(start * RATE), n = Math.floor(len * RATE);
    for (let i = 0; i < n && s0 + i < buf.length; i++) {
      const t = i / RATE;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 5.5 / len);   // fast attack, smooth decay
      let v = Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t) + 0.08 * Math.sin(6 * Math.PI * f * t);
      if (wave === "soft-square") v = Math.tanh(2.2 * Math.sin(2 * Math.PI * f * t)) * 0.8;
      buf[s0 + i] += v * env * gain;
    }
  }
  const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const pcm = Buffer.alloc(44 + buf.length * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + buf.length * 2, 4); pcm.write("WAVE", 8);
  pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) pcm.writeInt16LE(Math.round((buf[i] / peak) * 0.6 * 32767), 44 + i * 2);
  return pcm;
}

const sounds = {
  // Bobby wakes up: a bright rising fifth.
  "wake.wav": render([[76, 0, 0.35, 0.8], [83, 0.11, 0.55, 1]]),
  // Task done: a quick major arpeggio.
  "done.wav": render([[72, 0, 0.3, 0.8], [76, 0.09, 0.3, 0.85], [79, 0.18, 0.6, 1]]),
  // Task failed: two soft falling notes, gentle rather than alarming.
  "failed.wav": render([[69, 0, 0.32, 1], [65, 0.16, 0.55, 0.9]], "soft-square"),
};
for (const [name, data] of Object.entries(sounds)) {
  writeFileSync(join(out, name), data);
  console.log(`sounds/${name} ${(data.length / 1024).toFixed(1)} KB`);
}
