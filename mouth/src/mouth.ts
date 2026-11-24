// The Mouth's logic (CONTRACT.md v1, "Mouth" and "Sleeping"), independent of ElevenLabs.
// Plain TypeScript, timers only: runs in Node tests and in React Native.
import type { Frame } from "./hub";
import type { VoiceFactory, VoiceMode, VoiceSession } from "./voice";

export const SAY_TAG = "[SAY]";
export const CORRECT_TAG = "[CORRECT]";

export interface MouthDeps {
  send(msg: Frame): void; // to the hub (goes to the Mind)
  voice: VoiceFactory;
  log(line: string): void;
  now?: () => number;
  /** Timeouts, in ms. */
  sayStartTimeoutMs?: number; // a say that never starts speaking -> say_done spoken:false
  sayMaxMs?: number; // a say that never finishes -> say_done
  backstopMs?: number; // 5 min with nothing heard and nothing from the hub -> sleep
  listenSettleMs?: number; // "listening" must last this long before a turn counts as over (mode flickers in pauses)
  sayStaleMs?: number; // a say not started this long after it arrived is dropped (say_done spoken:false)
  micCloseMs?: number; // push-to-talk: silence after the last final user transcript before the mic closes
  micMaxMs?: number; // push-to-talk: the mic closes this long after a press even if nobody spoke
  commandMaxMs?: number; // push-to-talk: the mic closes this long after the command started, even if the room keeps talking
}

type State = "asleep" | "starting" | "live";
type Item =
  | { kind: "say"; id: string; text: string; queuedAt: number }
  | { kind: "correct"; text: string }
  /** v2 `progress` / `confirm_request` lines: spoken in order, no say_started/say_done. */
  | { kind: "line"; text: string };

/** Bobby's tools (protocol v2), announced in `voice_caps`. */
export const V2_TOOLS = ["request", "amend", "cancel", "confirm", "status"];

export class Mouth {
  private state: State = "asleep";
  private session: VoiceSession | null = null;
  private held: Frame[] = []; // messages that arrive while the session is starting
  private queue: Item[] = [];
  private current: (Item & { started: boolean; dispatchedAt: number }) | null = null;
  private mode: VoiceMode = "listening";
  private typedTurns: { text: string; at: number }[] = [];
  private sayTimer: ReturnType<typeof setTimeout> | null = null;
  private backstop: ReturnType<typeof setTimeout> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Push-to-talk: true from wake() until the user's command is over; heard is sent only then. */
  private listening = false;
  private micTimer: ReturnType<typeof setTimeout> | null = null;
  private micCap: ReturnType<typeof setTimeout> | null = null;
  private commandCap: ReturnType<typeof setTimeout> | null = null;
  private answeredWarned = false; // the current say's reply was already checked against the line
  /** Delay from a say arriving to Bobby starting to speak it, in ms (latest first). */
  readonly sayLatencies: number[] = [];
  // ---- protocol v2 (the voice model's tools are the input) ----
  /** The last raw user transcript (speech-to-text), sent with request/confirm_reply. */
  private lastHeard = "";
  /** Tasks the Mind reports as running/paused/waiting: speech then counts as a barge-in. */
  private activeTasks = new Set<string>();
  private pendingConfirm: { id: string; summary: string } | null = null;
  private statusCalls = new Map<string, { callId: string; timer: ReturnType<typeof setTimeout> }>();
  private statusSeq = 0;
  private lastBargeAt = 0;
  private readonly now: () => number;

  constructor(private readonly d: MouthDeps) {
    this.now = d.now ?? Date.now;
  }

  get status(): State {
    return this.state;
  }

