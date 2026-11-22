#!/usr/bin/env node
// Pretend hub for the Mouth and the Caller (CONTRACT.md v1, "Connecting").
//
//   node fakes/hub.mjs [--port 8765] [--script file] [--timeout 30]
//
// Accepts any token. Prints every frame it receives. Type commands (or put them in
// a --script file, one per line):
//   say <text>          -> mouth   {"type":"say","to":"mouth","id":"m1","text":...}
//   whisper <text>      -> mouth
//   correct <text>      -> mouth
//   hush                -> mouth
//   sleep               -> mouth
//   call +1415... <goal> -> caller
//   user <text>         -> mouth   TEST ONLY: {"type":"test_user_turn"}; the Mouth sends it to
//                                  the agent as a typed user turn, since nobody can speak to the emulator.
//   wait <seconds>      pause (scripts)
//   expect <type> [secs] wait for a frame of that type from anyone, exit 1 if it never comes (scripts)
//   quit
import { WebSocketServer } from "ws";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt("port", process.env.MOUTH_HUB_PORT || 8765));
const script = opt("script");
const defaultTimeout = Number(opt("timeout", 30));

const clients = new Map(); // role -> ws (newest wins for mind/mouth/caller)
const watchers = new Set();
const received = []; // every frame received, for `expect`
let seq = 0;
const stamp = () => new Date().toISOString().slice(11, 23);
const print = (line) => console.log(`${stamp()} ${line}`);

function peers() {
  return { type: "peers", hands: false, mind: true, mouth: clients.has("mouth"), caller: clients.has("caller") };
}
function sendRaw(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcastPeers() {
  for (const w of watchers) sendRaw(w, peers());
}
function sendTo(role, msg) {
  const ws = clients.get(role);
  if (!ws) {
    print(`!! ${role} is not connected; dropped ${JSON.stringify(msg)}`);
    return;
  }
  sendRaw(ws, msg);
  print(`-> ${role} ${JSON.stringify(msg)}`);
  for (const w of watchers) sendRaw(w, { type: "wire", from: "mind", to: role, at: Date.now(), msg });
}

const wss = new WebSocketServer({ port, host: "0.0.0.0" });
wss.on("listening", () => print(`pretend hub on ws://0.0.0.0:${port}/<role>?token=anything (contract v1)`));
wss.on("error", (e) => {
  console.error(`hub error: ${e.message}`);
  process.exit(2);
});
wss.on("connection", (ws, req) => {
  const role = new URL(req.url, "ws://x").pathname.replace(/^\/+/, "");
  let ready = false;
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      print(`<- ${role} (not JSON) ${String(data).slice(0, 200)}`);
      return;
    }
    if (!ready) {
      if (msg.type !== "hello") return;
      ready = true;
      sendRaw(ws, { type: "welcome", v: 1 });
      if (role === "watch") {
        watchers.add(ws);
        sendRaw(ws, peers());
      } else {
        const old = clients.get(role);
        clients.set(role, ws);
        if (old && old !== ws) old.close(4001, "replaced");
        broadcastPeers();
      }
      print(`== ${role} connected`);
      return;
    }
    if (role === "watch") return;
    print(`<- ${role} ${JSON.stringify(msg)}`);
    received.push({ role, msg, at: Date.now() });
    for (const w of watchers) sendRaw(w, { type: "wire", from: role, to: "mind", at: Date.now(), msg });
  });
  ws.on("close", (code) => {
    watchers.delete(ws);
    if (clients.get(role) === ws) {
      clients.delete(role);
      broadcastPeers();
    }
    print(`== ${role} disconnected (${code})`);
  });
});

async function run(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const text = line.trim().slice(cmd.length).trim();
  switch (cmd) {
    case "":
    case "#":
      return;
    case "say":
      return sendTo("mouth", { type: "say", to: "mouth", id: `m${++seq}`, text });
    case "whisper":
    case "correct":
      return sendTo("mouth", { type: cmd, to: "mouth", text });
    case "hush":
    case "sleep":
      return sendTo("mouth", { type: cmd, to: "mouth" });
    case "user":
      return sendTo("mouth", { type: "test_user_turn", to: "mouth", text });
    case "call": {
      const [number, ...goal] = rest;
      return sendTo("caller", {
        type: "call", to: "caller", id: `m${++seq}`, number, goal: goal.join(" ") || "Say hello.",
        context: "You are speaking as the phone's owner. They expect this call.",
      });
    }
    case "wait":
      return new Promise((r) => setTimeout(r, Number(rest[0] || 1) * 1000));
    case "expect": {
      const type = rest[0];
      const secs = Number(rest[1] || defaultTimeout);
      const start = Date.now();
      const seen = () => received.find((r) => r.msg.type === type && r.at >= expectMark);
      while (!seen()) {
        if (Date.now() - start > secs * 1000) {
          print(`FAIL: no "${type}" within ${secs}s`);
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      print(`ok: got "${type}"`);
      return;
    }
    case "mark": // `expect` only counts frames after the latest mark
      expectMark = Date.now();
      return;
    case "quit":
      process.exit(0);
    default:
      print(`?? unknown command: ${cmd}`);
  }
}
let expectMark = 0;

if (script) {
  wss.on("listening", async () => {
    for (const line of readFileSync(script, "utf8").split("\n")) await run(line);
    print("script finished");
    process.exit(0);
  });
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => run(l));
}
