// The shortcut index: common requests that skip UI driving entirely by firing an Android intent
// through Hands' `open` (or `launch`), then checking the result in code. Built once at start and
// held in memory. Two ways in:
//   1. matchLocal(): a cheap keyword/regex pre-match on what the user said. When it is confident
//      (all required slots filled, the recipient known), the task starts with no model call at all.
//   2. The router: CATALOGUE is embedded in its instructions; it returns {shortcut_id, slots}.
// Lookup by id is a Map get. Recipes (saved grounded runs) join the same index (see recipes.ts).

import type { HandsAct, SubgoalSpec, TaskPlan } from "./types";
import { findContact, leadingContact, type Contact } from "./contacts";
import { APP_LABELS } from "./screen";

export type SlotDef = { name: string; required: boolean; desc: string };

export type ShortcutCtx = { contacts: Contact[]; now: Date };

export type LocalMatch = { id: string; slots: Record<string, string>; confidence: "high" | "low" };

export type Shortcut = {
  id: string;
  intent: string;
  slots: SlotDef[];
  /** Words that suggest this shortcut (for the router catalogue and a cheap ranking). */
  keywords: string[];
  /** Local pre-match on one command. */
  match?: (text: string, ctx: ShortcutCtx) => LocalMatch | null;
  /** Builds the task: sub-goals with direct acts and done_when checks. */
  plan: (slots: Record<string, string>, ctx: ShortcutCtx) => TaskPlan | { error: string };
};

// ---------- helpers ----------