  /** The app was opened (side button held): start a session, send `wake` once it is live, and
   *  listen for one command. While a session is live it reopens the mic for one more command. */
  async wake(): Promise<void> {
    if (this.state === "live") {
      this.openMic();
      // A new press: the Mind opens a listening window on every wake.
      this.sendCaps();
      this.d.send({ type: "wake" });
      this.armBackstop();
      return;
    }
    if (this.state !== "asleep") return;
    this.state = "starting";
    this.mode = "listening";
    try {
      const s = await this.d.voice({
        onConnect: () => {},
        onDisconnect: (reason) => this.onVoiceGone(reason),
        onUserTranscript: (t) => this.onUserTranscript(t),
        onAgentResponse: (t) => this.onAgentResponse(t),
        onModeChange: (m) => this.onModeChange(m),
        onError: (m) => this.d.log(`voice error: ${m}`),
        onToolCall: (name, args, callId) => this.onToolCall(name, args, callId),
        onSpeechStarted: () => this.onSpeechStarted(),
      });
      if (this.state !== "starting") {
        await s.end(); // slept while starting
        return;
      }
      this.session = s;
      this.state = "live";
      this.openMic();
      this.sendCaps();
      this.d.send({ type: "wake" });
      this.armBackstop();
      const held = this.held;
      this.held = [];
      for (const m of held) this.onHub(m);
      this.pump();
    } catch (e) {
      this.d.log(`could not start session: ${String(e)}`);
      this.state = "asleep";
      this.flushHeld();
    }
  }

  /** Every frame from the hub. */
  onHub(msg: Frame): void {
    if (this.state === "starting") {
      this.held.push(msg);
      return;
    }
    if (this.state === "asleep") {
      // Asleep: say nothing. A say is answered straight away; whisper/correct/hush/sleep ignored.
      if (msg.type === "say" && typeof msg.id === "string") this.d.send({ type: "say_done", re: msg.id, spoken: false });
      return;
    }
    this.armBackstop();
    const text = typeof msg.text === "string" ? msg.text : "";
    switch (msg.type) {
      case "whisper":
        if (text) this.session!.sendContextualUpdate(text);
        return;
      case "say":
        if (typeof msg.id !== "string") return;
        // No stale narration: only the newest line waits. Older queued (not yet sent) lines are dropped.
        this.dropQueuedSays("superseded");
        this.queue.push({ kind: "say", id: msg.id, text, queuedAt: this.now() });
        this.pump();
        this.armStale();
        return;
      case "correct":
        if (text) {
          this.queue.unshift({ kind: "correct", text }); // a correction goes before queued lines
          this.pump();
        }
        return;
      case "hush":
        this.hush();
        return;
      case "sleep":
        void this.sleep();
        return;
      case "test_user_turn": // test only: a typed user turn, since nobody can speak to the emulator
        if (text) {
          this.typedTurns.push({ text, at: this.now() });
          this.lastHeard = text;
          this.d.send({ type: "heard", text });
          this.session!.sendUserMessage(text);
        }
        return;
      // ---- protocol v2 (mind/PROTOCOL-V2.md) ----
      case "progress": {
        if (!text) return;
        const p = String(msg.priority ?? "when_idle");
        if (p === "silent") this.session!.sendContextualUpdate(`UPDATE: ${text}`);
        else {
          if (p === "interrupt") this.hush();
          this.queue.push({ kind: "line", text });
          this.pump();
        }
        return;
      }
      case "confirm_request": {
        if (typeof msg.id !== "string") return;
        const summary = String(msg.summary ?? "");
        this.pendingConfirm = { id: msg.id, summary };
        this.session!.sendContextualUpdate(`CONFIRM id=${msg.id}: ${summary}. Ask the user if you should go ahead, then call confirm with id "${msg.id}" and their answer.`);
        this.queue.unshift({ kind: "line", text: `${summary.replace(/[.!?\s]+$/, "")}. Should I go ahead?` });
        this.openMic(); // the user has to be able to answer
        this.pump();
        return;
      }
      case "task_update": {
        const id = String(msg.task ?? "");
        const st = String(msg.status ?? "");
        if (["running", "paused", "waiting_confirm"].includes(st)) this.activeTasks.add(id);
        else this.activeTasks.delete(id);
        if (st === "cancelled" && this.pendingConfirm) this.pendingConfirm = null;
        return;
      }
      case "status_result": {
        const w = this.statusCalls.get(String(msg.re ?? ""));
        if (!w) return;
        clearTimeout(w.timer);
        this.statusCalls.delete(String(msg.re));
        this.session!.toolResult?.(w.callId, JSON.stringify({ status: text || "Nothing running." }), true);
        return;
      }
      default:
        return; // unknown: ignore
    }
  }

