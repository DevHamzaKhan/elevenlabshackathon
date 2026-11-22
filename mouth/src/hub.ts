// Hub client (CONTRACT.md v1, "Connecting"). Plain TypeScript: WebSocket and timers only,
// so it runs the same in Node (tests) and React Native (the app).

export type Frame = { type: string; [k: string]: unknown };
export type HubState = "connecting" | "live" | "disconnected" | "replaced" | "stopped";

export interface HubOptions {
  hubUrl: string; // e.g. ws://127.0.0.1:8765
  token: string;
  role: "mouth" | "caller";
  log: (line: string) => void;
  onMessage: (msg: Frame) => void;
  onState?: (s: HubState) => void;
  /** Injected for tests. Defaults to the global WebSocket. */
  WebSocketImpl?: { new (url: string): WebSocketLike };
  /** Reconnect delays in ms: 1 s, 2 s, 5 s, then every 5 s. */
  delays?: number[];
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Hub {
  send(msg: Frame): void;
  stop(): void;
  readonly state: HubState;
}

export function connectHub(o: HubOptions): Hub {
  const WS = o.WebSocketImpl ?? (globalThis as unknown as { WebSocket: { new (url: string): WebSocketLike } }).WebSocket;
  const delays = o.delays ?? [1000, 2000, 5000];
  const url = `${o.hubUrl.replace(/\/+$/, "")}/${o.role}?token=${encodeURIComponent(o.token)}`;
  let ws: WebSocketLike | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: HubState = "connecting";

  const setState = (s: HubState) => {
    if (state === s) return;
    state = s;
    o.onState?.(s);
  };

  const open = () => {
    if (state === "stopped" || state === "replaced") return;
    setState("connecting");
    const sock = new WS(url);
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "hello", role: o.role, v: 1 }));
    sock.onmessage = (ev) => {
      let msg: Frame;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // not JSON: ignore
      }
      if (!msg || typeof msg.type !== "string") return;
      o.log(`hub <- ${JSON.stringify(msg)}`);
      if (msg.type === "welcome") {
        attempt = 0;
        setState("live");
        return;
      }
      try {
        o.onMessage(msg);
      } catch (e) {
        o.log(`handler error: ${String(e)}`); // never crash on a message
      }
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (ev.code === 4001) {
        o.log("hub closed 4001: replaced by a newer connection, not reconnecting");
        setState("replaced");
        return;
      }
      if (ev.code === 4003) o.log("hub closed 4003: wrong HUB_TOKEN");
      if (state === "stopped") return;
      setState("disconnected");
      const d = delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      timer = setTimeout(open, d);
    };
  };
  open();

  return {
    send(msg: Frame) {
      if (ws && ws.readyState === 1 && state === "live") {
        ws.send(JSON.stringify(msg));
        o.log(`hub -> ${JSON.stringify(msg)}`);
      } else {
        o.log(`hub not live, dropped ${JSON.stringify(msg)}`);
      }
    },
    stop() {
      setState("stopped");
      if (timer) clearTimeout(timer);
      ws?.close(1000, "stop");
      ws = null;
    },
    get state() {
      return state;
    },
  };
}
