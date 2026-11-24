// The shortcut index on its own: local matching, slot filling, built acts and checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ShortcutIndex, splitChain, subjectFrom } from "../src/shortcuts";
import { parseContactBook, parseContacts } from "../src/contacts";

const contacts = parseContactBook("Hamza=+14155550111|hamza@example.com,Alex=+14155550123,Mom=+14155550199,Sam Lee=sam@example.com");
const ctx = { contacts, now: new Date("2026-11-24T10:00:00") };
const idx = new ShortcutIndex();

test("contacts: phone, email or both; v1 shape keeps phone-only", () => {
  assert.deepEqual(contacts.find((c) => c.name === "Hamza"), { name: "Hamza", phone: "+14155550111", email: "hamza@example.com" });
  assert.deepEqual(parseContacts("Hamza=+14155550111|hamza@example.com,Sam=sam@x.io"), { Hamza: "+14155550111" });
});

test("'send an email to Hamza saying I'm late' -> mailto open, confirm, Send; high confidence", () => {
  const r = idx.matchUtterance("send an email to Hamza saying I'm late", ctx);
  assert.ok(r, "matched locally");
  assert.equal(r!.matches[0].id, "email.send");
  assert.deepEqual(r!.matches[0].slots, { to: "Hamza", subject: "", body: "I'm late" });
  const plan = r!.plans[0];
  assert.equal(plan.subgoals.length, 2);
  const open = plan.subgoals[0].direct![0];
  assert.equal(open.do, "open");
  assert.equal(open.uri, "mailto:hamza@example.com?subject=I'm%20late&body=I'm%20late");
  assert.deepEqual(plan.subgoals[0].done_when.text_present, ["I'm late"]);
  const send = plan.subgoals[1];
  assert.equal(send.risk, "irreversible");
  assert.deepEqual(send.direct, [{ do: "tap", on: { text: "Send" } }]);
  assert.match(send.confirm!, /Hamza.*I'm late/);
});

test("email variants: subject, 'email X that', address, unknown contact is low", () => {
  const a = idx.matchOne("email Sam Lee with subject Lunch saying see you at 1", ctx)!;
  assert.deepEqual(a.slots, { to: "Sam Lee", subject: "Lunch", body: "see you at 1" });
  assert.equal(a.confidence, "high");
  const b = idx.matchOne("send a mail to bob@example.com saying hi there", ctx)!;
  assert.equal(b.slots.to, "bob@example.com");
  assert.equal(b.confidence, "high");
  assert.equal(idx.matchOne("send an email to Zed saying hi", ctx)!.confidence, "low");
  // Known contact with no email: the plan adds a "put them in To" step; the matcher leaves it to the router.
  assert.equal(idx.matchOne("send an email to Alex saying hi", ctx)!.confidence, "low");
  const p = idx.plan("email.send", { to: "Alex", body: "hi" }, ctx) as any;
  assert.equal(p.subgoals.length, 3);
  assert.match(p.subgoals[1].goal, /To field/);
  assert.equal(subjectFrom("running late, sorry. see you soon"), "Running late, sorry");
});

test("text, AI call vs dial, alarm, timer, navigate, search, open app, settings", () => {
  const sms = idx.matchOne("text Alex I'm late", ctx)!;
  assert.deepEqual([sms.id, sms.slots.body, sms.confidence], ["sms.send", "I'm late", "high"]);
  const smsPlan = idx.plan(sms.id, sms.slots, ctx) as any;
  assert.equal(smsPlan.subgoals[0].direct[0].uri, "smsto:+14155550123?body=I'm%20late");

  const ai = idx.matchOne("call Alex and tell him I'm running late", ctx)!;
  assert.equal(ai.id, "call.ai");
  assert.equal(ai.slots.goal, "Tell him I'm running late.");
  const aiPlan = idx.plan(ai.id, ai.slots, ctx) as any;
  assert.equal(aiPlan.kind, "call");
  assert.equal(aiPlan.call.number, "+14155550123");

  const dial = idx.matchOne("call Mom", ctx)!;
  assert.equal(dial.id, "phone.dial");
  assert.equal((idx.plan(dial.id, dial.slots, ctx) as any).subgoals[0].direct[0].uri, "tel:+14155550199");

  const al = idx.matchOne("set an alarm for 7:30 pm", ctx)!;
  assert.equal(al.slots.time, "19:30");
  const alPlan = idx.plan(al.id, al.slots, ctx) as any;
  assert.equal(alPlan.subgoals[0].direct[0].action, "android.intent.action.SET_ALARM");
  assert.equal(alPlan.subgoals[0].direct[0].extras["android.intent.extra.alarm.HOUR"], 19);
  assert.deepEqual(alPlan.subgoals[0].done_when.text_present, ["7:30", "19:30"]);

  const tm = idx.matchOne("set a timer for ten minutes", ctx)!;
  assert.equal(tm.slots.seconds, "600");
  assert.equal(idx.matchOne("navigate to the airport", ctx)!.slots.place, "the airport");
  assert.equal(idx.matchOne("google best ramen near me", ctx)!.id, "web.search");
  assert.deepEqual(idx.matchOne("open Spotify", ctx), { id: "app.open", slots: { app: "Spotify" }, confidence: "high" });
  assert.equal(idx.matchOne("open Sarah's email", ctx), null, "not an app: left to the router");
  assert.equal(idx.matchOne("open wifi settings", ctx)!.id, "settings.open");
});

test("chains split and match part by part; one unknown part sends the whole thing to the router", () => {
  assert.deepEqual(splitChain("open Spotify, then text Alex I'm late, and then call Mom"), ["open Spotify", "text Alex I'm late", "call Mom"]);
  const r = idx.matchUtterance("open Spotify, then text Alex I'm late, then call Mom", ctx)!;
  assert.deepEqual(r.matches.map((m) => m.id), ["app.open", "sms.send", "phone.dial"]);
  assert.equal(idx.matchUtterance("open Spotify then reply to Sarah", ctx), null);
});

test("catalogue for the router is stable and lists every shortcut with slots", () => {
  const c = idx.catalogue();
  assert.equal(c, new ShortcutIndex().catalogue());
  for (const s of idx.all()) assert.ok(c.includes(`- ${s.id}:`));
  assert.match(c, /email\.send: .*Slots: to \(contact name or email address\); subject\? /);
});
