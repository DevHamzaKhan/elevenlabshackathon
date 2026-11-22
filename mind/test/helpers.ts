// Test plumbing: a fake hub + phone, fake Mouth and Caller, and a rule-based stand-in for the model
// that reads the fake phone's screen, so the brain can be tested with no API key.

import { startMind } from "../src/index";
import { startFakeHub } from "../fakes/hub";
import { startFakeMouth } from "../fakes/mouth";
import { startFakeCaller } from "../fakes/caller";
import type { ModelFn, ModelRequest } from "../src/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 8000, step = 20): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

const blank = { whisper: "", title: "", goal: "", steps: [], call_name: "", call_goal: "", say: "" };
const act = (o: any) => ({ status: "act", step: 1, do: "none", n: -1, text: "", dir: "", key: "", app: "", ms: -1, say: "", plan: [], ...o });

function nodesFrom(user: string): { n: number; line: string }[] {
  const out: { n: number; line: string }[] = [];
  for (const line of user.split("\n")) {
    const m = /^\[(\d+)\] (.*)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), line: m[2] });
  }
  return out;
}

/** A pretend model with fixed rules. `slowMs` delays each reply; `calls` records every request. */
export function stubModel(opts: { slowMs?: number } = {}) {
  const calls: ModelRequest[] = [];
  const fn: ModelFn = async (req) => {
    calls.push(req);
    if (opts.slowMs) await sleep(opts.slowMs);
    const json = req.purpose === "decide" ? decide(req.user) : step(req.user);
    return { json, stopReason: "end_turn", ms: opts.slowMs ?? 0 };
  };
  return { fn, calls };
}

function decide(user: string) {
  const heard = (/The user just said: "(.*)"/.exec(user)?.[1] ?? "").toLowerCase();
  if (heard.includes("reply to sarah"))
    return { ...blank, action: "task", title: "Reply to Sarah", goal: 'Reply to Sarah Chen\'s email with "3 works for me."', steps: [{ do: "Open Gmail", why: "Sarah's message is an email" }, { do: "Reply", why: "to answer her" }], say: "I'll find Gmail and answer Sarah." };
  if (heard.startsWith("open "))
    return { ...blank, action: "task", title: `Open ${heard.slice(5)}`, goal: `Open the ${heard.slice(5)} app`, steps: [{ do: "Find the icon", why: "to open it" }] };
  if (heard.startsWith("call ")) {
    const name = heard.split(" ")[1];
    return { ...blank, action: "call", call_name: name[0].toUpperCase() + name.slice(1), call_goal: "Say I'm running late.", say: `I'm calling ${name} to say you're running late.` };
  }
  if (heard.includes("bye")) return { ...blank, action: "sleep" };
  return { ...blank, action: "chat", whisper: "Sarah Chen emailed about pushing to 3." };
}

function step(user: string) {
  const app = /^App: (.*)$/m.exec(user)?.[1] ?? "";
  const nodes = nodesFrom(user);
  const find = (re: RegExp) => nodes.find((x) => re.test(x.line));
  const goal = /^Goal: (.*)$/m.exec(user)?.[1] ?? "";
  const target = /spotify/i.test(goal) ? /"Spotify"/ : /"Gmail"/;
  if (/Home screen/.test(app)) {
    const icon = find(target);
    if (icon) return act({ do: "tap", n: icon.n, say: "Found it, opening it." });
    return act({ do: "swipe", dir: "left", say: "Not on this screen, so I'm swiping to the next one." });
  }
  if (/^Gmail/.test(app)) {
    const reply = find(/^"Reply"/);
    const sent = find(/^"Me: /);
    if (sent) return { ...act({}), status: "done", do: "none", say: "Your reply to Sarah is sent." };
    const row = find(/Sarah Chen, Meeting today/);
    if (row) return act({ do: "tap", n: row.n, say: "Opening Sarah's email to answer it." });
    if (reply) return act({ do: "tap", n: reply.n, say: "Tapping Reply to answer Sarah." });
    const body = find(/"Compose email"/);
    const send = find(/"Send"/);
    if (body) return act({ do: "type", n: body.n, text: "3 works for me.", say: "Writing that 3 works for you." });
    if (send) return act({ do: "tap", n: send.n, say: "Sending Sarah: 3 works for me." });
  }
  return act({ do: "key", key: "home", say: "Going home to start over." });
}

let nextPort = 18800 + Math.floor(Math.random() * 500);

/** Fake hub + Mind + Mouth + Caller on a fresh port, all fast. */
export async function setup(opts: { slowMs?: number; mouth?: boolean; caller?: boolean; sleepMs?: number; contacts?: string } = {}) {
  const port = nextPort++;
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const hub = startFakeHub({ port, log, speed: 0 });
  await hub.ready;
  const model = stubModel({ slowMs: opts.slowMs });
  const mind = startMind({
    hubUrl: `ws://localhost:${port}`,
    token: "test",
    env: { CONTACTS: opts.contacts ?? "Alex=+14155550123" },
    log,
    hints: [],
    model: model.fn,
    timing: { actMs: 2000, sayMs: 2000, callMs: 5000, sleepMs: opts.sleepMs ?? 60_000 },
  });
  const url = (role: string) => `ws://localhost:${port}/${role}?token=test`;
  const mouth = opts.mouth === false ? null : startFakeMouth({ url: url("mouth"), log, msPerChar: 0 });
  const caller = opts.caller === false ? null : startFakeCaller({ url: url("caller"), log, stepMs: 30 });
  // Wait until the hub has told the Mind who's here.
  await until(() => hub.wire.length >= 0 && (mouth ? mouth.awake : true), 3000);
  await sleep(150);
  return {
    port,
    url,
    hub,
    mind,
    mouth,
    caller,
    model,
    lines,
    toMind: (type: string) => hub.wire.filter((w) => w.to === "mind" && w.msg.type === type).map((w) => w.msg),
    fromMind: (type: string) => hub.wire.filter((w) => w.from === "mind" && w.msg.type === type).map((w) => w.msg),
    tasks: () => hub.watched.filter((m) => m.type === "task"),
    async close() {
      mouth?.close();
      caller?.close();
      mind.stop();
      await hub.close();
    },
  };
}
