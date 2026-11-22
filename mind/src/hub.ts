// WebSocket client for the hub, following CONTRACT.md "Connecting".
// Uses the global WebSocket that both Node 22+ and React Native provide.

import type { Msg } from "./types";

const BACKOFF_MS = [1000, 2000, 5000];

type Pending = { resolve: (m: Msg | null) => void; timer: ReturnType<typeof setTimeout> };

export class HubClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** True between `welcome` and close. */
  connected = false;

  constructor(
    private url: string,
    private role: string,
    private onMessage: (m: Msg) => void,
    private log: (line: string) => void,
    private onConnected: (up: boolean) => void = () => {},
  ) {}

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
    try {
      this.ws?.close(1000, "stop");
    } catch {}
    this.ws = null;
  }

  /** A new request id, unique to the Mind. */
  nextId(): string {
    this.seq += 1;
    return `m${this.seq}`;
  }

  send(m: Msg): boolean {
    if (!this.ws || !this.connected) return false;
    try {
      this.ws.send(JSON.stringify(m));
      return true;
    } catch (e) {
      this.log(`hub send failed: ${String(e)}`);
      return false;
    }
  }

  /**
   * Wait for a reply whose `re` matches `id`. Resolves null on timeout or disconnect.
   * Register before sending so a fast reply isn't missed.
   */
  waitFor(id: string, ms: number): Promise<Msg | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, ms);
      this.pending.set(id, { resolve, timer });
    });
  }

  /** Stop waiting for `id`, resolving its waiter with null. */
  cancelWait(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(null);
  }

  private open() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.log(`hub connect error: ${String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", role: this.role, v: 1 }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      let m: Msg;
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || typeof m.type !== "string") return;
      if (m.type === "welcome") {
        this.connected = true;
        this.attempt = 0;
        this.log("hub: connected");
        this.onConnected(true);
        return;
      }
      if (typeof m.re === "string") {
        const p = this.pending.get(m.re);
        // say_started also carries `re` but isn't the final reply; let the brain see it.
        if (p && m.type !== "say_started" && m.type !== "call_status") {
          clearTimeout(p.timer);
          this.pending.delete(m.re);
          p.resolve(m);
        }
      }
      try {
        this.onMessage(m);
      } catch (e) {
        this.log(`brain error on ${m.type}: ${String(e)}`);
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      const wasUp = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (wasUp) this.onConnected(false);
      if (ev.code === 4001) {
        this.log("hub: replaced by a newer mind (4001), not reconnecting");
        this.stopped = true;
        return;
      }
      if (ev.code === 4003) this.log("hub: wrong token (4003)");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles reconnecting.
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
