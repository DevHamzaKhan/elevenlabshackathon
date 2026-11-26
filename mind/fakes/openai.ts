// A scripted fake of the OpenAI Responses API, answered at the fetch level so the real model door
// (src/model.ts) is exercised too. Replies are deterministic and keyed by prompt content: the
// router reads "The user just said", the executor reads the sub-goal and the screen lines.
// Optional per-role latency simulates the network for `npm run story -- --sim`.
// Tests can override any role with `override(role, (user, body) => json | null)`.

export type FakeCall = { role: string; model: string; user: string; images: number; at: number; ms: number };

type Rule = (user: string, body: any) => any | null;

export type FakeOpenAI = {
  fetch: typeof fetch;
  calls: FakeCall[];
  override(role: string, rule: Rule): void;
  count(role: string): number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeOpenAI(opts: { latency?: Partial<Record<string, number>> } = {}): FakeOpenAI {
  const calls: FakeCall[] = [];
  const overrides: Record<string, Rule[]> = {};
  const fn = async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const role = String(body?.text?.format?.name ?? "exec");
    const userParts: any[] = body?.input?.[1]?.content ?? [];
    const user = String(userParts.find((p) => p.type === "input_text")?.text ?? "");
    const images = userParts.filter((p) => p.type === "input_image").length;
    const ms = opts.latency?.[role] ?? 0;
    if (ms) await sleep(ms);
    calls.push({ role, model: String(body.model), user, images, at: Date.now(), ms });
    let json: any = null;
    for (const r of overrides[role] ?? []) {
      json = r(user, body);
      if (json) break;
    }
    const system = String(body?.input?.[0]?.content?.[0]?.text ?? "");
    if (!json) json = role === "route" ? route(user, system) : role === "escalate" ? escalate(user, images) : role === "check" ? check(user) : role === "teach" ? teach(user) : exec(user);
    const text = JSON.stringify(json);
    const out = {
      status: "completed",
      model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 1500 + user.length / 4, output_tokens: text.length / 4, input_tokens_details: { cached_tokens: 1280 } },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) } as any;
  };
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    override(role, rule) {
      (overrides[role] ??= []).unshift(rule);
    },
    count(role) {
      return calls.filter((c) => c.role === role).length;
    },
  };
}

// ---------- router ----------

const NONE = { whisper: "", teach: "", say: "", cancel_scope: "", tasks: [] as any[] };
const dw = (o: Partial<{ app: string; text_present: string; text_absent: string; describe: string }>) => ({ app: "", text_present: "", text_absent: "", describe: "", ...o });

export function replyToSarahTask(n: string) {
  const body = `${n} works for me.`;
  return {
    title: "Reply to Sarah",
    goal: `Reply to Sarah Chen's email with "${body}"`,
    done_say: "Sent your reply to Sarah.",
    shortcut_id: "",
    slots: [{ name: "body", value: body }],
    app: "Gmail",
    subgoals: [
      { goal: "Open Sarah Chen's email", done_when: dw({ app: "gmail", text_present: "Hi! Running late", describe: "Sarah's email is open" }), risk: "safe" },
      { goal: `Write the reply "${body}"`, done_when: dw({ text_present: body, describe: "The reply text is typed" }), risk: "safe" },
      { goal: "Send the reply", done_when: dw({ text_present: `Me: ${body}`, describe: "The reply shows as sent" }), risk: "irreversible" },
    ],
  };
}

/** Skills the user taught, read from the catalogue in the router's instructions. */
function taughtSkills(system: string): { id: string; words: string[]; slots: string[] }[] {
  return [...system.matchAll(/^- (skill\.[\w-]+): (.*?) Slots: (.*)\.$/gm)].map((m) => ({
    id: m[1],
    words: m[2].toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((w) => w.length > 3 && !["taught", "user", "this", "that", "with"].includes(w)),
    slots: m[3].split(";").map((s) => s.trim().split(/[?\s]/)[0]).filter(Boolean),
  }));
}

