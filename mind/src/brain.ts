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
  /** Bobby already said "give me a second" in this task. */
  stalled?: boolean;
  correctedOnce: boolean;
  correctedName?: boolean;
  /** Resolves the moment the task is cancelled, so waits can be abandoned at once. */
  cancelSignal: Promise<void>;
  fireCancel: () => void;
};

type Call = { id: string; taskId: string; name: string; number: string; goal: string; correctedOnce: boolean; correctedName?: boolean };

const MAX_STEPS = 25;
const MAX_CONSECUTIVE_FAILS = 4;
const CANCEL_RE = /\b(stop|cancel|never ?mind|abort|forget it|don'?t do (it|that))\b/i;
/** Returned by a wait that was abandoned because the task was cancelled. */
const CANCELLED: unique symbol = Symbol("cancelled");
/** First-person or plain claims that the job is finished ("all done", "I've sent it", "it's sent"). */
const DONE_RE =
  /\b(all (done|set)|(it|that|this)('?s| is| has been) (done|sent|finished|on its way)|i('?m| am) (done|finished)|i('?ve| have)? (just |already )?(sent|finished|replied|completed)|(message|email|reply|text) (is|was|has been) sent)\b|^\W*(done|sent|finished)\W*$/i;

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
  /** Recent whispers: things Bobby has been told, so they count as known when checking what he says. */
  private recentWhispers: string[] = [];
  private lastSayDoneAt = 0;
  /** The user spoke and Bobby hasn't answered yet: his next unrecognised line is his own. */
  private answerPending = false;
  /** Bumped by every "stop": a decision started before it must not start anything. */
  private epoch = 0;
  private decidesInFlight = 0;
  /** Waits on Hands (screen, act), so they can be released the moment Hands drops. */
  private handsWaits = new Set<string>();
  /** When set, send `sleep` at this time (lets Bobby finish his goodbye). */
  private sleepAt = 0;
  /** Push-to-talk feel: once Bobby has answered a chat turn, go to sleep. */
  private sleepAfterReply = false;
  /** Things the Mind knows are true, newest last, for corrections and for "what happened?". */
  facts: string[] = [];
  private ticker: ReturnType<typeof setInterval>;
  private decideSys: string;
  private stepSys: string;
  private stopped = false;
  /** Resolves when the current task loop ends. Tests await it. */
  taskDone: Promise<void> = Promise.resolve();
  /** Open from a `wake` until one command has been taken: only then does `heard` count. */
  private listening = false;
  /** `heard` texts of the command being collected (the user may pause mid-sentence). */
  private pendingHeard: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: BrainOptions) {
    this.decideSys = decideSystem(o.hints);
    this.stepSys = stepSystem(o.hints);
    this.ticker = setInterval(() => this.tick(), 500);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.listenTimer) clearTimeout(this.listenTimer);
    if (this.task) {
      this.task.cancelled = true;
      this.task.fireCancel();
    }
  }

  // ---------- sending ----------

  private send(m: Msg) {
    this.o.hub.send(m);
  }

  private whisper(text: string) {
    if (!text.trim() || !this.peers.mouth) return;
    this.o.log(`mind: whisper: ${text}`);
    this.recentWhispers.push(text);
    if (this.recentWhispers.length > 12) this.recentWhispers.shift();
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
      this.lastSayDoneAt = Date.now();
    });
    this.send({ type: "say", to: "mouth", id, text });
    return done;
  }

  /** Resolves once no `say` is outstanding, or after `ms`. */
  private async quiet(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.pendingSays.size > 0 && Date.now() < end && !this.stopped) await sleep(30);
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
        if (!m.mouth) {
          this.awake = false;
          this.endWindow();
          // Nobody will send say_done now: don't make anything wait for it.
          for (const id of [...this.pendingSays]) this.o.hub.cancelWait(id);
        }
        if (!m.hands) for (const id of [...this.handsWaits]) this.o.hub.cancelWait(id);
        if (!m.caller && this.call) this.o.hub.cancelWait(this.call.id);
        break;
      case "notification":
        this.onNotification(m);
        break;
      case "wake":
        this.onWake();
        break;
      case "asleep":
        this.awake = false;
        this.endWindow();
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
    this.sleepAt = 0;
    this.lastActivity = Date.now();
    this.peers.mouth = true; // a wake can only come from a connected Mouth
    // Note: slice(-0) would return everything, so zero is handled on its own.
    const count = Math.min(this.undigested, 8);
    const fresh = count > 0 ? this.notifications.slice(-count) : [];
    this.undigested = 0;
    if (fresh.length === 0) {
      this.whisper("No new notifications since you last spoke with the user.");
    } else {
      this.whisper(
        `${fresh.length} new notification${fresh.length > 1 ? "s" : ""}, newest last: ${fresh.map(notifLine).join("; ")}.`,
      );
    }
    if (this.task) this.whisper(`Still working on: ${this.task.title}.`);
    if (this.call) this.whisper(`Still on the call to ${this.call.name}; no result yet.`);
    this.openWindow();
  }

  // ---------- listening windows: one command per press ----------

  private openWindow() {
    this.listening = true;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
    if (this.pendingHeard.length > 0) return; // still collecting: the debounce will take it
    this.listenTimer = setTimeout(() => {
      this.listenTimer = null;
      if (this.listening && this.pendingHeard.length === 0) {
        this.listening = false;
        this.lastActivity = Date.now();
        this.o.log("mind: listening window closed, nothing heard");
      }
    }, this.o.timing.listenMs);
  }

  /** The Mouth went to sleep or away: take whatever was heard, then stop listening. */
  private endWindow() {
    if (this.pendingHeard.length > 0) this.flushCommand();
    this.listening = false;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
  }

  private closeWindow() {
    this.listening = false;
    this.pendingHeard = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.debounceTimer = null;
    this.listenTimer = null;
  }

  /** The user went quiet: the collected `heard`s are one command, decided once. */
  private flushCommand() {
    const text = this.pendingHeard.join(" ").replace(/\s+/g, " ").trim();
    this.closeWindow();
    if (!text || this.stopped) return;
    this.o.log(`mind: command: ${text}`);
    void this.decide(text);
  }

  private onHeard(text: string) {
    // Room chatter, the user talking to friends, Bobby's own echo: only a press opens the mic.
    if (!this.listening) {
      this.o.log(`mind: ignored heard (outside a listening window): ${text}`);
      return;
    }
    this.lastActivity = Date.now();
    this.sleepSent = false;
    this.sleepAt = 0;
    this.sleepAfterReply = false;
    this.awake = true;
    this.answerPending = true;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;

    // Instant cancel, before any model call.
    if (isCancel(text) && text.split(/\s+/).length <= 8) {
      const hadPending = this.pendingHeard.length > 0;
      const deciding = this.decidesInFlight > 0 || hadPending;
      if (this.task || this.call || deciding || /^\W*(stop|cancel|never ?mind)\W*$/i.test(text)) {
        this.closeWindow();
        this.pushConvo("user", text);
      }
      if (this.task || this.call || deciding) {
        // Anything still being decided was asked for before this "stop": it must not start.
        this.epoch += 1;
        if (this.task || this.call) this.cancel();
        else {
          this.send({ type: "hush", to: "mouth" });
          this.whisper("The user said stop before anything began. Nothing was started on the phone.");
          this.facts.push("The user said stop before the last request began, so nothing was done.");
        }
        return;
      }
      // Nothing running: just stop Bobby talking.
      if (/^\W*(stop|cancel|never ?mind)\W*$/i.test(text)) {
        this.send({ type: "hush", to: "mouth" });
        return;
      }
    }

    // Collect until the user has been quiet for a moment, then decide once on the whole command.
    this.pendingHeard.push(text);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushCommand();
    }, this.o.timing.commandMs);
  }

  private pushConvo(who: "user" | "bobby", text: string) {
    this.convo.push({ who, text });
    if (this.convo.length > 12) this.convo.splice(0, this.convo.length - 12);
  }

  private async decide(text: string) {
    this.answerPending = true;
    this.pushConvo("user", text);
    const epoch = this.epoch;
    this.decidesInFlight += 1;
    const r = await this.o.model({
      purpose: "decide",
      system: this.decideSys,
      user: this.decideInput(text),
      schema: DECIDE_SCHEMA,
      timeoutMs: 20_000,
    }).finally(() => {
      this.decidesInFlight -= 1;
    });
    if (this.stopped) return;
    const d = r.json;
    if (epoch !== this.epoch) {
      this.o.log(`mind: dropped a decision made before the user said stop (${d?.action ?? "none"})`);
      return;
    }
    if (!d) {
      await this.say("Hm, something broke on my end. Try again in a sec.");
      this.sleepSoon();
      return;
    }
    switch (d.action) {
      case "chat":
        this.whisper(String(d.whisper ?? ""));
        // Bobby answers by himself; once he has (onSpoke), the session ends.
        if (this.answerPending) this.sleepAfterReply = true;
        else this.sleepSoon();
        break;
      case "sleep":
        this.whisper(String(d.whisper ?? ""));
        // Give Bobby a moment to say goodbye before the session ends.
        if (!this.task && !this.call) this.sleepAt = Date.now() + this.o.timing.goodbyeMs;
        break;
      case "cancel":
        this.epoch += 1;
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
        this.startTask(String(d.title || "Task"), String(d.goal || text), steps, String(d.say ?? ""));
        break;
      }
      case "call":
        void this.startCall(String(d.call_name ?? ""), String(d.call_goal || text), String(d.whisper ?? ""), String(d.say ?? ""));
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

  private startTask(title: string, goal: string, plan: PlanStep[], opening = "") {
    if (!this.peers.hands) {
      void this.say("The phone isn't ready yet, so I can't do that right now.");
      this.facts.push(`Couldn't start "${title}": the phone wasn't ready.`);
      return;
    }
    this.taskSeq += 1;
    let fireCancel = () => {};
    const cancelSignal = new Promise<void>((resolve) => (fireCancel = resolve));
    const task: Task = {
      id: `t${this.taskSeq}`,
      title,
      goal,
      plan,
      stepStatus: {},
      history: [],
      cancelled: false,
      correctedOnce: false,
      cancelSignal,
      fireCancel,
    };
    this.task = task;
    this.o.log(`mind: task ${task.id} "${title}": ${goal}`);
    this.watch({ type: "task", task: task.id, title, status: "started" });
    this.publishPlan(task);
    this.whisper(`Task started: ${title}. You will be given lines to say as it goes.`);
    // The opening line plays while the first step is being worked out. It names only the first
    // action ("Finding Gmail."); a long plan overview is dropped.
    if (opening.trim().split(/\s+/).length > 8) {
      this.o.log(`mind: dropped a long opening line: ${opening}`);
      opening = "";
    }
    void this.say(opening);
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

  /** A wait on Hands that is released early if Hands drops off the hub. */
  private waitHands(id: string): Promise<Msg | null> {
    if (!this.peers.hands) return Promise.resolve(null); // already gone: nothing will answer
    this.handsWaits.add(id);
    return this.o.hub.waitFor(id, this.o.timing.actMs).finally(() => this.handsWaits.delete(id));
  }

  private async readScreen(): Promise<(Msg & { readAt: number }) | null> {
    const id = this.o.hub.nextId();
    const wait = this.waitHands(id);
    this.send({ type: "screen", to: "hands", id });
    const r = await wait;
    return r && r.type === "screen_result" ? { ...r, readAt: Date.now() } : null;
  }

  /** Waits for `p`, or gives up at once (returning CANCELLED) if the task is cancelled first. */
  private untilCancelled<T>(task: Task, p: Promise<T>): Promise<Awaited<T> | typeof CANCELLED> {
    return Promise.race([p, task.cancelSignal.then((): typeof CANCELLED => CANCELLED)]);
  }

  private async runTask(task: Task) {
    let fails = 0;
    let modelFails = 0;
    let lastKey = "";
    let lastActionSig = "";
    let lastFailed = false;
    let lastError = "";
    let retriedTimeout = false;

    for (let i = 0; i < MAX_STEPS; i++) {
      if (task.cancelled || this.stopped) return this.finishCancelled(task);
      if (!this.peers.hands) {
        return this.finishTask(task, "failed", "I've lost touch with the phone, so I had to stop.");
      }

      const screen = await this.untilCancelled(task, this.readScreen());
      if (screen === CANCELLED || task.cancelled) return this.finishCancelled(task);
      if (!screen) {
        fails += 1;
        task.history.push({ action: "read the screen", result: "failed: no answer from the phone", say: "" });
        if (fails >= 3) return this.finishTask(task, "failed", "I can't see the phone's screen right now, so I've stopped.");
        await sleep(500);
        continue;
      }
      const key = screenKey(screen);
      const unchanged = i > 0 && key === lastKey;
      lastKey = key;

      // If the model is slow and Bobby has gone quiet, fill the silence once per task.
      const stall = setTimeout(() => {
        if (!task.cancelled && !task.stalled && this.pendingSays.size === 0) {
          task.stalled = true;
          void this.say("One sec.");
        }
      }, this.o.timing.stallMs);
      // A "stop" doesn't wait for a slow model call: the reply is simply ignored.
      const r = await this.untilCancelled(
        task,
        this.o.model({
          purpose: "step",
          system: this.stepSys,
          user: this.stepInput(task, screen, unchanged, lastFailed),
          schema: STEP_SCHEMA,
          timeoutMs: 15_000,
        }),
      );
      clearTimeout(stall);
      if (r === CANCELLED || task.cancelled) return this.finishCancelled(task);
      const d = r.json;
      if (!d) {
        modelFails += 1;
        if (modelFails >= 3) return this.finishTask(task, "failed", "I'm having trouble thinking this through, so I've stopped.");
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
        return this.finishTask(task, "done", String(d.say || "All done."));
      }
      if (d.status === "failed") {
        this.setStep(task, stepN, "failed");
        return this.finishTask(task, "failed", String(d.say || "Sorry, I couldn't get that done."));
      }

      const built = buildAct(d, screen);
      const desc = describeDecision(d, screen);
      if ("error" in built) {
        task.history.push({ action: desc, result: `not done: ${built.error}`, say: "" });
        fails += 1;
        lastFailed = true;
        if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task);
        continue;
      }
      const sig = JSON.stringify(built.act) + "|" + key;
      if (sig === lastActionSig && lastFailed && !(lastError === "timeout" && !retriedTimeout)) {
        task.history.push({
          action: desc,
          result: "not done: this exact action just failed on this same screen; choose something different",
          say: "",
        });
        fails += 1;
        if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task);
        continue;
      }
      retriedTimeout = sig === lastActionSig && lastFailed;
      lastActionSig = sig;

      // Narration never piles up: at most one line outstanding. A line that would have to queue
      // behind the previous one is skipped, except the Send line, which waits for it (briefly).
      const sayText = String(d.say ?? "");
      const isSend = isSendStep(d, screen, sayText);
      if (sayText.trim() && isSend && this.pendingSays.size > 0) {
        if ((await this.untilCancelled(task, this.quiet(this.o.timing.sayWaitMs))) === CANCELLED || task.cancelled) {
          return this.finishCancelled(task);
        }
      }

      // The screen was read before the model thought and Bobby spoke. Node numbers point at where
      // things were then, so if time has passed, look again and find the same target afresh.
      let act = built.act;
      if (act.on && Date.now() - screen.readAt >= this.o.timing.staleMs) {
        const fresh = await this.untilCancelled(task, this.readScreen());
        if (fresh === CANCELLED || task.cancelled) return this.finishCancelled(task);
        const now = fresh && screenKey(fresh) !== key ? findSameNode(screen, d.n, fresh) : d.n;
        if (!fresh || now === null) {
          task.history.push({
            action: desc,
            result: fresh ? "not done: the screen changed before the action and that target is no longer there" : "not done: the phone didn't answer",
            say: "",
          });
          fails += 1;
          lastFailed = true;
          lastError = "stale";
          if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task);
          continue;
        }
        if (now !== d.n) this.o.log(`mind: target moved from node ${d.n} to ${now} while Bobby was speaking`);
        act = { ...act, on: { n: now } };
      }

      // Speak and act at the same instant.
      this.advanceTo(task, stepN);
      const actId = this.o.hub.nextId();
      const actWait = this.waitHands(actId);
      let said = "";
      if (sayText.trim()) {
        if (this.pendingSays.size > 0 && !isSend) this.o.log(`mind: skipped say (previous line still playing): ${sayText}`);
        else {
          void this.say(sayText);
          said = sayText;
        }
      }
      this.send({ ...act, to: "hands", id: actId });
      // A "stop" takes effect after the current action, so this wait is not abandoned.
      const res = await actWait;
      if (!res) {
        task.history.push({ action: desc, result: "failed: timeout (no answer from the phone)", say: said });
        fails += 1;
        lastFailed = true;
        lastError = "timeout";
      } else if (res.ok) {
        task.history.push({ action: desc, result: "ok", say: said });
        fails = 0;
        lastFailed = false;
        lastError = "";
      } else {
        task.history.push({ action: desc, result: `failed: ${res.error ?? "unknown"}`, say: said });
        fails += 1;
        lastFailed = true;
        lastError = String(res.error ?? "unknown");
      }
      if (fails >= MAX_CONSECUTIVE_FAILS) return this.giveUp(task);
    }
    return this.finishTask(task, "failed", "This is taking too many steps, so I've stopped. Sorry about that.");
  }

  private giveUp(task: Task) {
    const n = Object.keys(task.stepStatus).map(Number).sort((a, b) => b - a)[0];
    if (n) this.setStep(task, n, "failed");
    return this.finishTask(task, "failed", "I keep hitting a wall on the phone, so I've stopped trying. Sorry.");
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

  private async finishTask(task: Task, status: "done" | "failed", line: string) {
    if (this.task !== task) return;
    // The result line is never skipped: let the previous line finish first (up to a few seconds).
    await this.quiet(this.o.timing.sayWaitMs);
    if (this.task !== task) return;
    this.o.log(`mind: task ${task.id} ${status}: ${line}`);
    this.task = null;
    this.watch({ type: "task", task: task.id, title: task.title, status });
    this.facts.push(`Task "${task.title}" ${status === "done" ? "finished" : "failed"}: ${line}`);
    this.lastActivity = Date.now();
    await this.say(line);
    this.sleepSoon();
  }

  private finishCancelled(task: Task) {
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
  }

  /** Stop the running task (after its current action) and/or tell Bobby about the call. */
  private cancel(quiet = false) {
    if (this.task) {
      this.task.cancelled = true;
      this.task.quiet = quiet;
      if (!quiet) this.send({ type: "hush", to: "mouth" });
      this.task.fireCancel();
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

  private async startCall(name: string, goal: string, whisper: string, startLine = "") {
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
    void this.say(startLine && startLine.toLowerCase().includes(who.toLowerCase().split(/\s+/)[0]) ? startLine : `I'm calling ${who} now.`);
    const r = await result;
    if (this.call !== call) return;
    this.call = null;
    this.lastActivity = Date.now();
    let line: string;
    let ok = false;
    if (!r) line = `The call to ${who} didn't finish in time, so I don't know how it went.`;
    else if (r.ok) {
      ok = true;
      const summary = String(r.summary ?? "").trim();
      const first = who.split(/\s+/)[0].toLowerCase();
      line = !summary ? `I spoke to ${who} and the call went fine.` : summary.toLowerCase().includes(first) ? summary : `I spoke to ${who}: ${summary}`;
    } else line = `I couldn't get through to ${who}: ${callError(String(r.error ?? "failed"))}.`;
    this.watch({ type: "step", task: call.taskId, n: 1, status: ok ? "done" : "failed" });
    this.watch({ type: "task", task: call.taskId, title, status: ok ? "done" : "failed" });
    this.facts.push(`Call to ${who}: ${line}`);
    await this.quiet(this.o.timing.sayWaitMs);
    await this.say(line);
    this.sleepSoon();
  }

  // ---------- corrections ----------

  private onSpoke(text: string) {
    const now = Date.now();
    this.lastActivity = now;
    // Is this a line the Mind gave Bobby, or something he said by himself? Lines he was given
    // are not claims to check. He may rephrase them, so word overlap alone isn't enough: a line
    // that arrives while one of ours is being spoken is ours too, unless the user has just
    // spoken and Bobby hasn't answered them yet (then this is his answer).
    const likeOurs = this.recentSays.some((s) => now - s.at < 60_000 && similar(s.text, text));
    const duringOurs = this.pendingSays.size > 0 || now - this.lastSayDoneAt < 1500;
    if (likeOurs || (duringOurs && !this.answerPending)) return;
    this.answerPending = false;
    if (this.sleepAfterReply) {
      this.sleepAfterReply = false;
      this.sleepSoon();
    }
    this.convo.push({ who: "bobby", text });
    if (this.convo.length > 12) this.convo.splice(0, this.convo.length - 12);

    // 1. Claiming the job is finished while it is still running.
    if (this.task && !this.task.correctedOnce && DONE_RE.test(text) && !/\b(not|n't|almost|until|once|when|soon)\b/i.test(text)) {
      this.task.correctedOnce = true;
      this.correct(`That isn't finished yet; I'm still working on: ${this.task.title}.`);
      return;
    }
    // 2. Reporting what someone said on a call that hasn't ended.
    if (this.call && !this.call.correctedOnce && /\b(said|says|told me|agreed|picked up|answered)\b/i.test(text)) {
      this.call.correctedOnce = true;
      this.correct(`The call to ${this.call.name} is still going; I don't know what they said yet.`);
      return;
    }
    // 3. The wrong person: Bobby names someone else as the one being called or written to.
    const wrong = this.wrongName(text);
    if (wrong) {
      this.correct(`It's ${wrong.right}, not ${wrong.said}.`);
      return;
    }
    // 4. A wrong time: one that appears nowhere in what the Mind knows or has told Bobby, while
    //    what is being talked about right now holds exactly one time.
    const spoken = times(text);
    if (spoken.length === 0) return;
    const userTurns = this.convo.filter((c) => c.who === "user").map((c) => c.text);
    const everything = [
      this.task?.goal ?? "",
      this.call?.goal ?? "",
      ...this.facts,
      ...userTurns,
      ...this.notifications.map((n) => `${n.title} ${n.text}`),
      ...this.recentWhispers,
      ...this.recentSays.map((s) => s.text),
    ].join(" . ");
    const known = new Set(times(everything));
    const unknown = spoken.filter((t) => !known.has(t));
    if (unknown.length === 0) return;
    const focus = [...new Set(times([this.task?.goal ?? "", ...this.facts.slice(-2), ...userTurns.slice(-2)].join(" . ")))];
    if (focus.length === 1) this.correct(`The time is ${focus[0]}, not ${unknown[0]}.`);
  }

  /**
   * If a task or call is about one known person and Bobby says he is calling or writing to a
   * different known person, returns both names. Known people: contacts and notification senders.
   */
  private wrongName(text: string): { right: string; said: string } | null {
    const about = this.call ? `${this.call.name}` : this.task ? `${this.task.title} ${this.task.goal}` : "";
    if (!about) return null;
    const flag = this.call ?? this.task!;
    if (flag.correctedName) return null;
    const people = new Set<string>();
    for (const n of Object.keys(this.o.contacts)) people.add(n.split(/\s+/)[0]);
    for (const n of this.notifications) {
      const first = n.title.split(/\s+/)[0];
      if (/^[A-Z][a-z]+$/.test(first)) people.add(first);
    }
    const has = (hay: string, name: string) => new RegExp(`\\b${name}\\b`, "i").test(hay);
    const subjects = [...people].filter((n) => has(about, n));
    if (subjects.length !== 1 || has(text, subjects[0])) return null;
    for (const other of people) {
      if (other === subjects[0]) continue;
      const re = new RegExp(`\\b(call(?:ing|ed)?|ring(?:ing)?|phon(?:e|ing|ed)|repl(?:y|ying|ied) to|email(?:ing|ed)?|text(?:ing|ed)?|messag(?:e|ing|ed)|writ(?:e|ing) to|tell(?:ing)?|told|answer(?:ing)?)\\s+${other}\\b`, "i");
      if (re.test(text)) {
        flag.correctedName = true;
        return { right: subjects[0], said: other };
      }
    }
    return null;
  }

  private correct(text: string) {
    if (!this.peers.mouth) return;
    this.o.log(`mind: correct: ${text}`);
    this.send({ type: "correct", to: "mouth", text });
  }

  // ---------- sleeping ----------

  /** A request has been handled: Bobby only listens again after the side button. */
  private sleepSoon() {
    if (this.task || this.call) return;
    this.sleepAt = Date.now() + this.o.timing.goodbyeMs;
  }

  private sendSleep() {
    if (!this.peers.mouth || this.sleepSent) return;
    this.sleepSent = true;
    this.awake = false;
    this.o.log("mind: sleep");
    this.send({ type: "sleep", to: "mouth" });
  }

  private tick() {
    if (!this.awake || this.task || this.call || this.listening || this.decidesInFlight > 0 || this.pendingSays.size > 0) return;
    const now = Date.now();
    if (this.sleepAt && now >= this.sleepAt) {
      this.sleepAt = 0;
      this.sendSleep();
    } else if (now - this.lastActivity >= this.o.timing.sleepMs) this.sendSleep();
  }
}

// ---------- helpers ----------

/** The step that sends the message: a tap on a Send button, or a line that says so. */
function isSendStep(d: any, screen: Msg, say: string): boolean {
  if (d.do === "tap" && Number.isInteger(d.n)) {
    const nodes: ScreenNode[] = Array.isArray(screen.nodes) ? screen.nodes : [];
    const node = nodes.find((x) => x.n === d.n);
    if (node && /\bsend\b/i.test(`${node.text ?? ""} ${node.desc ?? ""}`)) return true;
  }
  return /^\W*send(ing)?\b/i.test(say);
}

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

/**
 * Finds node `n` of an earlier screen in a newer one: same label, class and flags, nearest in
 * position. Returns its new number, or null when it is gone.
 */
export function findSameNode(old: Msg, n: number, fresh: Msg): number | null {
  const before: ScreenNode[] = Array.isArray(old.nodes) ? old.nodes : [];
  const after: ScreenNode[] = Array.isArray(fresh.nodes) ? fresh.nodes : [];
  const a = before.find((x) => x.n === n);
  if (!a) return null;
  const str = (v: unknown) => String(v ?? "");
  const same = (b: ScreenNode) =>
    str(a.text) === str(b.text) &&
    str(a.desc) === str(b.desc) &&
    str(a.hint) === str(b.hint) &&
    str(a.cls) === str(b.cls) &&
    !!a.tap === !!b.tap &&
    !!a.edit === !!b.edit;
  const centre = (x: ScreenNode) => (x.bounds ? [(x.bounds[0] + x.bounds[2]) / 2, (x.bounds[1] + x.bounds[3]) / 2] : [0, 0]);
  const [ax, ay] = centre(a);
  const dist = (b: ScreenNode) => Math.hypot(centre(b)[0] - ax, centre(b)[1] - ay);
  const found = after.filter(same).sort((p, q) => dist(p) - dist(q))[0];
  if (!found) return null;
  // A node with no label at all is only "the same" if it has barely moved.
  if (!a.text && !a.desc && !a.hint && dist(found) > 60) return null;
  return found.n;
}

type BuiltAct = { act: { type: "act"; do: string; on?: { n: number }; [k: string]: unknown } } | { error: string };

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
  const label = node ? ` "${(node.text || node.desc || node.hint || "").slice(0, 60)}"` : "";
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
