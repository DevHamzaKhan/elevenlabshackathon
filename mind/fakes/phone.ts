// The pretend phone: three home screens, a "Google" folder on page 2, Gmail on page 3, a Gmail
// inbox with Sarah Chen's email, the open email, a reply box and a sent state; plus the screens
// v2 shortcuts land on (Gmail compose, Messages, dialer and call, Clock alarms and timer, Calendar
// new event, Maps navigation, search results, settings pages) and a web-view app with no readable
// tree ("Tickets"). It answers `screen`, `act` and `caps` as CONTRACT.md plus the Hands v2
// additions describe (mind/PROTOCOL-V2.md): `open` intents, `since`/`hash`, `compact`, `image`,
// `then_screen`, `fast`, stable `key`/`id` targets, stale `n`, and a secure lock.
// `legacy: true` behaves like v1 Hands: no hash/keys/ids, `open` is a bad_request, extras ignored.
// For teaching by showing there is a "Projects" app (a list, a "New project" button, a dialog with
// a name field and Create) and a pretend user: `user.tap()`, `user.type()`, `user.scroll()` change
// the phone the way a finger would and, while `observe` is on, emit the `observed` frames Hands
// sends (PROTOCOL-V2.md). `drift` changes the Projects app the way an update would.

type Bounds = [number, number, number, number];

type PNode = {
  key: string;
  id?: string;
  text?: string;
  desc?: string;
  hint?: string;
  cls: string;
  bounds: Bounds;
  tap?: boolean;
  edit?: boolean;
  scroll?: boolean;
  checked?: boolean;
  focused?: boolean;
};

type AppDef = { label: string; pkg: string };

const W = 1080;
const H = 2400;

const APPS: Record<string, AppDef> = {
  phone: { label: "Phone", pkg: "com.google.android.dialer" },
  messages: { label: "Messages", pkg: "com.google.android.apps.messaging" },
  chrome: { label: "Chrome", pkg: "com.android.chrome" },
  camera: { label: "Camera", pkg: "com.android.camera" },
  clock: { label: "Clock", pkg: "com.google.android.deskclock" },
  settings: { label: "Settings", pkg: "com.android.settings" },
  maps: { label: "Maps", pkg: "com.google.android.apps.maps" },
  spotify: { label: "Spotify", pkg: "com.spotify.music" },
  calendar: { label: "Calendar", pkg: "com.google.android.calendar" },
  photos: { label: "Photos", pkg: "com.google.android.apps.photos" },
  google: { label: "Google", pkg: "com.google.android.googlequicksearchbox" },
  drive: { label: "Drive", pkg: "com.google.android.apps.docs" },
  youtube: { label: "YouTube", pkg: "com.google.android.youtube" },
  meet: { label: "Meet", pkg: "com.google.android.apps.tachyon" },
  keep: { label: "Keep Notes", pkg: "com.google.android.keep" },
  gmail: { label: "Gmail", pkg: "com.google.android.gm" },
  whatsapp: { label: "WhatsApp", pkg: "com.whatsapp" },
  calculator: { label: "Calculator", pkg: "com.google.android.calculator" },
  contacts: { label: "Contacts", pkg: "com.google.android.contacts" },
  tickets: { label: "Tickets", pkg: "com.example.tickets" },
  projects: { label: "Projects", pkg: "com.example.projects" },
};

const PAGES: string[][] = [
  ["clock", "camera", "settings", "contacts"],
  ["maps", "spotify", "calendar", "photos", "folder:google"],
  ["whatsapp", "gmail", "calculator", "tickets", "projects"],
];
const FOLDER_GOOGLE = ["google", "drive", "youtube", "meet", "keep"];
const DOCK = ["phone", "messages", "chrome"];
const LAUNCHER_PKG = "com.google.android.apps.nexuslauncher";
const GM = "com.google.android.gm:id/";
const SMS = "com.google.android.apps.messaging:id/";
const PJ = "com.example.projects:id/";

/** Ways the Projects app can differ from the day the user showed how to use it. */
export type Drift = {
  /** A banner pushes everything down and the button moves to the other corner. */
  moved?: boolean;
  /** "New project" is now called "Add project" (same resource id). */
  renamed?: boolean;
  /** Opening the app shows a "What's new" sheet with a Continue button: a step the demo never had. */
  interstitial?: boolean;
  /** A tip ("Got it") covers the app when it opens and again after a project is created, the way
   *  Google Contacts covers a saved contact: nothing underneath can be read until it is closed. */
  tip?: boolean;
  /** The list has grown so long that the button sits below the fold until you scroll. */
  long?: boolean;
};

type Screen =
  | { kind: "home"; page: number; folder: boolean }
  | { kind: "shade" }
  | { kind: "recents" }
  | { kind: "gmail_inbox" }
  | { kind: "gmail_email" }
  | { kind: "gmail_reply" }
  | { kind: "gmail_compose" }
  | { kind: "sms" }
  | { kind: "dialer" }
  | { kind: "in_call" }
  | { kind: "clock" }
  | { kind: "timer" }
  | { kind: "cal_edit" }
  | { kind: "cal_view" }
  | { kind: "nav" }
  | { kind: "search" }
  | { kind: "settings_page"; page: string }
  | { kind: "tickets" }
  | { kind: "proj_list" }
  | { kind: "proj_new" }
  | { kind: "proj_detail"; name: string }
  | { kind: "app"; app: string };

export type PhoneNotification = { app: string; title: string; text: string; at: number };

export type PhoneOptions = {
  log?: (s: string) => void;
  speed?: number;
  flaky?: boolean | number;
  random?: () => number;
  /** Behave like v1 Hands (no v2 fields, no `open`). */
  legacy?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gridBounds(i: number): Bounds {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const x = 60 + col * 250;
  const y = 500 + row * 320;
  return [x, y, x + 210, y + 260];
}

function hashOf(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return "h" + (h >>> 0).toString(16);
}

function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of q.split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    out[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
  }
  return out;
}

