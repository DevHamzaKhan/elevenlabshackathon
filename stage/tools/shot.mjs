// Screenshot the dashboard in real time against whatever hub is on :8765.
//   node tools/shot.mjs <out.png> [waitMs=3000] [width=1600] [height=900] [query]
import puppeteer from "puppeteer-core";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [out = "logs/shot.png", wait = "3000", w = "1600", h = "900", query = "hub=ws://localhost:8765&token=x"] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const page_url = "file://" + join(here, "..", "dashboard", "index.html") + "?" + query;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  defaultViewport: { width: Number(w), height: Number(h) },
});
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(page_url);
await new Promise((r) => setTimeout(r, Number(wait)));
await page.screenshot({ path: resolve(out) });
await browser.close();
console.log("wrote", out);
