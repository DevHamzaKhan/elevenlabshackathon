// npm run story: the whole demo against the fakes (hub + phone at real speed, v2 Mouth, Caller).
//   --sim            scripted fake OpenAI with simulated latencies (no key needed). Assumptions:
//                    router 700 ms, exec 900 ms, check 500 ms, escalate 3000 ms; the user answers a
//                    confirmation 800 ms after it is asked. The phone glides 400-900 ms (120-250 fast).
//   (default)        the real OpenAI models from the root .env (OPENAI_API_KEY, MIND_*).
//   --v1             drive with the v1 Mouth (heard/say) instead of v2 tool calls.
//   --flaky [--flaky-rate 0.3], --port N, --only digest|email|shortcut|chain|call|ask|stop|recipe
// Prints PASS/FAIL per check, a timing table (ms from the user's words) and model calls per role.

import { startMind } from "../src/index";
import { makeModel, modelOptionsFromEnv } from "../src/model";
import { InMemoryStore } from "../src/memory";
import { startFakeHub } from "../fakes/hub";
import { startFakeMouth } from "../fakes/mouth";
import { startFakeCaller } from "../fakes/caller";
import { fakeOpenAI } from "../fakes/openai";
import { loadEnv, loadHints, openLog, redact } from "./env";

const argv = process.argv;
const flag = (n: string) => argv.includes(n);
const arg = (n: string) => (argv.indexOf(n) > 0 ? argv[argv.indexOf(n) + 1] : undefined);
const port = Number(arg("--port") ?? 8790);
const only = arg("--only");
const sim = flag("--sim");
const v2 = !flag("--v1");
const url = (role: string) => `ws://localhost:${port}/${role}?token=story`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = loadEnv();
env.CONTACTS = "Alex=+14155550123,Hamza=+14155550111|hamza@example.com,Mom=+14155550199,Sam Lee=+14155550144,Sam Park=+14155550155";
const hints = loadHints(env.HINTS_DIR);
const { file, log } = openLog("story", (l) => /^(mind: (progress|say|task|confirm|ask|queued|local)|USER|BOBBY|phone: (EMAIL|TEXT|CALL|tap|type|launch|opened)|CALL|call )/.test(l));
console.log(`story: log ${file}`);
console.log(`story: ${sim ? "SIMULATED model latencies (fake OpenAI)" : `real OpenAI, key ${redact(env.OPENAI_API_KEY)}`}, ${v2 ? "v2" : "v1"} Mouth, ${hints.length} hint files`);
if (!sim && !env.OPENAI_API_KEY) {
  console.log("story: FAIL (no OPENAI_API_KEY in the root .env; try --sim)");
  process.exit(1);
}

const ai = fakeOpenAI({ latency: { route: 700, exec: 900, check: 500, escalate: 3000 } });
const counts: Record<string, number> = { route: 0, exec: 0, escalate: 0, check: 0 };
const inner = makeModel({ ...modelOptionsFromEnv(env), log, ...(sim ? { fetch: ai.fetch } : {}) });
const model = async (req: any) => {
  counts[req.purpose] = (counts[req.purpose] ?? 0) + 1;
  return inner(req);
};

const hub = startFakeHub({ port, log: (s) => log(s), flaky: flag("--flaky") ? Number(arg("--flaky-rate") ?? 0.12) : false });
await hub.ready;
const t0 = Date.now();
const mind = startMind({ hubUrl: `ws://localhost:${port}`, token: "story", env, hints, log, model, storage: new InMemoryStore() });
const caller = startFakeCaller({ url: url("caller"), log, stepMs: 1500 });
await sleep(800);
hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
hub.notify("com.whatsapp", "Mum", "Call me when you get a chance x");
await sleep(300);
const mouth = startFakeMouth({ url: url("mouth"), log, msPerChar: 35, v2, autoConfirm: v2 ? { ok: true, heard: "yes, go ahead" } : null, autoAnswer: v2 ? { heard: "the second one" } : null, confirmDelayMs: 800 });
await sleep(1500);

const results: { name: string; ok: boolean; detail: string }[] = [];
const timings: any[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};
const say = (text: string) => (v2 ? mouth.request(text) : mouth.hear(text));
const ended = () => hub.watched.filter((m) => m.type === "task" && m.status !== "started");

async function run(name: string, text: string, done: () => boolean, ms = 60_000) {
  const c0 = { ...counts };
  const w0 = hub.wire.length;
  const acts0 = hub.phone.actsDone;
  const start = Date.now();
  say(text);
  if (!v2) {
    // v1: answer the "Should I go ahead?" question by voice.
    void (async () => {
      const end = Date.now() + ms;
      while (Date.now() < end && !done()) {
        const q = hub.wire.slice(w0).find((w) => w.from === "mind" && w.msg.type === "say" && /Should I go ahead\?/.test(w.msg.text) && !(w as any).answered);
        if (q) {
          (q as any).answered = true;
          await sleep(800);
          mouth.hear("yes, go ahead");
        }
        // ...and a question with options the same way.
        const ask = hub.wire.slice(w0).find((w) => w.from === "mind" && w.msg.type === "say" && /Option one:/.test(w.msg.text) && !(w as any).answered);
        if (ask) {
          (ask as any).answered = true;
          await sleep(800);
          mouth.hear("the second one");
        }
        await sleep(100);
      }
    })();
  }
  while (!done() && Date.now() - start < ms) await sleep(50);
  const after = hub.wire.slice(w0);
  const firstLine = after.find((w) => w.from === "mind" && (w.msg.type === "say" || w.msg.type === "progress" || w.msg.type === "confirm_request" || w.msg.type === "ask_request"));
  const firstAct = after.find((w) => w.from === "mind" && w.msg.type === "act");
  const asked = after.find((w) => w.from === "mind" && (w.msg.type === "confirm_request" || (w.msg.type === "say" && /Should I go ahead/.test(w.msg.text))));
  const answered = after.find((w) => w.to === "mind" && (w.msg.type === "confirm_reply" || (w.msg.type === "heard" && /go ahead/.test(w.msg.text))));
  const waitMs = asked && answered ? Math.max(0, answered.at - asked.at) : 0;
  const total = Date.now() - start;
  const calls = Object.fromEntries(Object.keys(counts).map((k) => [k, counts[k] - (c0[k] ?? 0)]));
  timings.push({ name, totalMs: total, minusConfirmWaitMs: total - waitMs, firstLineMs: firstLine ? firstLine.at - start : null, firstActMs: firstAct ? firstAct.at - start : null, acts: hub.phone.actsDone - acts0, calls });
  return done();
}

