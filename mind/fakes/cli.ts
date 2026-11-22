// Shared command-line plumbing for the fakes: read lines from the terminal or from --script <file>.
// In a script, `wait 2` pauses for two seconds and lines starting with # are comments.

import fs from "node:fs";
import readline from "node:readline";

export function argValue(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Feed commands to `handle`. With --script, runs the file top to bottom (then calls onScriptEnd);
 * otherwise reads the terminal until it closes.
 */
export async function runCommands(
  handle: (line: string) => void | Promise<void>,
  onScriptEnd?: () => void,
) {
  const script = argValue("--script");
  if (script) {
    const lines = fs.readFileSync(script, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const w = /^wait\s+([\d.]+)$/.exec(line);
      if (w) {
        await sleep(parseFloat(w[1]) * 1000);
        continue;
      }
      await handle(line);
    }
    onScriptEnd?.();
    return;
  }
  if (!process.stdin.isTTY && hasFlag("--no-stdin")) return;
  const rl = readline.createInterface({ input: process.stdin });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    const w = /^wait\s+([\d.]+)$/.exec(line);
    if (w) {
      await sleep(parseFloat(w[1]) * 1000);
      continue;
    }
    await handle(line);
  }
}

/** A tiny WebSocket client for the fakes, with the contract's hello and reconnect rules. */
export function connectRole(
  url: string,
  role: string,
  onMessage: (m: any) => void,
  log: (s: string) => void,
  onWelcome: () => void = () => {},
) {
  let ws: WebSocket | null = null;
  let up = false;
  let attempt = 0;
  let stopped = false;
  const backoff = [1000, 2000, 5000];
  const open = () => {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "hello", role, v: 1 }));
    sock.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m?.type === "welcome") {
        up = true;
        attempt = 0;
        log(`connected to hub as ${role}`);
        onWelcome();
        return;
      }
      onMessage(m);
    };
    sock.onclose = (ev) => {
      up = false;
      if (ev.code === 4001) {
        log("replaced by a newer connection (4001); not reconnecting");
        stopped = true;
        return;
      }
      if (stopped) return;
      setTimeout(open, backoff[Math.min(attempt++, backoff.length - 1)]);
    };
    sock.onerror = () => {};
  };
  open();
  return {
    send(m: any) {
      if (ws && up) ws.send(JSON.stringify(m));
      else log(`(not connected, dropped ${m.type})`);
    },
    close() {
      stopped = true;
      ws?.close();
    },
    get up() {
      return up;
    },
  };
}

export function hubUrlFor(role: string): string {
  const base = argValue("--hub", process.env.MIND_HUB_URL || "ws://localhost:8765")!;
  const token = argValue("--token", process.env.HUB_TOKEN || "dev")!;
  return `${base.replace(/\/$/, "")}/${role}?token=${encodeURIComponent(token)}`;
}
