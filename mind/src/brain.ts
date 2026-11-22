// The brain: reacts to what the Mouth hears, plans tasks, drives Hands one step at a time,
// places calls through the Caller, and keeps Bobby's story straight.

import type { ModelFn, Msg, PlanStep, ScreenNode, Timing } from "./types";
import { DECIDE_SCHEMA, STEP_SCHEMA, decideSystem, stepSystem } from "./prompts";
import { appLabel, describeScreen, screenKey } from "./screen";

export type HubLike = {
  send(m: Msg): boolean;
  nextId(): string;
  waitFor(id: string, ms: number): Promise<Msg | null>;
  cancelWait(id: string): void;
};

export type BrainOptions = {
  hub: HubLike;
  model: ModelFn;
  log: (line: string) => void;
  hints: string[];
  contacts: Record<string, string>;
  timing: Timing;
};

type Notif = { app: string; title: string; text: string; at: number };

type HistoryEntry = { action: string; result: string; say: string };

type Task = {
  id: string;
  title: string;
  goal: string;
  plan: PlanStep[];
  stepStatus: Record<number, "running" | "done" | "failed">;
  history: HistoryEntry[];
  cancelled: boolean;
  /** Cancelled to make way for a new task: no whisper. */
  quiet?: boolean;
  correctedOnce: boolean;
};

type Call = { id: string; taskId: string; name: string; number: string; goal: string; correctedOnce: boolean };

const MAX_STEPS = 25;
const MAX_CONSECUTIVE_FAILS = 4;
const CANCEL_RE = /\b(stop|cancel|never ?mind|abort|forget it|don'?t do (it|that))\b/i;

export function parseContacts(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const num = part.slice(i + 1).trim();
    if (name && /^\+\d{6,15}$/.test(num)) out[name] = num;
  }
  return out;
}

