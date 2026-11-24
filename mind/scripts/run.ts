// Laptop runner: starts the Mind against a hub (the fake one by default) with the root .env and hints.
// Run: npm run mind [-- --hub ws://localhost:8765]

import { startMind } from "../src/index";
import { loadEnv, loadHints, openLog, redact } from "./env";

const i = process.argv.indexOf("--hub");
const hubUrl = i > 0 ? process.argv[i + 1] : "ws://localhost:8765";
const env = loadEnv();
const hints = loadHints(env.HINTS_DIR);
const { file, log } = openLog("mind", (l) => !l.startsWith("model>"));
console.log(`mind: log file ${file}`);
console.log(`mind: key ${redact(env.OPENAI_API_KEY)}, ${hints.length} hint files, hub ${hubUrl}`);

const mind = startMind({ hubUrl, token: env.HUB_TOKEN ?? "dev", env, hints, log });
process.on("SIGINT", () => {
  mind.stop();
  process.exit(0);
});
