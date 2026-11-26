// npm run teach:phone: teaching by showing against a REAL phone or emulator (Hands on the device,
// its hub reached through `adb forward`), with the Mind and a pretend Mouth on this laptop.
// The "user" is adb: real touches and key presses injected with `adb shell input`, so what Hands
// records is what its accessibility service really sees. The demo adds a contact in Google
// Contacts; then Bobby is asked to add another one and has to do it from what he learned.
//
//   --name Zed        the contact Bobby is asked to add (default: a random 4-letter name)
//   --real            use the real OpenAI models for the teach and router calls (needs OPENAI_API_KEY);
//                     by default the scripted fake stands in, so no key is needed
//   --hub ws://localhost:8765   --token dev   (the Hands test app's token is "dev")
// It leaves two contacts on the device. Nothing is sent anywhere.

import { execFileSync } from "node:child_process";
import { startMind } from "../src/index";
import { makeModel, modelOptionsFromEnv } from "../src/model";
import { InMemoryStore } from "../src/memory";
import { startFakeMouth } from "../fakes/mouth";
import { fakeOpenAI } from "../fakes/openai";
import { loadEnv, openLog } from "./env";

const argv = process.argv;
const flag = (n: string) => argv.includes(n);
const arg = (n: string) => (argv.indexOf(n) > 0 ? argv[argv.indexOf(n) + 1] : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hubUrl = arg("--hub") ?? "ws://localhost:8765";
const token = arg("--token") ?? "dev";
const real = flag("--real");
const taught = "Testy";
const asked = arg("--name") ?? "Z" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4);
const CONTACTS = "com.google.android.contacts";