function route(user: string, system = ""): any {
  const heard = (/The user just said: "([\s\S]*?)"\n/.exec(user)?.[1] ?? "").trim();
  const h = heard.toLowerCase();
  if (/\b(show|teach)(ing)? you\b/.test(h)) return { ...NONE, route: "teach", teach: (/how to ([^.]+)/.exec(h)?.[1] ?? "").trim() };
  for (const s of taughtSkills(system)) {
    const said = h.replace(/[^a-z ]+/g, " ").split(/\s+/).map((w) => w.replace(/s$/, ""));
    if (!s.words.some((w) => said.includes(w.replace(/s$/, "")))) continue;
    const value = ((/\b(?:called|named|titled)\s+(.+)$/i.exec(heard) ?? /\bfor\s+(.+)$/i.exec(heard))?.[1] ?? "").replace(/[.!?]+$/, "").trim();
    return { ...NONE, route: "tasks", say: "On it.", tasks: [{ title: "Taught skill", goal: heard, done_say: "", shortcut_id: s.id, slots: s.slots.slice(0, 1).map((name) => ({ name, value })), app: "", subgoals: [] }] };
  }
  if (h.startsWith("change the running task:")) {
    const n = /\b(\d{1,2})\b/.exec(h)?.[1] ?? "3";
    return { ...NONE, route: "amend", say: "Got it, changing it.", tasks: [replyToSarahTask(n)] };
  }
  if (/reply to sarah/.test(h)) {
    const n = /\b(\d{1,2})\b/.exec(h)?.[1] ?? (/\bfour\b/.test(h) ? "4" : "3");
    return { ...NONE, route: "tasks", say: "On it.", tasks: [replyToSarahTask(n)] };
  }
  if (/what did i miss/.test(h)) {
    const notes = [...user.matchAll(/^- (.*) \((?:just now|\d+ min ago|\d+ h ago)\)$/gm)].map((m) => m[1]);
    return { ...NONE, route: "chat", whisper: notes.length ? `You have: ${notes.join("; ")}.` : "Nothing new." };
  }
  if (/\b(bye|that's all|that is all)\b/.test(h)) return { ...NONE, route: "sleep" };
  if (/\b(how'?s it going|status|are you done)\b/.test(h)) return { ...NONE, route: "status" };
  if (/save .*ticket/.test(h)) {
    return {
      ...NONE,
      route: "tasks",
      say: "On it.",
      tasks: [
        {
          title: "Save my ticket",
          goal: "Save the ticket in the Tickets app",
          done_say: "Your ticket is saved.",
          shortcut_id: "",
          slots: [],
          app: "Tickets",
          subgoals: [{ goal: "Tap the Save ticket button", done_when: dw({ text_present: "Ticket saved", describe: "The page says the ticket is saved" }), risk: "safe" }],
        },
      ],
    };
  }
  const call = /^(?:call|phone|ring)\s+(\w+)(?:\s+(?:and|to)\s+(.*))?$/.exec(h);
  if (call) {
    const name = call[1][0].toUpperCase() + call[1].slice(1);
    return {
      ...NONE,
      route: "tasks",
      tasks: [{ title: `Call ${name}`, goal: call[2] ?? "Say hello.", done_say: "", shortcut_id: call[2] ? "call.ai" : "phone.dial", slots: [{ name: "to", value: name }, { name: "goal", value: call[2] ? `${call[2]}.` : "" }], app: "", subgoals: [] }],
    };
  }
  const email = /e-?mail\s+(?:to\s+)?(\w+)\s+(?:saying|that)\s+(.+)$/.exec(h);
  if (email) {
    const name = email[1][0].toUpperCase() + email[1].slice(1);
    return { ...NONE, route: "tasks", tasks: [{ title: `Email ${name}`, goal: email[2], done_say: `Sent it to ${name}.`, shortcut_id: "email.send", slots: [{ name: "to", value: name }, { name: "body", value: email[2] }, { name: "subject", value: "" }], app: "", subgoals: [] }] };
  }
  const open = /^open (?:the )?(\w+)/.exec(h);
  if (open) {
    const app = open[1][0].toUpperCase() + open[1].slice(1);
    return { ...NONE, route: "tasks", tasks: [{ title: `Open ${app}`, goal: `Open the ${app} app`, done_say: `${app}'s open.`, shortcut_id: "app.open", slots: [{ name: "app", value: app }], app: "", subgoals: [] }] };
  }
  return { ...NONE, route: "chat" };
}

// ---------- executor ----------

type N = { n: number; line: string };

function nodesOf(user: string): N[] {
  const out: N[] = [];
  for (const line of user.split("\n")) {
    const m = /^\[(\d+)\] (.*)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), line: m[2] });
  }
  return out;
}

const X = { app: "", text_present: "", text_absent: "", field_label: "", field_value: "" };
export const action = (o: any) => ({ do: "tap", n: -1, target_text: "", text: "", dir: "", key: "", app: "", ms: -1, irreversible: false, ...o, expect: { ...X, ...(o.expect ?? {}) } });
export const actReply = (actions: any[], say = "", note = "") => ({ status: "act", say, note, actions });

/**
 * A sub-goal that carries the steps the user once showed. The pretend model does what a real one
 * is asked to: get to where the steps start (close a sheet, go back, scroll), then follow them,
 * matching a renamed control by what it obviously is, and batching what it can predict.
 */
function followGuide(user: string, nodes: N[]): any | null {
  const block = /How the user showed this[^\n]*\n((?:\d+\. .*\n?)+)/.exec(user)?.[1];
  if (!block) return null;
  const steps = block.trim().split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter((l) => !/\(only if it is showing\)$/.test(l));
  const tried = /Tried so far[^\n]*\n((?:- .*\n?)+)/.exec(user)?.[1] ?? "";
  const done = (s: string) => tried.split("\n").some((l) => l.startsWith(`- ${s} -> ok`));
  const find = (re: RegExp) => nodes.find((x) => re.test(x.line));
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sheet = find(/^"(Got it|Not now|Dismiss|Skip|Continue)"/);
  if (sheet) return actReply([action({ n: sheet.n })], "Closing that first.");
  const todo = steps.filter((s) => !done(s));
  if (todo.length === 0) return { status: "done", say: "", note: "", actions: [] };
  const out: any[] = [];
  for (const [i, s] of todo.slice(0, 3).entries()) {
    const type = /^type "(.*)" into "(.*)"$/.exec(s);
    const tap = /^(?:tap|long-press) "(.*)"$/.exec(s);
    if (type) {
      const field = find(new RegExp(`hint="${esc(type[2])}"|^"${esc(type[2])}"`));
      if (i === 0 && !field) break;
      out.push(action({ do: "type", ...(i === 0 ? { n: field!.n } : { target_text: type[2] }), text: type[1], expect: { text_present: type[1] } }));
    } else if (tap) {
      let node = find(new RegExp(`^"${esc(tap[1])}"`));
      // The label changed: the button that is obviously the same thing.
      const noun = tap[1].toLowerCase().split(/\s+/).pop() ?? "";
      if (!node && noun.length > 3) node = find(new RegExp(`^"[^"]*${esc(noun)}[^"]*" \\(Button\\)`, "i"));
      if (i === 0 && !node) break;
      if (i > 0 && !node) out.push(action({ target_text: tap[1] }));
      else out.push(action(i === 0 ? { n: node!.n } : { target_text: /^"([^"]*)"/.exec(node!.line)?.[1] ?? tap[1] }));
    } else if (/^press (\w+)$/.test(s)) out.push(action({ do: "key", key: /^press (\w+)$/.exec(s)![1] }));
  }
  if (out.length) return actReply(out, "Doing it the way you showed me.");
  // The first step isn't on this screen: go back if this is a sub-page, else look further down.
  const up = find(/^"Navigate up"/);
  if (up) return actReply([action({ n: up.n })], "Going back.");
  if (find(/scroll/)) return actReply([action({ do: "swipe", dir: "up" })], "Looking for it.");
  return null;
}

function exec(user: string): any {
  const goal = /^Sub-goal: (.*)$/m.exec(user)?.[1] ?? "";
  const app = /^App: (.*)$/m.exec(user)?.[1] ?? "";
  const nodes = nodesOf(user);
  const find = (re: RegExp) => nodes.find((x) => re.test(x.line));
  const quoted = /"([^"]+)"/.exec(goal)?.[1] ?? "";

  const guided = followGuide(user, nodes);
  if (guided) return guided;

  const notNow = find(/^"Not now"/);
  if (notNow) return actReply([action({ n: notNow.n, expect: { text_absent: "Update available" } })], "Closing a pop-up.");

  if (/Open Sarah Chen's email/i.test(goal)) {
    const row = find(/Sarah Chen, Meeting today/);
    if (row) return actReply([action({ n: row.n, expect: { text_present: "Hi! Running late" } })], "Opening Sarah's email.", "Sarah asked to push to 3.");
    if (!/^Gmail/.test(app)) return actReply([action({ do: "launch", app: "Gmail", expect: { app: "gmail" } })], "Opening Gmail.");
  }
  if (/Write the reply/i.test(goal)) {
    const reply = find(/^"Reply"/);
    const field = find(/hint="Compose email"|\(EditText\) edit focused/);
    if (reply) {
      return actReply(
        [
          action({ n: reply.n, expect: { text_present: "Compose email" } }),
          action({ do: "type", n: -1, target_text: "", text: quoted, expect: { text_present: quoted } }),
        ],
        "Writing the reply.",
      );
    }
    if (field) return actReply([action({ do: "type", n: field.n, text: quoted, expect: { text_present: quoted } })], "Writing it.");
  }
  if (/Send the reply|Tap Send/i.test(goal)) {
    const send = find(/^"Send"/);
    if (send) return actReply([action({ n: send.n, irreversible: true, expect: { text_present: "Sent" } })], "Sending.");
  }
  if (/Open a new email draft/i.test(goal)) {
    const to = /\(([^)]+@[^)]+)\)/.exec(goal)?.[1] ?? "";
    const subject = /subject "([^"]*)"/.exec(goal)?.[1] ?? "";
    const body = /body "([^"]*)"/.exec(goal)?.[1] ?? "";
    if (!/^Gmail/.test(app)) return actReply([action({ do: "launch", app: "Gmail", expect: { app: "gmail" } })], "Opening Gmail.");
    const compose = find(/^"Compose"/);
    if (compose) {
      return actReply(
        [
          action({ n: compose.n, expect: { text_present: "Subject" } }),
          action({ do: "type", target_text: "To", text: to, expect: { text_present: to } }),
          action({ do: "type", target_text: "Subject", text: subject, expect: { text_present: subject } }),
          action({ do: "type", target_text: "Compose email", text: body, expect: { text_present: body } }),
        ],
        "Starting a new email.",
      );
    }
  }
  if (/Put (\w+) in the To field/i.test(goal)) {
    const name = /Put (\w+)/.exec(goal)![1];
    const to = find(/hint="To"|^"To"/);
    if (to) return actReply([action({ do: "type", n: to.n, text: name, expect: { text_present: name } })], `Adding ${name}.`);
  }
  const open = /^Open (\w+)$/.exec(goal);
  if (open) return actReply([action({ do: "launch", app: open[1], expect: { app: open[1] } })], `Opening ${open[1]}.`);
  if (/nothing readable/.test(user)) return { status: "failed", say: "I can't read this screen.", note: "", actions: [] };
  return { status: "failed", say: "I don't know how to do that here.", note: "", actions: [] };
}