  // ---------- v2: the voice model's tools ----------

  private sendCaps(): void {
    if (this.session?.tools) this.d.send({ type: "voice_caps", v: 2, tools: V2_TOOLS });
  }

  private onToolCall(name: string, args: Record<string, unknown>, callId: string): void {
    if (this.state !== "live" || !this.session) return;
    this.armBackstop();
    const s = this.session;
    const reply = (o: object, respond: boolean) => s.toolResult?.(callId, JSON.stringify(o), respond);
    const text = typeof args.text === "string" ? args.text.trim() : "";
    this.d.log(`tool ${name}(${JSON.stringify(args)})`);
    switch (name) {
      case "request":
        if (!text) return reply({ error: "empty request" }, false);
        this.d.send({ type: "request", text, heard: this.lastHeard });
        return reply({ accepted: true, note: "Acknowledge in two or three words. The outcome comes later as an UPDATE; don't claim it." }, true);
      case "amend":
        if (!text) return reply({ error: "empty amend" }, false);
        this.d.send({ type: "amend", text, heard: this.lastHeard });
        return reply({ accepted: true }, true);
      case "cancel":
        this.d.send({ type: "cancel", scope: args.scope === "current" ? "current" : "all" });
        return reply({ accepted: true, note: "Say it's stopping. Don't say what happened until an UPDATE." }, true);
      case "confirm": {
        const id = typeof args.id === "string" && args.id ? args.id : this.pendingConfirm?.id;
        if (!id) return reply({ error: "nothing to confirm" }, false);
        // The Mind checks the raw transcript too: the voice model's yes alone isn't enough.
        this.d.send({ type: "confirm_reply", re: id, ok: args.answer === "yes", heard: this.lastHeard });
        this.pendingConfirm = null;
        return reply({ recorded: true, note: "Wait for the UPDATE before saying anything happened." }, false);
      }
      case "status": {
        const id = `st${++this.statusSeq}`;
        const timer = setTimeout(() => {
          this.statusCalls.delete(id);
          reply({ status: "unknown right now" }, true);
        }, 2000);
        this.statusCalls.set(id, { callId, timer });
        this.d.send({ type: "status", id });
        return;
      }
      default:
        return reply({ error: `unknown tool ${name}` }, false);
    }
  }

  /** The user started talking while a task runs: the Mind pauses it at the next step. */
  private onSpeechStarted(): void {
    if (this.state !== "live" || this.activeTasks.size === 0 || this.pendingConfirm) return;
    const now = this.now();
    if (now - this.lastBargeAt < 2000) return;
    this.lastBargeAt = now;
    this.d.send({ type: "barge_in" });
  }

  /** Stop audio now and drop queued lines; every say still gets its say_done. */
  hush(): void {
    if (this.state !== "live") return;
    this.session?.interrupt();
    this.finishCurrent(true);
    this.dropQueue();
  }

  async sleep(): Promise<void> {
    if (this.state === "asleep") return;
    const wasStarting = this.state === "starting";
    this.state = "asleep";
    this.clearBackstop();
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    this.clearMicTimer();
    this.listening = false;
    for (const w of this.statusCalls.values()) clearTimeout(w.timer);
    this.statusCalls.clear();
    this.pendingConfirm = null;
    this.finishCurrent(true);
    this.dropQueue();
    this.flushHeld();
    const s = this.session;
    this.session = null;
    if (s) {
      try {
        await s.end();
      } catch (e) {
        this.d.log(`end failed: ${String(e)}`);
      }
    }
    if (!wasStarting || s) this.d.send({ type: "asleep" });
  }

  stop(): Promise<void> {
    return this.sleep();
  }

  // ---------- voice events ----------