export class Phone {
  screen: Screen = { kind: "home", page: 0, folder: false };
  private history: Screen[] = [];
  private lastNodes: PNode[] = [];
  private lastHash = "";
  private focusedKey: string | null = null;
  replyText = "";
  sent: { to: string; text: string; at: number } | null = null;
  compose = { to: "", subject: "", body: "" };
  composeError = "";
  mails: { to: string; subject: string; body: string; at: number }[] = [];
  sms = { number: "", body: "" };
  texts: { to: string; body: string; at: number }[] = [];
  dialNumber = "";
  calls: { number: string; at: number }[] = [];
  alarms: { h: number; m: number; label: string }[] = [];
  timerSec = 0;
  calDraft = { title: "", begin: 0 };
  events: { title: string; begin: number }[] = [];
  navPlace = "";
  query = "";
  ticketSaved = false;
  projects: string[] = ["Website redesign", "Q3 planning"];
  projName = "";
  drift: Drift = {};
  /** Where the Projects app was left: a plain launch resumes there, a fresh one starts at the list. */
  private projLeft: Screen = { kind: "proj_list" };
  private projNews = false;
  private projTip = false;
  private projScrolled = false;
  /** While on, user actions are reported as `observed` frames. */
  private observing: ((frame: any) => void) | null = null;
  private obsSeq = 0;
  private obsSentHash = "";
  private snackbarUntil = 0;
  private snackText = "";
  popup: string | null = null;
  notifications: PhoneNotification[] = [];
  on = true;
  locked = false;
  legacy: boolean;
  log: (s: string) => void;
  speed: number;
  flaky: boolean;
  flakyRate: number;
  random: () => number;
  lastCursor: [number, number] = [W / 2, H / 2];
  actsDone = 0;
  fastActs = 0;
  opens: any[] = [];
  /** Every screen_result returned, counting `same` replies, for tests. */
  reads = { full: 0, same: 0, images: 0 };

  constructor(opts: PhoneOptions = {}) {
    this.log = opts.log ?? ((s) => console.log(s));
    this.speed = opts.speed ?? 1;
    this.flaky = !!opts.flaky;
    this.flakyRate = typeof opts.flaky === "number" ? opts.flaky : 0.12;
    this.random = opts.random ?? Math.random;
    this.legacy = !!opts.legacy;
  }

  reset() {
    this.screen = { kind: "home", page: 0, folder: false };
    this.history = [];
    this.replyText = "";
    this.sent = null;
    this.popup = null;
    this.focusedKey = null;
    this.compose = { to: "", subject: "", body: "" };
    this.sms = { number: "", body: "" };
    this.ticketSaved = false;
  }

  currentApp(): string {
    const s = this.screen;
    if (this.popup) return "com.android.vending";
    switch (s.kind) {
      case "home":
      case "recents":
        return LAUNCHER_PKG;
      case "shade":
        return "com.android.systemui";
      case "gmail_inbox":
      case "gmail_email":
      case "gmail_reply":
      case "gmail_compose":
        return APPS.gmail.pkg;
      case "sms":
        return APPS.messages.pkg;
      case "dialer":
      case "in_call":
        return APPS.phone.pkg;
      case "clock":
      case "timer":
        return APPS.clock.pkg;
      case "cal_edit":
      case "cal_view":
        return APPS.calendar.pkg;
      case "nav":
        return APPS.maps.pkg;
      case "search":
        return APPS.google.pkg;
      case "settings_page":
        return APPS.settings.pkg;
      case "tickets":
        return APPS.tickets.pkg;
      case "proj_list":
      case "proj_new":
      case "proj_detail":
        return APPS.projects.pkg;
      case "app":
        return APPS[s.app]?.pkg ?? s.app;
    }
  }

  where(): string {
    const s = this.screen;
    if (this.popup) return `pop-up "${this.popup}"`;
    if (s.kind === "proj_detail") return `project "${s.name}"`;
    if (s.kind === "home") return `home page ${s.page + 1}${s.folder ? " with Google folder open" : ""}`;
    if (s.kind === "app") return `${APPS[s.app]?.label ?? s.app} app`;
    return s.kind.replace("_", " ");
  }

