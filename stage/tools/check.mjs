// Checks for Stage that need no person. Run from stage/: node tools/check.mjs
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";

let failures = 0;
const fail = (m) => { failures++; console.error("FAIL " + m); };
const ok = (m) => console.log("ok   " + m);

// 1. story.jsonl: valid JSON, known watch types, known wire message types.
const WATCH = new Set(["wire", "task", "plan", "step", "peers"]);
const WIRE = new Set(["screen", "screen_result", "act", "act_result", "cursor", "notification",
  "wake", "heard", "spoke", "say_started", "say_done", "asleep",
  "whisper", "say", "correct", "hush", "sleep", "call", "call_status", "call_result"]);
const PARTS = new Set(["mind", "hands", "mouth", "caller"]);
const lines = readFileSync("dashboard/story.jsonl", "utf8").split("\n");
let count = 0;
lines.forEach((line, i) => {
  if (!line.trim()) return;
  const where = `story.jsonl:${i + 1}`;
  let m;
  try { m = JSON.parse(line); } catch (e) { return fail(`${where} bad JSON: ${e.message}`); }
  count++;
  if (!WATCH.has(m.type)) return fail(`${where} unknown type ${m.type}`);
  if (m.type === "wire") {
    if (!PARTS.has(m.from) || !PARTS.has(m.to)) fail(`${where} wire from/to must be mind|hands|mouth|caller`);
    if (!m.msg || !WIRE.has(m.msg.type)) fail(`${where} unknown wire msg type ${m.msg?.type}`);
    if (m.from === "mind" && m.msg?.to !== m.to) fail(`${where} Mind frame must carry to=${m.to}`);
    if (m.msg?.type === "act" && m.msg.on && Object.keys(m.msg.on).sort().join() !== "text"
        && Object.keys(m.msg.on).sort().join() !== "n" && Object.keys(m.msg.on).sort().join() !== "x,y")
      fail(`${where} act target must be one of {n} {text} {x,y}`);
  }
  if (["task", "plan", "step"].includes(m.type) && m.to !== "watch") fail(`${where} ${m.type} must carry to=watch`);
});
ok(`story.jsonl: ${count} messages checked`);

// 2. cursors: well-formed vector drawable, 48dp, 48x48 viewport.
const dirs = readdirSync("cursor").filter((d) => statSync(`cursor/${d}`).isDirectory());
for (const d of dirs) {
  const f = `cursor/${d}/cursor.xml`;
  if (!existsSync(f)) { fail(`${f} missing`); continue; }
  const x = readFileSync(f, "utf8");
  const want = ['android:width="48dp"', 'android:height="48dp"', 'android:viewportWidth="48"', 'android:viewportHeight="48"'];
  const missing = want.filter((w) => !x.includes(w));
  if (!/<vector[\s>]/.test(x) || !/<\/vector>\s*$/.test(x)) fail(`${f} is not a <vector> drawable`);
  else if (missing.length) fail(`${f} missing ${missing.join(" ")}`);
  else ok(`${f} 48dp, 48x48`);
}
const chosen = existsSync("cursor/CHOSEN") ? readFileSync("cursor/CHOSEN", "utf8").trim() : "";
if (!chosen || !dirs.includes(chosen)) fail(`cursor/CHOSEN names "${chosen}", not a cursor folder`);
else ok(`cursor/CHOSEN = ${chosen}`);

// 3. hints required by the brief.
for (const h of ["home.md", "gmail.md", "TO-CHECK.md"]) existsSync(`hints/${h}`) ? ok(`hints/${h}`) : fail(`hints/${h} missing`);

process.exit(failures ? 1 : 0);
