// The pretend phone: three home screens, a "Google" folder on page 2, Gmail on page 3,
// a Gmail inbox with Sarah Chen's email, the open email, a reply box and a sent state.
// It answers `screen` and `act` exactly as CONTRACT.md "Hands" describes.

type Bounds = [number, number, number, number];

type PNode = {
  key: string; // internal id for the action handler; never sent
  text?: string;
  desc?: string;
  /** Like real Hands: an empty field's placeholder, sent as an extra `hint` field. */
  hint?: string;
  cls: string;
  bounds: Bounds;
  tap?: boolean;
  edit?: boolean;
  scroll?: boolean;
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
};

// Page contents. "folder:google" is the Google folder.
const PAGES: string[][] = [
  ["clock", "camera", "settings", "contacts"],
  ["maps", "spotify", "calendar", "photos", "folder:google"],
  ["whatsapp", "gmail", "calculator"],
];
const FOLDER_GOOGLE = ["google", "drive", "youtube", "meet", "keep"];
const DOCK = ["phone", "messages", "chrome"];
const LAUNCHER_PKG = "com.google.android.apps.nexuslauncher";

type Screen =
  | { kind: "home"; page: number; folder: boolean }
  | { kind: "shade" }
  | { kind: "recents" }
  | { kind: "gmail_inbox" }
  | { kind: "gmail_email" }
  | { kind: "gmail_reply" }
  | { kind: "app"; app: string };

export type PhoneNotification = { app: string; title: string; text: string; at: number };