  private nodes(): PNode[] {
    const s = this.screen;
    const out: PNode[] = [];
    const now = Date.now();
    const statusBar = () => out.push({ key: "clock", text: "10:45", cls: "TextView", bounds: [40, 10, 160, 70] });
    const snack = () => {
      if (now < this.snackbarUntil) out.push({ key: "snack", text: this.snackText, cls: "TextView", bounds: [40, 2260, 600, 2340] });
    };

    if (this.popup) {
      out.push(
        { key: "popup_title", text: this.popup, cls: "TextView", bounds: [120, 1000, 960, 1080] },
        { key: "popup_body", text: "A new version is ready to install.", cls: "TextView", bounds: [120, 1100, 960, 1180] },
        { key: "popup_dismiss", text: "Not now", cls: "Button", bounds: [200, 1260, 500, 1360], tap: true },
        { key: "popup_accept", text: "Update", cls: "Button", bounds: [580, 1260, 880, 1360], tap: true },
      );
      return out;
    }

    switch (s.kind) {
      case "home": {
        statusBar();
        if (s.folder) {
          out.push({ key: "folder_title", text: "Google", cls: "EditText", bounds: [140, 700, 940, 790] });
          FOLDER_GOOGLE.forEach((a, i) => {
            const b = gridBounds(i);
            out.push({ key: `open:${a}`, text: APPS[a].label, desc: APPS[a].label, cls: "TextView", bounds: [b[0] + 40, b[1] + 400, b[2] + 40, b[3] + 400], tap: true });
          });
          break;
        }
        if (s.page === 0) out.push({ key: "search_widget", desc: "Google Search", text: "Search", cls: "TextView", bounds: [60, 260, 1020, 380], tap: true });
        PAGES[s.page].forEach((a, i) => {
          const b = gridBounds(i);
          if (a === "folder:google") out.push({ key: "folder:google", text: "Google", desc: "Folder: Google, 5 apps", cls: "FolderIcon", bounds: b, tap: true });
          else out.push({ key: `open:${a}`, text: APPS[a].label, desc: APPS[a].label, cls: "TextView", bounds: b, tap: true });
        });
        out.push({ key: "pager", desc: `Page ${s.page + 1} of ${PAGES.length}`, cls: "PageIndicator", bounds: [440, 1880, 640, 1920], scroll: true });
        DOCK.forEach((a, i) => {
          const x = 120 + i * 300;
          out.push({ key: `open:${a}`, text: APPS[a].label, desc: APPS[a].label, cls: "TextView", bounds: [x, 2050, x + 200, 2250], tap: true });
        });
        break;
      }
      case "shade": {
        statusBar();
        out.push({ key: "shade_title", text: "Notifications", cls: "TextView", bounds: [40, 200, 600, 280] });
        if (this.notifications.length === 0) out.push({ key: "shade_empty", text: "No notifications", cls: "TextView", bounds: [40, 320, 1040, 400] });
        this.notifications.slice(-5).reverse().forEach((n, i) => {
          const y = 320 + i * 200;
          out.push({ key: `notif:${n.app}`, text: `${n.title}: ${n.text}`, desc: `${n.title}, ${n.text}`, cls: "FrameLayout", bounds: [40, y, 1040, y + 180], tap: true });
        });
        out.push({ key: "shade_clear", text: "Clear all", cls: "Button", bounds: [800, 2200, 1040, 2280], tap: true });
        break;
      }
      case "recents":
        out.push({ key: "recents_empty", text: "No recent items", cls: "TextView", bounds: [300, 1100, 780, 1200] });
        break;
      case "gmail_inbox": {
        statusBar();
        out.push(
          { key: "drawer", desc: "Open navigation drawer", cls: "ImageButton", bounds: [40, 120, 140, 220], tap: true },
          { key: "search", hint: "Search in mail", cls: "EditText", bounds: [160, 120, 900, 220], tap: true, edit: true },
          { key: "avatar", desc: "Signed in as owner@example.com Account and settings", cls: "ImageView", bounds: [920, 120, 1040, 220], tap: true },
          { key: "primary", text: "Primary", cls: "TextView", bounds: [40, 260, 400, 320] },
          { key: "row_sarah", desc: `Sarah Chen, Meeting today, Running late, can we push to 3?, 10:42 AM${this.sent ? "" : ", Unread"}`, cls: "LinearLayout", bounds: [0, 340, 1080, 540], tap: true },
          { key: "row_google", desc: "Google, Security alert, A new sign-in on Android, 9:15 AM", cls: "LinearLayout", bounds: [0, 540, 1080, 740], tap: true },
          { key: "row_linkedin", desc: "LinkedIn, You appeared in 5 searches this week, Yesterday", cls: "LinearLayout", bounds: [0, 740, 1080, 940], tap: true },
          { key: "compose", id: `${GM}compose_button`, text: "Compose", cls: "Button", bounds: [700, 2100, 1040, 2240], tap: true },
          { key: "list", cls: "RecyclerView", bounds: [0, 340, 1080, 2000], scroll: true },
        );
        snack();
        break;
      }
      case "gmail_email": {
        statusBar();
        out.push(
          { key: "up", desc: "Navigate up", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "archive", desc: "Archive", cls: "ImageButton", bounds: [700, 120, 790, 220], tap: true },
          { key: "delete", desc: "Delete", cls: "ImageButton", bounds: [800, 120, 890, 220], tap: true },
          { key: "more", desc: "More options", cls: "ImageButton", bounds: [960, 120, 1060, 220], tap: true },
          { key: "subject", text: "Meeting today", cls: "TextView", bounds: [40, 260, 900, 340] },
          { key: "sender", text: "Sarah Chen", cls: "TextView", bounds: [160, 380, 700, 440] },
          { key: "body", text: "Hi! Running late, can we push to 3? Sarah", cls: "TextView", bounds: [40, 520, 1040, 760] },
        );
        if (this.sent) out.push({ key: "sent_msg", text: `Me: ${this.sent.text}`, cls: "TextView", bounds: [40, 800, 1040, 960] });
        else out.push({ key: "smart", text: "Sounds good!", cls: "Button", bounds: [40, 1900, 400, 1980], tap: true });
        out.push(
          { key: "reply", id: `${GM}reply_button`, text: "Reply", cls: "Button", bounds: [40, 2100, 340, 2220], tap: true },
          { key: "reply_all", text: "Reply all", cls: "Button", bounds: [380, 2100, 680, 2220], tap: true },
          { key: "forward", text: "Forward", cls: "Button", bounds: [720, 2100, 1040, 2220], tap: true },
        );
        if (now < this.snackbarUntil) {
          out.push(
            { key: "snack", text: "Sent", cls: "TextView", bounds: [40, 2260, 600, 2340] },
            { key: "undo", text: "Undo", cls: "Button", bounds: [860, 2260, 1040, 2340], tap: true },
          );
        }
        break;
      }
      case "gmail_reply": {
        statusBar();
        out.push(
          { key: "up", desc: "Navigate up", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "send", id: `${GM}send`, desc: "Send", cls: "ImageButton", bounds: [860, 120, 960, 220], tap: true },
          { key: "to", text: "To", cls: "TextView", bounds: [40, 260, 140, 340] },
          { key: "to_chip", text: "Sarah Chen", cls: "TextView", bounds: [160, 260, 500, 340] },
          { key: "subj", text: "Re: Meeting today", cls: "EditText", bounds: [40, 380, 1040, 460], edit: true },
          { key: "body_field", id: `${GM}body`, text: this.replyText || "", hint: this.replyText ? "" : "Compose email", cls: "EditText", bounds: [40, 500, 1040, 900], edit: true, focused: this.focusedKey === "body_field" },
          { key: "kb", desc: "Keyboard", cls: "KeyboardView", bounds: [0, 1500, 1080, 2400] },
        );
        break;
      }
      case "gmail_compose": {
        statusBar();
        const c = this.compose;
        out.push(
          { key: "up", desc: "Navigate up", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "gm.send", id: `${GM}send`, desc: "Send", cls: "ImageButton", bounds: [860, 120, 960, 220], tap: true },
          { key: "gm.to", id: `${GM}to`, text: c.to, hint: c.to ? "" : "To", cls: "EditText", bounds: [40, 260, 1040, 340], edit: true, focused: this.focusedKey === "gm.to" },
          { key: "gm.subject", id: `${GM}subject`, text: c.subject, hint: c.subject ? "" : "Subject", cls: "EditText", bounds: [40, 380, 1040, 460], edit: true, focused: this.focusedKey === "gm.subject" },
          { key: "gm.body", id: `${GM}body`, text: c.body, hint: c.body ? "" : "Compose email", cls: "EditText", bounds: [40, 500, 1040, 900], edit: true, focused: this.focusedKey === "gm.body" },
        );
        if (this.composeError) out.push({ key: "gm.error", text: this.composeError, cls: "TextView", bounds: [40, 2260, 1040, 2340] });
        break;
      }
      case "sms": {
        statusBar();
        out.push(
          { key: "sms.up", desc: "Back", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "sms.to", text: this.sms.number, cls: "TextView", bounds: [160, 120, 900, 220] },
        );
        this.texts.filter((t) => t.to === this.sms.number).forEach((t, i) => out.push({ key: `sms.msg${i}`, text: t.body, cls: "TextView", bounds: [300, 400 + i * 120, 1040, 500 + i * 120] }));
        out.push(
          { key: "sms.field", id: `${SMS}compose_message_text`, text: this.sms.body, hint: this.sms.body ? "" : "Text message", cls: "EditText", bounds: [40, 2100, 900, 2220], edit: true },
          { key: "sms.send", id: `${SMS}send_message_button_icon`, desc: "Send SMS", cls: "ImageButton", bounds: [920, 2100, 1040, 2220], tap: true },
        );
        break;
      }
      case "dialer":
        statusBar();
        out.push(
          { key: "dial.number", text: this.dialNumber, cls: "EditText", bounds: [40, 400, 1040, 520] },
          { key: "dial.call", id: "com.google.android.dialer:id/dialpad_voice_call_button", desc: "Call", cls: "ImageButton", bounds: [440, 2000, 640, 2200], tap: true },
        );
        break;
      case "in_call":
        statusBar();
        out.push(
          { key: "call.state", text: `Calling ${this.dialNumber}`, cls: "TextView", bounds: [40, 400, 1040, 520] },
          { key: "call.end", desc: "End call", cls: "ImageButton", bounds: [440, 2000, 640, 2200], tap: true },
        );
        break;
      case "clock":
        statusBar();
        out.push({ key: "clk.title", text: "Alarm", cls: "TextView", bounds: [40, 120, 600, 220] });
        this.alarms.forEach((a, i) => {
          const h12 = a.h % 12 === 0 ? 12 : a.h % 12;
          out.push(
            { key: `clk.alarm${i}`, text: `${h12}:${String(a.m).padStart(2, "0")}`, cls: "TextView", bounds: [40, 300 + i * 200, 500, 400 + i * 200] },
            { key: `clk.ampm${i}`, text: a.h < 12 ? "AM" : "PM", cls: "TextView", bounds: [520, 300 + i * 200, 640, 400 + i * 200] },
            { key: `clk.switch${i}`, desc: a.label || "Alarm", cls: "Switch", bounds: [900, 300 + i * 200, 1040, 400 + i * 200], tap: true, checked: true },
          );
        });
        break;
      case "timer":
        statusBar();
        out.push(
          { key: "tmr.left", text: `${Math.floor(this.timerSec / 60)}:${String(this.timerSec % 60).padStart(2, "0")}`, cls: "TextView", bounds: [240, 800, 840, 1000] },
          { key: "tmr.pause", desc: "Pause", cls: "ImageButton", bounds: [440, 2000, 640, 2200], tap: true },
        );
        break;
      case "cal_edit":
        statusBar();
        out.push(
          { key: "cal.close", desc: "Close", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "cal.save", id: "com.google.android.calendar:id/save", text: "Save", cls: "Button", bounds: [860, 120, 1040, 220], tap: true },
          { key: "cal.title", text: this.calDraft.title, hint: this.calDraft.title ? "" : "Add title", cls: "EditText", bounds: [40, 300, 1040, 420], edit: true },
          { key: "cal.when", text: new Date(this.calDraft.begin).toISOString().slice(0, 16).replace("T", " "), cls: "TextView", bounds: [40, 460, 1040, 540] },
        );
        break;
      case "cal_view":
        statusBar();
        this.events.forEach((e, i) => out.push({ key: `cal.ev${i}`, text: e.title, cls: "TextView", bounds: [40, 300 + i * 150, 1040, 420 + i * 150], tap: true }));
        break;
      case "nav":
        statusBar();
        out.push(
          { key: "nav.to", text: `Navigating to ${this.navPlace}`, cls: "TextView", bounds: [40, 120, 1040, 220] },
          { key: "nav.exit", desc: "Exit navigation", cls: "ImageButton", bounds: [40, 2100, 200, 2260], tap: true },
        );
        break;
      case "search":
        statusBar();
        out.push(
          { key: "srch.box", text: this.query, cls: "EditText", bounds: [40, 120, 1040, 220], edit: true },
          { key: "srch.r1", text: `Results for ${this.query}`, cls: "TextView", bounds: [40, 300, 1040, 400], tap: true },
        );
        break;
      case "settings_page":
        statusBar();
        out.push(
          { key: "set.title", text: s.page, cls: "TextView", bounds: [40, 120, 1040, 220] },
          { key: "set.toggle", text: `Use ${s.page}`, cls: "Switch", bounds: [40, 300, 1040, 400], tap: true, checked: true },
        );
        break;
      case "tickets":
        // A web view: nothing readable in the tree. The "Save ticket" button is only in pixels.
        out.push({ key: "web", cls: "WebView", bounds: [0, 0, W, H] });
        if (this.ticketSaved) out.push({ key: "web.saved", text: "Ticket saved", cls: "TextView", bounds: [200, 1400, 880, 1500] });
        break;
      case "proj_list": {
        statusBar();
        const dy = this.drift.moved ? 180 : 0;
        if (this.projNews) {
          out.push(
            { key: "pj.news", text: "What's new in Projects", cls: "TextView", bounds: [120, 900, 960, 980] },
            { key: "pj.news_ok", id: `${PJ}whats_new_ok`, text: "Continue", cls: "Button", bounds: [380, 1260, 700, 1360], tap: true },
          );
          break;
        }
        if (this.projTip) {
          out.length = 0; // a modal tip: accessibility sees nothing else
          out.push(
            { key: "pj.tip", text: "Tip: long-press a project to archive it.", cls: "TextView", bounds: [63, 325, 919, 487] },
            { key: "pj.tip_x", desc: "Got it", cls: "ImageView", bounds: [951, 324, 1014, 387], tap: true },
          );
          break;
        }
        out.push({ key: "pj.title", text: "Projects", cls: "TextView", bounds: [40, 120, 600, 220] });
        if (this.drift.moved) out.push({ key: "pj.banner", text: "Try the new timeline view", cls: "TextView", bounds: [40, 240, 1040, 380] });
        const rows = this.drift.long && !this.projScrolled ? this.projects.slice(0, 6) : this.projects;
        rows.forEach((name, i) => {
          const y = 300 + dy + i * 160;
          out.push({ key: `pj.row:${name}`, id: `${PJ}project_row`, text: name, cls: "TextView", bounds: [40, y, 1040, y + 140], tap: true });
        });
        const fab = !this.drift.long || this.projScrolled;
        if (fab) {
          const b: Bounds = this.drift.moved ? [60, 2060, 400, 2200] : [700, 2100, 1040, 2240];
          out.push({ key: this.drift.renamed ? "pj.fab2" : "pj.fab", id: `${PJ}fab_new`, text: this.drift.renamed ? "Add project" : "New project", cls: "Button", bounds: b, tap: true });
        }
        out.push({ key: "pj.list", id: `${PJ}list`, cls: "RecyclerView", bounds: [0, 280, 1080, 2000], scroll: true });
        snack();
        break;
      }
      case "proj_new":
        statusBar();
        out.push(
          { key: "pj.dlg_title", text: "Create a project", cls: "TextView", bounds: [120, 800, 960, 880] },
          { key: "pj.name", id: `${PJ}name_input`, text: this.projName, hint: "Project name", cls: "EditText", bounds: [120, 920, 960, 1040], tap: true, edit: true, focused: this.focusedKey === "pj.name" },
          { key: "pj.cancel", id: `${PJ}cancel`, text: "Cancel", cls: "Button", bounds: [420, 1100, 660, 1200], tap: true },
          { key: "pj.create", id: `${PJ}create`, text: "Create", cls: "Button", bounds: [700, 1100, 960, 1200], tap: true },
        );
        break;
      case "proj_detail":
        statusBar();
        out.push(
          { key: "up", desc: "Navigate up", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "pj.d_title", text: s.name, cls: "TextView", bounds: [160, 120, 900, 220] },
          { key: "pj.d_empty", text: "No tasks yet", cls: "TextView", bounds: [40, 400, 1040, 500] },
          { key: "pj.d_add", id: `${PJ}add_task`, text: "Add task", cls: "Button", bounds: [700, 2100, 1040, 2240], tap: true },
        );
        break;
      case "app": {
        statusBar();
        const label = APPS[s.app]?.label ?? s.app;
        out.push(
          { key: "app_title", text: label, cls: "TextView", bounds: [160, 120, 900, 220] },
          { key: "up", desc: "Navigate up", cls: "ImageButton", bounds: [20, 120, 120, 220], tap: true },
          { key: "app_body", text: `${label} is open.`, cls: "TextView", bounds: [40, 400, 1040, 500] },
        );
        break;
      }
    }
    return out;
  }

