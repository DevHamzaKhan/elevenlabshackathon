// Teaching by showing: the user says what they'll show, does it on the (pretend) phone while
// Hands reports it, and says done. Later requests run the recorded steps with no model call, and
// fall back to the executor, with the demo as its guide, when the app no longer looks the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sleep, until, type T } from "./helpers";
import { InMemoryStore } from "../src/memory";
import { locate } from "../src/script";
import { buildSkill, fallbackMeta, forgetIntent, matchSkill, planSkill, readDemo, teachEnd, teachIntent } from "../src/teach";

const SAID = "Hey Tibby, I'm going to show you how to add a new project. I'm going to do it on my phone and type in test test.";
const done = (t: T) => t.tasks().filter((m) => m.status === "done" && !/^Learn/.test(m.title)).length;
const said = (t: T) => t.fromMind("progress").map((m) => String(m.text));

/** The user's demo: open Projects from the home screen, New project, type a name, Create. */
function showAddProject(t: T, name = "test test") {
  const u = t.hub.phone.user;
  u.open("Projects");
  u.tap("New project");
  u.type(name);
  u.tap("Create");
}

/** Says it, shows it, says done; waits until the skill is saved. */
async function teachAddProject(t: T) {
  t.mouth!.teach("start", "add a new project", SAID);
  assert.ok(await until(() => t.brain.teaching?.phase === "watching", 3000), "watching");
  showAddProject(t);
  await sleep(60);
  t.mouth!.teach("done", "", "okay, done");
  assert.ok(await until(() => t.brain.skills.all().length === 1, 4000), "skill saved");
  await t.brain.teachDone;
}

test("what the user says: starting, ending and forgetting", () => {
  assert.deepEqual(teachIntent(SAID), { name: "add a new project" });
  assert.deepEqual(teachIntent("I'm teaching you a skill"), { name: "" });
  assert.deepEqual(teachIntent("let me show you how I log my weight"), { name: "log my weight" });
  assert.deepEqual(teachIntent("Tibby, I want to teach you to start a focus session, watch me"), { name: "start a focus session" });
  assert.equal(teachIntent("text Alex I'll show you the house tomorrow"), null, "only at the start of what was said");
  assert.equal(teachIntent("add a project called test"), null);
  assert.equal(teachEnd("okay, I'm done"), "done");
  assert.equal(teachEnd("that's it"), "done");
  assert.equal(teachEnd("stop watching"), "done");
  assert.equal(teachEnd("never mind, forget it"), "cancel");
  assert.equal(teachEnd("now I tap the plus button down here in the corner of the screen to start"), null);
  assert.equal(forgetIntent("forget how to add a project"), "add a project");
  assert.equal(forgetIntent("forget it"), null);
});

test("locate: id and label agree, a shared id needs the label, twins are told apart by position, never a guess", () => {
  const screen = {
    nodes: [
      { n: 0, id: "com.x:id/row", text: "Alpha", cls: "TextView", tap: true, bounds: [0, 100, 1000, 200] },
      { n: 1, id: "com.x:id/row", text: "Beta", cls: "TextView", tap: true, bounds: [0, 200, 1000, 300] },
      { n: 2, id: "com.x:id/fab", text: "Add project", cls: "Button", tap: true, bounds: [700, 2000, 1000, 2100] },
      { n: 3, text: "More", cls: "Button", tap: true, bounds: [0, 400, 200, 500] },
      { n: 4, text: "More", cls: "Button", tap: true, bounds: [0, 900, 200, 1000] },
      { n: 5, id: "com.x:id/name", hint: "Project name", text: "old words", cls: "EditText", edit: true, bounds: [0, 600, 1000, 700] },
    ],
  };
  assert.equal(locate(screen, { id: "com.x:id/row", text: "Beta" })?.n, 1, "the row with that label");
  assert.equal(locate(screen, { id: "com.x:id/row", text: "Gamma" }), null, "same id, other words, two candidates: no guess");
  assert.equal(locate(screen, { id: "com.x:id/fab", text: "New project" })?.n, 2, "renamed, id unique");
  assert.equal(locate(screen, { text: "More", at: [100, 950] })?.n, 4, "nearest twin");
  assert.equal(locate(screen, { text: "More" }), null, "twins with nothing to tell them apart");
  assert.equal(locate(screen, { id: "name", hint: "Project name", text: "test test", edit: true })?.n, 5, "a field is found by id and hint, not by what it holds");
  assert.equal(locate(screen, { text: "Delete" }), null);
});

