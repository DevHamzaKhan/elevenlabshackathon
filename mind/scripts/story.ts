// npm run story: the whole demo against the fakes, with the real model.
// Starts the fake hub + phone, the Mind, the fake Caller and the fake Mouth in one process, plays
// "what did I miss?", "reply to Sarah and tell her 3 works", "call Alex and tell him I'm running late",
// then a task interrupted by "stop", and prints PASS or FAIL plus the log path.
// Flags: --flaky [--flaky-rate 0.3] (fake phone sometimes fails or shows a pop-up), --port N, --only email|call|stop|digest

import { startMind } from "../src/index";
import { startFakeHub } from "../fakes/hub";
import { startFakeMouth } from "../fakes/mouth";
import { startFakeCaller } from "../fakes/caller";
import { loadEnv, loadHints, openLog, redact } from "./env";

const argv = process.argv;
const flag = (n: string) => argv.includes(n);
const arg = (n: string) => (argv.indexOf(n) > 0 ? argv[argv.indexOf(n) + 1] : undefined);
const port = Number(arg("--port") ?? 8790);
const only = arg("--only");
const url = (role: string) => `ws://localhost:${port}/${role}?token=story`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = loadEnv();
if (!/(^|,)\s*Alex=/.test(env.CONTACTS ?? "")) {
  // Invented contact for the fake call; the fake Caller dials nothing.
  env.CONTACTS = ["Alex=+14155550123", env.CONTACTS].filter(Boolean).join(",");
}
const hints = loadHints(env.HINTS_DIR);
const { file, log } = openLog("story", (l) => /^(mind: (say|task|whisper|correct|sleep)|USER|BOBBY|phone: (EMAIL|tap|type|swipe|key|launch)|CALL|call )/.test(l));

console.log(`story: log ${file}`);
console.log(`story: key ${redact(env.ANTHROPIC_API_KEY)}, ${hints.length} hint files${flag("--flaky") ? ", flaky phone" : ""}`);
if (!env.ANTHROPIC_API_KEY) {
  console.log("story: FAIL (no ANTHROPIC_API_KEY in the root .env)");
  process.exit(1);
}

const hub = startFakeHub({ port, log: (s) => log(s), flaky: flag("--flaky") ? Number(arg("--flaky-rate") ?? 0.12) : false });
await hub.ready;
const t0 = Date.now();
const mind = startMind({ hubUrl: `ws://localhost:${port}`, token: "story", env, hints, log });
const caller = startFakeCaller({ url: url("caller"), log, stepMs: 1500 });
await sleep(800);

hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
hub.notify("com.whatsapp", "Mum", "Call me when you get a chance x");
hub.notify("com.google.android.calendar", "Team sync", "Starts in 30 minutes");
await sleep(300);

const mouth = startFakeMouth({ url: url("mouth"), log, msPerChar: 35 });
await sleep(1500);

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const tasksOf = () => hub.watched.filter((m) => m.type === "task");
async function waitTaskEnd(sinceCount: number, ms: number): Promise<any | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = tasksOf().slice(sinceCount).find((m) => m.status !== "started");
    if (t) return t;
    await sleep(250);
  }
  return null;
}
const mouthGot = (type: string) => mouth.received.filter((m) => m.type === type);
async function quiet(ms = 1500) {
  // Let Bobby finish talking.
  await sleep(ms);
}

// 1. Notification digest on wake, and "what did I miss?"
if (!only || only === "digest") {
  const digest = mouthGot("whisper").find((w) => /Sarah Chen/.test(w.text) && /notification/i.test(w.text));
  check("digest on wake", !!digest, digest ? digest.text : "no whisper with the notifications after wake");
  const before = mouthGot("whisper").length;
  mouth.hear("what did I miss?");
  await sleep(9000);
  const after = mouthGot("whisper").slice(before);
  const tasksStarted = tasksOf().filter((t) => t.status === "started").length;
  check(
    "what did I miss? is chat",
    tasksStarted === 0,
    after.length ? `whispered: ${after.map((w) => w.text).join(" | ")}` : "no task started (Bobby answers from the wake digest)",
  );
}

// 2. The email story.
if (!only || only === "email") {
  const n = tasksOf().length;
  const tStart = Date.now();
  mouth.hear("reply to Sarah and tell her 3 works");
  const end = await waitTaskEnd(n, 150_000);
  const sent = hub.phone.sent;
  const says = mouthGot("say").map((s) => s.text);
  check(
    "email task done",
    !!end && end.status === "done",
    end ? `${end.title}: ${end.status} in ${Math.round((Date.now() - tStart) / 1000)} s, ${hub.phone.actsDone} actions so far` : "task did not finish",
  );
  check("email sent on the fake phone", !!sent && /\b3\b|three/i.test(sent.text), sent ? `"${sent.text}"` : "nothing sent");
  check("narration has reasons", says.some((s) => /\b(so|to|because)\b/i.test(s)), `${says.length} lines spoken`);
  await quiet(4000);
}

// 3. The call.
if (!only || only === "call") {
  const before = mouthGot("say").length;
  mouth.hear("call Alex and tell him I'm running late");
  const endBy = Date.now() + 60_000;
  let summary: any = null;
  while (Date.now() < endBy && !summary) {
    summary = mouthGot("say").slice(before).find((s) => /3:20|spoke to Alex/i.test(s.text));
    await sleep(300);
  }
  check("call placed", caller.calls.length > 0, caller.calls[0] ? `to ${caller.calls[0].number}: ${caller.calls[0].goal}` : "no call reached the Caller");
  check("call summary spoken", !!summary, summary ? summary.text : "no say with the call summary");
  await quiet(4000);
}

// 4. A task cancelled with "stop".
if (!only || only === "stop") {
  hub.phone.reset();
  const n = tasksOf().length;
  mouth.hear("open Spotify");
  // Wait for the first action, then stop.
  const acts0 = hub.phone.actsDone;
  const endBy = Date.now() + 40_000;
  while (Date.now() < endBy && hub.phone.actsDone === acts0) await sleep(200);
  const tStop = Date.now();
  mouth.hear("stop");
  const end = await waitTaskEnd(n, 20_000);
  const stoppedAt = Date.now();
  const actsAtStop = hub.phone.actsDone;
  await sleep(4000);
  const hushed = mouthGot("hush").length > 0;
  check(
    "stop cancels the task",
    !!end && end.status === "cancelled" && hushed && hub.phone.actsDone <= actsAtStop + 1,
    end ? `${end.status} ${Math.round((stoppedAt - tStop) / 100) / 10} s after "stop", hush ${hushed ? "sent" : "missing"}` : "task not cancelled",
  );
}

const pass = results.every((r) => r.ok);
console.log(`\nstory: ${pass ? "PASS" : "FAIL"} (${results.filter((r) => r.ok).length}/${results.length} checks, ${Math.round((Date.now() - t0) / 1000)} s)`);
console.log(`story: log ${file}`);
mouth.close();
caller.close();
mind.stop();
await hub.close();
process.exit(pass ? 0 : 1);