  /** `screen_result` body. opts: since (hash), compact, image. */
  read(opts: { since?: string; compact?: boolean; image?: boolean } = {}): any {
    const app = this.currentApp();
    if (this.locked) return { app: "com.android.systemui", size: [W, H], locked: true, ...(this.legacy ? {} : { hash: "locked" }), nodes: [] };
    const nodes = this.nodes();
    const shown = nodes.map((p, n) => {
      const o: any = { n, text: p.text ?? "", desc: p.desc ?? "", cls: p.cls, bounds: p.bounds };
      if (p.hint) o.hint = p.hint;
      o.tap = !!p.tap;
      o.edit = !!p.edit;
      o.scroll = !!p.scroll;
      if (!this.legacy) {
        o.key = p.key;
        if (p.id) o.id = p.id;
        if (p.checked !== undefined) o.checked = p.checked;
        if (p.focused) o.focused = true;
      }
      return o;
    });
    const hash = hashOf(app + JSON.stringify(shown.map(({ n: _n, ...rest }) => rest)));
    if (!this.legacy && opts.since && opts.since === hash && opts.since === this.lastHash) {
      this.reads.same += 1;
      return { app, size: [W, H], same: true, hash };
    }
    this.lastNodes = nodes;
    this.lastHash = hash;
    this.reads.full += 1;
    const out: any = { app, size: [W, H], nodes: shown };
    if (this.legacy) return out;
    out.hash = hash;
    if (opts.compact) {
      out.nodes = shown.map((o: any) => {
        const c: any = {};
        for (const [k, v] of Object.entries(o)) if (v !== false && v !== "" && v !== undefined) c[k] = v;
        return c;
      });
    }
    if (opts.image) {
      this.reads.images += 1;
      out.image = Buffer.from(`FAKEJPEG ${this.where()}`).toString("base64");
    }
    return out;
  }