if (!only || only === "digest") {
  const digest = mouth.received.find((m) => m.type === "whisper" && /Sarah Chen/.test(m.text));
  check("digest on wake", !!digest, digest ? digest.text : "no whisper with the notifications after wake");
}

if (!only || only === "email") {
  hub.phone.reset();
  const n = ended().length;
  const ok = await run("reply to Sarah (grounded)", "reply to Sarah and tell her 3 works", () => ended().length > n);
  check("email reply sent", ok && hub.phone.sent?.text === "3 works for me.", hub.phone.sent ? `"${hub.phone.sent.text}"` : "nothing sent");
  await sleep(1500);
}

if (!only || only === "recipe" || only === "email") {
  hub.phone.reset();
  const n = ended().length;
  const ok = await run("reply to Sarah again (recipes)", "reply to Sarah and tell her 3 works", () => ended().length > n);
  check("recipe replay", ok && !!hub.phone.sent, `${timings[timings.length - 1].calls.exec} exec calls`);
  await sleep(1500);
}

if (!only || only === "shortcut") {
  const n = ended().length;
  const ok = await run("email Hamza (shortcut)", "send an email to Hamza saying I'm running late", () => ended().length > n);
  check("shortcut email", ok && hub.phone.mails.some((m) => /running late/.test(m.body)), `${hub.phone.mails.length} mail(s)`);
  await sleep(1500);
}

if (!only || only === "chain") {
  const n = ended().length;
  const ok = await run("chain: Spotify, text Alex, call Mom", "open Spotify, then text Alex I'm late, then call Mom", () => ended().length >= n + 3);
  const titles = hub.watched.filter((m) => m.type === "task" && m.status === "started").slice(-3).map((m) => m.title);
  check("chained tasks in order", ok && titles.join(",") === "Open Spotify,Text Alex,Call Mom", titles.join(", "));
  await sleep(1500);
}

if (!only || only === "call") {
  const n = ended().length;
  const ok = await run("call Alex (AI caller)", "call Alex and tell him I'm running late", () => ended().length > n, 30_000);
  check("call summary", ok && caller.calls.length > 0, caller.calls[0] ? `to ${caller.calls[0].number}` : "no call");
  await sleep(1500);
}

if (!only || only === "ask") {
  const n = ended().length;
  const ok = await run("text Sam (one question, two Sams)", "text Sam I'm running late", () => ended().length > n);
  const asked = hub.wire.filter((w) => w.from === "mind" && (w.msg.type === "ask_request" || (w.msg.type === "say" && /Option one:/.test(w.msg.text)))).length;
  const to = hub.phone.texts.filter((x) => /running late/.test(x.body)).map((x) => x.to);
  check("question with options", ok && asked === 1 && to.join() === "+14155550155", `${asked} question(s), text to ${to.join(", ") || "nobody"}`);
  await sleep(1500);
}

if (!only || only === "stop") {
  hub.phone.reset();
  const n = ended().length;
  say("reply to Sarah and tell her 3 works");
  const a0 = hub.phone.actsDone;
  const by = Date.now() + 20_000;
  while (Date.now() < by && hub.phone.actsDone === a0) await sleep(50);
  const ts = Date.now();
  if (v2) mouth.cancel("all");
  else mouth.hear("stop");
  while (Date.now() - ts < 5000 && ended().length === n) await sleep(20);
  const e = ended()[n];
  check("stop cancels", e?.status === "cancelled", e ? `${e.status} in ${Date.now() - ts} ms` : "not cancelled");
}

console.log("\ntimings (ms from the user's words; minusConfirmWait removes the user's 'yes')");
console.table(timings.map((t) => ({ scenario: t.name, total: t.totalMs, minusConfirmWait: t.minusConfirmWaitMs, firstLine: t.firstLineMs, firstAct: t.firstActMs, acts: t.acts, route: t.calls.route, exec: t.calls.exec, check: t.calls.check, escalate: t.calls.escalate })));
const pass = results.every((r) => r.ok);
console.log(`story: ${pass ? "PASS" : "FAIL"} (${results.filter((r) => r.ok).length}/${results.length} checks, ${Math.round((Date.now() - t0) / 1000)} s)`);
console.log(`story: model calls ${JSON.stringify(counts)}; log ${file}`);
console.log(`STORY_JSON ${JSON.stringify({ sim, v2, timings, counts })}`);
mouth.close();
caller.close();
mind.stop();
await hub.close();
process.exit(pass ? 0 : 1);
