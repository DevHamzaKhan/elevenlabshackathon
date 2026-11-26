// npm run teach:bench: four ways to turn one demonstration into something Bobby can repeat,
// measured on the same pretend phone at real phone speed (cursor glides, settles) with simulated
// model latencies (router 700 ms, executor 900 ms, check 500 ms, as in `npm run story -- --sim`).
//
//   pixels  replay the taps at the coordinates they were made (a classic macro recorder)
//   script  replay by resource id / label with a check after every step, and code-only recovery
//           (restart the app at its first screen, close tips, scroll to find); no model
//   guided  no script: the executor model does it every time, with the demo's steps as its guide
//   hybrid  script first; the guided executor takes over when the script can't go on (the default)
//
// Each cell: teach "add a project" once on a fresh phone, change the app as the scenario says,
// ask for a new project, and look at the phone afterwards. "ok" means exactly one new project
// with the right name exists AND Bobby said it was done; "WRONG" means he said done and it isn't
// so, or he changed something else. The model is the scripted fake (an idealised executor that
// follows the guide and batches predictable steps), so the guided numbers are a best case.
//   --json   also print the raw cells

import { startMind } from "../src/index";
import { makeModel } from "../src/model";
import { InMemoryStore } from "../src/memory";
import { startFakeHub } from "../fakes/hub";
import { startFakeMouth } from "../fakes/mouth";
import { fakeOpenAI } from "../fakes/openai";
import type { Drift } from "../fakes/phone";
import type { TeachMode } from "../src/teach";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(25);
  return cond();
}

type Scenario = { name: string; drift?: Drift; before?: (p: ReturnType<typeof startFakeHub>["phone"]) => void; ask?: (name: string) => string };

const SCENARIOS: Scenario[] = [
  { name: "nothing changed" },
  { name: "asked in other words", ask: (n) => `could you set up a project for me, called ${n}` },
  { name: "button renamed" , drift: { renamed: true } },
  { name: "layout moved", drift: { moved: true } },
  { name: "app left on another screen", before: (p) => p.user.tap("Website redesign") },
  { name: "a tip covers the app", drift: { tip: true } },
  { name: "list grew, button below the fold", drift: { long: true }, before: (p) => p.projects.push("A", "B", "C", "D", "E") },
  { name: "a new step in the way", drift: { interstitial: true } },
];
const MODES: TeachMode[] = ["pixels", "script", "guided", "hybrid"];

type Cell = { ok: boolean; wrong: boolean; ms: number; calls: Record<string, number>; said: string };

async function cell(mode: TeachMode, sc: Scenario): Promise<Cell> {
  const log = () => {};
  const hub = startFakeHub({ port: 0, log, speed: 1 });
  await hub.ready;
  const ai = fakeOpenAI({ latency: { route: 700, exec: 900, check: 500, escalate: 3000, teach: 1500 } });
  const mind = startMind({
    hubUrl: `ws://localhost:${hub.port}`,
    token: "bench",
    env: { MIND_TEACH_MODE: mode, MIND_CONFIRM: "never" },
    log,
    hints: [],
    storage: new InMemoryStore(),
    model: makeModel({ apiKey: "sk-fake", log, fetch: ai.fetch }),
  });
  const mouth = startFakeMouth({ url: `ws://localhost:${hub.port}/mouth?token=bench`, log, msPerChar: 0, v2: true });
  const p = hub.phone;
  try {
    await until(() => mind.brain.peers.hands && mind.brain.peers.mouth, 3000);
    await sleep(100);
    mouth.teach("start", "add a new project", "I'm going to show you how to add a new project. I'll type test test.");
    await until(() => mind.brain.teaching?.phase === "watching", 3000);
    p.user.open("Projects");
    p.user.tap("New project");
    p.user.type("test test");
    p.user.tap("Create");
    await sleep(50);
    mouth.teach("done");
    await until(() => mind.brain.skills.all().length === 1, 8000);
    await mind.brain.teachDone;

    sc.before?.(p);
    p.user.home();
    p.drift = sc.drift ?? {};
    const name = "Apollo";
    const had = [...p.projects];
    const calls0 = ai.calls.length;
    const t0 = Date.now();
    mouth.request(sc.ask ? sc.ask(name) : `add a project called ${name}`);
    const ended = () => hub.watched.find((m) => m.type === "task" && m.title === "Add a project" && m.status !== "started");
    await until(() => !!ended(), 45_000);
    const ms = Date.now() - t0;
    await sleep(60);
    const status = ended()?.status ?? "never finished";
    const added = p.projects.slice(had.length);
    const right = added.length === 1 && added[0] === name && had.every((x, i) => p.projects[i] === x);
    const calls: Record<string, number> = {};
    for (const c of ai.calls.slice(calls0)) calls[c.role] = (calls[c.role] ?? 0) + 1;
    return { ok: status === "done" && right, wrong: (status === "done" && !right) || (status !== "done" && added.length > 0 && !right), ms, calls, said: status };
  } finally {
    mouth.close();
    mind.stop();
    await hub.close();
  }
}

const callsText = (c: Record<string, number>) => {
  const n = Object.values(c).reduce((a, b) => a + b, 0);
  return n === 0 ? "0 calls" : `${n} call${n > 1 ? "s" : ""} (${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ")})`;
};

const rows: { scenario: string; cells: Record<string, Cell> }[] = [];
for (const sc of SCENARIOS) {
  const cells = await Promise.all(MODES.map((m) => cell(m, sc)));
  rows.push({ scenario: sc.name, cells: Object.fromEntries(MODES.map((m, i) => [m, cells[i]])) });
  console.log(`${sc.name}`);
  MODES.forEach((m, i) => {
    const c = cells[i];
    console.log(`  ${m.padEnd(7)} ${(c.ok ? "ok" : c.wrong ? "WRONG" : "failed").padEnd(6)} ${(c.ms / 1000).toFixed(1).padStart(5)} s  ${callsText(c.calls)}`);
  });
}

console.log("\n| Scenario | pixels | script | guided | hybrid |\n|---|---|---|---|---|");
for (const r of rows) {
  const f = (c: Cell) => `${c.ok ? "ok" : c.wrong ? "**wrong**" : "failed"} ${(c.ms / 1000).toFixed(1)} s, ${Object.values(c.calls).reduce((a, b) => a + b, 0)} calls`;
  console.log(`| ${r.scenario} | ${MODES.map((m) => f(r.cells[m])).join(" | ")} |`);
}
const sum = (m: TeachMode) => {
  const cs = rows.map((r) => r.cells[m]);
  const oks = cs.filter((c) => c.ok);
  const med = [...oks.map((c) => c.ms)].sort((a, b) => a - b)[Math.floor(oks.length / 2)] ?? 0;
  return `${oks.length}/${cs.length} ok${cs.some((c) => c.wrong) ? `, ${cs.filter((c) => c.wrong).length} wrong` : ""}, median ${(med / 1000).toFixed(1)} s`;
};
console.log(`| **all ${rows.length}** | ${MODES.map(sum).join(" | ")} |`);
if (process.argv.includes("--json")) console.log(`BENCH_JSON ${JSON.stringify(rows)}`);
process.exit(0);