  caps(): any {
    if (this.legacy) return null;
    return { sdk: 35, oem: "Fake", model: "Pretend 1", locale: "en-US", size: [W, H], density: 2.625, launcher: LAUNCHER_PKG, ime: "com.google.android.inputmethod.latin", secureLock: true, locked: this.locked, gestureNav: true, imeTyping: true, screenshot: true, features: ["open", "since", "compact", "then_screen", "fast", "target_id", "target_key", "locked", "caps", "observe", "launch_fresh"] };
  }

  // ---------- observing the user (teaching by showing) ----------

  /** `observe` on/off. Returns the `observe_result` body, or null for a v1 Hands (no reply). */
  observe(on: boolean, emit: (frame: any) => void): any | null {
    if (this.legacy) return null;
    if (on) {
      this.observing = emit;
      this.obsSeq = 0;
      const screen = this.read({ compact: true });
      this.obsSentHash = screen.hash;
      return { ok: true, screen };
    }
    if (this.observing) this.emitScreen();
    this.observing = null;
    return { ok: true, count: this.obsSeq };
  }

  private emitScreen() {
    if (!this.observing) return "";
    const screen = this.read({ compact: true });
    if (screen.hash !== this.obsSentHash) {
      this.obsSentHash = screen.hash;
      this.observing({ type: "observed", seq: ++this.obsSeq, kind: "screen", screen });
    }
    return String(screen.hash);
  }

  private emitAction(kind: string, node: PNode | null, extra: Record<string, unknown> = {}) {
    if (!this.observing) return;
    const hash = this.emitScreen();
    const shown = node ? this.read({ compact: true }).nodes.find((x: any) => x.key === node.key) : undefined;
    this.observing({ type: "observed", seq: ++this.obsSeq, kind, app: this.currentApp(), hash, at: Date.now(), ...(shown ? { node: shown } : {}), ...extra });
  }

  private byLabel(q: string): PNode | null {
    const t = this.findTarget({ key: q });
    if (t && t !== "pixel" && t !== "stale") return t;
    const u = this.findTarget({ text: q });
    return u && u !== "pixel" && u !== "stale" ? u : null;
  }

