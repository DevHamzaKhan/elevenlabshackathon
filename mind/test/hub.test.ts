// The Mind's hub client follows "Connecting": hello/welcome, reconnect, and 4001 means stop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HubClient } from "../src/hub";
import { startFakeHub } from "../fakes/hub";
import { sleep, until } from "./helpers";

const port = () => 19400 + Math.floor(Math.random() * 400);

test("a newer mind replaces the older one, which gets 4001 and stays away", async () => {
  const p = port();
  const hub = startFakeHub({ port: p, log: () => {}, speed: 0 });
  await hub.ready;
  const logs: string[] = [];
  const a = new HubClient(`ws://localhost:${p}/mind?token=t`, "mind", () => {}, (s) => logs.push(`a ${s}`));
  const b = new HubClient(`ws://localhost:${p}/mind?token=t`, "mind", () => {}, (s) => logs.push(`b ${s}`));
  try {
    a.start();
    await until(() => a.connected);
    b.start();
    await until(() => b.connected);
    await until(() => !a.connected);
    await sleep(1500); // longer than the first reconnect delay
    assert.equal(a.connected, false, "old mind did not come back");
    assert.equal(b.connected, true);
    assert.ok(logs.some((l) => /a .*4001/.test(l)));
  } finally {
    a.stop();
    b.stop();
    await hub.close();
  }
});

test("reconnects after the hub restarts, and gets peers after welcome", async () => {
  const p = port();
  let hub = startFakeHub({ port: p, log: () => {}, speed: 0 });
  await hub.ready;
  const got: any[] = [];
  const c = new HubClient(`ws://localhost:${p}/mind?token=t`, "mind", (m) => got.push(m), () => {});
  try {
    c.start();
    await until(() => c.connected);
    await until(() => got.some((m) => m.type === "peers"));
    await hub.close();
    await until(() => !c.connected);
    hub = startFakeHub({ port: p, log: () => {}, speed: 0 });
    await hub.ready;
    assert.ok(await until(() => c.connected, 6000), "reconnected");
  } finally {
    c.stop();
    await hub.close();
  }
});

test("a strict hub closes a wrong token with 4003", async () => {
  const p = port();
  const hub = startFakeHub({ port: p, log: () => {}, token: "right" });
  await hub.ready;
  try {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${p}/mind?token=wrong`);
      ws.onclose = (e) => resolve(e.code);
    });
    assert.equal(code, 4003);
  } finally {
    await hub.close();
  }
});
