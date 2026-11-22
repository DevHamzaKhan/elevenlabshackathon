// Pretend hub and pretend phone in one, following CONTRACT.md "Connecting", "Routing" and "Watch".
// Run: npx tsx fakes/hub.ts [--port 8765] [--flaky] [--strict-token] [--script file]
// Commands: notify <app> | <title> | <text>    hands on|off    where    sent    reset    popup

import { WebSocketServer, WebSocket as WS } from "ws";
import { pathToFileURL } from "node:url";
import { Phone } from "./phone";
import { argValue, hasFlag, runCommands } from "./cli";

const SINGLE_ROLES = ["mind", "mouth", "caller"] as const;
type Role = (typeof SINGLE_ROLES)[number] | "watch";

export type FakeHubOptions = {
  port?: number;
  log?: (s: string) => void;
  speed?: number;
  flaky?: boolean | number;
  /** When set, a wrong token is closed with 4003. Pretend hubs accept any token by default. */
  token?: string;
  random?: () => number;
};

export type FakeHub = {
  phone: Phone;
  /** Every frame the hub delivered, as {from,to,msg}. Tests read this. */
  wire: { from: string; to: string; at: number; msg: any }[];
  /** Every frame the Mind addressed to `watch` (task, plan, step). */
  watched: any[];
  notify(app: string, title: string, text: string): void;
  setHands(on: boolean): void;
  close(): Promise<void>;
  ready: Promise<void>;
  /** The port actually listened on (useful with `port: 0`, which lets the OS pick a free one). */
  readonly port: number;
};

