// The brain (v2): turns what the user asked into a queue of tasks, each a list of sub-goals with
// code-checked `done_when`s, and runs them one at a time: shortcut intents first, saved recipes
// next, grounded multi-action batches from the exec model last, escalating to the vision model
// when stuck. Irreversible steps wait for a confirmation, and a choice only the user can make
// becomes one spoken question with options (src/ask.ts). Also: notifications, calls through the
// Caller, corrections, sleeping, and the v1 Mouth messages for compatibility.

import type { HandsAct, ModelFn, Msg, SubgoalSpec, TaskPlan, Timing } from "./types";
import { ROUTER_SCHEMA, TEACH_SCHEMA, checkSystem, escalateSystem, execSystem, routerSystem, teachSystem } from "./prompts";
import { appLabel, checkScreen, fingerprint } from "./screen";
import { Executor, subgoalFromModel, type ActResult, type AskOutcome, type SubgoalResult, type SubgoalRun } from "./exec";
import { cleanQuestion, questionKey, resolveAnswer, spokenQuestion, type Answer, type Question, type RawAnswer } from "./ask";
import { ShortcutIndex, packageFor } from "./shortcuts";
import { escapeRe, findContact, parseContactBook, parseContacts as parseContactsV1, sharedFirstName, type Contact } from "./contacts";
import { InMemoryStore, Memory, type KeyValueStore } from "./memory";
import { RecipeBook } from "./recipes";
import { closeOverlay, firstTargetVisible, runScript } from "./script";
import { SkillBook, buildSkill, cleanMeta, fallbackMeta, forgetIntent, readDemo, teachEnd, teachInput, teachIntent, type TeachMode } from "./teach";

export type HubLike = {
  send(m: Msg): boolean;
  nextId(): string;
  waitFor(id: string, ms: number): Promise<Msg | null>;
  cancelWait(id: string): void;
};

export type ConfirmPolicy = "always" | "unknown_contacts" | "never";

export type BrainOptions = {
  hub: HubLike;
  model: ModelFn;
  log: (line: string) => void;
  hints: string[];
  /** v1 shape (name -> number) or the full contact book. */
  contacts: Record<string, string> | Contact[];
  timing: Timing;
  confirm?: ConfirmPolicy;
  /** Most questions per request before it starts, and again per task while it runs. 0 = never ask. Default 1. */
  askMax?: number;
  storage?: KeyValueStore;
  now?: () => Date;
  /** How taught skills run: script first, then the model with the demo as a guide (default). */
  teachMode?: TeachMode;
};

/** A demo being watched: what was said, and everything Hands has reported so far. */
type Teaching = {
  name: string;
  heard: string;
  notes: string[];
  events: Msg[];
  initial: Msg | null;
  startedAt: number;
  lastActionAt: number;
  actions: number;
  phase: "starting" | "watching" | "ending";
  task: string;
};

type Notif = { app: string; title: string; text: string; at: number };

type TaskStatus = "queued" | "running" | "waiting_confirm" | "waiting_answer" | "paused" | "done" | "failed" | "cancelled";

/** A question already put to the user for this request, and what came of it. */
type Clarified = { q: Question; answer: string; assumed: boolean };

type Task = {
  id: string;
  plan: TaskPlan;
  status: TaskStatus;
  idx: number;
  stepStatus: Record<number, "running" | "done" | "failed">;
  scratch: string[];
  history: string[];
  cancelled: boolean;
  /** Cancelled without a spoken word (replaced). */
  quiet?: boolean;
  /** The user said no to a confirmation. */
  declined?: boolean;
  paused: boolean;
  resume: () => void;
  resumed: Promise<void>;
  amended?: TaskPlan;
  escalationsUsed: number;
  asksUsed: number;
  correctedOnce: boolean;
  correctedName?: boolean;
  cancelSignal: Promise<void>;
  fireCancel: () => void;
  callId?: string;
};