  /** The pretend user's finger. Each call changes the phone and, while observed, reports it. */
  user = {
    /** Taps the control with this key or label. Throws when it isn't on screen (a broken test). */
    tap: (what: string, kind: "tap" | "long_press" = "tap") => {
      const node = this.byLabel(what);
      if (!node) throw new Error(`user.tap: "${what}" is not on ${this.where()}`);
      this.emitAction(kind, node);
      this.tapNode(node);
      this.log(`phone: (user) ${kind} "${label(node)}"; now on ${this.where()}`);
      this.emitScreen();
    },
    /** Types into the focused field (or the one named). Reported once, with the final text. */
    type: (text: string, into?: string) => {
      const key = into ? this.byLabel(into)?.key : this.focusedKey;
      const node = this.nodes().find((n) => n.key === key);
      if (!node?.edit) throw new Error(`user.type: no field to type into on ${this.where()}`);
      const hash = this.emitScreen();
      const shown = this.read({ compact: true }).nodes.find((x: any) => x.key === node.key);
      this.focusedKey = node.key;
      if (node.key === "pj.name") this.projName = text;
      else if (node.key === "gm.body") this.compose.body = text;
      else if (node.key === "body_field") this.replyText = text;
      else if (node.key === "sms.field") this.sms.body = text;
      this.log(`phone: (user) typed "${text}"`);
      if (this.observing) this.observing({ type: "observed", seq: ++this.obsSeq, kind: "type", app: this.currentApp(), hash, at: Date.now(), node: shown, text });
      this.emitScreen();
    },
    scroll: (dir: "up" | "down") => {
      const list = this.nodes().find((n) => n.scroll) ?? null;
      this.emitAction("scroll", list, { dir });
      if (this.screen.kind === "proj_list") this.projScrolled = dir === "up";
      this.emitScreen();
    },
    home: () => {
      this.history = [];
      this.screen = { kind: "home", page: 0, folder: false };
      this.emitScreen();
    },
    /** Opens an app the way a person does: home, find the icon, tap it. */
    open: (app: string) => {
      const id = Object.keys(APPS).find((a) => APPS[a].label.toLowerCase() === app.toLowerCase());
      if (!id) throw new Error(`user.open: no app "${app}"`);
      const page = PAGES.findIndex((p) => p.includes(id));
      this.history = [];
      this.screen = { kind: "home", page: Math.max(0, page), folder: false };
      this.emitScreen();
      this.user.tap(`open:${id}`);
    },
  };

  private findTarget(on: any): PNode | null | "pixel" | "stale" {
    if (!on || typeof on !== "object") return null;
    const current = this.nodes();
    if (typeof on.n === "number") {
      const want = this.lastNodes[on.n];
      if (!want) return null;
      const same = current.find((c) => c.key === want.key);
      // v2 Hands: `n` belongs to the last screen_result; if the screen has changed since, it's stale.
      if (!this.legacy && hashOf(JSON.stringify(current.map((c) => [c.key, c.text, c.hint]))) !== hashOf(JSON.stringify(this.lastNodes.map((c) => [c.key, c.text, c.hint])))) {
        return same && same.key === want.key && current.indexOf(same) === on.n ? same : "stale";
      }
      return same ?? null;
    }
    if (!this.legacy && typeof on.key === "string") return current.find((c) => c.key === on.key) ?? null;
    if (!this.legacy && typeof on.id === "string") return current.find((c) => c.id === on.id || (c.id ?? "").endsWith(`:id/${on.id}`)) ?? null;
    if (typeof on.text === "string") {
      const q = on.text.trim().toLowerCase();
      if (!q) return null;
      const label = (c: PNode) => [c.text ?? "", c.desc ?? "", c.hint ?? ""].map((s) => s.toLowerCase());
      const exact = current.find((c) => label(c).some((s) => s === q));
      if (exact) return exact;
      return current.find((c) => label(c).some((s) => s.includes(q))) ?? null;
    }
    if (typeof on.x === "number" && typeof on.y === "number") {
      const hits = current.filter((c) => on.x >= c.bounds[0] && on.x <= c.bounds[2] && on.y >= c.bounds[1] && on.y <= c.bounds[3]);
      if (hits.length === 0) return "pixel";
      hits.sort((a, b) => area(a.bounds) - area(b.bounds));
      return hits[0];
    }
    return null;
  }

  private go(next: Screen) {
    this.history.push(this.screen);
    this.screen = next;
    this.focusedKey = null;
    if (next.kind === "proj_list" || next.kind === "proj_detail") this.projLeft = next;
  }

  private openApp(id: string) {
    if (id === "gmail") return this.go({ kind: "gmail_inbox" });
    if (id === "tickets") return this.go({ kind: "tickets" });
    if (id === "clock") return this.go({ kind: "clock" });
    if (id === "projects") {
      // Like a real app: it comes back where it was left, unless it is started fresh.
      this.projNews = !!this.drift.interstitial;
      this.projTip = !!this.drift.tip;
      this.projScrolled = false;
      const left = this.projLeft;
      this.go({ kind: "proj_list" });
      if (left.kind === "proj_detail") this.go(left);
      return;
    }
    this.go({ kind: "app", app: id });
  }

  private snackbar(text: string) {
    this.snackText = text;
    this.snackbarUntil = Date.now() + 4000;
  }