  private onUserTranscript(text: string): void {
    const t = text.trim();
    if (!/[\p{L}\p{N}]/u.test(t)) return; // "..." and other noise-only transcripts
    if (t.startsWith(SAY_TAG) || t.startsWith(CORRECT_TAG)) return; // our own instructions
    this.lastHeard = t;
    // A typed test turn may be echoed back as a transcript: it was already sent as heard.
    const i = this.typedTurns.findIndex((x) => x.text === t && this.now() - x.at < 10_000);
    if (i >= 0) {
      this.typedTurns.splice(i, 1);
      return;
    }
    if (!this.listening) {
      this.d.log(`mic closed: not sent as heard: ${t}`);
      return; // push-to-talk: one command per press
    }
    this.armBackstop();
    this.d.send({ type: "heard", text: t });
    // The command is over after this much silence; another final transcript restarts the wait.
    if (this.micTimer) clearTimeout(this.micTimer);
    this.micTimer = setTimeout(() => this.closeMic(), this.d.micCloseMs ?? 1_800);
    // ...and at most this long after it started, however much the room keeps talking.
    if (!this.commandCap) this.commandCap = setTimeout(() => this.closeMic(), this.d.commandMaxMs ?? 6_000);
    // The user spoke before our line started: the agent's next turn answers the user, not
    // the line. Put the line back at the front and send it again once that answer is over.
    const c = this.current;
    if (c && !c.started) {
      this.current = null;
      if (this.sayTimer) clearTimeout(this.sayTimer);
      this.sayTimer = null;
      const { started: _s, dispatchedAt: _d, ...item } = c;
      this.queue.unshift(item as Item);
      // Re-sent when the answer ends (mode -> listening), or after a while if no answer comes.
      this.setSayTimer(this.d.sayStartTimeoutMs ?? 8_000);
      this.armStale(); // still dropped if it hasn't started within sayStaleMs of arriving
    }
  }

  private onAgentResponse(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.d.send({ type: "spoke", text: t });
    // The agent sometimes answers a [SAY] line ("Yep. On it.") instead of speaking it. It still
    // counts as spoken (it was said, and re-sending would pile up); just log it.
    const c = this.current;
    if (c && c.kind === "say" && c.started && !this.answeredWarned) {
      this.answeredWarned = true;
      if (!resembles(t, c.text)) this.d.log(`say ${c.id} answered instead of spoken: "${t}" (line: "${c.text}")`);
    }
  }

