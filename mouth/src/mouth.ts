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
}

type State = "asleep" | "starting" | "live";
type Item = { kind: "say"; id: string; text: string; queuedAt: number } | { kind: "correct"; text: string };

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
  /** Delay from a say arriving to Bobby starting to speak it, in ms (latest first). */
  readonly sayLatencies: number[] = [];
  private readonly now: () => number;

  constructor(private readonly d: MouthDeps) {
    this.now = d.now ?? Date.now;
  }

  get status(): State {
    return this.state;
  }

  /** The app was opened: start a session, send `wake` once it is live. No-op if one is live or starting. */
  async wake(): Promise<void> {
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
      });
      if (this.state !== "starting") {
        await s.end(); // slept while starting
        return;
      }
      this.session = s;
      this.state = "live";
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
        this.queue.push({ kind: "say", id: msg.id, text, queuedAt: this.now() });
        this.pump();
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
          this.d.send({ type: "heard", text });
          this.session!.sendUserMessage(text);
        }
        return;
      default:
        return; // unknown: ignore
    }
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
    // A typed test turn may be echoed back as a transcript: it was already sent as heard.
    const i = this.typedTurns.findIndex((x) => x.text === t && this.now() - x.at < 10_000);
    if (i >= 0) {
      this.typedTurns.splice(i, 1);
      return;
    }
    this.armBackstop();
    this.d.send({ type: "heard", text: t });
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
    }
  }

  private onAgentResponse(text: string): void {
    const t = text.trim();
    if (t) this.d.send({ type: "spoke", text: t });
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
    const next = this.queue.shift();
    if (!next) return;
    this.current = { ...next, started: false, dispatchedAt: this.now() };
    const tag = next.kind === "say" ? SAY_TAG : CORRECT_TAG;
    this.session!.sendUserMessage(`${tag} ${next.text}`);
    this.setSayTimer(this.d.sayStartTimeoutMs ?? 8_000);
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