export function startFakeHub(opts: FakeHubOptions = {}): FakeHub {
  const port = opts.port ?? 8765;
  const log = opts.log ?? ((s: string) => console.log(s));
  const phone = new Phone({ log, speed: opts.speed, flaky: opts.flaky, random: opts.random });
  const wire: FakeHub["wire"] = [];
  const watched: any[] = [];
  const conns: Partial<Record<(typeof SINGLE_ROLES)[number], WS>> = {};
  const watchers = new Set<WS>();
  let lastTask: any = null;
  let lastPlan: any = null;

  const wss = new WebSocketServer({ port, host: "0.0.0.0" });
  const ready = new Promise<void>((resolve) => wss.on("listening", () => resolve()));

  const sendRaw = (ws: WS | undefined, m: any) => {
    if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(m));
  };

  const peersMsg = () => ({
    type: "peers",
    hands: phone.on,
    mind: !!conns.mind,
    mouth: !!conns.mouth,
    caller: !!conns.caller,
  });

  const broadcastPeers = () => {
    const p = peersMsg();
    sendRaw(conns.mind, p);
    for (const w of watchers) sendRaw(w, p);
  };

  const mirror = (from: string, to: string, msg: any) => {
    const entry = { from, to, at: Date.now(), msg };
    wire.push(entry);
    const frame = { type: "wire", ...entry };
    for (const w of watchers) sendRaw(w, frame);
  };

  /** Deliver a frame to a part, mirroring it to watchers. Dropped when the part is absent. */
  const deliver = (from: string, to: string, msg: any) => {
    if (to === "watch") {
      watched.push(msg);
      if (msg.type === "task") log(`hub: task ${msg.task} "${msg.title}" ${msg.status}`);
      if (msg.type === "task") lastTask = msg;
      if (msg.type === "plan") lastPlan = msg;
      for (const w of watchers) sendRaw(w, msg);
      return;
    }
    if (to === "hands") {
      if (!phone.on) return;
      mirror(from, to, msg);
      void handsHandle(msg);
      return;
    }
    const target = conns[to as (typeof SINGLE_ROLES)[number]];
    if (!target) {
      log(`hub: dropped ${msg.type} for ${to} (not connected)`);
      return;
    }
    mirror(from, to, msg);
    sendRaw(target, msg);
  };

  const fromHands = (msg: any) => {
    if (!conns.mind) return;
    mirror("hands", "mind", msg);
    sendRaw(conns.mind, msg);
  };

  const handsHandle = async (m: any) => {
    if (m.type === "screen") {
      const r = phone.read();
      log(`hub: screen read on ${phone.where()} (${r.nodes.length} nodes)`);
      fromHands({ type: "screen_result", re: m.id, ...r });
    } else if (m.type === "act") {
      const r = await phone.act(m);
      if (!r.ok) log(`phone: ${m.do} failed: ${r.error}`);
      fromHands({ type: "act_result", re: m.id, ...r });
    } else if (m.type === "cursor") {
      log(`phone: cursor ${m.show ? "shown" : "hidden"}`);
    }
  };

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "ws://x");
    const role = url.pathname.replace(/^\//, "") as Role;
    const token = url.searchParams.get("token");
    if (opts.token && token !== opts.token) {
      ws.close(4003, "bad token");
      return;
    }
    if (![...SINGLE_ROLES, "watch"].includes(role)) {
      ws.close(1008, "unknown role");
      return;
    }
    let helloed = false;
    ws.on("message", (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!m || typeof m.type !== "string") return;
      if (!helloed) {
        if (m.type !== "hello") return;
        helloed = true;
        sendRaw(ws, { type: "welcome", v: 1 });
        if (role === "watch") {
          watchers.add(ws);
          sendRaw(ws, peersMsg());
          if (lastTask && lastTask.status === "started") {
            sendRaw(ws, lastTask);
            if (lastPlan && lastPlan.task === lastTask.task) sendRaw(ws, lastPlan);
          }
        } else {
          const old = conns[role];
          conns[role] = ws;
          if (old && old !== ws) old.close(4001, "replaced");
          log(`hub: ${role} connected`);
          broadcastPeers();
        }
        return;
      }
      if (role === "watch") return; // read-only
      if (role === "mind") {
        const to = m.to;
        if (!["hands", "mouth", "caller", "watch"].includes(to)) {
          log(`hub: mind frame without a valid "to" dropped: ${m.type}`);
          return;
        }
        deliver("mind", to, m);
      } else {
        deliver(role, "mind", m);
      }
    });
    ws.on("close", () => {
      if (role === "watch") {
        watchers.delete(ws);
        return;
      }
      if (conns[role as (typeof SINGLE_ROLES)[number]] === ws) {
        delete conns[role as (typeof SINGLE_ROLES)[number]];
        log(`hub: ${role} disconnected`);
        broadcastPeers();
      }
    });
  });

  return {
    phone,
    wire,
    watched,
    ready,
    get port() {
      const a = wss.address();
      return a && typeof a === "object" ? a.port : port;
    },
    notify(app, title, text) {
      const n = { type: "notification", app, title, text, at: Date.now() };
      phone.notifications.push({ app, title, text, at: n.at });
      log(`phone: notification from ${app}: ${title}: ${text}`);
      if (app.startsWith("dev.bobby.")) return; // Hands never forwards its own
      fromHands(n);
    },
    setHands(on) {
      phone.on = on;
      log(`hub: hands ${on ? "on" : "off"}`);
      broadcastPeers();
    },
    close() {
      return new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      });
    },
  };
}

// Command-line mode.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(argValue("--port", "8765"));
  const hub = startFakeHub({
    port,
    flaky: hasFlag("--flaky") ? Number(argValue("--flaky-rate", "0.12")) : false,
    token: hasFlag("--strict-token") ? process.env.HUB_TOKEN : undefined,
    log: (s) => console.log(`[hub] ${s}`),
  });
  await hub.ready;
  console.log(`[hub] pretend hub + phone listening on ws://localhost:${port}`);
  await runCommands((line) => {
    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    if (cmd === "notify") {
      const [app, title, text] = arg.split("|").map((s) => s.trim());
      if (!app || !title) return console.log("usage: notify <app> | <title> | <text>");
      hub.notify(app, title, text ?? "");
    } else if (cmd === "hands") {
      hub.setHands(arg !== "off");
    } else if (cmd === "where") {
      console.log(`[hub] phone is on ${hub.phone.where()}`);
    } else if (cmd === "sent") {
      console.log(`[hub] sent: ${hub.phone.sent ? JSON.stringify(hub.phone.sent) : "nothing"}`);
    } else if (cmd === "reset") {
      hub.phone.reset();
      console.log("[hub] phone reset to home page 1");
    } else if (cmd === "popup") {
      hub.phone.popup = "Update available";
      console.log("[hub] pop-up shown");
    } else {
      console.log("commands: notify <app> | <title> | <text>, hands on|off, where, sent, reset, popup, wait <s>");
    }
  });
}
