// Test plumbing: a fake hub + phone, fake Mouth (v1 or v2) and Caller, and the scripted fake
// OpenAI behind the real model door, so the brain is tested end to end with no API key.

import { startMind } from "../src/index";
import { makeModel } from "../src/model";
import { InMemoryStore } from "../src/memory";
import { startFakeHub } from "../fakes/hub";
import { startFakeMouth } from "../fakes/mouth";
import { startFakeCaller } from "../fakes/caller";
import { fakeOpenAI, type FakeOpenAI } from "../fakes/openai";
import type { ModelFn, Timing } from "../src/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 8000, step = 20): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

export const CONTACTS = "Alex=+14155550123,Hamza=+14155550111|hamza@example.com,Mom=+14155550199,Sam=sam@example.com";

/** Fake hub + Mind + Mouth + Caller on a fresh port, all fast. */
export async function setup(
  opts: {
    mouth?: boolean;
    /** The fake Mouth speaks protocol v2 (request/confirm_reply/...). */
    v2?: boolean;
    autoConfirm?: { ok: boolean; heard: string } | null;
    caller?: boolean;
    sleepMs?: number;
    contacts?: string;
    env?: Record<string, string>;
    legacy?: boolean;
    latency?: Partial<Record<string, number>>;
    /** Wrap the model door, e.g. to change the phone while it "thinks". */
    model?: (hub: ReturnType<typeof startFakeHub>, inner: ModelFn) => ModelFn;
    timing?: Partial<Timing>;
    msPerChar?: number;
    callerStepMs?: number;
    storage?: InMemoryStore;
  } = {},
) {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const hub = startFakeHub({ port: 0, log, speed: 0, legacy: opts.legacy });
  await hub.ready;
  const port = hub.port;
  const ai: FakeOpenAI = fakeOpenAI({ latency: opts.latency });
  const door = makeModel({ apiKey: "sk-fake", log, fetch: ai.fetch });
  const storage = opts.storage ?? new InMemoryStore();
  const mind = startMind({
    hubUrl: `ws://localhost:${port}`,
    token: "test",
    env: { CONTACTS: opts.contacts ?? CONTACTS, ...(opts.env ?? {}) },
    log,
    hints: [],
    model: opts.model ? opts.model(hub, door) : door,
    storage,
    timing: { actMs: 2000, sayMs: 2000, callMs: 5000, sleepMs: opts.sleepMs ?? 60_000, commandMs: 40, listenMs: 300, confirmMs: 3000, bargeMs: 1500, ...(opts.timing ?? {}) },
  });
  const url = (role: string) => `ws://localhost:${port}/${role}?token=test`;
  const mouth =
    opts.mouth === false
      ? null
      : startFakeMouth({ url: url("mouth"), log, msPerChar: opts.msPerChar ?? 0, v2: opts.v2, autoConfirm: opts.autoConfirm === undefined ? (opts.v2 ? { ok: true, heard: "yes, send it" } : null) : opts.autoConfirm });
  const caller = opts.caller === false ? null : startFakeCaller({ url: url("caller"), log, stepMs: opts.callerStepMs ?? 30 });
  await until(() => (mouth ? mouth.awake : true), 3000);
  await sleep(150);
  return {
    port,
    url,
    hub,
    mind,
    brain: mind.brain,
    mouth,
    caller,
    ai,
    storage,
    lines,
    toMind: (type: string) => hub.wire.filter((w) => w.to === "mind" && w.msg.type === type).map((w) => w.msg),
    fromMind: (type: string) => hub.wire.filter((w) => w.from === "mind" && w.msg.type === type).map((w) => w.msg),
    tasks: () => hub.watched.filter((m) => m.type === "task"),
    acts: () => hub.wire.filter((w) => w.from === "mind" && w.msg.type === "act").map((w) => w.msg),
    async close() {
      mouth?.close();
      caller?.close();
      mind.stop();
      await hub.close();
    },
  };
}

export type T = Awaited<ReturnType<typeof setup>>;

/** v1 Mouth: answers a "Should I go ahead?" say with a press and a reply. */
export async function answerConfirmV1(t: T, reply: string, ms = 6000): Promise<boolean> {
  const ok = await until(() => t.fromMind("say").some((m) => /Should I go ahead\?/.test(m.text)), ms);
  if (!ok) return false;
  await sleep(30);
  t.mouth!.hear(reply);
  return true;
}
