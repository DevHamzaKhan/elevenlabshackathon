// The Caller (CONTRACT.md v1, "Caller"). Plain TypeScript: fetch, WebSocket and timers only,
// so it runs the same in Node (tests, tools/caller.mjs) and React Native (the app).
//
// On a `call` it checks the number against CALL_ALLOWLIST, then fakes the call (CALLER_DRY_RUN,
// the default) or, only when CALLER_DRY_RUN is exactly "0", places it with GPT-Live over a SIP
// trunk (caller-live.ts). Every call ends in exactly one call_result.
import { connectHub, type Frame, type Hub, type HubOptions } from "./hub";
import { liveCall, type LiveCallDeps } from "./caller-live";

export const E164 = /^\+[1-9]\d{6,14}$/;

export function allowlist(env: Record<string, string | undefined>): string[] {
  return (env.CALL_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** CALLER_DRY_RUN defaults to 1: only the exact value "0" places real calls. */
export function isDryRun(env: Record<string, string | undefined>): boolean {
  return (env.CALLER_DRY_RUN ?? "1").trim() !== "0";
}

function notAllowed(msg: Frame, allowed: string[]): Frame | null {
  const number = String(msg.number ?? "");
  if (E164.test(number) && allowed.includes(number)) return null; // an empty allowlist allows nothing
  return { type: "call_result", re: String(msg.id ?? ""), ok: false, error: "not_allowed" };
}

/** The frames one call produces in dry-run mode, in order. */
export function dryRunCall(msg: Frame, allowed: string[]): Frame[] {
  const re = String(msg.id ?? "");
  const refused = notAllowed(msg, allowed);
  if (refused) return [refused];
  const goal = String(msg.goal ?? "");
  return [
    { type: "call_status", re, status: "dialing" },
    { type: "call_status", re, status: "answered" },
    { type: "call_status", re, status: "ended" },
    {
      type: "call_result", re, ok: true,
      summary: "Dry run: no call was placed. They said that works for them.",
      transcript: [{ who: "me", text: `Hi, this is Bobby, an AI assistant calling for my owner. ${goal || "Just saying hello."}` }, { who: "them", text: "Sure, that works." }],
    },
  ];
}

export type Line = { who: "me" | "them"; text: string };

// ---------------------------------------------------------------- entry point

/**
 * Connects as `caller`. On `call`: dry run (CALLER_DRY_RUN, default 1), else a real call with
 * GPT-Live over SIP (caller-live.ts). On `hangup` {re}: that call is ended and still gets exactly
 * one call_result.
 */
export function startCallerWith(
  o: Omit<HubOptions, "role" | "onMessage"> & {
    env: Record<string, string | undefined>;
    stepMs?: number;
    liveDeps?: Partial<Omit<LiveCallDeps, "env" | "send" | "log" | "cancelled">>;
  },
): { stop(): void; hub: Hub } {
  const timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  const hungUp = new Set<string>();
  let stopped = false;
  const hub: Hub = connectHub({
    ...o,
    role: "caller",
    onMessage: (msg) => {
      if (msg.type === "hangup") {
        const re = String(msg.re ?? "");
        hungUp.add(re);
        const pending = timers.get(re);
        if (pending?.size) {
          // A dry-run call still in progress: stop it and end it once.
          pending.forEach(clearTimeout);
          timers.delete(re);
          hub.send({ type: "call_status", re, status: "ended" });
          hub.send({ type: "call_result", re, ok: false, error: "cancelled" });
        }
        o.log(`caller: hangup for ${re}`);
        return;
      }
      if (msg.type !== "call") return;
      const re = String(msg.id ?? "");
      if (isDryRun(o.env)) {
        const set = new Set<ReturnType<typeof setTimeout>>();
        timers.set(re, set);
        const frames = dryRunCall(msg, allowlist(o.env));
        frames.forEach((f, i) => {
          const t = setTimeout(() => {
            set.delete(t);
            if (i === frames.length - 1) timers.delete(re);
            hub.send(f);
          }, i * (o.stepMs ?? 700));
          set.add(t);
        });
        return;
      }
      const cancelled = () => stopped || hungUp.has(re);
      const send = (f: Frame) => hub.send(f);
      void liveCall(msg, { ...o.liveDeps, env: o.env, send, log: o.log, cancelled });
    },
  });
  return {
    hub,
    stop: () => {
      stopped = true;
      for (const s of timers.values()) s.forEach(clearTimeout);
      timers.clear();
      hub.stop();
    },
  };
}
