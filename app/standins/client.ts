// Tiny hub client for the stand-ins, per CONTRACT.md "Connecting":
// hello/welcome, reconnect after 1 s, 2 s, 5 s, then every 5 s; never after close code 4001.
type Msg = { type: string; [k: string]: unknown };

export function connect(
  hubUrl: string,
  role: string,
  token: string,
  log: (line: string) => void,
  onMessage: (m: Msg, send: (m: Msg) => void) => void,
) {
  const backoff = [1000, 2000, 5000];
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let up = false;
  // Frames sent before the hub's welcome (e.g. wake on a cold start) wait here.
  const queue: Msg[] = [];

  const send = (m: Msg) => {
    if (ws && up) ws.send(JSON.stringify(m));
    else if (queue.length < 20) queue.push(m);
  };

  const open = () => {
    if (stopped) return;
    const url = `${hubUrl}/${role}?token=${encodeURIComponent(token)}`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', role, v: 1 }));
    sock.onmessage = (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'welcome') {
        up = true;
        attempt = 0;
        log('connected to hub');
        while (queue.length) sock.send(JSON.stringify(queue.shift()));
        return;
      }
      try {
        onMessage(m, send);
      } catch (e) {
        log(`handler error: ${String(e)}`);
      }
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (ws === sock) ws = null;
      if (up) log(`hub closed (${ev.code})`);
      up = false;
      if (stopped) return;
      if (ev.code === 4001) {
        log('replaced by a newer connection (4001); not reconnecting');
        return;
      }
      if (ev.code === 4003) log('hub rejected the token (4003)');
      const wait = backoff[Math.min(attempt++, backoff.length - 1)];
      timer = setTimeout(open, wait);
    };
  };

  open();
  return {
    send,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close(1000, 'stop');
      } catch {}
      ws = null;
    },
  };
}
