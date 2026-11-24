// Saved recipes: recorded from a grounded success, replayed with zero exec-model calls, persisted
// through the injected store, invalidated after two mismatches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until } from "./helpers";
import { InMemoryStore, Memory } from "../src/memory";
import { RecipeBook, normalizeIntent } from "../src/recipes";
import { fakeOpenAI } from "../fakes/openai";

const done = (t: Awaited<ReturnType<typeof setup>>) => t.tasks().filter((m) => m.status === "done").length;

test("a grounded success is saved as a recipe and replayed next time with zero exec calls", async () => {
  const t = await setup({ v2: true });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => done(t) === 1, 8000), "first run done");
    const execFirst = t.ai.count("exec");
    assert.equal(execFirst, 3);
    const book = t.brain.recipes.all();
    assert.equal(book.length, 3, "one recipe per grounded sub-goal");
    for (const r of book) {
      assert.equal(r.app, "com.google.android.gm");
      for (const s of r.steps) assert.ok(!(s.act.on && "n" in s.act.on), `no node numbers in ${r.intent}`);
    }
    const write = book.find((r) => /write the reply/.test(r.intent))!;
    assert.equal(write.intent, "write the reply {{body}}", "parameterized by the slot");
    assert.ok(write.steps.some((s) => s.act.text === "{{body}}"));

    t.hub.phone.reset();
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => done(t) === 2, 8000), "second run done");
    assert.equal(t.ai.count("exec"), execFirst, "zero exec-model calls on the replay");
    assert.equal(t.brain.stats.recipe, 3);
    assert.equal(t.hub.phone.sent?.text, "3 works for me.");
    assert.ok(t.fromMind("confirm_request").length === 2, "the replay still asked before sending");
  } finally {
    await t.close();
  }
});

test("recipes persist through the store: a new Mind replays them", async () => {
  const storage = new InMemoryStore();
  let t = await setup({ v2: true, storage });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => done(t) === 1, 8000));
    await t.brain.memory.flush();
  } finally {
    await t.close();
  }
  assert.ok([...storage.data.values()].some((v) => /write the reply \{\{body\}\}/.test(v)), "saved in the store");
  t = await setup({ v2: true, storage });
  try {
    await t.brain.memory.loaded;
    t.mouth!.request("reply to Sarah and tell her 4 works");
    assert.ok(await until(() => done(t) === 1, 8000));
    assert.equal(t.ai.count("exec"), 0, "the new Mind drove Gmail from recipes alone");
    assert.equal(t.hub.phone.sent?.text, "4 works for me.", "slot filled with the new value");
  } finally {
    await t.close();
  }
});

test("a recipe mismatch falls back to the grounded executor and marks it stale; two failures delete it", async () => {
  const t = await setup({ v2: true });
  try {
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => done(t) === 1, 8000));
    const open = t.brain.recipes.all().find((r) => /open sarah/.test(r.intent))!;
    open.steps[0].act.on = { key: "row_that_moved" }; // the app changed under the recipe
    t.hub.phone.reset();
    const before = t.ai.count("exec");
    t.mouth!.request("reply to Sarah and tell her 3 works");
    assert.ok(await until(() => done(t) === 2, 8000), "still done");
    assert.equal(t.ai.count("exec"), before + 1, "one exec call for the sub-goal whose recipe broke");
    assert.ok(t.lines.some((l) => /mismatched .*marked stale/.test(l)));
    // The fresh grounded run re-saved a working recipe in its place.
    assert.equal(t.brain.recipes.all().find((r) => /open sarah/.test(r.intent))!.stale, false);
  } finally {
    await t.close();
  }
  // Unit: two failed replays delete it.
  const mem = new Memory(new InMemoryStore());
  const book = new RecipeBook(mem, () => {});
  const plan: any = { kind: "phone", title: "x", goal: "x", subgoals: [], slots: {} };
  const sg: any = { goal: "Tap the thing", done_when: { describe: "", text_present: ["Done"] }, risk: "safe" };
  book.save("com.app", sg, plan, [{ act: { do: "tap", on: { key: "k" } }, expect: { text_present: ["Done"] }, label: "thing" }]);
  const r = book.lookup("com.app", sg, plan)!;
  const deps = { act: async () => ({ ok: false, error: "not_found", screen: null }), narrate() {}, gate: async () => "go" as const, isDone: async () => "no" };
  const run: any = { spec: sg, taskGoal: "x", scratch: [], confirmed: false, budget: 5 };
  assert.equal((await book.replay(r, run, plan, deps)).ok, false);
  assert.ok(book.lookup("com.app", sg, plan)?.stale, "stale after one failure");
  await book.replay(r, run, plan, deps);
  assert.equal(book.lookup("com.app", sg, plan), null, "deleted after two");
  void fakeOpenAI;
});

test("normalizeIntent swaps slot values and keys on the shortcut", () => {
  assert.equal(normalizeIntent('Write the reply "3 works for me."', { body: "3 works for me." }), "write the reply {{body}}");
  assert.equal(normalizeIntent("Put Alex in the To field", { to: "Alex" }, "email.send"), "email.send: put {{to}} in the to field");
});