function escalate(user: string, images: number): any {
  const app = /^App: (.*)$/m.exec(user)?.[1] ?? "";
  if (/Tickets/.test(app) && images > 0) {
    return { status: "act", say: "Found the button.", note: "", replan: [], actions: [{ ...action({ n: -1, expect: { text_present: "Ticket saved" } }), x: 540, y: 1260 }] };
  }
  return { status: "failed", say: "I couldn't find a way through this screen.", note: "", actions: [], replan: [] };
}

function check(user: string): any {
  // A taught skill's end check names the values it ran with: done when the screen shows one.
  const values = [...(/has just been done/.test(user) ? (/^Step: .* with (.*?) has just been done/m.exec(user)?.[1] ?? "") : "").matchAll(/\w+: ([^,]+)/g)].map((m) => m[1].trim());
  const screen = user.split("Current screen:")[1] ?? "";
  if (values.length) return { done: values.some((v) => screen.includes(`"${v}"`)), why: "looked for what was entered" };
  return { done: /Ticket saved|Sent/.test(user), why: "checked the screen" };
}

// ---------- teach: naming a demonstrated skill and finding its slots ----------

const FAKE_SYNONYMS = [["add", "create", "make", "new", "start"], ["delete", "remove"], ["open", "show"], ["send", "post"]];