test("teach by showing, then ask: the steps replay with the new name and no model call at all", async () => {
  const t = await setup({ v2: true });
  try {
    await teachAddProject(t);
    const skill = t.brain.skills.all()[0];
    assert.equal(skill.id, "skill.add-a-project");
    assert.deepEqual(skill.slots.map((s) => [s.name, s.example]), [["name", "test test"]]);
    assert.equal(skill.parts.length, 1);
    assert.deepEqual(skill.parts[0].open, { do: "launch", app: "com.example.projects" }, "the home-screen tap became 'open the app'");
    assert.deepEqual(skill.parts[0].steps.map((s) => s.label), ['tap "New project"', 'type "{{name}}" into "Project name"', 'tap "Create"']);
    assert.equal(skill.parts[0].steps[1].act.text, "{{name}}");
    assert.deepEqual(skill.parts[0].steps[2].expect.text_present, ["{{name}}"], "the check after Create is the new project showing, nothing weaker");
    assert.deepEqual(skill.parts[0].done_when.text_present, ["{{name}}"], "and so is 'done'");
    assert.ok(said(t).some((l) => /learned how to add a project.*the project's name/i.test(l)), "Bobby says what he learned and what he needs");
    assert.equal(t.ai.count("teach"), 1, "one model call to name it and find the slot");
    assert.deepEqual(t.fromMind("observe").map((m) => m.on), [true, false]);

    const before = { route: t.ai.count("route"), exec: t.ai.count("exec"), check: t.ai.count("check") };
    t.mouth!.request("Hey Tibby, add a project with a name called test");
    assert.ok(await until(() => done(t) === 1, 6000), "the request finished");
    assert.ok(t.hub.phone.projects.includes("test"), "the project exists on the phone");
    assert.deepEqual({ route: t.ai.count("route"), exec: t.ai.count("exec"), check: t.ai.count("check") }, before, "no router, executor or check call");
    assert.equal(t.brain.stats.script, 1);
    assert.equal(t.brain.stats.local, 1, "matched locally");
    assert.ok(await until(() => said(t).some((l) => /just like you showed me/i.test(l)), 2000), said(t).join(" | "));

    // Another phrasing goes through the router, which sees the skill in its catalogue.
    t.mouth!.request("could you set up a project for me, called Apollo launch");
    assert.ok(await until(() => done(t) === 2, 6000));
    assert.ok(t.hub.phone.projects.includes("Apollo launch"));
    assert.equal(t.ai.count("route"), before.route + 1, "one router call");
    assert.equal(t.ai.count("exec"), before.exec, "still no executor call");
  } finally {
    await t.close();
  }
});

test("said in plain words (no teach tool), and with a v1 Mouth: the Mind catches it itself", async () => {
  for (const v2 of [true, false]) {
    const t = await setup({ v2 });
    try {
      if (v2) t.mouth!.request(SAID);
      else t.mouth!.hear(SAID);
      assert.ok(await until(() => t.brain.teaching?.phase === "watching", 3000), `watching (v2=${v2})`);
      const line = v2 ? said(t) : t.fromMind("say").map((m) => String(m.text));
      assert.ok(await until(() => (v2 ? said(t) : t.fromMind("say").map((m) => String(m.text))).some((l) => /show me/i.test(l)), 2000), `Bobby invites the demo (${line.join(" | ")})`);
      showAddProject(t);
      await sleep(60);
      if (v2) t.mouth!.request("stop");
      else t.mouth!.hear("okay that's it");
      assert.ok(await until(() => t.brain.skills.all().length === 1, 4000), "saved");
      await t.brain.teachDone;
      assert.equal(t.ai.count("route"), 0, "neither the start nor the end needed the router");
      assert.equal(t.tasks().filter((m) => m.status === "cancelled").length, 0, "'stop' ended the demo, it didn't cancel anything");
    } finally {
      await t.close();
    }
  }
});

test("skills persist: a new Mind with the same store knows them", async () => {
  const storage = new InMemoryStore();
  let t = await setup({ v2: true, storage });
  try {
    await teachAddProject(t);
    await t.brain.skills.flush();
  } finally {
    await t.close();
  }
  t = await setup({ v2: true, storage });
  try {
    await t.brain.skills.loaded;
    assert.equal(t.brain.skills.all().length, 1);
    t.mouth!.request("add a project called Garden");
    assert.ok(await until(() => done(t) === 1, 6000));
    assert.ok(t.hub.phone.projects.includes("Garden"));
    assert.equal(t.ai.calls.length, 0, "no model call of any kind");
  } finally {
    await t.close();
  }
});

test("the app changed: a renamed button is still found by its id; a moved one by its label", async () => {
  const t = await setup({ v2: true });
  try {
    await teachAddProject(t);
    t.hub.phone.drift = { renamed: true, moved: true };
    t.mouth!.request("add a project called Renamed");
    assert.ok(await until(() => done(t) === 1, 6000));
    assert.ok(t.hub.phone.projects.includes("Renamed"));
    assert.equal(t.ai.count("exec"), 0, "the script still held");
  } finally {
    await t.close();
  }
});

test("the app was left on another screen: it is restarted at its first screen, then the script runs", async () => {
  const t = await setup({ v2: true });
  try {
    await teachAddProject(t);
    t.hub.phone.user.tap("Website redesign"); // the user wanders into a project and leaves the app there
    t.hub.phone.user.home();
    t.mouth!.request("add a project called Deep");
    assert.ok(await until(() => done(t) === 1, 6000));
    assert.ok(t.hub.phone.projects.includes("Deep"));
    assert.ok(t.acts().some((a) => a.do === "launch" && a.fresh === true), "relaunched fresh");
    assert.equal(t.ai.count("exec"), 0);
  } finally {
    await t.close();
  }
});

test("the script can't be followed (a new sheet in the way): the executor finishes with the demo as its guide", async () => {
  const t = await setup({ v2: true });
  try {
    await teachAddProject(t);
    t.hub.phone.drift = { interstitial: true };
    t.hub.phone.user.home();
    t.mouth!.request("add a project called Guided");
    assert.ok(await until(() => done(t) === 1, 8000));
    assert.ok(t.hub.phone.projects.includes("Guided"));
    assert.ok(t.ai.count("exec") >= 1, "the executor took over");
    const guide = t.ai.calls.find((c) => c.role === "exec")!.user;
    assert.match(guide, /How the user showed this[\s\S]*1\. tap "New project"\n2\. type "Guided" into "Project name"\n3\. tap "Create"/, "with the user's steps, slot filled");
    assert.ok(t.lines.some((l) => /the executor takes over with the demo as a guide|leaving it to the executor/.test(l)));
  } finally {
    await t.close();
  }
});

test("a demo that needed scrolling: the replay scrolls the same way to find the control", async () => {
  const t = await setup({ v2: true });
  try {
    const p = t.hub.phone;
    p.projects.push("A", "B", "C", "D", "E", "F");
    p.drift = { long: true };
    t.mouth!.teach("start", "add a new project", SAID);
    assert.ok(await until(() => t.brain.teaching?.phase === "watching", 3000));
    p.user.open("Projects");
    p.user.scroll("up");
    p.user.tap("New project");
    p.user.type("test test");
    p.user.tap("Create");
    await sleep(60);
    t.mouth!.teach("done");
    assert.ok(await until(() => t.brain.skills.all().length === 1, 4000));
    await t.brain.teachDone;
    assert.equal(t.brain.skills.all()[0].parts[0].steps[0].seek, "up");
    p.user.home();
    t.mouth!.request("add a project called Scrolled");
    assert.ok(await until(() => done(t) === 1, 6000));
    assert.ok(p.projects.includes("Scrolled"));
    assert.ok(t.acts().some((a) => a.do === "swipe" && a.dir === "up"));
    assert.equal(t.ai.count("exec"), 0);
  } finally {
    await t.close();
  }
});

test("asked without the value it needs: Bobby says what is missing and touches nothing", async () => {
  const t = await setup({ v2: true });
  try {
    await teachAddProject(t);
    const acts = t.acts().length;
    t.mouth!.request("add a project");
    assert.ok(await until(() => said(t).some((l) => /I need the project's name/i.test(l)), 4000), said(t).join(" | "));
    assert.equal(t.acts().length, acts);
  } finally {
    await t.close();
  }
});

test("never mind, nothing shown, an older Hands, and forgetting a skill", async () => {
  let t = await setup({ v2: true });
  try {
    t.mouth!.teach("start", "add a new project", SAID);
    assert.ok(await until(() => t.brain.teaching?.phase === "watching", 3000));
    showAddProject(t);
    t.mouth!.request("never mind");
    await until(() => !t.brain.teaching, 3000);
    await t.brain.teachDone;
    assert.equal(t.brain.skills.all().length, 0, "dropped");
    assert.equal(t.ai.count("teach"), 0);

    t.mouth!.teach("start", "add a new project", SAID);
    assert.ok(await until(() => t.brain.teaching?.phase === "watching", 3000));
    t.mouth!.teach("done");
    assert.ok(await until(() => said(t).some((l) => /didn't see you do anything/i.test(l)), 3000));
    assert.equal(t.brain.skills.all().length, 0);

    await teachAddProject(t);
    t.mouth!.request("forget how to add a project");
    assert.ok(await until(() => said(t).some((l) => /forgotten how to add a project/i.test(l)), 3000));
    assert.equal(t.brain.skills.all().length, 0);
    assert.equal(t.brain.shortcuts.get("skill.add-a-project"), undefined);
  } finally {
    await t.close();
  }
  t = await setup({ v2: true, legacy: true });
  try {
    t.mouth!.teach("start", "add a new project", SAID);
    assert.ok(await until(() => said(t).some((l) => /can't watch/i.test(l)), 5000), "an older Hands doesn't answer observe");
    assert.equal(t.brain.teaching, null);
  } finally {
    await t.close();
  }
});

test("a demo ends by itself when the user stops doing things", async () => {
  const t = await setup({ v2: true, timing: { teachIdleMs: 700 } });
  try {
    t.mouth!.teach("start", "add a new project", SAID);
    assert.ok(await until(() => t.brain.teaching?.phase === "watching", 3000));
    await sleep(900); // nothing shown yet: it keeps waiting
    assert.equal(t.brain.teaching?.phase, "watching");
    showAddProject(t);
    assert.ok(await until(() => t.brain.skills.all().length === 1, 5000), "saved without a word");
  } finally {
    await t.close();
  }
});

test("readDemo: a password stops the recording; the keyboard's enter is inferred; mistakes can be dropped", () => {
  const scr = (hash: string, nodes: any[], app = "com.shop") => ({ type: "screen_result", app, hash, nodes: nodes.map((n, i) => ({ n: i, ...n })) });
  const search = { key: "k1", id: "com.shop:id/q", hint: "Search", cls: "EditText", edit: true, tap: true, bounds: [0, 100, 1000, 200] };
  const s0 = scr("h0", [search, { key: "k2", text: "Deals", tap: true, bounds: [0, 300, 500, 400] }]);
  const s1 = scr("h1", [{ key: "k3", text: "Results for socks", bounds: [0, 100, 1000, 200] }, { key: "k4", text: "Wool socks", tap: true, bounds: [0, 300, 1000, 400] }]);
  const s2 = scr("h2", [{ key: "k5", id: "com.shop:id/pw", hint: "Password", cls: "EditText", edit: true, password: true, bounds: [0, 100, 1000, 200] }]);
  const demo = readDemo(
    [
      { type: "observed", seq: 1, kind: "tap", app: "com.shop", hash: "h0", node: s0.nodes[0] },
      { type: "observed", seq: 2, kind: "type", app: "com.shop", hash: "h0", node: s0.nodes[0], text: "socks" },
      { type: "observed", seq: 3, kind: "screen", screen: s1 },
      { type: "observed", seq: 4, kind: "tap", app: "com.shop", hash: "h1", node: s1.nodes[1] },
      { type: "observed", seq: 5, kind: "screen", screen: s2 },
      { type: "observed", seq: 6, kind: "type", app: "com.shop", hash: "h2", node: s2.nodes[0], password: true },
      { type: "observed", seq: 7, kind: "tap", app: "com.shop", hash: "h2", node: { text: "Sign in" } },
    ],
    { initial: s0 },
  );
  assert.equal(demo.secret, true);
  assert.deepEqual(demo.steps.map((s) => `${s.kind}:${s.text ?? s.node?.text ?? ""}`), ["type:socks", "key:enter", "tap:Wool socks"], "tap+type merged, enter inferred, nothing after the password");
  const meta = { ...fallbackMeta(demo, { name: "search for socks" }), slots: [{ name: "query", required: true, desc: "what to search for", example: "socks" }], drop: [] };
  const skill = buildSkill(demo, meta, { heard: "" });
  const steps = skill.parts[0].steps;
  assert.equal(steps[0].act.text, "{{query}}");
  assert.deepEqual(steps[1].expect.text_present, ["Results for {{query}}", "Wool {{query}}"], "the check holds whatever is searched");
  assert.equal(steps[2].want?.text, "Wool {{query}}", "a tapped label that holds the slot follows the slot");
  assert.equal(steps[2].want?.key, undefined, "and is not pinned to the old label's key");
  const plan = planSkill(skill, { query: "gloves" });
  assert.match(plan.subgoals[1].guide!, /1\. type "gloves" into "Search"\n2\. press enter\n3\. tap "Wool gloves"/);
  assert.equal(matchSkill(skill, "search for socks called gloves")?.slots.query, "gloves");
  assert.equal(matchSkill(skill, "search for a flight to Paris called gloves"), null, "an unknown word sends it to the router");
});
