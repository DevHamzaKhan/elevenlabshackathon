#!/usr/bin/env node
// Runs the Caller on the laptop against a hub (normally the pretend hub), reading the root .env.
//
//   node tools/caller.mjs [--hub ws://localhost:8765] [--dry-run]
//
// Settings in the shell environment override the root .env (handy for check.sh):
//   CALLER_DRY_RUN=1 CALL_ALLOWLIST=+15555550100 node tools/caller.mjs --hub ws://localhost:8797
// CALLER_DRY_RUN defaults to 1. Only CALLER_DRY_RUN=0 (and no --dry-run) places a real call.
import { tsImport } from "tsx/esm/api";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// caller.ts, not index.ts: index.ts also loads the React Native voice layer, which Node can't run.
const { startCallerWith } = await tsImport("../src/caller.ts", import.meta.url);
const { parseEnv } = await import("../agent/setup.mjs");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const KEYS = ["ELEVENLABS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "OWNER_NUMBER", "CALL_ALLOWLIST",
  "CALLER_DRY_RUN", "ELEVENLABS_CALLER_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID", "HUB_TOKEN"];

const rootEnv = join(here, "..", "..", ".env");
const fileEnv = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, "utf8")) : {};
const env = {};
for (const k of KEYS) env[k] = process.env[k] ?? fileEnv[k];
if (args.includes("--dry-run")) env.CALLER_DRY_RUN = "1";
env.CALLER_DRY_RUN ??= "1";

const hubUrl = opt("hub", `ws://localhost:${process.env.MOUTH_HUB_PORT || 8765}`);
const token = env.HUB_TOKEN || "dev";
const log = (l) => console.log(`${new Date().toISOString().slice(11, 23)} ${l}`);
log(`caller -> ${hubUrl} (${env.CALLER_DRY_RUN === "0" ? "REAL CALLS" : "dry run"}; allowlist: ${env.CALL_ALLOWLIST || "empty"})`);
const caller = startCallerWith({ hubUrl, token, env, log }); // same as startCaller(config)
const quit = () => { caller.stop(); process.exit(0); };
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