export function isCancel(text: string): boolean {
  return CANCEL_RE.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Brain {
  peers = { hands: false, mouth: false, caller: false };
  awake = false;
  notifications: Notif[] = [];
  private undigested = 0;
  private convo: { who: "user" | "bobby"; text: string }[] = [];
  task: Task | null = null;
  call: Call | null = null;
  private taskSeq = 0;
  private lastActivity = Date.now();
  private sleepSent = false;
  private pendingSays = new Set<string>();
  private recentSays: { text: string; at: number }[] = [];
  /** Things the Mind knows are true, newest last, for corrections and for "what happened?". */
  facts: string[] = [];
  private ticker: ReturnType<typeof setInterval>;
  private decideSys: string;
  private stepSys: string;
  private stopped = false;
  /** Resolves when the current task loop ends. Tests await it. */
  taskDone: Promise<void> = Promise.resolve();

  constructor(private o: BrainOptions) {
    this.decideSys = decideSystem(o.hints);
    this.stepSys = stepSystem(o.hints);
    this.ticker = setInterval(() => this.tick(), 500);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.task) this.task.cancelled = true;
  }

  // ---------- sending ----------

  private send(m: Msg) {
    this.o.hub.send(m);
  }

  private whisper(text: string) {
    if (!text.trim() || !this.peers.mouth) return;
    this.o.log(`mind: whisper: ${text}`);
    this.send({ type: "whisper", to: "mouth", text });
  }

  /** Sends a `say` and returns a promise that resolves when it's done (or timed out / no Mouth). */
  private say(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    this.o.log(`mind: say: ${text}`);
    this.recentSays.push({ text, at: Date.now() });
    if (this.recentSays.length > 20) this.recentSays.shift();
    this.convo.push({ who: "bobby", text });
    if (!this.peers.mouth) return Promise.resolve();
    const id = this.o.hub.nextId();
    this.pendingSays.add(id);
    const done = this.o.hub.waitFor(id, this.o.timing.sayMs).then(() => {
      this.pendingSays.delete(id);
      this.lastActivity = Date.now();
    });
    this.send({ type: "say", to: "mouth", id, text });
    return done;
  }

  private watch(m: Msg) {
    this.send({ ...m, to: "watch" });
  }

  // ---------- incoming ----------

  handle(m: Msg) {
    if (this.stopped) return;
    switch (m.type) {
      case "peers":
        this.peers = { hands: !!m.hands, mouth: !!m.mouth, caller: !!m.caller };
        if (!m.mouth) this.awake = false;
        break;
      case "notification":
        this.onNotification(m);
        break;
      case "wake":
        this.onWake();
        break;
      case "asleep":
        this.awake = false;
        break;
      case "heard":
        if (typeof m.text === "string") void this.onHeard(m.text);
        break;
      case "spoke":
        if (typeof m.text === "string") this.onSpoke(m.text);
        break;
      case "call_status":
        if (this.call && m.re === this.call.id && typeof m.status === "string") {
          this.whisper(`Call to ${this.call.name}: ${m.status}.`);
        }
        break;
      default:
        // act_result, screen_result, say_started, say_done, call_result: handled by waiters.
        break;
    }
  }

  private onNotification(m: Msg) {
    const n: Notif = {
      app: String(m.app ?? ""),
      title: String(m.title ?? ""),
      text: String(m.text ?? ""),
      at: Number(m.at) || Date.now(),
    };
    this.notifications.push(n);
    if (this.notifications.length > 30) this.notifications.shift();
    this.undigested += 1;
    if (this.awake) {
      this.whisper(`New notification just now: ${notifLine(n)}.`);
      this.undigested = 0;
    }
  }

  private onWake() {
    this.awake = true;
    this.sleepSent = false;
    this.lastActivity = Date.now();
    const fresh = this.notifications.slice(-Math.min(this.undigested, 8));
    this.undigested = 0;
    if (fresh.length === 0) {
      this.whisper("No new notifications since you last spoke with the user.");
    } else {
      this.whisper(
        `${fresh.length} new notification${fresh.length > 1 ? "s" : ""}, newest last: ${fresh.map(notifLine).join("; ")}.`,
      );
    }
    if (this.task) this.whisper(`Still working on: ${this.task.title}.`);
  }

  private async onHeard(text: string) {
    this.lastActivity = Date.now();
    this.sleepSent = false;
    this.awake = true;
    this.convo.push({ who: "user", text });
    if (this.convo.length > 12) this.convo.splice(0, this.convo.length - 12);

    // Instant cancel, before any model call.
    if (isCancel(text) && text.split(/\s+/).length <= 8) {
      if (this.task || this.call) {
        this.cancel();
        return;
      }
      // Nothing running: just stop Bobby talking.
      if (/^\W*(stop|cancel|never ?mind)\W*$/i.test(text)) {
        this.send({ type: "hush", to: "mouth" });
        return;
      }
    }

    const r = await this.o.model({
      purpose: "decide",
      system: this.decideSys,
      user: this.decideInput(text),
      schema: DECIDE_SCHEMA,
    });
    if (this.stopped) return;
    const d = r.json;
    if (!d) {
      await this.say("Sorry, something went wrong on my side. Could you say that again?");
      return;
    }
    switch (d.action) {
      case "chat":
        this.whisper(String(d.whisper ?? ""));
        break;
      case "sleep":
        this.whisper(String(d.whisper ?? ""));
        if (!this.task && !this.call) this.sendSleep();
        break;
      case "cancel":
        this.cancel();
        break;
      case "task": {
        if (this.task) {
          this.cancel(true);
          await this.taskDone;
        }
        this.whisper(String(d.whisper ?? ""));
        const steps: PlanStep[] = (Array.isArray(d.steps) ? d.steps : []).map((s: any, i: number) => ({
          n: i + 1,
          do: String(s.do ?? ""),
          why: String(s.why ?? ""),
        }));
        this.startTask(String(d.title || "Task"), String(d.goal || text), steps);
        break;
      }
      case "call":
        void this.startCall(String(d.call_name ?? ""), String(d.call_goal || text), String(d.whisper ?? ""));
        break;
    }
  }

  private decideInput(heard: string): string {
    const lines: string[] = [];
    lines.push(`The user just said: "${heard}"`);
    lines.push("");
    if (this.task) lines.push(`Running task: ${this.task.title} (goal: ${this.task.goal})`);
    else lines.push("Running task: none");
    lines.push(this.call ? `Call in progress: to ${this.call.name}` : "Call in progress: none");
    lines.push(`Contacts Bobby may call: ${Object.keys(this.o.contacts).join(", ") || "none"}`);
    const notifs = this.notifications.slice(-8);
    lines.push(
      notifs.length
        ? `Recent notifications, newest last:\n${notifs.map((n) => `- ${notifLine(n)} (${ago(n.at)})`).join("\n")}`
        : "Recent notifications: none",
    );
    if (this.facts.length) lines.push(`What has happened so far:\n${this.facts.slice(-5).map((f) => `- ${f}`).join("\n")}`);
    const convo = this.convo.slice(-9, -1);
    if (convo.length) lines.push(`Recent conversation:\n${convo.map((c) => `${c.who === "user" ? "User" : "Bobby"}: ${c.text}`).join("\n")}`);
    return lines.join("\n");
  }

  // ---------- tasks ----------

  private startTask(title: string, goal: string, plan: PlanStep[]) {
    if (!this.peers.hands) {
      void this.say("The phone isn't ready yet, so I can't do that right now.");
      this.facts.push(`Couldn't start "${title}": the phone wasn't ready.`);
      return;
    }
    this.taskSeq += 1;
    const task: Task = {
      id: `t${this.taskSeq}`,
      title,
      goal,
      plan,
      stepStatus: {},
      history: [],
      cancelled: false,
      correctedOnce: false,
    };
    this.task = task;
    this.o.log(`mind: task ${task.id} "${title}": ${goal}`);
    this.watch({ type: "task", task: task.id, title, status: "started" });
    this.publishPlan(task);
    this.whisper(`Task started: ${title}. You will be given lines to say as it goes.`);
    this.taskDone = this.runTask(task).catch((e) => {
      this.o.log(`mind: task crashed: ${String(e?.stack ?? e)}`);
      this.finishTask(task, "failed", "Sorry, something went wrong and I had to stop.");
    });
  }

  private publishPlan(task: Task) {
    this.watch({ type: "plan", task: task.id, steps: task.plan.map((s) => ({ n: s.n, do: s.do, why: s.why })) });
  }

  private setStep(task: Task, n: number, status: "running" | "done" | "failed") {
    if (!task.plan.some((s) => s.n === n)) return;
    if (task.stepStatus[n] === status) return;
    task.stepStatus[n] = status;
    this.watch({ type: "step", task: task.id, n, status });
  }

  /** Moves the dashboard to step n: earlier running steps are done, n is running. */
  private advanceTo(task: Task, n: number) {
    for (const s of task.plan) {
      if (s.n < n && task.stepStatus[s.n] === "running") this.setStep(task, s.n, "done");
    }
    this.setStep(task, n, "running");
  }

  private async readScreen(): Promise<Msg | null> {
    const id = this.o.hub.nextId();
    const wait = this.o.hub.waitFor(id, this.o.timing.actMs);
    this.send({ type: "screen", to: "hands", id });
    const r = await wait;
    return r && r.type === "screen_result" ? r : null;
  }

  private async runTask(task: Task) {
    let fails = 0;
    let modelFails = 0;
    let lastSay: Promise<void> = Promise.resolve();
    let lastKey = "";
    let lastActionSig = "";
    let lastFailed = false;

    for (let i = 0; i < MAX_STEPS; i++) {
      if (task.cancelled || this.stopped) return this.finishCancelled(task, lastSay);

      const screen = await this.readScreen();
      if (task.cancelled) return this.finishCancelled(task, lastSay);
      if (!screen) {
        fails += 1;
        task.history.push({ action: "read the screen", result: "failed: no answer from the phone", say: "" });
        if (fails >= 3) return this.finishTask(task, "failed", "I can't see the phone's screen right now, so I've stopped.", lastSay);
        await sleep(500);
        continue;
      }
      const key = screenKey(screen);
      const unchanged = i > 0 && key === lastKey;
      lastKey = key;

      const r = await this.o.model({
        purpose: "step",
        system: this.stepSys,
        user: this.stepInput(task, screen, unchanged, lastFailed),
        schema: STEP_SCHEMA,
      });
      if (task.cancelled) return this.finishCancelled(task, lastSay);
      const d = r.json;
      if (!d) {
        modelFails += 1;
        if (modelFails >= 3) return this.finishTask(task, "failed", "I'm having trouble thinking this through, so I've stopped.", lastSay);
        continue;
      }
      modelFails = 0;

      if (Array.isArray(d.plan) && d.plan.length > 0) {
        task.plan = d.plan.map((s: any, k: number) => ({ n: k + 1, do: String(s.do ?? ""), why: String(s.why ?? "") }));
        task.stepStatus = {};
        this.publishPlan(task);
      }
      const stepN = Number.isInteger(d.step) && d.step > 0 ? d.step : 1;

      if (d.status === "done") {
        for (const s of task.plan) if (task.stepStatus[s.n] !== "done") this.setStep(task, s.n, "done");
        return this.finishTask(task, "done", String(d.say || "All done."), lastSay);
      }
      if (d.status === "failed") {
        this.setStep(task, stepN, "failed");
        return this.finishTask(task, "failed", String(d.say || "Sorry, I couldn't get that done."), lastSay);
      }

      const built = buildAct(d, screen);
      if ("error" in built) {
        task.history.push({ action: describeDecision(d, screen), result: `not done: ${built.error}`, say: "" });
        fails += 1;
        lastFailed = true;
        if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task, lastSay);
        continue;
      }
      const sig = JSON.stringify(built.act) + "|" + key;
      if (sig === lastActionSig && lastFailed) {
        task.history.push({
          action: describeDecision(d, screen),
          result: "not done: this exact action just failed on this same screen; choose something different",
          say: "",
        });
        fails += 1;
        if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task, lastSay);
        continue;
      }
      lastActionSig = sig;

      // Wait for Bobby to finish the previous line, then speak and act at the same instant.
      await lastSay;
      if (task.cancelled) return this.finishCancelled(task, Promise.resolve());
      this.advanceTo(task, stepN);
      const actId = this.o.hub.nextId();
      const actWait = this.o.hub.waitFor(actId, this.o.timing.actMs);
      const sayText = String(d.say ?? "");
      lastSay = this.say(sayText);
      this.send({ type: "act", to: "hands", id: actId, ...built.act });
      const res = await actWait;
      const desc = describeDecision(d, screen);
      if (!res) {
        task.history.push({ action: desc, result: "failed: timeout (no answer within 10 s)", say: sayText });
        fails += 1;
        lastFailed = true;
      } else if (res.ok) {
        task.history.push({ action: desc, result: "ok", say: sayText });
        fails = 0;
        lastFailed = false;
      } else {
        task.history.push({ action: desc, result: `failed: ${res.error ?? "unknown"}`, say: sayText });
        fails += 1;
        lastFailed = true;
      }
      if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task, lastSay);
    }
    return this.finishTask(task, "failed", "This is taking too many steps, so I've stopped. Sorry about that.", lastSay);
  }

  private giveUp(task: Task, lastSay: Promise<void>) {
    const n = Object.keys(task.stepStatus).map(Number).sort((a, b) => b - a)[0];
    if (n) this.setStep(task, n, "failed");
    return this.finishTask(task, "failed", "I keep hitting a wall on the phone, so I've stopped trying. Sorry.", lastSay);
  }

  private stepInput(task: Task, screen: Msg, unchanged: boolean, lastFailed: boolean): string {
    const lines: string[] = [];
    lines.push(`Task: ${task.title}`);
    lines.push(`Goal: ${task.goal}`);
    lines.push("Plan:");
    for (const s of task.plan) {
      const st = task.stepStatus[s.n];
      lines.push(`${s.n}. ${s.do} (why: ${s.why})${st ? ` [${st}]` : ""}`);
    }
    const h = task.history;
    if (h.length === 0) lines.push("So far: nothing yet. This is the first action.");
    else {
      lines.push("So far:");
      const start = Math.max(0, h.length - 10);
      if (start > 0) lines.push(`(${start} earlier actions not shown)`);
      h.slice(start).forEach((e, k) => {
        lines.push(`${start + k + 1}. ${e.action} -> ${e.result}${e.say ? `. Bobby said: "${e.say}"` : ""}`);
      });
    }
    if (lastFailed) lines.push("Note: the last action failed. Look at the screen fresh and try something different.");
    if (unchanged) lines.push("Note: the screen did not change after the last action.");
    lines.push("");
    lines.push("Current screen:");
    lines.push(describeScreen(screen));
    return lines.join("\n");
  }

  private async finishTask(task: Task, status: "done" | "failed", line: string, lastSay: Promise<void> = Promise.resolve()) {
    if (this.task !== task) return;
    await lastSay;
    if (this.task !== task) return;
    this.o.log(`mind: task ${task.id} ${status}: ${line}`);
    this.task = null;
    this.watch({ type: "task", task: task.id, title: task.title, status });
    this.facts.push(`Task "${task.title}" ${status === "done" ? "finished" : "failed"}: ${line}`);
    this.lastActivity = Date.now();
    await this.say(line);
  }

  private async finishCancelled(task: Task, lastSay: Promise<void>) {
    if (this.task !== task) return;
    this.task = null;
    this.send({ type: "cursor", to: "hands", show: false });
    const running = Object.entries(task.stepStatus).find(([, s]) => s === "running");
    if (running) this.setStep(task, Number(running[0]), "failed");
    this.watch({ type: "task", task: task.id, title: task.title, status: "cancelled" });
    const last = task.history[task.history.length - 1];
    const fact = `Task "${task.title}" was cancelled by the user${last ? ` after: ${last.action}` : " before any action"}. Nothing more will happen on the phone.`;
    this.facts.push(fact);
    this.o.log(`mind: task ${task.id} cancelled`);
    if (!task.quiet) this.whisper(fact);
    this.lastActivity = Date.now();
    void lastSay;
  }

  /** Stop the running task (after its current action) and/or tell Bobby about the call. */
  private cancel(quiet = false) {
    if (this.task) {
      this.task.cancelled = true;
      this.task.quiet = quiet;
      if (!quiet) this.send({ type: "hush", to: "mouth" });
    } else if (this.call) {
      this.whisper(`The call to ${this.call.name} can't be stopped from here; it will end on its own.`);
    }
  }

  // ---------- calls ----------

  private lookup(name: string): [string, string] | null {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    const entries = Object.entries(this.o.contacts);
    const exact = entries.find(([n]) => n.toLowerCase() === q);
    if (exact) return exact;
    const first = entries.find(([n]) => n.toLowerCase().split(/\s+/)[0] === q.split(/\s+/)[0]);
    return first ?? null;
  }

  private async startCall(name: string, goal: string, whisper: string) {
    const found = this.lookup(name);
    if (!found) {
      this.facts.push(`No number for ${name}, so no call was made.`);
      await this.say(`I don't have a number for ${name || "them"}.`);
      return;
    }
    const [who, number] = found;
    if (!this.peers.caller) {
      this.facts.push(`Couldn't call ${who}: the calling part wasn't connected.`);
      await this.say(`I can't make calls right now, so I couldn't ring ${who}.`);
      return;
    }
    if (this.call) {
      await this.say(`I'm already on a call with ${this.call.name}.`);
      return;
    }
    this.whisper(whisper);
    this.taskSeq += 1;
    const id = this.o.hub.nextId();
    const call: Call = { id, taskId: `t${this.taskSeq}`, name: who, number, goal, correctedOnce: false };
    this.call = call;
    const title = `Call ${who}`;
    this.watch({ type: "task", task: call.taskId, title, status: "started" });
    this.watch({ type: "plan", task: call.taskId, steps: [{ n: 1, do: `Call ${who}`, why: goal }] });
    this.watch({ type: "step", task: call.taskId, n: 1, status: "running" });
    const result = this.o.hub.waitFor(id, this.o.timing.callMs);
    this.send({
      type: "call",
      to: "caller",
      id,
      number,
      goal,
      context: `You are speaking as the phone's owner. ${who} is someone they know and expects this call.`,
    });
    this.o.log(`mind: calling ${who} (${number}): ${goal}`);
    void this.say(`I'm calling ${who} now.`);
    const r = await result;
    if (this.call !== call) return;
    this.call = null;
    this.lastActivity = Date.now();
    let line: string;
    let ok = false;
    if (!r) line = `The call to ${who} didn't finish in time, so I don't know how it went.`;
    else if (r.ok) {
      ok = true;
      line = `I spoke to ${who}. ${String(r.summary ?? "").trim() || "The call went fine."}`;
    } else line = `I couldn't get through to ${who}: ${callError(String(r.error ?? "failed"))}.`;
    this.watch({ type: "step", task: call.taskId, n: 1, status: ok ? "done" : "failed" });
    this.watch({ type: "task", task: call.taskId, title, status: ok ? "done" : "failed" });
    this.facts.push(`Call to ${who}: ${line}`);
    await this.say(line);
  }

  // ---------- corrections ----------

  private onSpoke(text: string) {
    this.lastActivity = Date.now();
    // Bobby speaking a line the Mind gave him is not a claim to check.
    const now = Date.now();
    if (this.recentSays.some((s) => now - s.at < 60_000 && similar(s.text, text))) return;
    this.convo.push({ who: "bobby", text });
    if (this.convo.length > 12) this.convo.splice(0, this.convo.length - 12);

    const claimsDone = /\b(done|sent|finished|all set|completed|replied|it'?s on its way)\b/i.test(text);
    if (this.task && claimsDone && !this.task.correctedOnce && !/\b(not|n't|almost|until|once|when)\b/i.test(text)) {
      this.task.correctedOnce = true;
      this.correct(`That isn't finished yet; I'm still working on: ${this.task.title}.`);
      return;
    }
    if (this.call && !this.call.correctedOnce && /\b(said|says|told me|agreed|picked up|answered)\b/i.test(text)) {
      this.call.correctedOnce = true;
      this.correct(`The call to ${this.call.name} is still going; I don't know what they said yet.`);
      return;
    }
    // Times: if Bobby names a time that contradicts the one fact we hold, correct it.
    const spokenTimes = times(text);
    if (spokenTimes.length) {
      const known = times([this.task?.goal ?? "", ...this.facts.slice(-3), ...this.convo.filter((c) => c.who === "user").map((c) => c.text)].join(" "));
      const uniq = [...new Set(known)];
      if (uniq.length === 1 && spokenTimes.every((t) => t !== uniq[0])) {
        this.correct(`The time is ${uniq[0]}, not ${spokenTimes[0]}.`);
      }
    }
  }

  private correct(text: string) {
    if (!this.peers.mouth) return;
    this.o.log(`mind: correct: ${text}`);
    this.send({ type: "correct", to: "mouth", text });
  }

  // ---------- sleeping ----------

  private sendSleep() {
    if (!this.peers.mouth || this.sleepSent) return;
    this.sleepSent = true;
    this.awake = false;
    this.o.log("mind: sleep");
    this.send({ type: "sleep", to: "mouth" });
  }

  private tick() {
    if (!this.awake || this.task || this.call || this.pendingSays.size > 0) return;
    if (Date.now() - this.lastActivity >= this.o.timing.sleepMs) this.sendSleep();
  }
}

// ---------- helpers ----------

function notifLine(n: Notif): string {
  return `${appLabel(n.app)} from ${n.title}: "${n.text}"`;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function callError(e: string): string {
  switch (e) {
    case "no_answer":
      return "nobody answered";
    case "busy":
      return "the line was busy";
    case "not_allowed":
      return "that number isn't on the allowed list";
    default:
      return "the call failed";
  }
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

/** True when two lines share most of their words (Bobby may rephrase lightly). */
function similar(a: string, b: string): boolean {
  const wa = new Set(words(a));
  const wb = words(b);
  if (wa.size === 0 || wb.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = wb.filter((w) => wa.has(w)).length;
  return shared / Math.max(wa.size, wb.length) >= 0.5;
}

/** Clock times mentioned in text, normalised to "3", "3:20". */
function times(s: string): string[] {
  const out: string[] = [];
  const re = /\b(?:at|to|by|push(?:ed)? to|until|around)\s+(\d{1,2})(?::(\d{2}))?\s*(?:am|pm|o'clock)?\b|\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const h = m[1] ?? m[3];
    const mm = m[2] ?? m[4];
    out.push(mm && mm !== "00" ? `${Number(h)}:${mm}` : `${Number(h)}`);
  }
  return out;
}

type BuiltAct = { act: Record<string, unknown> } | { error: string };

/** Turns the model's step reply into a contract `act` (without type/to/id). */
export function buildAct(d: any, screen: Msg): BuiltAct {
  const nodes: ScreenNode[] = Array.isArray(screen.nodes) ? screen.nodes : [];
  const n = Number.isInteger(d.n) ? d.n : -1;
  const node = n >= 0 ? nodes.find((x) => x.n === n) : undefined;
  if (n >= 0 && !node) return { error: `there is no node ${n} on this screen` };
  const on = node ? { n } : undefined;
  switch (d.do) {
    case "tap":
    case "long_press":
      if (!on) return { error: `${d.do} needs a node` };
      return { act: { type: "act", do: d.do, on } };
    case "type":
      if (typeof d.text !== "string" || !d.text) return { error: "type needs text" };
      return { act: { type: "act", do: "type", text: d.text, ...(on ? { on } : {}) } };
    case "swipe":
      if (!["left", "right", "up", "down"].includes(d.dir)) return { error: "swipe needs a direction" };
      return { act: { type: "act", do: "swipe", dir: d.dir, ...(on ? { on } : {}) } };
    case "key":
      if (!["home", "back", "recents", "notifications", "enter"].includes(d.key)) return { error: "key needs a name" };
      return { act: { type: "act", do: "key", name: d.key } };
    case "launch":
      if (!d.app) return { error: "launch needs an app" };
      return { act: { type: "act", do: "launch", app: d.app } };
    case "wait": {
      const ms = Math.max(100, Math.min(5000, Number(d.ms) || 1000));
      return { act: { type: "act", do: "wait", ms } };
    }
    default:
      return { error: `unknown action "${d.do}"` };
  }
}

/** A short description of an action for the history, e.g. tap [7] "Gmail". */
function describeDecision(d: any, screen: Msg): string {
  const nodes: ScreenNode[] = Array.isArray(screen.nodes) ? screen.nodes : [];
  const node = Number.isInteger(d.n) && d.n >= 0 ? nodes.find((x) => x.n === d.n) : undefined;
  const label = node ? ` "${(node.text || node.desc || "").slice(0, 60)}"` : "";
  const where = `on ${appLabel(screen.app)}`;
  switch (d.do) {
    case "tap":
    case "long_press":
      return `${d.do}${label} ${where}`;
    case "type":
      return `type "${d.text}"${label ? ` into${label}` : ""} ${where}`;
    case "swipe":
      return `swipe ${d.dir} ${where}`;
    case "key":
      return `press ${d.key} ${where}`;
    case "launch":
      return `launch ${d.app}`;
    case "wait":
      return `wait ${d.ms} ms`;
    default:
      return String(d.do);
  }
}
