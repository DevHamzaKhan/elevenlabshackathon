// Layout audit: loads the dashboard against a hub on :8765, waits, then reports text
// smaller than MIN px and elements whose text overflows their box. Also saves a screenshot.
//   node tools/audit.mjs <out.png> <waitMs> <width> <height> [minPx=14]
import puppeteer from "puppeteer-core";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [out, wait = "8000", w = "1440", h = "900", min = "14"] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  defaultViewport: { width: +w, height: +h } });
const p = await b.newPage();
await p.goto("file://" + join(here, "..", "dashboard", "index.html") + "?hub=ws://localhost:8765&token=x");
await new Promise((r) => setTimeout(r, +wait));
const report = await p.evaluate((MIN) => {
  const small = new Map(), over = [];
  const name = (e) => (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : "") || e.tagName;
  for (const e of document.querySelectorAll("body *")) {
    if (!e.offsetParent && getComputedStyle(e).position !== "fixed") continue;
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const cs = getComputedStyle(e);
    if (own && parseFloat(cs.fontSize) < MIN) {
      const k = e.tagName + name(e) + " " + cs.fontSize;
      small.set(k, (small.get(k) || 0) + 1);
    }
    if (own && cs.overflow !== "visible" || own) {
      if (e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== "ellipsis" && !["auto", "scroll"].includes(cs.overflowX))
        over.push(name(e) + " “" + e.textContent.trim().slice(0, 30) + "” " + e.scrollWidth + ">" + e.clientWidth);
      if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1)
        over.push("(truncated…) " + name(e) + " “" + e.textContent.trim().slice(0, 30) + "”");
    }
  }
  const pageOver = document.documentElement.scrollWidth > innerWidth;
  return { small: [...small].map(([k, v]) => `${k} ×${v}`), over: [...new Set(over)].slice(0, 25), pageOver };
}, +min);
await p.screenshot({ path: resolve(out) });
await b.close();
console.log(`== ${w}x${h}`);
console.log("text <" + min + "px:", report.small.length ? "\n  " + report.small.join("\n  ") : "none");
console.log("overflow:", report.over.length ? "\n  " + report.over.join("\n  ") : "none");
console.log("page scrolls sideways:", report.pageOver);