  private tapNode(node: PNode, at?: [number, number]): void {
    const k = node.key;
    if (this.popup) {
      if (k === "popup_dismiss" || k === "popup_accept") this.popup = null;
      return;
    }
    if (k === "web" && at) {
      // The web view's "Save ticket" button lives at [300,1200,780,1320] in pixels only.
      if (at[0] >= 300 && at[0] <= 780 && at[1] >= 1200 && at[1] <= 1320) {
        this.ticketSaved = true;
        this.log("phone: TICKET SAVED (web view button)");
      }
      return;
    }
    if (!node.tap && !node.edit) return;
    if (k.startsWith("open:")) return this.openApp(k.slice(5));
    if (k === "folder:google") {
      this.screen = { kind: "home", page: 1, folder: true };
      return;
    }
    if (k.startsWith("pj.row:")) return this.go({ kind: "proj_detail", name: k.slice(7) });
    if (k.startsWith("notif:")) {
      const app = k.slice(6);
      if (app === APPS.gmail.pkg) {
        this.go({ kind: "gmail_inbox" });
        this.go({ kind: "gmail_email" });
      } else {
        const id = Object.keys(APPS).find((a) => APPS[a].pkg === app);
        this.go(id ? { kind: "app", app: id } : { kind: "app", app });
      }
      return;
    }
    switch (k) {
      case "shade_clear":
        this.notifications = [];
        return;
      case "pj.news_ok":
        this.projNews = false;
        return;
      case "pj.tip_x":
        this.projTip = false;
        return;
      case "pj.fab":
      case "pj.fab2":
        this.projName = "";
        this.go({ kind: "proj_new" });
        this.focusedKey = "pj.name";
        return;
      case "pj.name":
        this.focusedKey = k;
        return;
      case "pj.cancel":
        return this.back();
      case "pj.create": {
        const name = this.projName.trim();
        if (!name) return;
        this.projects.push(name);
        this.log(`phone: PROJECT CREATED "${name}"`);
        this.history.pop();
        this.screen = { kind: "proj_list" };
        this.projLeft = this.screen;
        this.focusedKey = null;
        this.projTip = !!this.drift.tip;
        this.snackbar("Project created");
        return;
      }
      case "row_sarah":
        return this.go({ kind: "gmail_email" });
      case "row_google":
      case "row_linkedin":
        return this.go({ kind: "app", app: "gmail" });
      case "compose":
        this.compose = { to: "", subject: "", body: "" };
        this.go({ kind: "gmail_compose" });
        this.focusedKey = "gm.to";
        return;
      case "up":
      case "sms.up":
      case "cal.close":
        return this.back();
      case "reply":
      case "reply_all":
        this.replyText = "";
        this.go({ kind: "gmail_reply" });
        this.focusedKey = "body_field";
        return;
      case "smart":
        this.replyText = "Sounds good!";
        this.go({ kind: "gmail_reply" });
        this.focusedKey = "body_field";
        return;
      case "body_field":
      case "subj":
      case "gm.to":
      case "gm.subject":
      case "gm.body":
      case "sms.field":
      case "cal.title":
        this.focusedKey = k;
        return;
      case "send": {
        if (!this.replyText.trim()) {
          this.log("phone: Send tapped with an empty body; nothing sent");
          return;
        }
        this.sent = { to: "Sarah Chen", text: this.replyText, at: Date.now() };
        this.log(`phone: EMAIL SENT to Sarah Chen: "${this.replyText}"`);
        this.history.pop();
        this.screen = { kind: "gmail_email" };
        this.snackbarUntil = Date.now() + 4000;
        return;
      }
      case "gm.send": {
        if (!this.compose.to.trim()) {
          this.composeError = "Add at least one recipient.";
          this.log("phone: Send tapped with no recipient");
          return;
        }
        this.mails.push({ ...this.compose, at: Date.now() });
        this.log(`phone: EMAIL SENT to ${this.compose.to}: "${this.compose.body}" (subject "${this.compose.subject}")`);
        this.composeError = "";
        this.compose = { to: "", subject: "", body: "" };
        this.screen = { kind: "gmail_inbox" };
        this.history = [];
        this.snackbar("Sent");
        return;
      }
      case "sms.send": {
        if (!this.sms.body.trim()) return;
        this.texts.push({ to: this.sms.number, body: this.sms.body, at: Date.now() });
        this.log(`phone: TEXT SENT to ${this.sms.number}: "${this.sms.body}"`);
        this.sms.body = "";
        return;
      }
      case "dial.call":
        this.calls.push({ number: this.dialNumber, at: Date.now() });
        this.log(`phone: CALL PLACED to ${this.dialNumber}`);
        return this.go({ kind: "in_call" });
      case "call.end":
        return this.back();
      case "cal.save":
        this.events.push({ ...this.calDraft });
        this.log(`phone: EVENT SAVED "${this.calDraft.title}"`);
        this.screen = { kind: "cal_view" };
        return;
      case "undo":
        if (this.sent) {
          this.replyText = this.sent.text;
          this.sent = null;
          this.go({ kind: "gmail_reply" });
        }
        return;
      default:
        return;
    }
  }

  private back() {
    if (this.screen.kind === "home") {
      if (this.screen.folder) this.screen = { ...this.screen, folder: false };
      return;
    }
    this.screen = this.history.pop() ?? { kind: "home", page: 0, folder: false };
    this.focusedKey = null;
    if (this.screen.kind === "proj_list" || this.screen.kind === "proj_detail") this.projLeft = this.screen;
  }

  /** Runs one `act` and returns the `act_result` body (without `re`). */
  async act(m: any): Promise<{ ok: boolean; error?: string; why?: string; app?: string }> {
    const d = this.speed;
    const hadPopup = !!this.popup;
    if (m.fast && !this.legacy) this.fastActs += 1;
    const r = this.locked ? { ok: false, error: "no_permission", why: "locked" } : await this.actInner(m, d);
    this.actsDone += 1;
    await sleep(150 * d);
    if (r.ok && this.flaky && !hadPopup && !this.popup && this.random() < this.flakyRate) {
      this.popup = "Update available";
      this.log('phone: (flaky) an "Update available" pop-up appeared');
    }
    if (r.ok && !this.legacy && (m.do === "launch" || m.do === "open")) return { ...r, app: this.currentApp() };
    return r;
  }

  private async glide(to: [number, number], fast: boolean) {
    const dist = Math.hypot(to[0] - this.lastCursor[0], to[1] - this.lastCursor[1]);
    const ms = fast ? 120 + Math.min(130, (dist / 2600) * 130) : 400 + Math.min(500, (dist / 2600) * 500);
    this.lastCursor = to;
    await sleep(ms * this.speed);
  }

  /** `open`: an intent by URI scheme or explicit action (PROTOCOL-V2.md). */
  private openIntent(m: any): { ok: boolean; error?: string; why?: string } {
    if (this.legacy) return { ok: false, error: "bad_request", why: "unknown do" };
    const uri = String(m.uri ?? "");
    const action = String(m.action ?? "");
    const ex = m.extras ?? {};
    this.opens.push(m);
    this.popup = null;
    const scheme = uri.split(":")[0].toLowerCase();
    if (scheme === "mailto") {
      const [addr, q] = uri.slice(7).split("?");
      const p = parseQuery(q ?? "");
      this.compose = { to: decodeURIComponent(addr ?? ""), subject: p.subject ?? "", body: p.body ?? "" };
      this.composeError = "";
      this.go({ kind: "gmail_compose" });
      this.focusedKey = "gm.body";
      return { ok: true };
    }
    if (scheme === "smsto" || scheme === "sms") {
      const [num, q] = uri.slice(scheme.length + 1).split("?");
      this.sms = { number: decodeURIComponent(num ?? ""), body: parseQuery(q ?? "").body ?? "" };
      this.go({ kind: "sms" });
      return { ok: true };
    }
    if (scheme === "tel") {
      if (/CALL$/.test(action)) return { ok: false, error: "no_permission", why: "CALL is never used; DIAL only" };
      this.dialNumber = decodeURIComponent(uri.slice(4));
      this.go({ kind: "dialer" });
      return { ok: true };
    }
    if (scheme === "google.navigation" || scheme === "geo") {
      const q = scheme === "geo" ? parseQuery(uri.split("?")[1] ?? "").q ?? "" : decodeURIComponent(uri.replace(/^google\.navigation:q=/, ""));
      this.navPlace = q;
      this.go({ kind: "nav" });
      return { ok: true };
    }
    if (action === "android.intent.action.SET_ALARM") {
      const h = Number(ex["android.intent.extra.alarm.HOUR"]);
      const mm = Number(ex["android.intent.extra.alarm.MINUTES"] ?? 0);
      if (!Number.isFinite(h)) return { ok: false, error: "bad_request", why: "no HOUR" };
      this.alarms.push({ h, m: mm, label: String(ex["android.intent.extra.alarm.MESSAGE"] ?? "") });
      this.log(`phone: ALARM SET ${h}:${String(mm).padStart(2, "0")}`);
      this.go({ kind: "clock" });
      return { ok: true };
    }
    if (action === "android.intent.action.SET_TIMER") {
      this.timerSec = Number(ex["android.intent.extra.alarm.LENGTH"]) || 0;
      this.go({ kind: "timer" });
      return { ok: true };
    }
    if (action === "android.intent.action.INSERT" && uri.startsWith("content://com.android.calendar/events")) {
      this.calDraft = { title: String(ex.title ?? ""), begin: Number(ex.beginTime) || Date.now() };
      this.go({ kind: "cal_edit" });
      return { ok: true };
    }
    if (action === "android.intent.action.WEB_SEARCH") {
      this.query = String(ex.query ?? "");
      this.go({ kind: "search" });
      return { ok: true };
    }
    if (action.startsWith("android.settings.") || action === "android.intent.action.POWER_USAGE_SUMMARY") {
      const page = action.replace(/^android\.(settings|intent\.action)\./, "").replace(/_SETTINGS$/, "").replace(/_/g, " ").toLowerCase();
      this.go({ kind: "settings_page", page });
      return { ok: true };
    }
    if (scheme === "http" || scheme === "https") {
      this.go({ kind: "app", app: "chrome" });
      return { ok: true };
    }
    return { ok: false, error: "not_found", why: "no app handles this intent" };
  }

