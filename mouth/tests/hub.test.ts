import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket as NodeWS } from "ws";
import { connectHub, type Frame } from "../src/hub";
import { dryRunCall, allowlist, startCallerWith } from "../src/caller";

const WS = NodeWS as unknown as { new (url: string): never };

function server(port: number, onHello: (ws: NodeWS, role: string, hello: Frame) => void) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (ws, req) => {
    const role = new URL(req.url!, "ws://x").pathname.slice(1);
    ws.once("message", (d) => onHello(ws, role, JSON.parse(String(d))));
  });
  return wss;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("hello first, welcome makes it live, unknown frames ignored, reconnects after a drop", async () => {
  const hellos: Frame[] = [];
  let conns = 0;
  const wss = server(8811, (ws, role, hello) => {
    hellos.push(hello);
    conns++;
    ws.send(JSON.stringify({ type: "welcome", v: 1 }));
    ws.send("not json");
    ws.send(JSON.stringify({ type: "brand_new", x: 1 }));
    ws.send(JSON.stringify({ type: "say", to: "mouth", id: "m1", text: "hi" }));
    if (conns === 1) setTimeout(() => ws.close(1011, "drop"), 50);
  });
  const got: Frame[] = [];
  const hub = connectHub({ hubUrl: "ws://127.0.0.1:8811", token: "t", role: "mouth", log: () => {}, onMessage: (m) => got.push(m), WebSocketImpl: WS, delays: [50, 50] });
  await wait(300);
  assert.deepEqual(hellos[0], { type: "hello", role: "mouth", v: 1 });
  assert.equal(conns, 2, "reconnected");
  assert.equal(hub.state, "live");
  assert.deepEqual(got.map((m) => m.type), ["brand_new", "say", "brand_new", "say"]);
  hub.stop();
  wss.close();
});

test("close code 4001 means replaced: never reconnect", async () => {
  let conns = 0;
  const wss = server(8812, (ws) => {
    conns++;
    ws.send(JSON.stringify({ type: "welcome", v: 1 }));
    setTimeout(() => ws.close(4001, "replaced"), 30);
  });
  const hub = connectHub({ hubUrl: "ws://127.0.0.1:8812", token: "t", role: "mouth", log: () => {}, onMessage: () => {}, WebSocketImpl: WS, delays: [20] });
  await wait(250);
  assert.equal(conns, 1);
  assert.equal(hub.state, "replaced");
  wss.close();
});

test("dry-run caller: status sequence then exactly one call_result; not_allowed for others", async () => {
  const ok = dryRunCall({ type: "call", id: "m9", number: "+14155550123", goal: "Say hi" }, ["+14155550123"]);
  assert.deepEqual(ok.map((f) => f.type === "call_status" ? f.status : f.type), ["dialing", "answered", "ended", "call_result"]);
  assert.equal(ok.at(-1)!.ok, true);
  assert.deepEqual(dryRunCall({ type: "call", id: "m1", number: "+19999999999" }, ["+14155550123"]),
    [{ type: "call_result", re: "m1", ok: false, error: "not_allowed" }]);
  assert.equal(dryRunCall({ type: "call", id: "m2", number: "555-1234" }, []).at(-1)!.error, "not_allowed");
  assert.deepEqual(allowlist({ CALL_ALLOWLIST: " +1415555, +1416666 ," }), ["+1415555", "+1416666"]);
});

test("startCaller connects as caller and answers a call over the hub", async () => {
  const got: Frame[] = [];
  const wss = server(8813, (ws, role) => {
    assert.equal(role, "caller");
    ws.send(JSON.stringify({ type: "welcome", v: 1 }));
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ type: "call", to: "caller", id: "m9", number: "+14155550123", goal: "hi", context: "c" }));
  });
  const c = startCallerWith({ hubUrl: "ws://127.0.0.1:8813", token: "t", log: () => {}, env: {}, WebSocketImpl: WS, stepMs: 10 });
  await wait(200);
  assert.deepEqual(got.map((f) => f.type), ["call_status", "call_status", "call_status", "call_result"]);
  c.stop();
  wss.close();
});
