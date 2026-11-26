// Pretend Bobby: connects as `mouth`. Each typed line is a press: `wake`, then `heard`.
// `!more <text>` sends a `heard` with no press (a paused command's tail, or chatter).
// `!spoke <text>` sends a `spoke` instead (to test corrections). `!asleep` ends the session.
// Run: npx tsx fakes/mouth.ts [--script file] [--hub ws://localhost:8765]

import { pathToFileURL } from "node:url";
import { connectRole, hubUrlFor, runCommands } from "./cli";

export type FakeMouthOptions = {
  url: string;
  log?: (s: string) => void;
  /** ms of speech per character; 0 makes tests fast. */
  msPerChar?: number;
  /** Speak protocol v2: announce `voice_caps`, send `request` instead of `heard`. */
  v2?: boolean;
  /** v2: answer every `confirm_request` automatically with this (after `confirmDelayMs`). */
  autoConfirm?: { ok: boolean; heard: string } | null;
  confirmDelayMs?: number;
  /** v2: answer every `ask_request` automatically: what the user said, and the voice model's pick (0 = none). */
  autoAnswer?: { heard: string; option?: number } | null;
  /** v2 without the `answer` tool (an older Mouth): questions arrive as progress lines. */
  noAnswerTool?: boolean;
};

export function startFakeMouth(opts: FakeMouthOptions) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const msPerChar = opts.msPerChar ?? 45;
  let awake = false;
  const queue: { id: string; text: string }[] = [];
  let speaking: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const received: any[] = [];
  let lastConfirm: any = null;
  let lastAsk: any = null;
  const tools = ["request", "amend", "cancel", "confirm", "status", "teach", ...(opts.noAnswerTool ? [] : ["answer"])];

  const speakNext = () => {
    if (speaking || queue.length === 0) return;
    const s = queue.shift()!;
    conn.send({ type: "say_started", re: s.id });
    log(`BOBBY SAYS: ${s.text}`);
    const ms = Math.max(msPerChar ? 200 : 5, s.text.length * msPerChar);
    speaking = {
      id: s.id,
      timer: setTimeout(() => {
        speaking = null;
        conn.send({ type: "spoke", text: s.text });
        conn.send({ type: "say_done", re: s.id });
        speakNext();
      }, Math.min(ms, 12_000)),
    };
  };

  const conn = connectRole(
    opts.url,
    "mouth",
    (m) => {
      received.push(m);
      switch (m.type) {
        case "say":
          if (!awake) {
            conn.send({ type: "say_done", re: m.id, spoken: false });
            log(`(asleep, not saying: ${m.text})`);
            return;
          }
          queue.push({ id: m.id, text: m.text });
          speakNext();
          break;
        case "whisper":
          if (awake) log(`(whisper) ${m.text}`);
          break;
        case "correct":
          if (!awake) return;
          log(`BOBBY CORRECTS: ${m.text}`);
          conn.send({ type: "spoke", text: `Sorry, correction: ${m.text}` });
          break;
        case "hush":
          if (!awake) return;
          log("(hush)");
          if (speaking) {
            clearTimeout(speaking.timer);
            conn.send({ type: "say_done", re: speaking.id });
            speaking = null;
          }
          for (const q of queue.splice(0)) conn.send({ type: "say_done", re: q.id });
          break;
        case "sleep":
          log("(sleep: Bobby goes quiet)");
          awake = false;
          if (speaking) {
            clearTimeout(speaking.timer);
            conn.send({ type: "say_done", re: speaking.id });
            speaking = null;
          }
          for (const q of queue.splice(0)) conn.send({ type: "say_done", re: q.id, spoken: false });
          conn.send({ type: "asleep" });
          break;
        case "peers":
          break;
        case "progress":
          log(`BOBBY (${m.priority}): ${m.text}`);
          break;
        case "task_update":
          log(`(task ${m.task} ${m.status}${m.text ? `: ${m.text}` : ""})`);
          break;
        case "status_result":
          log(`(status) ${m.text}`);
          break;
        case "confirm_request":
          log(`BOBBY ASKS: ${m.summary}. Should I go ahead?`);
          lastConfirm = m;
          if (opts.autoConfirm) {
            const a = opts.autoConfirm;
            setTimeout(() => conn.send({ type: "confirm_reply", re: m.id, ok: a.ok, heard: a.heard }), opts.confirmDelayMs ?? 20);
          }
          break;
        case "ask_request":
          if (opts.noAnswerTool) {
            log("(got ask_request: ignored, this Mouth has no answer tool)");
            break;
          }
          log(`BOBBY ASKS: ${m.say ?? m.question}`);
          lastAsk = m;
          if (opts.autoAnswer) {
            const a = opts.autoAnswer;
            setTimeout(() => {
              if (lastAsk !== m) return;
              lastAsk = null;
              log(`USER: ${a.heard}`);
              conn.send({ type: "heard", text: a.heard });
              conn.send({ type: "ask_reply", re: m.id, option: a.option ?? 0, text: a.heard, heard: a.heard });
            }, opts.confirmDelayMs ?? 20);
          }
          break;
        default:
          log(`(got ${m.type})`);
      }
    },
    log,
    () => {
      if (opts.v2) conn.send({ type: "voice_caps", v: 2, tools });
      if (!awake) {
        awake = true;
        conn.send({ type: "wake" });
      }
    },
  );

  const wake = () => {
    if (opts.v2) conn.send({ type: "voice_caps", v: 2, tools });
    if (!awake) {
      awake = true;
      conn.send({ type: "wake" });
      log("(wake)");
    }
  };

  return {
    received,
    get awake() {
      return awake;
    },
    /** One press of the side button and one command: `wake` (always), then `heard`. */
    hear(text: string) {
      awake = true;
      conn.send({ type: "wake" });
      log(`USER: ${text}`);
      conn.send({ type: "heard", text });
    },
    /** A `heard` with no press first: the rest of a paused command, or room chatter. */
    hearMore(text: string) {
      log(`USER (no press): ${text}`);
      conn.send({ type: "heard", text });
    },
    /** v2: the voice model called request(text); `heard` is the raw transcript. */
    request(text: string, heard = text) {
      awake = true;
      log(`USER: ${heard}`);
      conn.send({ type: "heard", text: heard });
      conn.send({ type: "request", text, heard });
    },
    amend(text: string) {
      log(`USER (amend): ${text}`);
      conn.send({ type: "heard", text });
      conn.send({ type: "amend", text });
    },
    cancel(scope: "current" | "all" = "all") {
      conn.send({ type: "cancel", scope });
    },
    /** v2: the voice model called teach(action, text). */
    teach(action: "start" | "done" | "cancel", text = "", heard = text) {
      awake = true;
      if (heard) {
        log(`USER: ${heard}`);
        conn.send({ type: "heard", text: heard });
      }
      conn.send({ type: "teach", action, ...(text ? { text } : {}), heard });
    },
    bargeIn() {
      conn.send({ type: "barge_in" });
    },
    /** v2: answer the latest confirm_request (ok from the voice model, heard = raw transcript). */
    confirm(ok: boolean, heard: string) {
      if (!lastConfirm) return false;
      log(`USER: ${heard}`);
      conn.send({ type: "heard", text: heard });
      conn.send({ type: "confirm_reply", re: lastConfirm.id, ok, heard });
      lastConfirm = null;
      return true;
    },
    get pendingConfirm() {
      return lastConfirm;
    },
    /** v2: answer the latest ask_request. `option` is the voice model's pick (1-based, 0 = none); `heard` the raw transcript. */
    answer(heard: string, option = 0, text = heard) {
      if (!lastAsk) return false;
      log(`USER: ${heard}`);
      if (heard) conn.send({ type: "heard", text: heard });
      conn.send({ type: "ask_reply", re: lastAsk.id, option, text, heard });
      lastAsk = null;
      return true;
    },
    get pendingAsk() {
      return lastAsk;
    },
    status(id = "s1") {
      conn.send({ type: "status", id });
    },
    spoke(text: string) {
      wake();
      conn.send({ type: "spoke", text });
    },
    wake,
    asleep() {
      awake = false;
      conn.send({ type: "asleep" });
    },
    close() {
      conn.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const mouth = startFakeMouth({ url: hubUrlFor("mouth"), log: (s) => console.log(`[mouth] ${s}`) });
  // Give the socket a moment before the first scripted line.
  await new Promise((r) => setTimeout(r, 800));
  await runCommands(
    (line) => {
      if (line.startsWith("!spoke ")) mouth.spoke(line.slice(7));
      else if (line === "!asleep") mouth.asleep();
      else if (line === "!wake") mouth.wake();
      else if (line.startsWith("!more ")) mouth.hearMore(line.slice(6));
      else mouth.hear(line);
    },
    () => {
      console.log("[mouth] script finished");
      mouth.close();
      setTimeout(() => process.exit(0), 200);
    },
  );
}
