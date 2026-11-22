// Renders the icon SVGs in stage/icon/ to 1024 x 1024 PNGs with the installed Chrome.
//   node tools/icon.mjs
import puppeteer from "puppeteer-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const jobs = [
  ["bobby-icon.svg", "bobby-icon-1024.png"],
  ["bobby-adaptive-foreground.svg", "bobby-adaptive-foreground-1024.png"],
];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  defaultViewport: { width: 1024, height: 1024 },
});
const page = await browser.newPage();
for (const [src, dst] of jobs) {
  const out = join(here, "..", "icon", dst);
  await page.goto("file://" + join(here, "..", "icon", src));
  await page.screenshot({ path: out, omitBackground: true });
  console.log("wrote", out);
}
await browser.close();