export type PhoneOptions = {
  log?: (s: string) => void;
  /** Multiplies every delay; 0 makes acts answer almost at once (tests). */
  speed?: number;
  /** Sometimes fail an action or show a pop-up, to test recovery. A number sets the chance per action. */
  flaky?: boolean | number;
  /** Random source, replaceable for deterministic tests. */
  random?: () => number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gridBounds(i: number): Bounds {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const x = 60 + col * 250;
  const y = 500 + row * 320;
  return [x, y, x + 210, y + 260];
}

export class Phone {
  screen: Screen = { kind: "home", page: 0, folder: false };
  private history: Screen[] = [];
  private lastNodes: PNode[] = [];
  private focusedKey: string | null = null;
  replyText = "";
  sent: { to: string; text: string; at: number } | null = null;
  private snackbarUntil = 0;
  popup: string | null = null;
  notifications: PhoneNotification[] = [];
  on = true;
  log: (s: string) => void;
  speed: number;
  flaky: boolean;
  flakyRate: number;
  random: () => number;
  lastCursor: [number, number] = [W / 2, H / 2];
  actsDone = 0;

  constructor(opts: PhoneOptions = {}) {
    this.log = opts.log ?? ((s) => console.log(s));
    this.speed = opts.speed ?? 1;
    this.flaky = !!opts.flaky;
    this.flakyRate = typeof opts.flaky === "number" ? opts.flaky : 0.12;
    this.random = opts.random ?? Math.random;
  }

  reset() {
    this.screen = { kind: "home", page: 0, folder: false };
    this.history = [];
    this.replyText = "";
    this.sent = null;
    this.popup = null;
    this.focusedKey = null;
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
        return APPS.gmail.pkg;
      case "app":
        return APPS[s.app]?.pkg ?? s.app;
    }
  }

  /** A short human description, for logs. */
  where(): string {
    const s = this.screen;
    if (this.popup) return `pop-up "${this.popup}"`;
    if (s.kind === "home") return `home page ${s.page + 1}${s.folder ? " with Google folder open" : ""}`;
    if (s.kind === "app") return `${APPS[s.app]?.label ?? s.app} app`;
    return s.kind.replace("_", " ");
  }

  private nodes(): PNode[] {
    const s = this.screen;
    const out: PNode[] = [];
    const now = Date.now();
    const statusBar = () =>
      out.push({ key: "clock", text: "10:45", cls: "TextView", bounds: [40, 10, 160, 70] });

    if (this.popup) {
      out.push(
        { key: "popup_title", text: this.popup, cls: "TextView", bounds: [120, 1000, 960, 1080] },
        {
          key: "popup_body",
          text: "A new version is ready to install.",
          cls: "TextView",
          bounds: [120, 1100, 960, 1180],
        },
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
            out.push({
              key: `open:${a}`,
              text: APPS[a].label,
              desc: APPS[a].label,
              cls: "TextView",
              bounds: [b[0] + 40, b[1] + 400, b[2] + 40, b[3] + 400],
              tap: true,
            });
          });
          break;
        }
        if (s.page === 0) {
          out.push({
            key: "search_widget",
            desc: "Google Search",
            text: "Search",
            cls: "TextView",
            bounds: [60, 260, 1020, 380],
            tap: true,
          });
        }
        PAGES[s.page].forEach((a, i) => {
          const b = gridBounds(i);
          if (a === "folder:google") {
            out.push({
              key: "folder:google",
              text: "Google",
              desc: "Folder: Google, 5 apps",
              cls: "FolderIcon",
              bounds: b,
              tap: true,
            });
          } else {
            out.push({ key: `open:${a}`, text: APPS[a].label, desc: APPS[a].label, cls: "TextView", bounds: b, tap: true });
          }
        });
        out.push({
          key: "pager",
          desc: `Page ${s.page + 1} of ${PAGES.length}`,
          cls: "PageIndicator",
          bounds: [440, 1880, 640, 1920],
          scroll: true,
        });
        DOCK.forEach((a, i) => {
          const x = 120 + i * 300;
          out.push({ key: `open:${a}`, text: APPS[a].label, desc: APPS[a].label, cls: "TextView", bounds: [x, 2050, x + 200, 2250], tap: true });
        });
        break;
      }
      case "shade": {
        statusBar();
        out.push({ key: "shade_title", text: "Notifications", cls: "TextView", bounds: [40, 200, 600, 280] });
        if (this.notifications.length === 0) {
          out.push({ key: "shade_empty", text: "No notifications", cls: "TextView", bounds: [40, 320, 1040, 400] });
        }
        this.notifications.slice(-5).reverse().forEach((n, i) => {
          const y = 320 + i * 200;
          out.push({
            key: `notif:${n.app}`,
            text: `${n.title}: ${n.text}`,
            desc: `${n.title}, ${n.text}`,
            cls: "FrameLayout",
            bounds: [40, y, 1040, y + 180],
            tap: true,
          });
        });
        out.push({ key: "shade_clear", text: "Clear all", cls: "Button", bounds: [800, 2200, 1040, 2280], tap: true });
        break;
      }
      case "recents": {
        out.push({ key: "recents_empty", text: "No recent items", cls: "TextView", bounds: [300, 1100, 780, 1200] });
        break;
      }
      case "gmail_inbox": {
        statusBar();
        out.push(
          { key: "drawer", desc: "Open navigation drawer", cls: "ImageButton", bounds: [40, 120, 140, 220], tap: true },
          { key: "search", hint: "Search in mail", cls: "EditText", bounds: [160, 120, 900, 220], tap: true, edit: true },
          { key: "avatar", desc: "Signed in as owner@example.com Account and settings", cls: "ImageView", bounds: [920, 120, 1040, 220], tap: true },
          { key: "primary", text: "Primary", cls: "TextView", bounds: [40, 260, 400, 320] },
          {
            key: "row_sarah",
            desc: `Sarah Chen, Meeting today, Running late, can we push to 3?, 10:42 AM${this.sent ? "" : ", Unread"}`,
            cls: "LinearLayout",
            bounds: [0, 340, 1080, 540],
            tap: true,
          },
          { key: "row_google", desc: "Google, Security alert, A new sign-in on Android, 9:15 AM", cls: "LinearLayout", bounds: [0, 540, 1080, 740], tap: true },
          { key: "row_linkedin", desc: "LinkedIn, You appeared in 5 searches this week, Yesterday", cls: "LinearLayout", bounds: [0, 740, 1080, 940], tap: true },
          { key: "compose", text: "Compose", cls: "Button", bounds: [700, 2100, 1040, 2240], tap: true },
          { key: "list", cls: "RecyclerView", bounds: [0, 340, 1080, 2000], scroll: true },
        );
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
        if (this.sent) {
          out.push({ key: "sent_msg", text: `Me: ${this.sent.text}`, cls: "TextView", bounds: [40, 800, 1040, 960] });
        } else {
          out.push({ key: "smart", text: "Sounds good!", cls: "Button", bounds: [40, 1900, 400, 1980], tap: true });
        }
        out.push(
          { key: "reply", text: "Reply", cls: "Button", bounds: [40, 2100, 340, 2220], tap: true },
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
          { key: "send", desc: "Send", cls: "ImageButton", bounds: [860, 120, 960, 220], tap: true },
          { key: "to", text: "To", cls: "TextView", bounds: [40, 260, 140, 340] },
          { key: "to_chip", text: "Sarah Chen", cls: "TextView", bounds: [160, 260, 500, 340] },
          { key: "subj", text: "Re: Meeting today", cls: "EditText", bounds: [40, 380, 1040, 460], edit: true },
          {
            key: "body_field",
            text: this.replyText || "",
            hint: this.replyText ? "" : "Compose email",
            cls: "EditText",
            bounds: [40, 500, 1040, 900],
            edit: true,
          },
          { key: "kb", desc: "Keyboard", cls: "KeyboardView", bounds: [0, 1500, 1080, 2400] },
        );
        break;
      }
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

  /** CONTRACT.md `screen_result` body. */
  read() {
    const nodes = this.nodes();
    this.lastNodes = nodes;
    return {
      app: this.currentApp(),
      size: [W, H],
      nodes: nodes.map((p, n) => {
        const o: any = { n, text: p.text ?? "", desc: p.desc ?? "", cls: p.cls, bounds: p.bounds };
        if (p.hint) o.hint = p.hint;
        o.tap = !!p.tap;
        o.edit = !!p.edit;
        o.scroll = !!p.scroll;
        return o;
      }),
    };
  }

  private findTarget(on: any): PNode | null | "pixel" {
    if (!on || typeof on !== "object") return null;
    const current = this.nodes();
    if (typeof on.n === "number") {
      const want = this.lastNodes[on.n];
      if (!want) return null;
      return current.find((c) => c.key === want.key) ?? null;
    }
    if (typeof on.text === "string") {
      const q = on.text.trim().toLowerCase();
      if (!q) return null;
      const label = (c: PNode) => [c.text ?? "", c.desc ?? "", c.hint ?? ""].map((s) => s.toLowerCase());
      const exact = current.find((c) => label(c).some((s) => s === q));
      if (exact) return exact;
      return current.find((c) => label(c).some((s) => s.includes(q))) ?? null;
    }
    if (typeof on.x === "number" && typeof on.y === "number") {
      const hits = current.filter(
        (c) => on.x >= c.bounds[0] && on.x <= c.bounds[2] && on.y >= c.bounds[1] && on.y <= c.bounds[3],
      );
      if (hits.length === 0) return "pixel";
      // The smallest box under the finger wins.
      hits.sort((a, b) => area(a.bounds) - area(b.bounds));
      return hits[0];
    }
    return null;
  }

  private go(next: Screen) {
    this.history.push(this.screen);
    this.screen = next;
    this.focusedKey = null;
  }

  private openApp(id: string) {
    if (id === "gmail") return this.go({ kind: "gmail_inbox" });
    this.go({ kind: "app", app: id });
  }

  private tapNode(node: PNode): string | null {
    const k = node.key;
    if (this.popup) {
      if (k === "popup_dismiss" || k === "popup_accept") {
        this.popup = null;
        return null;
      }
      return null;
    }
    if (!node.tap && !node.edit) return null; // tapping plain text does nothing
    if (k.startsWith("open:")) {
      this.openApp(k.slice(5));
      return null;
    }
    if (k === "folder:google") {
      this.screen = { kind: "home", page: 1, folder: true };
      return null;
    }
    if (k.startsWith("notif:")) {
      const app = k.slice(6);
      if (app === APPS.gmail.pkg) {
        this.go({ kind: "gmail_inbox" });
        this.go({ kind: "gmail_email" });
      } else {
        const id = Object.keys(APPS).find((a) => APPS[a].pkg === app);
        this.go(id ? { kind: "app", app: id } : { kind: "app", app });
      }
      return null;
    }
    if (k === "shade_clear") {
      this.notifications = [];
      return null;
    }
    switch (k) {
      case "row_sarah":
        this.go({ kind: "gmail_email" });
        return null;
      case "row_google":
      case "row_linkedin":
        this.go({ kind: "app", app: "gmail" });
        return null;
      case "up":
        this.back();
        return null;
      case "reply":
      case "reply_all":
        this.replyText = "";
        this.go({ kind: "gmail_reply" });
        this.focusedKey = "body_field";
        return null;
      case "smart":
        this.replyText = "Sounds good!";
        this.go({ kind: "gmail_reply" });
        this.focusedKey = "body_field";
        return null;
      case "body_field":
      case "subj":
        this.focusedKey = k;
        return null;
      case "send": {
        if (!this.replyText.trim()) {
          this.log("phone: Send tapped with an empty body; nothing sent");
          return null;
        }
        this.sent = { to: "Sarah Chen", text: this.replyText, at: Date.now() };
        this.log(`phone: EMAIL SENT to Sarah Chen: "${this.replyText}"`);
        // Back to the email, with the "Sent" snackbar.
        this.history.pop();
        this.screen = { kind: "gmail_email" };
        this.snackbarUntil = Date.now() + 4000;
        return null;
      }
      case "undo":
        if (this.sent) {
          this.log("phone: Undo tapped, the email went back to drafts");
          this.replyText = this.sent.text;
          this.sent = null;
          this.go({ kind: "gmail_reply" });
        }
        return null;
      default:
        return null;
    }
  }

  private back() {
    if (this.screen.kind === "home") {
      if (this.screen.folder) this.screen = { ...this.screen, folder: false };
      return;
    }
    this.screen = this.history.pop() ?? { kind: "home", page: 0, folder: false };
    this.focusedKey = null;
  }

  /** Runs one `act` and returns the `act_result` body (without `re`). */
  async act(m: any): Promise<{ ok: boolean; error?: string }> {
    const d = this.speed;
    const hadPopup = !!this.popup;
    const r = await this.actInner(m, d);
    this.actsDone += 1;
    // Settle time.
    await sleep(300 * d);
    // A pop-up never reappears straight after one was dismissed.
    if (r.ok && this.flaky && !hadPopup && !this.popup && this.random() < this.flakyRate) {
      this.popup = "Update available";
      this.log("phone: (flaky) an \"Update available\" pop-up appeared");
    }
    return r;
  }

  private async glide(to: [number, number]) {
    const dist = Math.hypot(to[0] - this.lastCursor[0], to[1] - this.lastCursor[1]);
    const ms = 400 + Math.min(500, (dist / 2600) * 500);
    this.lastCursor = to;
    await sleep(ms * this.speed);
  }

  private async actInner(m: any, d: number): Promise<{ ok: boolean; error?: string }> {
    const kind = m.do;
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
        if (!t) return { ok: false, error: m.on ? "not_found" : "bad_request" };
        const center: [number, number] =
          t === "pixel" ? [m.on.x, m.on.y] : [(t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2];
        await this.glide(center);
        if (kind === "point" || t === "pixel") {
          this.log(`phone: ${kind} at ${center.join(",")}${t === "pixel" ? " (nothing there)" : ` on "${label(t)}"`}`);
          return { ok: true };
        }
        this.log(`phone: ${kind} "${label(t)}"`);
        if (kind === "tap") this.tapNode(t);
        else if (t.key.startsWith("open:") || t.key === "row_sarah") this.tapNode(t);
        this.log(`phone: now on ${this.where()}`);
        return { ok: true };
      }
      case "type": {
        if (typeof m.text !== "string") return { ok: false, error: "bad_request" };
        let key = this.focusedKey;
        if (m.on) {
          const t = this.findTarget(m.on);
          if (!t || t === "pixel") return { ok: false, error: "not_found" };
          if (!t.edit) return { ok: false, error: "not_editable" };
          await this.glide([(t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2]);
          key = t.key;
          this.focusedKey = key;
        }
        if (!key) return { ok: false, error: "not_editable" };
        await sleep(Math.min(1500, 20 * m.text.length) * d);
        if (key === "body_field") this.replyText = m.text;
        this.log(`phone: typed "${m.text}"`);
        return { ok: true };
      }
      case "swipe": {
        const dir = m.dir;
        if (!["left", "right", "up", "down"].includes(dir)) return { ok: false, error: "bad_request" };
        await this.glide([W / 2, H / 2]);
        const s = this.screen;
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
        await sleep(150 * d);
        this.log(`phone: key ${name}; now on ${this.where()}`);
        return { ok: true };
      }
      case "launch": {
        const q = String(m.app ?? "").toLowerCase();
        const id = Object.keys(APPS).find((a) => APPS[a].label.toLowerCase() === q || APPS[a].pkg === q);
        if (!id) return { ok: false, error: "not_found" };
        this.popup = null;
        this.openApp(id);
        await sleep(400 * d);
        this.log(`phone: launched ${APPS[id].label}`);
        return { ok: true };
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