  private async actInner(m: any, d: number): Promise<{ ok: boolean; error?: string; why?: string }> {
    const kind = m.do;
    const fast = !!m.fast && !this.legacy;
    if (this.flaky && ["tap", "type"].includes(kind) && this.random() < this.flakyRate * 0.8) {
      this.log(`phone: (flaky) ${kind} timed out`);
      await sleep(500 * d);
      return { ok: false, error: "timeout" };
    }
    switch (kind) {
      case "tap":
      case "long_press":
      case "point": {
        const t = this.findTarget(m.on);
        if (t === "stale") return { ok: false, error: "not_found", why: "stale" };
        if (!t) return { ok: false, error: m.on ? "not_found" : "bad_request" };
        const center: [number, number] = t === "pixel" || (typeof m.on?.x === "number" && t.key === "web") ? [m.on.x, m.on.y] : [(t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2];
        await this.glide(center, fast);
        if (kind === "point" || t === "pixel") {
          this.log(`phone: ${kind} at ${center.join(",")}${t === "pixel" ? " (nothing there)" : ` on "${label(t)}"`}`);
          return { ok: true };
        }
        this.log(`phone: ${kind} "${label(t)}"`);
        if (kind === "tap") this.tapNode(t, typeof m.on?.x === "number" ? center : undefined);
        else if (t.key.startsWith("open:") || t.key === "row_sarah") this.tapNode(t);
        this.log(`phone: now on ${this.where()}`);
        return { ok: true };
      }
      case "type": {
        if (typeof m.text !== "string") return { ok: false, error: "bad_request" };
        let key = this.focusedKey;
        if (m.on) {
          const t = this.findTarget(m.on);
          if (t === "stale") return { ok: false, error: "not_found", why: "stale" };
          if (!t || t === "pixel") return { ok: false, error: "not_found" };
          if (!t.edit) return { ok: false, error: "not_editable" };
          await this.glide([(t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2], fast);
          key = t.key;
          this.focusedKey = key;
        }
        if (!key) return { ok: false, error: "not_editable" };
        await sleep(Math.min(1500, 20 * m.text.length) * d);
        if (key === "body_field") this.replyText = m.text;
        else if (key === "gm.to") this.compose.to = m.text;
        else if (key === "gm.subject") this.compose.subject = m.text;
        else if (key === "gm.body") this.compose.body = m.text;
        else if (key === "sms.field") this.sms.body = m.text;
        else if (key === "cal.title") this.calDraft.title = m.text;
        else if (key === "pj.name") this.projName = m.text;
        this.log(`phone: typed "${m.text}"`);
        return { ok: true };
      }
      case "swipe": {
        const dir = m.dir;
        if (!["left", "right", "up", "down"].includes(dir)) return { ok: false, error: "bad_request" };
        await this.glide([W / 2, H / 2], fast);
        const s = this.screen;
        if (s.kind === "proj_list" && !this.popup) this.projScrolled = dir === "up" ? true : dir === "down" ? false : this.projScrolled;
        if (s.kind === "home" && !s.folder && !this.popup) {
          if (dir === "left" && s.page < PAGES.length - 1) this.screen = { ...s, page: s.page + 1 };
          else if (dir === "right" && s.page > 0) this.screen = { ...s, page: s.page - 1 };
          else if (dir === "down") this.screen = { kind: "shade" };
        }
        this.log(`phone: swipe ${dir}; now on ${this.where()}`);
        return { ok: true };
      }
      case "key": {
        const name = m.name;
        if (this.popup && name === "back") {
          this.popup = null;
          this.log("phone: back dismissed the pop-up");
          return { ok: true };
        }
        switch (name) {
          case "home":
            this.popup = null;
            this.history = [];
            this.screen = { kind: "home", page: 0, folder: false };
            break;
          case "back":
            this.back();
            break;
          case "recents":
            this.go({ kind: "recents" });
            break;
          case "notifications":
            this.go({ kind: "shade" });
            break;
          case "enter":
            break;
          default:
            return { ok: false, error: "bad_request" };
        }
        await sleep(100 * d);
        this.log(`phone: key ${name}; now on ${this.where()}`);
        return { ok: true };
      }
      case "launch": {
        const q = String(m.app ?? "").toLowerCase();
        const id = Object.keys(APPS).find((a) => APPS[a].label.toLowerCase() === q || APPS[a].pkg === q);
        if (!id) return { ok: false, error: "not_found" };
        this.popup = null;
        this.history = [];
        if (m.fresh && !this.legacy && id === "projects") this.projLeft = { kind: "proj_list" };
        this.openApp(id);
        await sleep((m.fresh && !this.legacy ? 600 : 250) * d);
        this.log(`phone: launched ${APPS[id].label}${m.fresh && !this.legacy ? " (fresh)" : ""}`);
        return { ok: true };
      }
      case "open": {
        const r = this.openIntent(m);
        await sleep(250 * d);
        if (r.ok) this.log(`phone: opened ${m.uri ?? m.action}; now on ${this.where()}`);
        return r;
      }
      case "wait": {
        const ms = Math.max(0, Math.min(10_000, Number(m.ms) || 0));
        await sleep(ms * d);
        return { ok: true };
      }
      default:
        return { ok: false, error: "bad_request" };
    }
  }
}

function area(b: Bounds) {
  return (b[2] - b[0]) * (b[3] - b[1]);
}

function label(p: PNode) {
  return p.text || p.desc || p.hint || p.key;
}
