// The Caller, Core version: dry run only. Connects as `caller` and answers every `call`
// with a canned result (CONTRACT.md v1, "Caller"), whatever CALLER_DRY_RUN says.
// The real dialing path is an Extra (see STATUS.md).
import { connectHub, type Frame, type Hub, type HubOptions } from "./hub";

export const E164 = /^\+[1-9]\d{6,14}$/;

export function allowlist(env: Record<string, string | undefined>): string[] {
  return (env.CALL_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The frames one call produces in dry-run mode, in order. */
export function dryRunCall(msg: Frame, allowed: string[]): Frame[] {
  const re = String(msg.id ?? "");
  const number = String(msg.number ?? "");
  if (!E164.test(number) || (allowed.length > 0 && !allowed.includes(number))) {
    return [{ type: "call_result", re, ok: false, error: "not_allowed" }];
  }
  const goal = String(msg.goal ?? "");
  return [
    { type: "call_status", re, status: "dialing" },
    { type: "call_status", re, status: "answered" },
    { type: "call_status", re, status: "ended" },
    {
      type: "call_result", re, ok: true,
      summary: "Dry run: no call was placed. They said that works for them.",
      transcript: [{ who: "me", text: goal || "Hi, it's me." }, { who: "them", text: "Sure, that works." }],
    },
  ];
}

export function startCallerWith(o: Omit<HubOptions, "role" | "onMessage"> & { env: Record<string, string | undefined>; stepMs?: number }): { stop(): void; hub: Hub } {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const hub: Hub = connectHub({
    ...o,
    role: "caller",
    onMessage: (msg) => {
      if (msg.type !== "call") return;
      dryRunCall(msg, allowlist(o.env)).forEach((f, i) => {
        const t = setTimeout(() => { timers.delete(t); hub.send(f); }, i * (o.stepMs ?? 700));
        timers.add(t);
      });
    },
  });
  return { hub, stop: () => { timers.forEach(clearTimeout); hub.stop(); } };
}
