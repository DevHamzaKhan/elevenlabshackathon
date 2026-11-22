// Pretend hub for the dashboard. Listens on :8765, accepts /watch with any token,
// and plays stage/dashboard/story.jsonl to every watch client on a loop.
//
//   node stage/dashboard/replay.mjs [--story path] [--port 8765] [--speed 1] [--once]
//
// Each story line is one watch message (CONTRACT.md "Watch"), plus an optional
// "dt" field: milliseconds to wait before sending it. "dt" is stripped before
// sending, and every "at" is rewritten to the current time.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const here = dirname(fileURLToPath(import.meta.url));
const storyPath = opt("story", join(here, "story.jsonl"));
const port = Number(opt("port", process.env.HUB_PORT || 8765));
const speed = Number(opt("speed", 1));
const once = args.includes("--once");

const story = readFileSync(storyPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("//"))
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      console.error(`${storyPath}:${i + 1}: bad JSON: ${e.message}`);
      process.exit(1);
    }
  });

const clients = new Set();
// What a real hub remembers for late joiners.
let snapshot = { peers: null, task: null, plan: null };

const wss = new WebSocketServer({ port });
wss.on("connection", (ws, req) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path !== "/watch") {
    ws.close(4003, "replay only serves /watch");
    return;
  }
  ws.once("message", (data) => {
    let hello;
    try {
      hello = JSON.parse(data);
    } catch {
      return ws.close(1003, "bad hello");
    }
    if (hello.type !== "hello") return ws.close(1003, "expected hello");
    ws.send(JSON.stringify({ type: "welcome", v: 1 }));
    for (const m of [snapshot.peers, snapshot.task?.status === "started" ? snapshot.task : null,
      snapshot.task?.status === "started" ? snapshot.plan : null]) {
      if (m) ws.send(JSON.stringify(m));
    }
    clients.add(ws);
    console.log(`watch connected (${clients.size})`);
  });
  ws.on("close", () => clients.delete(ws));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(msg) {
  const now = Date.now();
  const out = { ...msg };
  delete out.dt;
  if ("at" in out) out.at = now;
  if (out.msg && "at" in out.msg) out.msg = { ...out.msg, at: now };
  if (out.type === "peers") snapshot.peers = out;
  if (out.type === "task") snapshot.task = out;
  if (out.type === "plan") snapshot.plan = out;
  const text = JSON.stringify(out);
  for (const ws of clients) if (ws.readyState === 1) ws.send(text);
  const label = out.type === "wire" ? `wire ${out.from}->${out.to} ${out.msg?.type}` : out.type;
  console.log(`${new Date(now).toISOString().slice(11, 19)} ${label}`);
}

async function play() {
  do {
    for (const msg of story) {
      await sleep((msg.dt ?? 600) / speed);
      broadcast(msg);
    }
    await sleep(4000 / speed);
  } while (!once);
  process.exit(0);
}

wss.on("listening", () => {
  console.log(`replay hub on ws://localhost:${port}/watch, ${story.length} messages, speed ${speed}`);
  play();
});
wss.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `port ${port} is in use: stop the other hub first` : e.message);
  process.exit(1);
});