  private onModeChange(mode: VoiceMode): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    const ms = this.d.listenSettleMs ?? 600;
    if (mode === "listening" && ms > 0 && this.mode === "speaking") {
      // A short pause inside one turn also reports "listening": wait until it lasts.
      this.settle = setTimeout(() => {
        this.settle = null;
        this.applyMode("listening");
      }, ms);
      return;
    }
    this.applyMode(mode);
  }

  private applyMode(mode: VoiceMode): void {
    if (this.state !== "live") return;
    this.mode = mode;
    const c = this.current;
    if (mode === "speaking" && c && !c.started) {
      c.started = true;
      if (c.kind === "say") {
        const ms = this.now() - c.queuedAt;
        this.sayLatencies.unshift(ms);
        this.d.log(`say ${c.id} started after ${ms} ms`);
        this.d.send({ type: "say_started", re: c.id });
      }
      this.setSayTimer(this.d.sayMaxMs ?? 30_000);
    } else if (mode === "listening") {
      if (c && c.started) this.finishCurrent(true);
      this.pump();
    }
  }

  private onVoiceGone(reason: string): void {
    if (this.state === "asleep") return; // our own end()
    this.d.log(`session ended by the other side: ${reason}`);
    this.session = null;
    void this.sleep();
  }

  // ---------- the say queue ----------

  /** Send the next queued line to the agent when nothing is being spoken. */
  private pump(): void {
    if (this.state !== "live" || this.current || this.mode === "speaking") return;
    this.dropStale();
    const next = this.queue.shift();
    if (!next) return;
    this.current = { ...next, started: false, dispatchedAt: this.now() };
    this.answeredWarned = false;
    const s = this.session!;
    if (s.speak) s.speak(next.kind === "correct" ? `Quick correction: ${next.text}` : next.text);
    else s.sendUserMessage(`${next.kind === "correct" ? CORRECT_TAG : SAY_TAG} ${next.text}`);
    // A say must start within sayStaleMs of arriving, or it is dropped as stale.
    let ms = this.d.sayStartTimeoutMs ?? 8_000;
    if (next.kind === "say") ms = Math.min(ms, Math.max(0, next.queuedAt + this.staleMs() - this.now()));
    this.setSayTimer(ms);
  }

  private staleMs(): number {
    return this.d.sayStaleMs ?? 4_000;
  }

  /** Queued says (not yet sent to the agent) older than sayStaleMs get say_done spoken:false. */
  private dropStale(): void {
    const now = this.now();
    this.queue = this.queue.filter((it) => {
      if (it.kind !== "say" || now - it.queuedAt < this.staleMs()) return true;
      this.d.log(`say ${it.id} dropped: not started ${now - it.queuedAt} ms after it arrived`);
      this.d.send({ type: "say_done", re: it.id, spoken: false });
      return false;
    });
  }

  private dropQueuedSays(why: string): void {
    this.queue = this.queue.filter((it) => {
      if (it.kind !== "say") return true;
      this.d.log(`say ${it.id} dropped: ${why}`);
      this.d.send({ type: "say_done", re: it.id, spoken: false });
      return false;
    });
  }

  /** Wake up when the oldest queued say goes stale, even if nothing else happens. */
  private armStale(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    const says = this.queue.filter((it) => it.kind === "say") as { queuedAt: number }[];
    if (!says.length) return;
    const due = Math.min(...says.map((it) => it.queuedAt)) + this.staleMs() - this.now();
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.state !== "live") return;
      this.dropStale();
      this.pump();
      this.armStale();
    }, Math.max(0, due) + 1);
  }

  // ---------- push-to-talk ----------

  private openMic(): void {
    this.clearMicTimer();
    this.listening = true;
    this.session?.setMicMuted(false);
    this.d.log("listening");
    // Hard caps, so a noisy room can't keep the mic open.
    this.micCap = setTimeout(() => this.closeMic(), this.d.micMaxMs ?? 12_000);
  }

  private closeMic(): void {
    this.clearMicTimer();
    if (!this.listening) return;
    this.listening = false;
    this.session?.setMicMuted(true);
    this.d.log("mic closed");
  }

  private clearMicTimer(): void {
    if (this.micTimer) clearTimeout(this.micTimer);
    this.micTimer = null;
    if (this.micCap) clearTimeout(this.micCap);
    this.micCap = null;
    if (this.commandCap) clearTimeout(this.commandCap);
    this.commandCap = null;
  }

  private finishCurrent(spokenIfStarted: boolean): void {
    const c = this.current;
    this.current = null;
    if (this.sayTimer) clearTimeout(this.sayTimer);
    this.sayTimer = null;
    if (!c || c.kind !== "say") return;
    this.d.send(c.started && spokenIfStarted ? { type: "say_done", re: c.id } : { type: "say_done", re: c.id, spoken: false });
  }

  private dropQueue(): void {
    for (const it of this.queue) if (it.kind === "say") this.d.send({ type: "say_done", re: it.id, spoken: false });
    this.queue = [];
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  private flushHeld(): void {
    const held = this.held;
    this.held = [];
    for (const m of held) if (m.type === "say" && typeof m.id === "string") this.d.send({ type: "say_done", re: m.id, spoken: false });
  }

  private setSayTimer(ms: number): void {
    if (this.sayTimer) clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(() => {
      this.d.log("say timed out");
      this.finishCurrent(true);
      this.pump();
    }, ms);
  }

  // ---------- 5 minute backstop ----------

  private armBackstop(): void {
    this.clearBackstop();
    this.backstop = setTimeout(() => {
      this.d.log("5 minutes with nothing heard and nothing from the hub: ending the session");
      void this.sleep();
    }, this.d.backstopMs ?? 5 * 60_000);
  }

  private clearBackstop(): void {
    if (this.backstop) clearTimeout(this.backstop);
    this.backstop = null;
  }
}

/** Loosely: does the agent's reply contain most of the line's words? ("Yep. On it." vs "Finding Gmail." -> no) */
export function resembles(reply: string, line: string): boolean {
  const words = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1);
  const want = words(line);
  if (!want.length) return true;
  const got = new Set(words(reply));
  return want.filter((w) => got.has(w)).length / want.length >= 0.5;
}
