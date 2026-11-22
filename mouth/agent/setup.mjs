#!/usr/bin/env node
// Creates or updates the Bobby agent in ElevenLabs from agent/bobby-prompt.md, and writes
// ELEVENLABS_BOBBY_AGENT_ID into the root .env and mouth/example/.env. Safe to run again.
//
//   node agent/setup.mjs            # apply
//   node agent/setup.mjs --dry-run  # print the request body, call nothing
//
// Reads ELEVENLABS_API_KEY from the root .env. The Mouth itself never needs the key:
// the agent is public (connect by agent id alone).
// Voice mode: tries Realtime (MOUTH_REALTIME_MODEL, default eleven_realtime_v1_mini). If the
// workspace doesn't have Realtime yet, the agent stays in the standard voice mode; running this
// again later switches it, with no code change.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mouthDir = join(here, "..");
const rootEnvPath = join(mouthDir, "..", ".env");
const exampleEnvPath = join(mouthDir, "example", ".env");
const API = "https://api.elevenlabs.io";
const AGENT_NAME = "Bobby";
const dryRun = process.argv.includes("--dry-run");

export function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Set KEY=value in an env file, replacing an existing line or appending one. */
export function setEnvLine(path, key, value) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(path, next);
}

export function agentBody(prompt) {
  return {
    name: AGENT_NAME,
    tags: ["bobby"],
    conversation_config: {
      agent: {
        // Empty: Bobby waits; the Mind decides what he says first (whisper/say).
        first_message: "",
        language: "en",
        prompt: { prompt },
      },
      conversation: {
        client_events: [
          "audio", "interruption", "user_transcript", "agent_response",
          "agent_response_correction", "conversation_initiation_metadata", "ping",
        ],
      },
    },
    platform_settings: { auth: { enable_auth: false } },
  };
}

async function call(key, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json;
}

async function main() {
  const env = existsSync(rootEnvPath) ? parseEnv(readFileSync(rootEnvPath, "utf8")) : {};
  const prompt = readFileSync(join(here, "bobby-prompt.md"), "utf8").trim();
  const body = agentBody(prompt);
  const realtime = env.MOUTH_REALTIME_MODEL || "eleven_realtime_v1_mini";

  if (dryRun) {
    console.log(JSON.stringify(body, null, 2));
    console.log(`then PATCH conversation_config.realtime_model = ${realtime}`);
    return;
  }
  const key = env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error(`No ELEVENLABS_API_KEY in ${rootEnvPath}. Copy env/mouth.env to .env at the repo root and fill it in.`);
    process.exit(2);
  }

  // 1. Find the agent: the saved id, else one named "Bobby", else create it.
  let id = env.ELEVENLABS_BOBBY_AGENT_ID || "";
  if (!id) {
    const list = await call(key, "GET", `/v1/convai/agents?search=${encodeURIComponent(AGENT_NAME)}&page_size=100`);
    id = (list.agents || []).find((a) => a.name === AGENT_NAME && !a.archived)?.agent_id || "";
  }
  if (id) {
    await call(key, "PATCH", `/v1/convai/agents/${id}`, body);
    console.log(`updated agent ${AGENT_NAME} (${id})`);
  } else {
    id = (await call(key, "POST", "/v1/convai/agents/create", body)).agent_id;
    console.log(`created agent ${AGENT_NAME} (${id})`);
  }

  // 2. Realtime voice mode, if this workspace has it.
  let mode = "standard";
  try {
    await call(key, "PATCH", `/v1/convai/agents/${id}`, { conversation_config: { realtime_model: realtime } });
    mode = `realtime (${realtime})`;
  } catch (e) {
    console.log(`Realtime not set (${e.message.slice(0, 160)}). Staying on the standard voice mode; re-run later to switch.`);
  }
  console.log(`voice mode: ${mode}`);

  // 3. Save the id where the test app and laptop scripts find it.
  setEnvLine(rootEnvPath, "ELEVENLABS_BOBBY_AGENT_ID", id);
  setEnvLine(exampleEnvPath, "EXPO_PUBLIC_ELEVENLABS_BOBBY_AGENT_ID", id);
  if (!existsSync(exampleEnvPath) || !/EXPO_PUBLIC_HUB_URL=/.test(readFileSync(exampleEnvPath, "utf8"))) {
    setEnvLine(exampleEnvPath, "EXPO_PUBLIC_HUB_URL", "ws://10.0.2.2:8765");
  }
  console.log(`wrote ELEVENLABS_BOBBY_AGENT_ID to .env and mouth/example/.env`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