const enc = encodeURIComponent;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.trim().replace(/^["'“”]+|["'“”.]+$/g, "").trim();

/** A short subject from the body: its first sentence, at most 6 words. */
export function subjectFrom(body: string): string {
  const first = body.split(/[.!?\n]/)[0].trim();
  const words = first.split(/\s+/).slice(0, 6).join(" ");
  return cap(words || "Quick note");
}

/** "7", "7:30", "7pm", "7:30 a.m." -> {h (0-23), m}. */
export function parseClock(h: string, m: string | undefined, ampm: string | undefined): { h: number; m: number } | null {
  let hh = Number(h);
  const mm = m ? Number(m) : 0;
  if (!Number.isFinite(hh) || hh > 23 || mm > 59) return null;
  const ap = (ampm ?? "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  return { h: hh, m: mm };
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60 };

export function parseDuration(n: string, unit: string): number | null {
  const v = /^\d+$/.test(n) ? Number(n) : NUMBER_WORDS[n.toLowerCase()];
  if (!v) return null;
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return v * 3600;
  if (u.startsWith("m")) return v * 60;
  if (u.startsWith("s")) return v;
  return null;
}

/** App label -> package, for checks ("Spotify" -> "com.spotify.music"). */
export function packageFor(label: string): string | null {
  const q = label.trim().toLowerCase();
  for (const [pkg, l] of Object.entries(APP_LABELS)) if (l.toLowerCase() === q) return pkg;
  return null;
}

/** Labels the local matcher trusts for "open X" (anything else goes to the router). */
const KNOWN_APPS = new Set(
  [...Object.values(APP_LABELS), "Clock", "Camera", "Photos", "Drive", "Keep", "Keep Notes", "Calculator", "Contacts", "Meet", "Netflix", "Instagram", "Uber", "Slack", "Discord", "Telegram", "Signal", "Outlook", "Teams", "Zoom", "Waze", "Amazon", "TikTok", "Snapchat", "Reddit", "X", "Facebook", "Messenger", "LinkedIn", "Duolingo"]
    .filter((l) => !/home screen|notification shade|^google$/i.test(l))
    .map((l) => l.toLowerCase()),
);

const SETTINGS: Record<string, { action: string; label: string }> = {
  wifi: { action: "android.settings.WIFI_SETTINGS", label: "Wi-Fi" },
  "wi-fi": { action: "android.settings.WIFI_SETTINGS", label: "Wi-Fi" },
  bluetooth: { action: "android.settings.BLUETOOTH_SETTINGS", label: "Bluetooth" },
  display: { action: "android.settings.DISPLAY_SETTINGS", label: "Display" },
  brightness: { action: "android.settings.DISPLAY_SETTINGS", label: "Display" },
  sound: { action: "android.settings.SOUND_SETTINGS", label: "Sound" },
  volume: { action: "android.settings.SOUND_SETTINGS", label: "Sound" },
  battery: { action: "android.intent.action.POWER_USAGE_SUMMARY", label: "Battery" },
  location: { action: "android.settings.LOCATION_SOURCE_SETTINGS", label: "Location" },
  "airplane mode": { action: "android.settings.AIRPLANE_MODE_SETTINGS", label: "Airplane mode" },
  "do not disturb": { action: "android.settings.ZEN_MODE_SETTINGS", label: "Do Not Disturb" },
  notifications: { action: "android.settings.NOTIFICATION_SETTINGS", label: "Notifications" },
  apps: { action: "android.settings.APPLICATION_SETTINGS", label: "Apps" },
  date: { action: "android.settings.DATE_SETTINGS", label: "Date & time" },
};

const SEND_WORDS = /(?:saying|that says|to say|telling (?:him|her|them)|and (?:say|tell (?:him|her|them))|that|:)\s+/i;

function recipient(ctx: ShortcutCtx, name: string): { contact: Contact | null; name: string } {
  const contact = findContact(ctx.contacts, name);
  return { contact, name: contact?.name ?? cap(clean(name)) };
}

function err(e: string) {
  return { error: e };
}

// ---------- the shortcuts ----------

const email: Shortcut = {
  id: "email.send",
  intent: "Send an email to someone (prefilled draft, then confirm and tap Send).",
  slots: [
    { name: "to", required: true, desc: "contact name or email address" },
    { name: "subject", required: false, desc: "subject line" },
    { name: "body", required: true, desc: "the message, first person" },
  ],
  keywords: ["email", "e-mail", "mail", "send", "write"],
  match(text, ctx) {
    const m =
      /^(?:please\s+)?(?:send|write|shoot|drop)\s+(?:an?\s+)?(?:quick\s+)?(?:e-?mail|mail)\s+to\s+(.+)$/i.exec(text) ??
      /^(?:please\s+)?e-?mail\s+(.+)$/i.exec(text);
    if (!m) return null;
    const lead = leadingContact(ctx.contacts, m[1]);
    let to: string;
    let rest: string;
    if (lead) {
      to = lead.contact.name;
      rest = lead.rest;
    } else {
      const sp = SEND_WORDS.exec(m[1]);
      if (!sp) return { id: "email.send", slots: {}, confidence: "low" };
      to = m[1].slice(0, sp.index);
      rest = m[1].slice(sp.index);
    }
    let subject = "";
    const subj = /^(?:with (?:the )?subject|about|re)\s+(.+?)\s+(?=saying|that says|telling|:)/i.exec(rest);
    if (subj) {
      subject = clean(subj[1]);
      rest = rest.slice(subj[0].length);
    }
    const b = /^(?:saying|that says|to say|telling (?:him|her|them)|and (?:say|tell (?:him|her|them))(?: that)?|that|:)\s*(.+)$/i.exec(rest.trim());
    const body = b ? clean(b[1]) : "";
    const slots = { to: clean(to), subject, body };
    const known = findContact(ctx.contacts, slots.to);
    const high = !!body && (!!known?.email || /@/.test(slots.to));
    return { id: "email.send", slots, confidence: high ? "high" : "low" };
  },
  plan(s, ctx) {
    const body = (s.body ?? "").trim();
    if (!s.to || !body) return err("missing recipient or message");
    const r = /@/.test(s.to) ? { contact: null, name: s.to } : recipient(ctx, s.to);
    const address = /@/.test(s.to) ? s.to.trim() : r.contact?.email ?? "";
    const subject = (s.subject ?? "").trim() || subjectFrom(body);
    const uri = `mailto:${address}?subject=${enc(subject)}&body=${enc(body)}`;
    const subgoals: SubgoalSpec[] = [
      {
        goal: `Open a new email draft to ${r.name}${address ? ` (${address})` : ""} with subject "${subject}" and body "${body}"`,
        done_when: { text_present: [body], describe: `An email draft is open with the body "${body}"` },
        risk: "safe",
        direct: [{ do: "open", uri }],
        say: `Writing to ${r.name}.`,
      },
    ];
    if (!address) {
      subgoals.push({
        goal: `Put ${r.name} in the To field of the open email draft (type the name and pick the suggestion)`,
        done_when: { text_present: [r.name], describe: `${r.name} is in the To field` },
        risk: "safe",
      });
    }
    subgoals.push({
      goal: "Tap Send on the email draft",
      done_when: { text_absent: [body], describe: "The draft is gone (sent), back in the mail list or thread" },
      risk: "irreversible",
      direct: [{ do: "tap", on: { text: "Send" } }],
      confirm: `Email to ${r.name}: "${body}"`,
      say: "Sending.",
    });
    return {
      kind: "phone",
      title: `Email ${r.name}`,
      goal: `Send ${r.name} an email: "${body}"`,
      subgoals,
      shortcut: "email.send",
      slots: { to: r.name, subject, body },
      recipient: { name: r.name, known: !!r.contact },
    };
  },
};

const sms: Shortcut = {
  id: "sms.send",
  intent: "Send a text message (SMS) to a contact (prefilled, then confirm and tap Send).",
  slots: [
    { name: "to", required: true, desc: "contact name or phone number" },
    { name: "body", required: true, desc: "the message, first person" },
  ],
  keywords: ["text", "sms", "message"],
  match(text, ctx) {
    const m = /^(?:please\s+)?(?:send\s+(?:a\s+)?)?(?:text|sms|message)(?:\s+message)?\s+(?:to\s+)?(.+)$/i.exec(text);
    if (!m) return null;
    const lead = leadingContact(ctx.contacts, m[1]);
    if (!lead) return { id: "sms.send", slots: {}, confidence: "low" };
    const body = clean(lead.rest.replace(/^(?:saying|that says|to say|that|and say|and tell (?:him|her|them)(?: that)?|:)\s*/i, ""));
    const slots = { to: lead.contact.name, body };
    return { id: "sms.send", slots, confidence: body && lead.contact.phone ? "high" : "low" };
  },
  plan(s, ctx) {
    const body = (s.body ?? "").trim();
    if (!s.to || !body) return err("missing recipient or message");
    const isNum = /^\+?\d[\d\s-]{5,}$/.test(s.to);
    const r = isNum ? { contact: null, name: s.to } : recipient(ctx, s.to);
    const number = isNum ? s.to.replace(/[\s-]/g, "") : r.contact?.phone;
    if (!number) return err(`no number for ${r.name}`);
    return {
      kind: "phone",
      title: `Text ${r.name}`,
      goal: `Text ${r.name}: "${body}"`,
      subgoals: [
        {
          goal: `Open a text message to ${r.name} (${number}) with "${body}" typed in`,
          done_when: { text_present: [body], describe: `A message to ${r.name} with "${body}" is ready to send` },
          risk: "safe",
          direct: [{ do: "open", uri: `smsto:${number}?body=${enc(body)}` }],
          say: `Texting ${r.name}.`,
        },
        {
          goal: "Tap the Send button of the message",
          done_when: { text_absent: [], field: { text: "Text message", value: "" }, describe: "The message was sent (shown in the conversation, the box is empty)" },
          risk: "irreversible",
          direct: [{ do: "tap", on: { text: "Send" } }],
          confirm: `Text to ${r.name}: "${body}"`,
          say: "Sending.",
        },
      ],
      shortcut: "sms.send",
      slots: { to: r.name, body },
      recipient: { name: r.name, known: !!r.contact },
    };
  },
};

const callAi: Shortcut = {
  id: "call.ai",
  intent: "Bobby phones a contact himself (AI voice) to say or ask something, then reports back.",
  slots: [
    { name: "to", required: true, desc: "contact name" },
    { name: "goal", required: true, desc: "what to say or ask, from the user's point of view" },
  ],
  keywords: ["call", "phone", "ring", "tell", "ask"],
  match(text, ctx) {
    const m = /^(?:please\s+)?(?:call|phone|ring)\s+(.+)$/i.exec(text);
    if (!m) return null;
    const lead = leadingContact(ctx.contacts, m[1]);
    if (!lead) return null;
    const g = /^(?:and|to)\s+(.+)$/i.exec(lead.rest.trim());
    if (!g) return null; // plain "call X" is phone.dial
    return { id: "call.ai", slots: { to: lead.contact.name, goal: cap(clean(g[1])) + "." }, confidence: lead.contact.phone ? "high" : "low" };
  },
  plan(s, ctx) {
    const c = findContact(ctx.contacts, s.to ?? "");
    const name = c?.name ?? cap(clean(s.to ?? ""));
    if (!c?.phone) return err(`no number for ${name || "them"}`);
    const goal = (s.goal ?? "").trim() || "Say hello.";
    return {
      kind: "call",
      title: `Call ${name}`,
      goal,
      subgoals: [
        {
          goal: `Phone ${name} and: ${goal}`,
          done_when: { describe: "The call ended with a result" },
          risk: "irreversible",
          confirm: `Call ${name} for you: ${goal}`,
        },
      ],
      shortcut: "call.ai",
      slots: { to: name, goal },
      recipient: { name, known: true },
      call: { name, number: c.phone, goal },
    };
  },
};

const dial: Shortcut = {
  id: "phone.dial",
  intent: "Start a normal phone call from the phone to a contact, for the user to talk (dialer, then tap Call).",
  slots: [{ name: "to", required: true, desc: "contact name or number" }],
  keywords: ["call", "dial", "phone", "ring"],
  match(text, ctx) {
    const m = /^(?:please\s+)?(?:call|phone|ring|dial)\s+(.+?)\s*(?:for me|now|please)?$/i.exec(text);
    if (!m) return null;
    const lead = leadingContact(ctx.contacts, m[1]);
    if (!lead || lead.rest.trim()) return null;
    return { id: "phone.dial", slots: { to: lead.contact.name }, confidence: lead.contact.phone ? "high" : "low" };
  },
  plan(s, ctx) {
    const isNum = /^\+?\d[\d\s-]{5,}$/.test(s.to ?? "");
    const c = isNum ? null : findContact(ctx.contacts, s.to ?? "");
    const name = c?.name ?? cap(clean(s.to ?? ""));
    const number = isNum ? (s.to ?? "").replace(/[\s-]/g, "") : c?.phone;
    if (!number) return err(`no number for ${name || "them"}`);
    return {
      kind: "phone",
      title: `Call ${name}`,
      goal: `Start a phone call to ${name}`,
      subgoals: [
        {
          goal: `Open the dialer with ${name}'s number (${number})`,
          done_when: { app: "dialer", describe: "The dialer shows the number" },
          risk: "safe",
          direct: [{ do: "open", uri: `tel:${number}` }],
          say: `Getting ${name}'s number up.`,
        },
        {
          goal: "Tap the Call button",
          done_when: { text_present: ["Calling", "Dialing", "Ringing"], describe: "The call is ringing" },
          risk: "irreversible",
          direct: [{ do: "tap", on: { text: "Call" } }],
          confirm: `Call ${name} from your phone`,
          say: `Calling ${name}.`,
        },
      ],
      shortcut: "phone.dial",
      slots: { to: name },
      recipient: { name, known: !!c },
    };
  },
};

const alarm: Shortcut = {
  id: "alarm.set",
  intent: "Set an alarm at a clock time.",
  slots: [
    { name: "time", required: true, desc: "HH:MM, 24-hour" },
    { name: "label", required: false, desc: "what it's for" },
  ],
  keywords: ["alarm", "wake me"],
  match(text) {
    const m = /\b(?:alarm|wake me(?: up)?)\b.*?\b(?:for|at)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
    if (!m) return null;
    const t = parseClock(m[1], m[2], m[3]);
    if (!t) return null;
    const label = /\b(?:called|labell?ed|for (?!\d))\s*(.+)$/i.exec(text.slice(m.index + m[0].length))?.[1] ?? "";
    return { id: "alarm.set", slots: { time: `${t.h}:${String(t.m).padStart(2, "0")}`, label: clean(label) }, confidence: "high" };
  },
  plan(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s.time ?? "").trim());
    if (!m) return err("no time");
    const h = Number(m[1]);
    const min = Number(m[2]);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const shown = [`${h12}:${m[2]}`, `${String(h).padStart(2, "0")}:${m[2]}`];
    const extras: Record<string, string | number | boolean> = { "android.intent.extra.alarm.HOUR": h, "android.intent.extra.alarm.MINUTES": min };
    if (s.label) extras["android.intent.extra.alarm.MESSAGE"] = s.label;
    return {
      kind: "phone",
      title: `Alarm ${shown[0]}`,
      goal: `Set an alarm for ${s.time}${s.label ? ` (${s.label})` : ""}`,
      subgoals: [
        {
          goal: `Set an alarm for ${s.time}`,
          done_when: { app: "clock", text_present: shown, describe: `An alarm for ${shown[0]} is on` },
          risk: "safe",
          direct: [{ do: "open", action: "android.intent.action.SET_ALARM", extras }],
          say: `Setting an alarm for ${shown[0]}.`,
        },
      ],
      shortcut: "alarm.set",
      slots: { time: s.time, label: s.label ?? "" },
    };
  },
};

const timer: Shortcut = {
  id: "timer.set",
  intent: "Start a countdown timer.",
  slots: [{ name: "seconds", required: true, desc: "length in seconds" }],
  keywords: ["timer", "countdown"],
  match(text) {
    const m = /\btimer\b.*?\b(?:for\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i.exec(text);
    if (!m) return null;
    const sec = parseDuration(m[1], m[2]);
    return sec ? { id: "timer.set", slots: { seconds: String(sec) }, confidence: "high" } : null;
  },
  plan(s) {
    const sec = Number(s.seconds);
    if (!sec) return err("no length");
    const words = sec % 3600 === 0 ? `${sec / 3600} hour${sec === 3600 ? "" : "s"}` : sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? "" : "s"}` : `${sec} seconds`;
    return {
      kind: "phone",
      title: `Timer ${words}`,
      goal: `Start a ${words} timer`,
      subgoals: [
        {
          goal: `Start a ${words} timer`,
          done_when: { app: "clock", describe: "A timer is running" },
          risk: "safe",
          direct: [{ do: "open", action: "android.intent.action.SET_TIMER", extras: { "android.intent.extra.alarm.LENGTH": sec, "android.intent.extra.alarm.SKIP_UI": false } }],
          say: `${cap(words)} timer.`,
        },
      ],
      shortcut: "timer.set",
      slots: { seconds: String(sec) },
    };
  },
};

const calendar: Shortcut = {
  id: "calendar.add",
  intent: "Add an event to the calendar (prefilled new event, then Save).",
  slots: [
    { name: "title", required: true, desc: "event title" },
    { name: "start", required: true, desc: "local start, YYYY-MM-DDTHH:MM" },
    { name: "minutes", required: false, desc: "length in minutes, default 60" },
  ],
  keywords: ["calendar", "event", "meeting", "schedule", "remind"],
  plan(s) {
    const start = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s.start ?? "") ? new Date(s.start) : null;
    if (!s.title || !start || isNaN(start.getTime())) return err("missing title or start");
    const mins = Number(s.minutes) || 60;
    const begin = start.getTime();
    return {
      kind: "phone",
      title: `Add "${s.title}"`,
      goal: `Add "${s.title}" to the calendar at ${s.start}`,
      subgoals: [
        {
          goal: `Open a new calendar event "${s.title}" at ${s.start}`,
          done_when: { text_present: [s.title], describe: `A new event "${s.title}" is open` },
          risk: "safe",
          direct: [{ do: "open", action: "android.intent.action.INSERT", uri: "content://com.android.calendar/events", extras: { title: s.title, beginTime: begin, endTime: begin + mins * 60_000 } }],
          say: "Adding it to your calendar.",
        },
        {
          goal: "Tap Save on the new event",
          done_when: { text_absent: ["Save"], describe: "The event is saved" },
          risk: "safe",
          direct: [{ do: "tap", on: { text: "Save" } }],
        },
      ],
      shortcut: "calendar.add",
      slots: { title: s.title, start: s.start, minutes: String(mins) },
    };
  },
};

const navigate: Shortcut = {
  id: "maps.navigate",
  intent: "Start navigation (directions) to a place in Maps.",
  slots: [{ name: "place", required: true, desc: "where to" }],
  keywords: ["navigate", "directions", "take me", "drive to", "maps"],
  match(text) {
    const m = /^(?:please\s+)?(?:navigate|(?:get |give me )?directions|take me|drive me|get me)\s+(?:to\s+)?(.+)$/i.exec(text);
    return m ? { id: "maps.navigate", slots: { place: clean(m[1]) }, confidence: "high" } : null;
  },
  plan(s) {
    if (!s.place) return err("no place");
    return {
      kind: "phone",
      title: `Directions to ${s.place}`,
      goal: `Start navigation to ${s.place}`,
      subgoals: [
        {
          goal: `Start navigation to ${s.place}`,
          done_when: { app: "maps", describe: "Maps shows the route" },
          risk: "safe",
          direct: [{ do: "open", uri: `google.navigation:q=${enc(s.place)}`, pkg: "com.google.android.apps.maps" }],
          say: `Getting directions to ${s.place}.`,
        },
      ],
      shortcut: "maps.navigate",
      slots: { place: s.place },
    };
  },
};

const search: Shortcut = {
  id: "web.search",
  intent: "Search the web for something.",
  slots: [{ name: "query", required: true, desc: "search words" }],
  keywords: ["search", "google", "look up"],
  match(text) {
    const m = /^(?:please\s+)?(?:search(?: the web| google)?(?: for)?|google|look up)\s+(.+)$/i.exec(text);
    return m ? { id: "web.search", slots: { query: clean(m[1]) }, confidence: "high" } : null;
  },
  plan(s) {
    if (!s.query) return err("no query");
    return {
      kind: "phone",
      title: `Search "${s.query}"`,
      goal: `Search the web for ${s.query}`,
      subgoals: [
        {
          goal: `Search the web for "${s.query}"`,
          done_when: { text_present: [s.query], describe: "Search results are showing" },
          risk: "safe",
          direct: [{ do: "open", action: "android.intent.action.WEB_SEARCH", extras: { query: s.query } }],
          say: `Searching for ${s.query}.`,
        },
      ],
      shortcut: "web.search",
      slots: { query: s.query },
    };
  },
};

const openApp: Shortcut = {
  id: "app.open",
  intent: "Open an app by name.",
  slots: [{ name: "app", required: true, desc: "app name" }],
  keywords: ["open", "launch", "start", "go to"],
  match(text) {
    const m = /^(?:please\s+)?(?:open|launch|start|go to|bring up)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/i.exec(text);
    if (!m) return null;
    const app = clean(m[1]);
    return KNOWN_APPS.has(app.toLowerCase()) ? { id: "app.open", slots: { app: cap(app) }, confidence: "high" } : null;
  },
  plan(s) {
    if (!s.app) return err("no app");
    const label = KNOWN_APPS.has(s.app.toLowerCase()) ? [...Object.values(APP_LABELS)].find((l) => l.toLowerCase() === s.app.toLowerCase()) ?? cap(s.app) : cap(s.app);
    const pkg = packageFor(label);
    return {
      kind: "phone",
      title: `Open ${label}`,
      goal: `Open the ${label} app`,
      subgoals: [
        {
          goal: `Open ${label}`,
          done_when: { app: pkg ?? label, describe: `${label} is on screen` },
          risk: "safe",
          direct: [{ do: "launch", app: label }],
          say: `Opening ${label}.`,
        },
      ],
      shortcut: "app.open",
      slots: { app: label },
    };
  },
};

const settings: Shortcut = {
  id: "settings.open",
  intent: `Open a settings page: ${[...new Set(Object.keys(SETTINGS))].join(", ")}.`,
  slots: [{ name: "page", required: true, desc: "which settings page" }],
  keywords: ["settings", "wifi", "bluetooth", "brightness", "battery", "location"],
  match(text) {
    const m = /^(?:please\s+)?(?:open|show|go to)\s+(?:the\s+|my\s+)?(.+?)\s+settings$/i.exec(text);
    if (!m) return null;
    const k = m[1].toLowerCase();
    return SETTINGS[k] ? { id: "settings.open", slots: { page: k }, confidence: "high" } : null;
  },
  plan(s) {
    const p = SETTINGS[(s.page ?? "").toLowerCase()];
    if (!p) return err("unknown settings page");
    return {
      kind: "phone",
      title: `${p.label} settings`,
      goal: `Open ${p.label} settings`,
      subgoals: [
        {
          goal: `Open the ${p.label} settings page`,
          done_when: { app: "settings", describe: `${p.label} settings are on screen` },
          risk: "safe",
          direct: [{ do: "open", action: p.action }],
          say: `Opening ${p.label} settings.`,
        },
      ],
      shortcut: "settings.open",
      slots: { page: s.page },
    };
  },
};

export const SHORTCUTS: Shortcut[] = [email, sms, callAi, dial, alarm, timer, calendar, navigate, search, settings, openApp];

// ---------- the index ----------

export class ShortcutIndex {
  private byId = new Map<string, Shortcut>();
  constructor(list: Shortcut[] = SHORTCUTS) {
    for (const s of list) this.byId.set(s.id, s);
  }
  get(id: string): Shortcut | undefined {
    return this.byId.get(id);
  }
  all(): Shortcut[] {
    return [...this.byId.values()];
  }
  /** The compact list embedded in the router's instructions. Stable across calls (caching). */
  catalogue(): string {
    return this.all()
      .map((s) => `- ${s.id}: ${s.intent} Slots: ${s.slots.map((x) => `${x.name}${x.required ? "" : "?"} (${x.desc})`).join("; ")}.`)
      .join("\n");
  }
  /** Builds a task plan from a shortcut id and slots (from the router or the local matcher). */
  plan(id: string, slots: Record<string, string>, ctx: ShortcutCtx): TaskPlan | { error: string } {
    const s = this.byId.get(id);
    if (!s) return { error: `unknown shortcut ${id}` };
    return s.plan(slots, ctx);
  }
  /**
   * Local pre-match on a whole utterance. Splits chains ("X, then Y"); returns one plan per part
   * only when every part matched with high confidence and built a plan. Otherwise null: the
   * router decides.
   */
  matchUtterance(text: string, ctx: ShortcutCtx): { matches: LocalMatch[]; plans: TaskPlan[] } | null {
    const parts = splitChain(text);
    if (parts.length === 0) return null;
    const matches: LocalMatch[] = [];
    const plans: TaskPlan[] = [];
    for (const p of parts) {
      const m = this.matchOne(p, ctx);
      if (!m || m.confidence !== "high") return null;
      const plan = this.plan(m.id, m.slots, ctx);
      if ("error" in plan) return null;
      matches.push(m);
      plans.push(plan);
    }
    return { matches, plans };
  }
  matchOne(text: string, ctx: ShortcutCtx): LocalMatch | null {
    const t = text.trim().replace(/[.!]+$/, "");
    for (const s of this.byId.values()) {
      const m = s.match?.(t, ctx);
      if (m) return m;
    }
    return null;
  }
}

/** "open Spotify, then text Alex I'm late, and then call Mom" -> three commands. */
export function splitChain(text: string): string[] {
  return text
    .replace(/^\s*(?:hey\s+)?bobby[,\s]+/i, "")
    .split(/\s*(?:,\s*)?\b(?:and then|then|after that|afterwards)\b[,\s]*/i)
    .map((s) => s.trim().replace(/^(?:and|also)\s+/i, "").replace(/[,.;]+$/, "").trim())
    .filter(Boolean);
}