function teach(user: string): any {
  const name = (/Skill name as heard: "(.*)"/.exec(user)?.[1] ?? "").replace("(none given)", "").trim();
  const steps = [...user.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
  const typed = steps.map((s) => /^type "(.*)" into "(.*)"/.exec(s.text)).filter(Boolean) as RegExpExecArray[];
  const title = (name || "do that").replace(/\b(a|an|the) new\b/, "$1");
  const content = title.toLowerCase().split(/\s+/).filter((w) => !["a", "an", "the", "my", "new", "to"].includes(w));
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    intent: `${title.charAt(0).toUpperCase() + title.slice(1)} in the ${/^Apps?: (\w+)/m.exec(user)?.[1] ?? "app"} app.`,
    say: "Doing it the way you showed me.",
    done_say: "Done, just like you showed me.",
    keywords: content.slice(0, 3).map((w) => FAKE_SYNONYMS.find((g) => g.includes(w)) ?? [w.replace(/s$/, "")]),
    slots: typed.map((t, i) => ({ name: i === 0 ? "name" : `text${i + 1}`, desc: /name/i.test(t[2]) ? `the ${content[content.length - 1] ?? "thing"}'s name` : t[2].toLowerCase(), example: t[1], required: true })),
    irreversible: [],
    drop: [],
  };
}