const adb = (...a: string[]) => execFileSync("adb", a, { encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/Library/Android/sdk/platform-tools:${process.env.PATH}` } }).trim();
const env = loadEnv();
const { file, log } = openLog("teach-phone", (l) => /^(mind: (teaching|progress|task|queued|local|"|taught|act )|skills:|script:|USER)/.test(l));
console.log(`teach-phone: log ${file}`);
if (real && !env.OPENAI_API_KEY) {
  console.log("teach-phone: FAIL (--real needs OPENAI_API_KEY in the root .env)");
  process.exit(1);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};
async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(50);
  return cond();
}

try {
  adb("forward", "tcp:8765", "tcp:8765");
} catch (e) {
  console.log(`teach-phone: FAIL (adb: ${String(e).split("\n")[0]})`);
  process.exit(1);
}

const ai = fakeOpenAI();
const calls: Record<string, number> = {};
const inner = makeModel({ ...modelOptionsFromEnv(env), log, ...(real ? {} : { apiKey: "sk-fake", fetch: ai.fetch }) });
const mind = startMind({
  hubUrl,
  token,
  env: { ...env, MIND_CONFIRM: "never" },
  log,
  hints: [],
  storage: new InMemoryStore(),
  model: async (req) => {
    calls[req.purpose] = (calls[req.purpose] ?? 0) + 1;
    return inner(req);
  },
});
const brain = mind.brain;
const mouth = startFakeMouth({ url: `${hubUrl}/mouth?token=${token}`, log, msPerChar: 0, v2: true });

function contactNames(): string[] {
  const out = adb("shell", "content", "query", "--uri", "content://com.android.contacts/contacts", "--projection", "display_name");
  return out.split("\n").map((l) => /display_name=(.*)$/.exec(l.trim())?.[1] ?? "").filter(Boolean);
}

/** A finger: finds the control by its label on the live screen and taps its centre through adb. */
async function userTap(label: string) {
  for (let i = 0; i < 20; i++) {
    const s = await brain.readScreen();
    const q = label.toLowerCase();
    const n = (s?.nodes ?? []).find((x: any) => [x.text, x.desc, x.hint].some((l) => String(l ?? "").toLowerCase() === q));
    if (n) {
      const [l, t, r, b] = n.bounds;
      adb("shell", "input", "tap", String(Math.round((l + r) / 2)), String(Math.round((t + b) / 2)));
      log(`USER (adb) taps "${label}"`);
      await sleep(1200);
      return;
    }
    await sleep(300);
  }
  throw new Error(`"${label}" never showed up on the phone`);
}

async function main() {
  if (!(await until(() => brain.peers.hands, 8000))) throw new Error("no Hands on the hub (is the accessibility service on and the port forwarded?)");
  await sleep(500);
  check("Hands can observe", (brain.caps?.features ?? []).includes("observe"), `features: ${(brain.caps?.features ?? []).join(", ") || "none reported"}`);
  // Start like someone opening Contacts cold: wherever an earlier run left it doesn't matter.
  adb("shell", "am", "force-stop", CONTACTS);
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(800);

  // ---- the lesson ----
  mouth.teach("start", "add a new contact", `I'm going to show you how to add a new contact. I'll type ${taught} as the name.`);
  if (!(await until(() => brain.teaching?.phase === "watching", 5000))) throw new Error("the Mind never started watching");
  // The user opens Contacts (started by intent here: finding its icon is the launcher's business).
  const activity = adb("shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", CONTACTS).split("\n").pop()!.trim();
  adb("shell", "am", "start", "-n", activity);
  await sleep(2500);
  await userTap("Create contact");
  await userTap("First name");
  adb("shell", "input", "text", taught);
  log(`USER (adb) types "${taught}"`);
  await sleep(1500);
  await userTap("Save");
  await sleep(2000);
  const frames = brain.teaching?.events ?? [];
  const kinds = frames.map((e) => e.kind).join(" ");
  mouth.teach("done", "", "okay, done");
  await until(() => brain.skills.all().length === 1, 30_000);
  await brain.teachDone;
  const skill = brain.skills.all()[0];
  check("Hands reported the demo", /tap/.test(kinds) && /type/.test(kinds), `${frames.length} frames: ${kinds}`);
  if (!skill) throw new Error("no skill came out of the demo");
  const steps = skill.parts.flatMap((p) => p.steps);
  console.log(`skill ${skill.id} "${skill.title}", slots ${JSON.stringify(skill.slots.map((s) => [s.name, s.example]))}`);
  for (const [i, s] of steps.entries()) console.log(`  ${i + 1}. ${s.label}   want ${JSON.stringify({ ...s.want, at: undefined })}   expect ${JSON.stringify(s.expect)}`);
  check("the demo became steps with a slot", steps.some((s) => s.act.do === "type" && /\{\{\w+\}\}/.test(String(s.act.text))), steps.map((s) => s.label).join("; "));

  // ---- later: "add a contact called ..." ----
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1000);
  const before = { ...calls };
  const contactsBefore = contactNames().length;
  const t0 = Date.now();
  mouth.request(`add a contact called ${asked}`);
  let finished: any = null;
  await until(() => !!(finished = brain.memory.outcomes.find((o) => o.title === skill.title)), 60_000);
  const ms = Date.now() - t0;
  await sleep(800);
  const screen = await brain.readScreen();
  let seen = (screen?.nodes ?? []).some((n: any) => [n.text, n.desc].some((l) => String(l ?? "").includes(asked)));
  // The proof that doesn't depend on how the screen is read: the contact is in the phone's database.
  const rows = contactNames();
  const stored = rows.filter((n) => n === asked).length;
  console.log(`contacts on the phone: ${rows.join(", ")} (${rows.length - contactsBefore} more than before the request)`);
  // Exactly one new contact, with the name asked for, and the one from the demo untouched.
  seen = seen && stored >= 1 && rows.length === contactsBefore + 1 && rows.includes(taught);
  const used = Object.fromEntries(Object.keys(calls).map((k) => [k, calls[k] - (before[k] ?? 0)]).filter(([, v]) => v));
  check("Bobby did it from what he was shown", finished?.status === "done" && seen, `${finished?.status ?? "never finished"} in ${ms} ms; "${asked}" ${seen ? "is" : "is NOT"} on screen; model calls: ${JSON.stringify(used)}; from the script: ${brain.stats.script}, executor calls: ${brain.stats.exec}`);
}

let code = 0;
try {
  await main();
} catch (e) {
  console.log(`teach-phone: ERROR ${String((e as any)?.message ?? e)}`);
  code = 1;
}
mouth.close();
mind.stop();
const failed = results.filter((r) => !r.ok).length;
console.log(`teach-phone: ${failed || code ? "FAIL" : "PASS"} (${results.length - failed}/${results.length})`);
setTimeout(() => process.exit(failed || code ? 1 : 0), 300);
