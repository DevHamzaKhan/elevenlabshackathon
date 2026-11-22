// Pretend Caller: connects as `caller` and answers each `call` with status updates and a canned result.
// Run: npx tsx fakes/caller.ts [--fail no_answer] [--hub ws://localhost:8765]

import { pathToFileURL } from "node:url";
import { argValue, connectRole, hubUrlFor } from "./cli";

export type FakeCallerOptions = {
  url: string;
  log?: (s: string) => void;
  /** Delay between status changes, ms. */
  stepMs?: number;
  /** Numbers it may dial; empty means any number. */
  allow?: string[];
  /** Make every call fail with this error. */
  fail?: string;
};

export function startFakeCaller(opts: FakeCallerOptions) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const stepMs = opts.stepMs ?? 1500;
  const calls: any[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const conn = connectRole(
    opts.url,
    "caller",
    async (m) => {
      if (m.type !== "call") return;
      calls.push(m);
      const re = m.id;
      log(`CALL to ${m.number}: goal "${m.goal}"`);
      if (opts.allow && opts.allow.length && !opts.allow.includes(m.number)) {
        conn.send({ type: "call_status", re, status: "failed" });
        conn.send({ type: "call_result", re, ok: false, error: "not_allowed" });
        return;
      }
      conn.send({ type: "call_status", re, status: "dialing" });
      await sleep(stepMs);
      if (opts.fail) {
        conn.send({ type: "call_status", re, status: "failed" });
        conn.send({ type: "call_result", re, ok: false, error: opts.fail });
        log(`call failed: ${opts.fail}`);
        return;
      }
      conn.send({ type: "call_status", re, status: "answered" });
      await sleep(stepMs * 2);
      conn.send({ type: "call_status", re, status: "ended" });
      const summary = "Alex said no problem, he'll see you at 3:20 instead.";
      conn.send({
        type: "call_result",
        re,
        ok: true,
        summary,
        transcript: [
          { who: "me", text: "Hey Alex, it's me. I'm running about 20 minutes late, sorry." },
          { who: "them", text: "No problem, I'll see you at 3:20 then." },
        ],
      });
      log(`call ended: ${summary}`);
    },
    log,
  );

  return { calls, close: () => conn.close() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startFakeCaller({ url: hubUrlFor("caller"), fail: argValue("--fail"), log: (s) => console.log(`[caller] ${s}`) });
}