const CANCEL_RE = /\b(stop|cancel|never ?mind|abort|forget it|don'?t do (it|that))\b/i;
const YES_RE = /\b(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|send it|send|post it|call (him|her|them)|confirm(ed)?|correct|please do|go for it|absolutely|definitely|that'?s right|right)\b/i;
const NO_RE = /\b(no|nope|nah|don'?t|do not|stop|cancel|wait|hold on|not yet|never ?mind|change)\b/i;
const CANCELLED: unique symbol = Symbol("cancelled");
const DONE_RE =
  /\b(all (done|set)|(it|that|this)('?s| is| has been) (done|sent|finished|on its way)|i('?m| am) (done|finished)|i('?ve| have)? (just |already )?(sent|finished|replied|completed)|(message|email|reply|text) (is|was|has been) sent)\b|^\W*(done|sent|finished)\W*$/i;
const MAX_ESCALATIONS = 2;
const SUBGOAL_BUDGET = 10;

/** v1 export, kept for callers: name -> E.164 number. */
export const parseContacts = parseContactsV1;

export function isCancel(text: string): boolean {
  return CANCEL_RE.test(text);
}

/** A raw transcript counts as yes only if it says yes and nothing that sounds like no. */
export function isAffirmative(heard: string): boolean {
  return YES_RE.test(heard) && !NO_RE.test(heard);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Brain {
  peers = { hands: false, mouth: false, caller: false };
  /** The Mouth speaks protocol v2 (request/confirm/progress). Learned from `voice_caps` or a v2 message. */
  mouthV2 = false;
  awake = false;
  notifications: Notif[] = [];
  private undigested = 0;
  private convo: { who: "user" | "bobby"; text: string }[] = [];
  current: Task | null = null;
  queue: Task[] = [];
  private taskSeq = 0;
  private lastActivity = Date.now();
  private sleepSent = false;
  private pendingSays = new Set<string>();
  private recentSays: { text: string; at: number }[] = [];
  private recentWhispers: string[] = [];
  private lastSayDoneAt = 0;
  private answerPending = false;
  private epoch = 0;
  private decidesInFlight = 0;
  private handsWaits = new Set<string>();
  private sleepAt = 0;
  private sleepAfterReply = false;
  facts: string[] = [];
  private ticker: ReturnType<typeof setInterval>;
  private routerSys: string;
  private systems: { exec: string; escalate: string; check: string };
  private stopped = false;
  /** Resolves when the queue has drained. Tests await it. */
  taskDone: Promise<void> = Promise.resolve();
  private drained: () => void = () => {};
  private listening = false;
  private pendingHeard: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScreen: Msg | null = null;
  /** Hands' own hash of lastScreen, when it sends one (then `since` can be used). */
  private handsHash = "";
  caps: Msg | null = null;
  private pendingConfirm: { id: string; task: Task; resolve: (r: { ok: boolean; heard: string }) => void } | null = null;
  /** The one question out with the user. `heard` is the raw transcript since it was asked. */
  private pendingAsk: { id: string; task: Task | null; q: Question; heard: string; grace?: ReturnType<typeof setTimeout>; resolve: (a: Answer) => void } | null = null;
  /**
   * The v2 Mouth has the `answer` tool. Assumed until a `voice_caps` says otherwise (it can be
   * missed when the Mouth connects first); a Mouth without it gets the question as a line and
   * answers with `request`.
   */
  private mouthAsks = true;
  private lastHeardRaw = "";
  private bargeTimer: ReturnType<typeof setTimeout> | null = null;
  shortcuts = new ShortcutIndex();
  memory: Memory;
  recipes: RecipeBook;
  skills: SkillBook;
  teaching: Teaching | null = null;
  /** Resolves when the demo that just ended has been turned into a skill (or dropped). Tests await it. */
  teachDone: Promise<void> = Promise.resolve();
  private teachSys = teachSystem();
  private book: Contact[];
  private exec: Executor;
  /** Model calls by role, for the story's numbers. */
  stats = { route: 0, exec: 0, escalate: 0, check: 0, local: 0, recipe: 0, acts: 0, script: 0, teach: 0 };

  constructor(private o: BrainOptions) {
    this.book = Array.isArray(o.contacts) ? o.contacts : Object.entries(o.contacts).map(([name, phone]) => ({ name, phone }));
    this.routerSys = routerSystem(o.hints, this.shortcuts.catalogue());
    this.systems = { exec: execSystem(o.hints), escalate: escalateSystem(o.hints), check: checkSystem() };
    const store = o.storage ?? new InMemoryStore();
    this.memory = new Memory(store, o.log);
    this.recipes = new RecipeBook(this.memory, o.log);
    this.skills = new SkillBook(store, this.shortcuts, o.log, o.teachMode ?? "hybrid");
    // A taught skill is a new line in the router's catalogue.
    this.skills.onChange = () => {
      this.routerSys = routerSystem(o.hints, this.shortcuts.catalogue());
    };
    void this.memory.loaded.then(() => {
      this.facts = [...this.memory.facts.slice(-10), ...this.facts].slice(-40);
    });
    this.ticker = setInterval(() => this.tick(), 500);
    this.exec = new Executor({
      model: o.model,
      log: o.log,
      systems: this.systems,
      readScreen: (opts) => this.readScreen(opts),
      act: (a, opts) => this.act(a, opts),
      narrate: (t) => this.narrate(t),
      gate: () => (this.current ? this.gate(this.current) : Promise.resolve("go")),
      confirm: (summary) => (this.current ? this.confirmGate(this.current, summary) : Promise.resolve(false)),
      ask: (q) => this.askInTask(this.current, q),
      canAsk: () => !!this.current && this.current.asksUsed < this.askMax && this.peers.mouth,
      escalations: {
        left: () => (this.current ? MAX_ESCALATIONS - this.current.escalationsUsed : 0),
        take: () => {
          if (this.current) this.current.escalationsUsed += 1;
        },
      },
      counters: this.stats,
      race: <T,>(p: Promise<T>) => {
        const t = this.current;
        if (!t) return p;
        return Promise.race([p, t.cancelSignal.then(() => null)]);
      },
    });
  }

  /** A thing the Mind knows happened: kept for corrections and the router, persisted in memory. */
  private addFact(f: string) {
    this.facts.push(f);
    if (this.facts.length > 40) this.facts.shift();
    this.memory.addFact(f);
  }

  private get now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  private get policy(): ConfirmPolicy {
    return this.o.confirm ?? "always";
  }

  private get askMax(): number {
    return this.o.askMax ?? 1;
  }

  private contactsCtx() {
    const learned = this.memory.contacts.filter((c) => !this.book.some((b) => b.name === c.name));
    return { contacts: [...this.book, ...learned], now: this.now };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.listenTimer) clearTimeout(this.listenTimer);
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    if (this.teaching) {
      this.send({ type: "observe", to: "hands", id: this.o.hub.nextId(), on: false });
      this.teaching = null;
    }
    this.pendingAsk?.resolve({ kind: "cancel" });
    for (const t of [this.current, ...this.queue]) {
      if (!t) continue;
      t.cancelled = true;
      t.fireCancel();
    }
    this.queue = [];
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

  /** v1: a `say`, resolved when done (or timed out / no Mouth). */
  private say(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    this.o.log(`mind: say: ${text}`);
    this.recentSays.push({ text, at: Date.now() });
    if (this.recentSays.length > 20) this.recentSays.shift();
    this.pushConvo("bobby", text);
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

  private async quiet(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.pendingSays.size > 0 && Date.now() < end && !this.stopped) await sleep(30);
  }

  /** Narration of a step: never piles up, never waited for. */
  private narrate(text: string) {
    if (!text.trim()) return;
    const task = this.current;
    if (this.mouthV2) return this.progress(task, text, "when_idle");
    if (this.pendingSays.size > 0) {
      this.o.log(`mind: skipped say (previous line still playing): ${text}`);
      return;
    }
    void this.say(text);
  }

  /** v2 `progress`, or its v1 equivalent. Outcome lines use priority when_idle and are awaited in v1. */
  private async progress(task: Task | null, text: string, priority: "silent" | "when_idle" | "interrupt"): Promise<void> {
    if (!text.trim()) return;
    if (this.mouthV2) {
      if (!this.peers.mouth) return;
      this.o.log(`mind: progress (${priority}): ${text}`);
      this.recentSays.push({ text, at: Date.now() });
      this.pushConvo("bobby", text);
      this.send({ type: "progress", to: "mouth", task: task?.id ?? "", text, priority });
      return;
    }
    if (priority === "silent") return this.whisper(text);
    if (priority === "interrupt") this.send({ type: "hush", to: "mouth" });
    else await this.quiet(this.o.timing.sayWaitMs);
    await this.say(text);
  }

  private taskUpdate(task: Task, status: TaskStatus, text = "") {
    task.status = status;
    if (this.mouthV2 && this.peers.mouth) this.send({ type: "task_update", to: "mouth", task: task.id, title: task.plan.title, status, ...(text ? { text } : {}) });
  }

  private watch(m: Msg) {
    this.send({ ...m, to: "watch" });
  }

  // ---------- incoming ----------

  handle(m: Msg) {
    if (this.stopped) return;
    switch (m.type) {
      case "peers": {
        const handsWas = this.peers.hands;
        this.peers = { hands: !!m.hands, mouth: !!m.mouth, caller: !!m.caller };
        if (!m.mouth) {
          this.awake = false;
          this.mouthV2 = false;
          this.mouthAsks = true;
          this.endWindow();
          for (const id of [...this.pendingSays]) this.o.hub.cancelWait(id);
          if (this.pendingConfirm) this.pendingConfirm.resolve({ ok: false, heard: "" });
          this.pendingAsk?.resolve({ kind: "none" });
        }
        if (!m.hands) for (const id of [...this.handsWaits]) this.o.hub.cancelWait(id);
        if (!m.hands && this.teaching?.phase === "watching") void this.endTeach(this.teaching.actions > 0);
        if (!handsWas && m.hands) void this.askCaps();
        if (!m.caller && this.current?.callId) this.o.hub.cancelWait(this.current.callId);
        break;
      }
      case "voice_caps":
        this.mouthV2 = Number(m.v) >= 2;
        this.mouthAsks = !Array.isArray(m.tools) || m.tools.includes("answer");
        this.peers.mouth = true;
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
        if (typeof m.text === "string") {
          this.lastHeardRaw = m.text;
          if (this.mouthV2) {
            // v2: the voice model's tool calls are the input; heard is the raw transcript only.
            this.pushConvo("user", m.text);
            this.lastActivity = Date.now();
            if (this.pendingAsk) this.heardDuringAsk(m.text);
          } else this.onHeard(m.text);
        }
        break;
      case "request":
        this.mouthV2 = true;
        if (typeof m.text === "string") void this.onRequest(m);
        break;
      case "amend":
        this.mouthV2 = true;
        if (typeof m.text === "string") void this.onAmend(m.text);
        break;
      case "teach":
        this.mouthV2 = true;
        this.onTeach(m);
        break;
      case "observed":
        this.onObserved(m);
        break;
      case "cancel":
        this.mouthV2 = true;
        if (this.teaching) {
          void this.endTeach(false);
          break;
        }
        this.resumeIfPaused();
        this.epoch += 1;
        this.cancelTasks(m.scope === "current" ? "current" : "all");
        break;
      case "confirm_reply":
        this.mouthV2 = true;
        if (this.pendingConfirm && m.re === this.pendingConfirm.id) {
          this.pendingConfirm.resolve({ ok: m.ok === true, heard: String(m.heard ?? "") });
        }
        break;
      case "ask_reply":
        this.mouthV2 = true;
        if (this.pendingAsk && m.re === this.pendingAsk.id) {
          this.answerAsk({ option: Number(m.option) || 0, text: String(m.text ?? ""), heard: String(m.heard ?? "") || this.pendingAsk.heard });
        }
        break;
      case "barge_in":
        this.onBargeIn();
        break;
      case "status":
        this.send({ type: "status_result", to: "mouth", re: m.id, text: this.statusLine(), tasks: this.taskList() });
        break;
      case "spoke":
        if (typeof m.text === "string") this.onSpoke(m.text);
        break;
      case "call_status":
        if (this.current?.callId && m.re === this.current.callId && typeof m.status === "string") {
          const name = this.current.plan.call?.name ?? "them";
          this.progress(this.current, `Call to ${name}: ${m.status}.`, "silent");
        }
        break;
      default:
        break;
    }
  }

  private async askCaps() {
    const id = this.o.hub.nextId();
    const wait = this.o.hub.waitFor(id, 1500);
    this.send({ type: "caps", to: "hands", id });
    const r = await wait;
    if (r && r.type === "caps_result") {
      this.caps = r;
      this.o.log(`mind: hands caps: sdk ${r.sdk ?? "?"}, ${r.oem ?? "?"} ${r.model ?? ""}, launcher ${r.launcher ?? "?"}, locked ${r.locked ?? "?"}`);
    } else this.o.log("mind: hands sent no caps (older Hands); carrying on without");
  }

  private onNotification(m: Msg) {
    const n: Notif = { app: String(m.app ?? ""), title: String(m.title ?? ""), text: String(m.text ?? ""), at: Number(m.at) || Date.now() };
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
    this.peers.mouth = true;
    const count = Math.min(this.undigested, 8);
    const fresh = count > 0 ? this.notifications.slice(-count) : [];
    this.undigested = 0;
    if (fresh.length === 0) this.whisper("No new notifications since you last spoke with the user.");
    else this.whisper(`${fresh.length} new notification${fresh.length > 1 ? "s" : ""}, newest last: ${fresh.map(notifLine).join("; ")}.`);
    if (this.current) this.whisper(`Still working on: ${this.current.plan.title}.`);
    if (this.queue.length) this.whisper(`Queued after it: ${this.queue.map((t) => t.plan.title).join(", ")}.`);
    this.openWindow();
  }

  // ---------- v1 listening windows: one command per press ----------

  private openWindow() {
    this.listening = true;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
    if (this.pendingHeard.length > 0) return;
    this.listenTimer = setTimeout(() => {
      this.listenTimer = null;
      if (this.listening && this.pendingHeard.length === 0) {
        this.listening = false;
        this.lastActivity = Date.now();
        this.o.log("mind: listening window closed, nothing heard");
      }
    }, this.o.timing.listenMs);
  }

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

  private flushCommand() {
    const text = this.pendingHeard.join(" ").replace(/\s+/g, " ").trim();
    this.closeWindow();
    if (!text || this.stopped) return;
    this.o.log(`mind: command: ${text}`);
    void this.utter(text, text);
  }

  private onHeard(text: string) {
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

    // A pending confirmation takes the next thing said (v1 has no confirm tool).
    if (this.pendingConfirm) {
      this.closeWindow();
      this.pushConvo("user", text);
      this.pendingConfirm.resolve({ ok: isAffirmative(text), heard: text });
      return;
    }
    // So does a pending question.
    if (this.pendingAsk) {
      this.closeWindow();
      this.pushConvo("user", text);
      this.answerAsk({ heard: text });
      return;
    }

    // While a demo is being watched, "stop" means "stop watching": utter() handles it.
    if (!this.teaching && isCancel(text) && text.split(/\s+/).length <= 8) {
      const hadPending = this.pendingHeard.length > 0;
      const deciding = this.decidesInFlight > 0 || hadPending;
      const busy = !!this.current || this.queue.length > 0;
      if (busy || deciding || /^\W*(stop|cancel|never ?mind)\W*$/i.test(text)) {
        this.closeWindow();
        this.pushConvo("user", text);
      }
      if (busy || deciding) {
        this.epoch += 1;
        if (busy) this.cancelTasks("all");
        else {
          this.send({ type: "hush", to: "mouth" });
          this.whisper("The user said stop before anything began. Nothing was started on the phone.");
          this.addFact("The user said stop before the last request began, so nothing was done.");
        }
        return;
      }
      if (/^\W*(stop|cancel|never ?mind)\W*$/i.test(text)) {
        this.send({ type: "hush", to: "mouth" });
        return;
      }
    }

    this.pendingHeard.push(text);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushCommand();
    }, this.o.timing.commandMs);
  }

  // ---------- v2 input: tool calls from the voice model, no debounce ----------

  private async onRequest(m: Msg) {
    const text = String(m.text);
    const raw = typeof m.heard === "string" && m.heard ? m.heard : this.lastHeardRaw || text;
    this.lastActivity = Date.now();
    this.sleepSent = false;
    this.sleepAt = 0;
    this.awake = true;
    this.resumeIfPaused();
    if (this.teaching) return void this.utter(text, raw);
    if (this.pendingConfirm && text.split(/\s+/).length <= 6 && (YES_RE.test(text) || NO_RE.test(text))) {
      this.pendingConfirm.resolve({ ok: isAffirmative(text), heard: raw });
      return;
    }
    // The voice model sometimes sends the answer to a question as a request: take it as the answer.
    if (this.pendingAsk) {
      this.answerAsk({ text, heard: this.pendingAsk.heard });
      return;
    }
    if (isCancel(text) && text.split(/\s+/).length <= 8) {
      this.epoch += 1;
      this.pushConvo("user", text);
      this.cancelTasks("all");
      return;
    }
    await this.utter(text, raw);
  }

  private async onAmend(text: string) {
    this.resumeIfPaused();
    if (this.pendingAsk) return this.answerAsk({ text, heard: this.pendingAsk.heard });
    if (!this.current) return void this.utter(text, text);
    await this.utter(`Change the running task: ${text}`, text, true);
  }

  private onBargeIn() {
    const t = this.current;
    if (!t || t.paused || t.status === "waiting_confirm" || t.status === "waiting_answer") return;
    t.paused = true;
    this.o.log(`mind: barge-in: task ${t.id} pauses at the next step`);
    this.taskUpdate(t, "paused");
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.bargeTimer = setTimeout(() => this.resumeIfPaused(), this.o.timing.bargeMs);
  }

  private resumeIfPaused() {
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.bargeTimer = null;
    const t = this.current;
    if (t?.paused) {
      t.paused = false;
      this.o.log(`mind: task ${t.id} resumes`);
      this.taskUpdate(t, "running");
      t.resume();
    }
  }

  private pushConvo(who: "user" | "bobby", text: string) {
    this.convo.push({ who, text });
    if (this.convo.length > 12) this.convo.splice(0, this.convo.length - 12);
  }

  // ---------- routing ----------

  /**
   * One command: instant local shortcut match, else one router call. `clar` is set on the second
   * pass, after the user answered a question about this command: no second question then.
   */
  private async utter(text: string, raw: string, amend = false, clar?: Clarified): Promise<void> {
    if (!clar) {
      this.answerPending = true;
      this.pushConvo("user", raw);
      // Mid-lesson, or the start of one: that is teaching's to handle, never a question's.
      if (await this.teachTalk(text, raw)) return;
    }
    const epoch = this.epoch;
    if (!amend && !clar) {
      const ctx = this.contactsCtx();
      let local = this.shortcuts.matchUtterance(text, ctx);
      // A shortcut is about to act on a first name two contacts share: settled in code, with no
      // model call. (Anything else that mentions the name is the router's to judge.)
      const shared = local && this.askMax > 0 ? sharedFirstName(ctx.contacts, text) : null;
      if (shared) {
        const q: Question = { question: `Which ${shared.first}?`, options: shared.names.slice(0, 4) };
        const a = await this.askUser(null, q);
        if (epoch !== this.epoch || this.stopped) return;
        if (a.kind === "cancel") return this.dropRequest();
        if (a.kind === "free") return this.utter(text, raw, false, { q, answer: a.text, assumed: false });
        const name = a.kind === "option" ? a.label : q.options[0];
        if (a.kind === "none") void this.progress(null, `Going with ${name}.`, "when_idle");
        text = text.replace(new RegExp(`\\b${escapeRe(shared.first)}\\b`, "gi"), name);
        local = this.shortcuts.matchUtterance(text, ctx);
      }
      if (local) {
        this.stats.local += 1;
        this.o.log(`mind: local shortcut match: ${local.matches.map((m) => `${m.id} ${JSON.stringify(m.slots)}`).join(" | ")}`);
        for (const p of local.plans) this.enqueue(p);
        return;
      }
    }
    this.decidesInFlight += 1;
    this.stats.route += 1;
    const r = await this.o
      .model({ purpose: "route", role: "router", system: this.routerSys, user: this.routerInput(text, clar), schema: ROUTER_SCHEMA, timeoutMs: 12_000, maxTokens: 2500 })
      .finally(() => {
        this.decidesInFlight -= 1;
      });
    if (this.stopped) return;
    const d = r.json;
    if (epoch !== this.epoch) {
      this.o.log(`mind: dropped a decision made before the user said stop (${d?.route ?? "none"})`);
      return;
    }
    if (!d) {
      await this.progress(null, "Hm, something broke on my end. Try again in a sec.", "interrupt");
      this.sleepSoon();
      return;
    }
    switch (d.route) {
      case "chat":
        this.whisper(String(d.whisper ?? ""));
        if (this.answerPending) this.sleepAfterReply = true;
        else this.sleepSoon();
        break;
      case "sleep":
        this.whisper(String(d.whisper ?? ""));
        if (!this.current && !this.queue.length) this.sleepAt = Date.now() + this.o.timing.goodbyeMs;
        break;
      case "cancel":
        this.epoch += 1;
        this.cancelTasks(d.cancel_scope === "current" ? "current" : "all");
        break;
      case "status":
        await this.progress(this.current, this.statusLine(), "interrupt");
        break;
      case "teach":
        void this.startTeach(String(d.teach ?? "").trim() || (teachIntent(text)?.name ?? ""), raw, true);
        break;
      case "ask": {
        const q = cleanQuestion(d);
        if (!q || clar || this.askMax <= 0) {
          // Not allowed to ask (again). Mid-task the caller carries on with the user's words as a note.
          this.o.log(`mind: router asked ${clar ? "a second question" : "with questions off"}; dropped`);
          if (!amend) {
            await this.progress(null, "Sorry, I'm not sure what you mean. Try saying it another way.", "interrupt");
            this.sleepSoon();
          }
          break;
        }
        const a = await this.askUser(null, q);
        if (epoch !== this.epoch || this.stopped) return;
        if (a.kind === "cancel") return this.dropRequest();
        if (a.kind === "none" && !q.options.length) {
          await this.progress(null, "No worries, I'll leave that for now.", "when_idle");
          this.sleepSoon();
          break;
        }
        const answer = a.kind === "option" ? a.label : a.kind === "free" ? a.text : q.options[0];
        if (a.kind === "none") void this.progress(null, `Going with ${answer}.`, "when_idle");
        return this.utter(text, raw, amend, { q, answer, assumed: a.kind === "none" });
      }
      case "amend": {
        const t = Array.isArray(d.tasks) && d.tasks[0] ? this.planFromRouter(d.tasks[0]) : null;
        if (!t) break;
        if (this.current && !this.current.cancelled) {
          this.o.log(`mind: amend task ${this.current.id}: ${t.goal}`);
          this.current.amended = t;
          this.addFact(`The user changed "${this.current.plan.title}": ${t.goal}`);
          await this.progress(this.current, String(d.say || "Got it, changing that."), "when_idle");
        } else this.enqueue(t);
        break;
      }
      case "tasks":
      default: {
        const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map((x: any) => this.planFromRouter(x)).filter(Boolean) as TaskPlan[];
        if (!tasks.length) {
          this.whisper(String(d.whisper ?? ""));
          break;
        }
        if (d.say && this.mouthV2) this.progress(null, String(d.say), "silent");
        for (const p of tasks) this.enqueue(p);
      }
    }
  }

  private planFromRouter(t: any): TaskPlan | null {
    const slots: Record<string, string> = {};
    for (const s of Array.isArray(t.slots) ? t.slots : []) if (s?.name) slots[String(s.name)] = String(s.value ?? "");
    const id = String(t.shortcut_id ?? "").trim();
    if (id && this.shortcuts.get(id)) {
      const p = this.shortcuts.plan(id, slots, this.contactsCtx());
      if (!("error" in p)) return { ...p, ...(t.done_say ? { doneSay: String(t.done_say) } : {}) } as TaskPlan;
      this.o.log(`mind: shortcut ${id} rejected its slots (${p.error}); using the router's sub-goals`);
      if (id === "call.ai" || id === "phone.dial" || id === "sms.send") {
        // No number: say so instead of driving the screen.
        const who = /^no number for (.+)$/.exec(p.error)?.[1];
        return { kind: "phone", title: String(t.title || "Task"), goal: String(t.goal || ""), subgoals: [], failSay: who ? `I don't have a number for ${who}.` : cap(p.error) + "." } as TaskPlan;
      }
    }
    const subgoals: SubgoalSpec[] = (Array.isArray(t.subgoals) ? t.subgoals : []).map(subgoalFromModel).filter((s: SubgoalSpec) => s.goal);
    const app = String(t.app ?? "").trim();
    if (app && !subgoals.some((s) => s.direct?.some((a) => a.do === "launch"))) {
      subgoals.unshift({
        goal: `Open ${app}`,
        done_when: { app: packageFor(app) ?? app, describe: `${app} is on screen` },
        risk: "safe",
        direct: [{ do: "launch", app }],
        say: `Opening ${app}.`,
      });
    }
    if (!subgoals.length) subgoals.push({ goal: String(t.goal || t.title || ""), done_when: { describe: String(t.goal || "") }, risk: "safe" });
    const goal = String(t.goal || t.title || "");
    const who = this.contactsCtx().contacts.find((c) => new RegExp(`\\b${escapeRe(c.name.split(/\s+/)[0])}\\b`, "i").test(`${t.title} ${goal}`));
    return {
      kind: "phone",
      title: String(t.title || "Task"),
      goal,
      subgoals,
      slots,
      ...(t.done_say ? { doneSay: String(t.done_say) } : {}),
      recipient: who ? { name: who.name, known: true } : undefined,
    } as TaskPlan;
  }

  private routerInput(heard: string, clar?: Clarified): string {
    const lines: string[] = [];
    const now = this.now;
    lines.push(`The user just said: "${heard}"`);
    if (clar) {
      const opts = clar.q.options.length ? ` (options: ${clar.q.options.join("; ")})` : "";
      const got = clar.assumed ? `The user didn't answer, so go with "${clar.answer}".` : `The user answered: "${clar.answer}".`;
      lines.push(`Bobby then asked: "${clar.q.question}"${opts}. ${got} You can't ask again: decide now.`);
    } else if (this.askMax <= 0) lines.push("You can't ask the user anything: decide yourself.");
    lines.push("");
    lines.push(`Now: ${now.toDateString()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} (local time)`);
    const t = this.current;
    lines.push(t ? `Running task: ${t.plan.title} (goal: ${t.plan.goal}; at step ${t.idx + 1} of ${t.plan.subgoals.length})` : "Running task: none");
    if (this.queue.length) lines.push(`Queued: ${this.queue.map((q) => q.plan.title).join("; ")}`);
    if (this.lastScreen?.app) lines.push(`Phone shows: ${appLabel(this.lastScreen.app)}`);
    const people = this.contactsCtx().contacts.map((c) => `${c.name}${c.phone ? " (phone)" : ""}${c.email ? " (email)" : ""}`);
    lines.push(`Contacts: ${people.join(", ") || "none"}`);
    const notifs = this.notifications.slice(-8);
    lines.push(notifs.length ? `Recent notifications, newest last:\n${notifs.map((n) => `- ${notifLine(n)} (${ago(n.at)})`).join("\n")}` : "Recent notifications: none");
    const facts = [...this.memory.outcomes.slice(-3).map((o) => `${o.title}: ${o.status} (${o.line})`), ...this.facts.slice(-5)];
    if (facts.length) lines.push(`What has happened so far:\n${facts.map((f) => `- ${f}`).join("\n")}`);
    const known = this.knownAnswers();
    if (known.length) lines.push(`The user's answers to earlier questions (don't ask these again):\n${known.map((k) => `- ${k}`).join("\n")}`);
    const convo = this.convo.slice(-9, -1);
    if (convo.length) lines.push(`Recent conversation:\n${convo.map((c) => `${c.who === "user" ? "User" : "Bobby"}: ${c.text}`).join("\n")}`);
    return lines.join("\n");
  }

  // ---------- the queue ----------

  private enqueue(plan: TaskPlan): Task {
    this.taskSeq += 1;
    let fireCancel = () => {};
    const cancelSignal = new Promise<void>((resolve) => (fireCancel = resolve));
    const task: Task = {
      id: `t${this.taskSeq}`,
      plan,
      status: "queued",
      idx: 0,
      stepStatus: {},
      scratch: [],
      history: [],
      cancelled: false,
      paused: false,
      resume: () => {},
      resumed: Promise.resolve(),
      escalationsUsed: 0,
      asksUsed: 0,
      correctedOnce: false,
      cancelSignal,
      fireCancel,
    };
    this.queue.push(task);
    this.o.log(`mind: queued ${task.id} "${plan.title}" (${plan.shortcut ?? "grounded"}): ${plan.subgoals.map((s) => s.goal).join(" | ")}`);
    this.taskUpdate(task, "queued");
    this.pump();
    return task;
  }

  private pump() {
    if (this.current || this.stopped) return;
    const next = this.queue.shift();
    if (!next) {
      this.drained();
      return;
    }
    if (!this.taskDoneOpen) {
      this.taskDoneOpen = true;
      this.taskDone = new Promise<void>((r) => (this.drained = () => {
        this.taskDoneOpen = false;
        r();
      }));
    }
    this.current = next;
    void this.runTask(next)
      .catch((e) => {
        this.o.log(`mind: task crashed: ${String(e?.stack ?? e)}`);
        return this.finishTask(next, "failed", "Sorry, something went wrong and I had to stop.");
      })
      .finally(() => {
        if (this.current === next) this.current = null;
        this.pump();
      });
  }
  private taskDoneOpen = false;

  private publishPlan(task: Task) {
    this.watch({ type: "plan", task: task.id, steps: task.plan.subgoals.map((s, i) => ({ n: i + 1, do: s.goal, why: s.done_when.describe })) });
  }

  private setStep(task: Task, n: number, status: "running" | "done" | "failed") {
    if (task.stepStatus[n] === status) return;
    task.stepStatus[n] = status;
    this.watch({ type: "step", task: task.id, n, status });
  }

  private async runTask(task: Task) {
    const plan = task.plan;
    if ((plan as any).failSay) return this.finishTask(task, "failed", (plan as any).failSay);
    if (plan.kind === "call") return this.runCall(task);
    if (!this.peers.hands) {
      this.addFact(`Couldn't start "${plan.title}": the phone wasn't ready.`);
      return this.finishTask(task, "failed", "The phone isn't ready yet, so I can't do that right now.", false);
    }
    this.o.log(`mind: task ${task.id} "${plan.title}": ${plan.goal}`);
    this.watch({ type: "task", task: task.id, title: plan.title, status: "started" });
    this.publishPlan(task);
    this.taskUpdate(task, "running");
    if (!this.mouthV2) this.whisper(`Task started: ${plan.title}. You will be given lines to say as it goes.`);
    for (task.idx = 0; task.idx < task.plan.subgoals.length; task.idx++) {
      if (task.cancelled || this.stopped) return this.finishCancelled(task);
      if (!this.peers.hands) return this.finishTask(task, "failed", "I've lost touch with the phone, so I had to stop.");
      if (this.applyAmend(task)) continue;
      const n = task.idx + 1;
      const sg = task.plan.subgoals[task.idx];
      this.setStep(task, n, "running");
      const r = await this.runSubgoal(task, sg);
      if (task.cancelled || this.stopped || (!r.ok && r.cancelled)) return this.finishCancelled(task);
      if (this.applyAmend(task)) continue;
      if (!r.ok) {
        if (r.replan?.length) {
          task.plan.subgoals.splice(task.idx, 1, ...r.replan);
          this.publishPlan(task);
          task.idx -= 1;
          continue;
        }
        this.setStep(task, n, "failed");
        if (!this.peers.hands) return this.finishTask(task, "failed", "I've lost touch with the phone, so I had to stop.");
        return this.finishTask(task, "failed", r.say || "Sorry, I couldn't get that done.");
      }
      this.setStep(task, n, "done");
    }
    return this.finishTask(task, "done", plan.doneSay || `Done: ${plan.title}.`);
  }

  /** Swaps in an amended plan at a step boundary; the loop restarts at the first unfinished step. */
  private applyAmend(task: Task): boolean {
    if (!task.amended) return false;
    task.plan = { ...task.amended, title: task.plan.title };
    task.amended = undefined;
    task.stepStatus = {};
    this.publishPlan(task);
    task.idx = -1;
    return true;
  }

  private async runSubgoal(task: Task, sg: SubgoalSpec): Promise<SubgoalResult> {
    const run: SubgoalRun = { spec: sg, taskGoal: task.plan.goal, scratch: task.scratch, confirmed: false, budget: SUBGOAL_BUDGET, known: this.knownAnswers() };
    const onlyLaunch = !sg.direct || sg.direct.every((a) => a.do === "launch");
    // A taught sub-goal is never "already done": the user asked for it to be done again.
    if (sg.risk === "safe" && onlyLaunch && !sg.script && !sg.guide) {
      const s = await this.readScreen();
      if (s && checkScreen(sg.done_when, s) === null) {
        this.o.log(`mind: "${sg.goal}" already holds; skipping`);
        return { ok: true, trace: [], how: "already" };
      }
    }
    if (sg.risk === "irreversible") {
      const ok = await this.confirmGate(task, sg.confirm ?? task.plan.goal);
      if (!ok) return { ok: false, cancelled: true, reason: "declined", say: "" };
      run.confirmed = true;
    }
    if (sg.direct?.length) {
      const r = await this.exec.runDirect(run);
      if (r.ok || !r.degrade || task.cancelled) return r;
    }
    if (sg.script?.length) {
      const r = await this.runTaught(task, sg, run);
      if (r.ok || r.cancelled || task.cancelled || sg.scriptOnly) return r;
    } else if (sg.guide) run.mustAct = true;
    const appBefore = this.lastScreen?.app ?? "";
    const verBefore = String(this.lastScreen?.app_version ?? "");
    const recipe = this.recipes.lookup(appBefore, sg, task.plan, verBefore);
    if (recipe) {
      const r = await this.recipes.replay(recipe, run, task.plan, { act: (a, o) => this.act(a, o), narrate: (t) => this.narrate(t), gate: () => this.gate(task), isDone: (dw, s) => this.exec.isDone(dw, s) });
      if (r.ok) {
        this.stats.recipe += 1;
        return r;
      }
      if (r.cancelled) return r;
    }
    const r = await this.exec.runGrounded(run, task.history);
    if (r.ok && r.trace.length) this.recipes.save(appBefore, sg, task.plan, r.trace, verBefore);
    return r;
  }

  /** Replays the steps the user showed, in code. Falls through (ok:false) when the screen doesn't match. */
  private async runTaught(task: Task, sg: SubgoalSpec, run: SubgoalRun): Promise<SubgoalResult> {
    const steps = sg.script ?? [];
    const slots = task.plan.slots ?? {};
    const id = task.plan.shortcut;
    let screen = await this.readScreen();
    if (task.cancelled) return { ok: false, cancelled: true, reason: "cancelled", say: "" };
    const taps = { act: (a: HandsAct, o: { fast: boolean }) => this.act(a, o), log: this.o.log };
    if (!steps.some((s) => s.pixel)) screen = (await closeOverlay(screen, taps, task.history)) ?? screen;
    if (sg.scriptApp && !steps.some((s) => s.pixel) && !firstTargetVisible(steps, slots, screen)) {
      // The app came back where it was left, not where the demo began: start it from its first screen.
      this.o.log(`mind: "${sg.goal}": the first step isn't on this screen; restarting ${appLabel(sg.scriptApp)} from its first screen`);
      await this.act({ do: "launch", app: sg.scriptApp, fresh: true }, { fast: true });
      if (task.cancelled) return { ok: false, cancelled: true, reason: "cancelled", say: "" };
      // Still not there? The script closes a tip or looks further down the page itself before giving up.
    }
    const out = await runScript(steps, slots, sg, task.history, {
      act: (a, o) => this.act(a, o),
      read: () => this.readScreen(),
      screen: () => this.lastScreen,
      narrate: (t) => this.narrate(t),
      gate: () => this.gate(task),
      isDone: (dw, s) => this.exec.isDone(dw, s),
      log: this.o.log,
    });
    if (out.ok) {
      this.stats.script += 1;
      this.skills.note(id, true);
      this.o.log(`mind: "${sg.goal}" done from the taught steps (${out.ran} steps, no model call)`);
      return out;
    }
    if (out.cancelled) return out;
    this.o.log(`mind: taught steps stopped after ${out.ran} of ${steps.length} (${out.reason})${sg.scriptOnly ? "" : "; the executor takes over with the demo as a guide"}`);
    this.skills.note(id, false);
    run.mustAct = out.ran === 0;
    return sg.scriptOnly ? { ...out, say: "That didn't go the way you showed me, so I've stopped." } : out;
  }

  // ---------- teaching: the user shows, Hands watches, a skill comes out ----------

  /** The voice model's teach(action, text) tool. */
  private onTeach(m: Msg) {
    const action = String(m.action ?? "");
    const heard = typeof m.heard === "string" && m.heard ? m.heard : this.lastHeardRaw || String(m.text ?? "");
    this.lastActivity = Date.now();
    this.awake = true;
    if (action === "start") void this.startTeach(String(m.text ?? "").trim(), heard, false);
    else if (action === "done") void this.endTeach(true);
    else if (action === "cancel") void this.endTeach(false);
  }

  /**
   * What the user says around a demo. True when it was dealt with here: starting one ("I'm going
   * to show you how to..."), ending one ("done", "never mind"), a remark made while showing
   * (kept as a note for naming the skill), or "forget how to...".
   */
  private async teachTalk(text: string, raw: string): Promise<boolean> {
    const t = this.teaching;
    if (t) {
      const end = teachEnd(text) ?? teachEnd(raw);
      if (end) void this.endTeach(end === "done");
      else if (teachIntent(text)) await this.progress(null, "I'm watching. Say done when you're finished.", "when_idle");
      else {
        t.notes.push(raw);
        this.o.log(`mind: teaching: noted "${raw}"`);
      }
      return true;
    }
    const forget = forgetIntent(text);
    if (forget) {
      const s = this.skills.find(forget);
      if (s) this.skills.remove(s.id);
      this.o.log(`mind: forget "${forget}": ${s ? `removed ${s.id}` : "no such skill"}`);
      await this.progress(null, s ? `Okay, I've forgotten how to ${lower(s.title)}.` : "I haven't learned anything like that.", "when_idle");
      this.sleepSoon();
      return true;
    }
    const intent = teachIntent(text) ?? teachIntent(raw);
    if (!intent) return false;
    // With a v2 Mouth the voice model has only said "On it": the invitation to start is ours.
    void this.startTeach(intent.name, raw, true);
    return true;
  }

  /** Asks Hands to start reporting what the user does. `speak`: say "show me" ourselves. */
  private async startTeach(name: string, heard: string, speak: boolean) {
    if (this.teaching || this.stopped) return;
    this.lastActivity = Date.now();
    this.sleepAt = 0;
    this.sleepAfterReply = false;
    this.epoch += 1;
    if (this.current || this.queue.length) this.cancelTasks("all", true);
    if (!this.peers.hands) {
      await this.progress(null, "The phone isn't ready yet, so I can't watch right now.", "when_idle");
      this.sleepSoon();
      return;
    }
    this.taskSeq += 1;
    const t: Teaching = { name, heard, notes: [], events: [], initial: null, startedAt: Date.now(), lastActionAt: Date.now(), actions: 0, phase: "starting", task: `t${this.taskSeq}` };
    this.teaching = t;
    const id = this.o.hub.nextId();
    const wait = this.waitHands(id, this.o.timing.observeMs);
    this.send({ type: "observe", to: "hands", id, on: true });
    const r = await wait;
    if (this.teaching !== t || t.phase !== "starting") return;
    if (!r || r.type !== "observe_result" || r.ok === false) {
      this.teaching = null;
      this.o.log(`mind: teaching: Hands can't observe (${r ? String(r.error ?? "refused") : "no reply; older Hands"})`);
      await this.progress(null, "I can't watch what you do on this phone yet, so I can't learn it that way.", "when_idle");
      this.sleepSoon();
      return;
    }
    if (r.screen && typeof r.screen === "object") t.initial = { type: "screen_result", ...r.screen };
    t.phase = "watching";
    t.startedAt = Date.now();
    t.lastActionAt = Date.now();
    this.o.log(`mind: teaching: watching the user show "${name || "a new skill"}"`);
    this.watch({ type: "task", task: t.task, title: `Learning: ${name || "a new skill"}`, status: "started" });
    await this.progress(null, "Okay, show me. Say done when you're finished.", speak ? "when_idle" : "silent");
  }

  private onObserved(m: Msg) {
    const t = this.teaching;
    if (!t) return;
    t.events.push(m);
    if (m.kind === "screen") return;
    t.lastActionAt = Date.now();
    this.lastActivity = Date.now();
    if (m.kind !== "scroll") t.actions += 1;
  }

  /** Stops the watching and, when `save`, turns what was seen into a skill. */
  private endTeach(save: boolean, why = ""): Promise<void> {
    const t = this.teaching;
    if (!t || t.phase === "ending") return this.teachDone;
    t.phase = "ending";
    this.decidesInFlight += 1; // nothing sleeps while the skill is being written
    this.teachDone = this.finishTeach(t, save, why)
      .catch((e) => this.o.log(`mind: teaching crashed: ${String(e?.stack ?? e)}`))
      .finally(() => {
        this.decidesInFlight -= 1;
        if (this.teaching === t) this.teaching = null;
        this.lastActivity = Date.now();
        this.sleepSoon();
      });
    return this.teachDone;
  }

  private async finishTeach(t: Teaching, save: boolean, why: string) {
    // Hands flushes typing it was still collecting, then answers; those frames arrive first.
    const id = this.o.hub.nextId();
    const wait = this.waitHands(id, this.o.timing.observeMs);
    this.send({ type: "observe", to: "hands", id, on: false });
    await wait;
    this.teaching = null;
    const title = `Learning: ${t.name || "a new skill"}`;
    if (!save) {
      this.o.log("mind: teaching: dropped");
      this.watch({ type: "task", task: t.task, title, status: "cancelled" });
      await this.progress(null, "Okay, I'll forget that one.", "when_idle");
      return;
    }
    const launcher = typeof this.caps?.launcher === "string" ? this.caps.launcher : undefined;
    const demo = readDemo(t.events, { launcher, initial: t.initial });
    this.o.log(`mind: teaching: ${t.events.length} frames from Hands -> ${demo.steps.length} steps${why ? ` (ended because ${why})` : ""}`);
    if (demo.steps.length === 0) {
      this.watch({ type: "task", task: t.task, title, status: "failed" });
      await this.progress(null, demo.secret ? "That starts with a password, and I don't keep those, so I can't learn it." : "I didn't see you do anything in an app, so there's nothing to learn yet.", "when_idle");
      return;
    }
    const said = { name: t.name, heard: t.heard, notes: t.notes };
    this.stats.teach += 1;
    const r = await this.o.model({ purpose: "teach", role: "teach", system: this.teachSys, user: teachInput(demo, said), schema: TEACH_SCHEMA, timeoutMs: 20_000, maxTokens: 1500 });
    if (this.stopped) return;
    let meta = cleanMeta(r.json, demo, said);
    if (!meta) {
      this.o.log("mind: teaching: the model gave nothing usable; naming the skill and its slots from the demo alone");
      meta = fallbackMeta(demo, said);
    }
    const skill = buildSkill(demo, meta, { heard: t.heard, pixels: this.o.teachMode === "pixels" });
    this.skills.add(skill);
    this.watch({ type: "plan", task: t.task, steps: skill.parts.flatMap((p) => p.steps).map((s, i) => ({ n: i + 1, do: s.label, why: "you showed me" })) });
    this.watch({ type: "task", task: t.task, title: `Learned: ${skill.title}`, status: "done" });
    const needs = skill.slots.filter((s) => s.required).map((s) => s.desc);
    const line = `Got it. I've learned how to ${lower(skill.title)}.${needs.length ? ` Next time, just tell me ${needs.join(" and ")}.` : ""}${demo.secret ? " I stopped at the password, though: I don't keep those." : ""}`;
    this.addFact(`The user taught Bobby a skill by showing it: "${skill.title}" (${skill.parts.reduce((n, p) => n + p.steps.length, 0)} steps in ${appLabel(skill.app)}).`);
    await this.progress(null, line, "when_idle");
  }

  /** Waits while a barge-in has paused the task. */
  private async gate(task: Task): Promise<"go" | "cancelled"> {
    while (task.paused && !task.cancelled && !this.stopped) {
      task.resumed = new Promise<void>((r) => (task.resume = r));
      await Promise.race([task.resumed, task.cancelSignal]);
    }
    return task.cancelled || this.stopped ? "cancelled" : "go";
  }

  // ---------- confirmations ----------

  private needsConfirm(task: Task): boolean {
    if (this.policy === "never") return false;
    if (this.policy === "unknown_contacts") return !task.plan.recipient?.known;
    return true;
  }

  /**
   * Pauses before an irreversible step. Goes ahead only if the voice model's confirm says yes AND
   * the user's own transcript is affirmative (the voice model alone isn't trusted).
   */
  private async confirmGate(task: Task, summary: string): Promise<boolean> {
    if (!this.needsConfirm(task)) return true;
    if (!this.peers.mouth) {
      this.o.log(`mind: can't confirm "${summary}" with no Mouth connected; not doing it`);
      task.declined = true;
      return false;
    }
    const id = this.o.hub.nextId();
    this.taskUpdate(task, "waiting_confirm", summary);
    let resolve!: (r: { ok: boolean; heard: string }) => void;
    const reply = new Promise<{ ok: boolean; heard: string }>((r) => (resolve = r));
    this.pendingConfirm = { id, task, resolve };
    this.o.log(`mind: confirm ${id}: ${summary}`);
    if (this.mouthV2) this.send({ type: "confirm_request", to: "mouth", id, task: task.id, summary, risk: "irreversible" });
    else {
      await this.quiet(this.o.timing.sayWaitMs);
      void this.say(`${summary.replace(/[.!?\s]+$/, "")}. Should I go ahead?`);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<any>((r) => (timeout = setTimeout(() => r({ ok: false, heard: "", timeout: true }), this.o.timing.confirmMs)));
    const r: any = await Promise.race([reply, timer, task.cancelSignal.then(() => ({ ok: false, heard: "", cancelled: true }))]);
    clearTimeout(timeout);
    this.pendingConfirm = null;
    if (r.cancelled) return false;
    const go = r.ok === true && isAffirmative(r.heard);
    this.o.log(`mind: confirm ${id}: ${go ? "yes" : "no"} (ok=${r.ok}, heard="${r.heard}"${r.timeout ? ", timed out" : ""})`);
    if (!go) {
      task.declined = true;
      return false;
    }
    this.taskUpdate(task, "running");
    return true;
  }

  // ---------- questions ----------

  private knownAnswers(): string[] {
    return this.memory.answers.slice(-4).map((a) => `${a.q} -> ${a.a}`);
  }

  /**
   * Puts one question to the user and waits. An option picked before is reused without asking.
   * "none" means nobody answered (or nobody could be asked): callers go with the first option.
   */
  private async askUser(task: Task | null, q: Question): Promise<Answer> {
    const key = questionKey(q.question);
    const before = this.memory.answerTo(key)?.toLowerCase();
    const again = before ? q.options.findIndex((o) => o.toLowerCase() === before) : -1;
    if (again >= 0) {
      this.o.log(`mind: not asking "${q.question}" again: ${q.options[again]} (remembered)`);
      void this.progress(task, `Going with ${q.options[again]}, like last time.`, "when_idle");
      return { kind: "option", index: again, label: q.options[again] };
    }
    if (!this.peers.mouth || this.pendingAsk) {
      this.o.log(`mind: can't ask "${q.question}" (${this.pendingAsk ? "another question is out" : "no Mouth"})`);
      return { kind: "none" };
    }
    const id = this.o.hub.nextId();
    const say = spokenQuestion(q);
    let resolve!: (a: Answer) => void;
    const reply = new Promise<Answer>((r) => (resolve = r));
    this.pendingAsk = { id, task, q, heard: "", resolve };
    if (task) this.taskUpdate(task, "waiting_answer", q.question);
    this.o.log(`mind: ask ${id}: ${say}`);
    if (this.mouthV2 && this.mouthAsks) {
      this.recentSays.push({ text: say, at: Date.now() });
      this.pushConvo("bobby", say);
      this.send({ type: "ask_request", to: "mouth", id, task: task?.id ?? "", question: q.question, options: q.options, say });
    } else if (this.mouthV2) void this.progress(task, say, "when_idle");
    else {
      await this.quiet(this.o.timing.sayWaitMs);
      void this.say(say);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<Answer>((r) => (timeout = setTimeout(() => r({ kind: "none" }), this.o.timing.askMs)));
    const a = await Promise.race([reply, timer, ...(task ? [task.cancelSignal.then((): Answer => ({ kind: "cancel" }))] : [])]);
    clearTimeout(timeout);
    if (this.pendingAsk?.grace) clearTimeout(this.pendingAsk.grace);
    this.pendingAsk = null;
    this.lastActivity = Date.now();
    this.o.log(`mind: ask ${id}: ${a.kind === "option" ? `option ${a.index + 1} (${a.label})` : a.kind === "free" ? `"${a.text}"` : a.kind === "cancel" ? "never mind" : "no answer"}`);
    if (a.kind === "option") this.memory.addAnswer(key, q.question, a.label);
    if (task && !task.cancelled) this.taskUpdate(task, "running");
    return a;
  }

  /**
   * v2: the user spoke while a question is out. The voice model normally follows with its
   * `answer` call; if it doesn't, the transcript alone is the answer after a short grace.
   */
  private heardDuringAsk(text: string) {
    const p = this.pendingAsk;
    if (!p) return;
    p.heard = `${p.heard} ${text}`.trim();
    if (p.grace) clearTimeout(p.grace);
    p.grace = setTimeout(() => {
      if (this.pendingAsk !== p) return;
      this.o.log(`mind: ask ${p.id}: no answer call from the Mouth; taking what was heard`);
      this.answerAsk({ heard: p.heard });
    }, this.o.timing.askGraceMs);
  }

  private answerAsk(raw: RawAnswer) {
    const p = this.pendingAsk;
    if (!p) return;
    this.lastActivity = Date.now();
    this.sleepSent = false;
    this.sleepAt = 0;
    p.resolve(resolveAnswer(p.q, raw));
  }

  /** The user said "never mind" to a question asked before anything started. */
  private dropRequest() {
    this.addFact("The user dropped the last request when asked about it, so nothing was done.");
    void this.progress(null, "Okay, never mind.", "when_idle");
    this.sleepSoon();
  }

  /**
   * A question the executor raised from the screen. A picked option costs no model call: it is
   * noted and the step carries on. Anything else the user says goes to the router as a change to
   * the task ("oh, you know what you should do..."). With no answer, the first option stands.
   */
  private async askInTask(task: Task | null, q: Question): Promise<AskOutcome> {
    const first = q.options[0];
    const unasked = first ? `Couldn't ask the user "${q.question}"; going with "${first}".` : `Couldn't ask the user "${q.question}"; decide yourself.`;
    if (!task || task.asksUsed >= this.askMax) return { kind: "note", note: unasked };
    task.asksUsed += 1;
    const a = await this.askUser(task, q);
    if (task.cancelled || this.stopped) return { kind: "cancelled" };
    switch (a.kind) {
      case "cancel":
        this.cancelTasks("current");
        return { kind: "cancelled" };
      case "option":
        return { kind: "note", note: `Asked the user "${q.question}"; they chose "${a.label}".` };
      case "none":
        if (first) void this.progress(task, `Going with ${first}.`, "when_idle");
        return { kind: "note", note: unasked };
      case "free": {
        const note = `Asked the user "${q.question}"; they said: "${a.text}".`;
        await this.utter(`Change the running task: ${a.text}`, a.text, true, { q, answer: a.text, assumed: false });
        if (task.cancelled || this.stopped) return { kind: "cancelled" };
        if (!task.amended) return { kind: "note", note };
        task.scratch.push(note);
        return { kind: "amended" };
      }
    }
  }

  // ---------- Hands ----------

  private waitHands(id: string, ms = this.o.timing.actMs): Promise<Msg | null> {
    if (!this.peers.hands) return Promise.resolve(null);
    this.handsWaits.add(id);
    return this.o.hub.waitFor(id, ms).finally(() => this.handsWaits.delete(id));
  }

  private remember(s: Msg) {
    this.lastScreen = { ...s, readAt: Date.now() };
    this.handsHash = typeof s.hash === "string" ? s.hash : "";
  }

  /** Reads the screen compactly; with Hands' hash, an unchanged screen costs no nodes. */
  async readScreen(opts: { image?: boolean } = {}): Promise<Msg | null> {
    const id = this.o.hub.nextId();
    const wait = this.waitHands(id);
    const req: Msg = { type: "screen", to: "hands", id, compact: true };
    if (opts.image) req.image = true;
    else if (this.handsHash) req.since = this.handsHash;
    this.send(req);
    const r = await wait;
    if (!r || r.type !== "screen_result") return null;
    if (r.same && this.lastScreen) {
      this.lastScreen.readAt = Date.now();
      return this.lastScreen;
    }
    this.remember(r);
    return this.lastScreen;
  }

  /** One act, with the screen after it (from then_screen, or read separately for old Hands). */
  async act(a: HandsAct, opts: { fast: boolean }): Promise<ActResult> {
    if (!this.peers.hands) return { ok: false, error: "no_hands", screen: null };
    const id = this.o.hub.nextId();
    const wait = this.waitHands(id);
    this.stats.acts += 1;
    this.send({ type: "act", to: "hands", id, ...a, then_screen: true, compact: true, ...(opts.fast ? { fast: true } : {}) });
    const t0 = Date.now();
    const r = await wait;
    // One line per act: on a real phone this is the only record of what was done and how it went.
    const what = `${a.do}${a.on ? ` ${JSON.stringify(a.on)}` : ""}${a.app ? ` ${a.app}${a.fresh ? " (fresh)" : ""}` : ""}${a.name ? ` ${a.name}` : ""}${a.dir ? ` ${a.dir}` : ""}${a.uri ? ` ${a.uri.slice(0, 60)}` : ""}`;
    this.o.log(`mind: act ${what} -> ${!r ? "no reply" : r.ok ? "ok" : `${r.error}${r.why ? ` (${r.why})` : ""}`} in ${Date.now() - t0} ms${r?.screen?.app ? `, then ${appLabel(r.screen.app)} with ${Array.isArray(r.screen.nodes) ? r.screen.nodes.length : 0} nodes` : ""}`);
    if (!r) return { ok: false, error: "timeout", screen: null };
    let screen: Msg | null = null;
    if (r.screen && typeof r.screen === "object") {
      this.remember({ type: "screen_result", ...r.screen });
      screen = this.lastScreen;
    } else if (r.ok) screen = await this.readScreen();
    else screen = this.lastScreen;
    return { ok: !!r.ok, error: r.error, why: r.why, app: r.app ?? screen?.app, screen };
  }

  // ---------- finishing ----------

  private async finishTask(task: Task, status: "done" | "failed", line: string, published = true) {
    this.o.log(`mind: task ${task.id} ${status}: ${line}`);
    if (published) this.watch({ type: "task", task: task.id, title: task.plan.title, status });
    this.taskUpdate(task, status, line);
    this.addFact(`Task "${task.plan.title}" ${status === "done" ? "finished" : "failed"}: ${line}`);
    this.memory.addOutcome({ task: task.id, title: task.plan.title, status, line, at: Date.now() });
    this.lastActivity = Date.now();
    if (this.current === task) this.current = null;
    await this.progress(task, line, "when_idle");
    this.sleepSoon();
  }

  private finishCancelled(task: Task) {
    if (this.current === task) this.current = null;
    this.send({ type: "cursor", to: "hands", show: false });
    const running = Object.entries(task.stepStatus).find(([, s]) => s === "running");
    if (running) this.setStep(task, Number(running[0]), "failed");
    this.watch({ type: "task", task: task.id, title: task.plan.title, status: "cancelled" });
    this.taskUpdate(task, "cancelled");
    const last = task.history[task.history.length - 1];
    const fact = task.declined
      ? `Task "${task.plan.title}" was not finished: the user didn't confirm the last step, so nothing was sent.`
      : `Task "${task.plan.title}" was cancelled by the user${last ? ` after: ${last}` : " before any action"}. Nothing more will happen on the phone.`;
    this.addFact(fact);
    this.memory.addOutcome({ task: task.id, title: task.plan.title, status: "cancelled", line: fact, at: Date.now() });
    this.o.log(`mind: task ${task.id} cancelled${task.declined ? " (not confirmed)" : ""}`);
    if (task.declined) void this.progress(task, "Okay, I won't. Nothing was sent.", "when_idle");
    else if (!task.quiet) {
      if (this.mouthV2) this.progress(task, fact, "silent");
      else this.whisper(fact);
    }
    this.lastActivity = Date.now();
    this.sleepSoon();
  }

  /** Stops the running task after its current action; "all" also empties the queue. */
  private cancelTasks(scope: "current" | "all", quiet = false) {
    if (scope === "all") {
      for (const q of this.queue.splice(0)) {
        q.cancelled = true;
        this.taskUpdate(q, "cancelled");
        this.o.log(`mind: dropped queued task ${q.id} "${q.plan.title}"`);
      }
    }
    const t = this.current;
    if (t) {
      t.cancelled = true;
      t.quiet = quiet;
      if (t.callId) {
        this.o.log(`mind: hanging up ${t.callId}`);
        this.send({ type: "hangup", to: "caller", re: t.callId });
      }
      if (!quiet && !this.mouthV2) this.send({ type: "hush", to: "mouth" });
      if (this.pendingConfirm?.task === t) this.pendingConfirm.resolve({ ok: false, heard: "" });
      t.fireCancel();
    } else if (!quiet && !this.mouthV2) this.send({ type: "hush", to: "mouth" });
    // A question about a request that hasn't started is dropped with it.
    if (this.pendingAsk && !this.pendingAsk.task) this.pendingAsk.resolve({ kind: "cancel" });
  }

  private statusLine(): string {
    const t = this.current;
    if (!t) return this.queue.length ? `Nothing running; ${this.queue.length} queued.` : "Nothing running right now.";
    const step = t.plan.subgoals[t.idx];
    const state = t.status === "waiting_confirm" ? "waiting for your OK" : t.status === "waiting_answer" ? "waiting for your answer" : t.status === "paused" ? "paused" : `on step ${t.idx + 1} of ${t.plan.subgoals.length}${step ? `: ${step.goal}` : ""}`;
    return `${t.plan.title}: ${state}.${this.queue.length ? ` Then ${this.queue.map((q) => q.plan.title).join(", ")}.` : ""}`;
  }

  private taskList() {
    return [this.current, ...this.queue].filter(Boolean).map((t) => ({ task: t!.id, title: t!.plan.title, status: t!.status }));
  }

  // ---------- calls ----------

  private async runCall(task: Task) {
    const c = task.plan.call!;
    if (!this.peers.caller) {
      this.addFact(`Couldn't call ${c.name}: the calling part wasn't connected.`);
      return this.finishTask(task, "failed", `I can't make calls right now, so I couldn't ring ${c.name}.`, false);
    }
    this.watch({ type: "task", task: task.id, title: task.plan.title, status: "started" });
    this.publishPlan(task);
    this.taskUpdate(task, "running");
    this.setStep(task, 1, "running");
    const ok = await this.confirmGate(task, task.plan.subgoals[0]?.confirm ?? `Call ${c.name}`);
    if (!ok || task.cancelled) return this.finishCancelled(task);
    const id = this.o.hub.nextId();
    task.callId = id;
    const result = this.o.hub.waitFor(id, this.o.timing.callMs);
    this.send({ type: "call", to: "caller", id, number: c.number, goal: c.goal, context: `You are calling on behalf of the phone's owner. ${c.name} is someone they know.` });
    this.o.log(`mind: calling ${c.name} (${c.number}): ${c.goal}`);
    this.narrate(`I'm calling ${c.name} now.`);
    const r = await Promise.race([result, task.cancelSignal.then(() => CANCELLED)]);
    if (r === CANCELLED || task.cancelled) {
      this.o.hub.cancelWait(id);
      return this.finishCancelled(task);
    }
    const res = r as Msg | null;
    let line: string;
    let good = false;
    if (!res) line = `The call to ${c.name} didn't finish in time, so I don't know how it went.`;
    else if (res.ok) {
      good = true;
      const summary = String(res.summary ?? "").trim();
      const first = c.name.split(/\s+/)[0].toLowerCase();
      line = !summary ? `I spoke to ${c.name} and the call went fine.` : summary.toLowerCase().includes(first) ? summary : `I spoke to ${c.name}: ${summary}`;
    } else line = `I couldn't get through to ${c.name}: ${callError(String(res.error ?? "failed"))}.`;
    this.setStep(task, 1, good ? "done" : "failed");
    return this.finishTask(task, good ? "done" : "failed", line);
  }

  // ---------- corrections (cheap, rule-based) ----------

  private onSpoke(text: string) {
    const now = Date.now();
    this.lastActivity = now;
    const likeOurs = this.recentSays.some((s) => now - s.at < 60_000 && similar(s.text, text));
    const duringOurs = this.pendingSays.size > 0 || now - this.lastSayDoneAt < 1500;
    if (likeOurs || (duringOurs && !this.answerPending)) return;
    this.answerPending = false;
    if (this.sleepAfterReply) {
      this.sleepAfterReply = false;
      this.sleepSoon();
    }
    this.pushConvo("bobby", text);
    const t = this.current;
    if (t && !t.correctedOnce && t.plan.kind === "phone" && DONE_RE.test(text) && !/\b(not|n't|almost|until|once|when|soon)\b/i.test(text)) {
      t.correctedOnce = true;
      this.correct(`That isn't finished yet; I'm still working on: ${t.plan.title}.`);
      return;
    }
    if (t?.plan.kind === "call" && !t.correctedOnce && /\b(said|says|told me|agreed|picked up|answered)\b/i.test(text)) {
      t.correctedOnce = true;
      this.correct(`The call to ${t.plan.call!.name} is still going; I don't know what they said yet.`);
      return;
    }
    const wrong = this.wrongName(text);
    if (wrong) {
      this.correct(`It's ${wrong.right}, not ${wrong.said}.`);
      return;
    }
    const spoken = times(text);
    if (spoken.length === 0) return;
    const userTurns = this.convo.filter((c) => c.who === "user").map((c) => c.text);
    const everything = [
      t?.plan.goal ?? "",
      ...this.facts,
      ...userTurns,
      ...this.notifications.map((n) => `${n.title} ${n.text}`),
      ...this.recentWhispers,
      ...this.recentSays.map((s) => s.text),
    ].join(" . ");
    const known = new Set(times(everything));
    const unknown = spoken.filter((x) => !known.has(x));
    if (unknown.length === 0) return;
    const focus = [...new Set(times([t?.plan.goal ?? "", ...this.facts.slice(-2), ...userTurns.slice(-2)].join(" . ")))];
    if (focus.length === 1) this.correct(`The time is ${focus[0]}, not ${unknown[0]}.`);
  }

  private wrongName(text: string): { right: string; said: string } | null {
    const t = this.current;
    if (!t || t.correctedName) return null;
    const about = t.plan.kind === "call" ? t.plan.call!.name : `${t.plan.title} ${t.plan.goal}`;
    const people = new Set<string>();
    for (const c of this.contactsCtx().contacts) people.add(c.name.split(/\s+/)[0]);
    for (const n of this.notifications) {
      const first = n.title.split(/\s+/)[0];
      if (/^[A-Z][a-z]+$/.test(first)) people.add(first);
    }
    const has = (hay: string, name: string) => new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(hay);
    const subjects = [...people].filter((n) => has(about, n));
    if (subjects.length !== 1 || has(text, subjects[0])) return null;
    for (const other of people) {
      if (other === subjects[0]) continue;
      const re = new RegExp(`\\b(call(?:ing|ed)?|ring(?:ing)?|phon(?:e|ing|ed)|repl(?:y|ying|ied) to|email(?:ing|ed)?|text(?:ing|ed)?|messag(?:e|ing|ed)|writ(?:e|ing) to|tell(?:ing)?|told|answer(?:ing)?)\\s+${escapeRe(other)}\\b`, "i");
      if (re.test(text)) {
        t.correctedName = true;
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

  private sleepSoon() {
    if (this.current || this.queue.length) return;
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
    const t = this.teaching;
    if (t) {
      // Never sleep mid-demo; end it when the user has stopped doing things, or after the cap.
      const now = Date.now();
      if (t.phase !== "watching") return;
      if (now - t.startedAt >= this.o.timing.teachMaxMs) void this.endTeach(t.actions > 0, "it has been long enough");
      else if (t.actions > 0 && now - t.lastActionAt >= this.o.timing.teachIdleMs) void this.endTeach(true, "nothing more was happening");
      return;
    }
    if (!this.awake || this.current || this.queue.length || this.pendingConfirm || this.pendingAsk || this.listening || this.decidesInFlight > 0 || this.pendingSays.size > 0) return;
    const now = Date.now();
    if (this.sleepAt && now >= this.sleepAt) {
      this.sleepAt = 0;
      this.sendSleep();
    } else if (now - this.lastActivity >= this.o.timing.sleepMs) this.sendSleep();
  }
}

// ---------- helpers ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

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

function similar(a: string, b: string): boolean {
  const wa = new Set(words(a));
  const wb = words(b);
  if (wa.size === 0 || wb.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = wb.filter((w) => wa.has(w)).length;
  return shared / Math.max(wa.size, wb.length) >= 0.5;
}

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

export { parseContactBook, findContact, fingerprint };
