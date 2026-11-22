#!/usr/bin/env node
// Configures ElevenLabs (and reads Twilio) for the Mouth and the Caller. Safe to run again:
// every step finds what an earlier run made and updates it instead of making another.
//
//   node agent/setup.mjs            # apply
//   node agent/setup.mjs --dry-run  # run every step against a fake API that prints each request
//
// Steps:
//   1. The Bobby agent from agent/bobby-prompt.md, public (connect by agent id alone, so the Mouth
//      never needs the key), in Realtime voice mode if the workspace has it (MOUTH_REALTIME_MODEL,
//      default eleven_realtime_v1_mini), else the standard mode; re-running later switches it.
//   2. The owner's voice clone from the sample in mouth/private/ (until there is one, the caller
//      agent uses a ready-made voice, MOUTH_CALLER_FALLBACK_VOICE_ID).
//   3. The caller agent from agent/caller-prompt.md, in that voice, with {{goal}} and {{context}}
//      filled in per call, an end_call tool, and a `their_answer` data collection item that the
//      Caller uses as its summary.
//   4. The bought Twilio number imported into ElevenLabs (MOUTH_TWILIO_NUMBER picks one if the
//      account has several), and a check that OWNER_NUMBER is a verified caller ID in Twilio.
//   5. ELEVENLABS_BOBBY_AGENT_ID, ELEVENLABS_CALLER_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID into the
//      root .env, and what the test app needs into mouth/example/.env.
// Steps 2-4 are skipped with a note when their keys are missing; step 1 still runs.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mouthDir = join(here, "..");
const rootEnvPath = join(mouthDir, "..", ".env");
const exampleEnvPath = join(mouthDir, "example", ".env");
const privateDir = join(mouthDir, "private");
export const API = "https://api.elevenlabs.io";
export const TWILIO_API = "https://api.twilio.com/2010-04-01";
export const AGENT_NAME = "Bobby";
export const CALLER_AGENT_NAME = "Bobby caller";
export const VOICE_NAME = "Bobby owner voice";
export const PHONE_LABEL = "Bobby caller";
// A ready-made ElevenLabs voice ("George"), used until the owner's sample is in mouth/private/.
export const DEFAULT_FALLBACK_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const CALLER_FIRST_MESSAGE = "Hi, it's me. Have you got a quick second?";
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|flac|webm|mp4)$/i;

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
      // -1: Bobby never speaks up on his own after a silence ("Are you still there?"). The user
      // is often silent for long stretches while the Mind narrates a task or a call runs.
      turn: { turn_timeout: -1 },
    },
    platform_settings: { auth: { enable_auth: false } },
  };
}

export function callerAgentBody(prompt, voiceId, ttsModel) {
  return {
    name: CALLER_AGENT_NAME,
    tags: ["bobby"],
    conversation_config: {
      agent: {
        first_message: CALLER_FIRST_MESSAGE,
        language: "en",
        // Filled per call by the Caller (conversation_initiation_client_data.dynamic_variables).
        dynamic_variables: { dynamic_variable_placeholders: { goal: "Say hello and ask how they are.", context: "A friend who expects the call." } },
        prompt: {
          prompt,
          built_in_tools: {
            end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } },
          },
        },
      },
      tts: { voice_id: voiceId, ...(ttsModel ? { model_id: ttsModel } : {}) },
    },
    platform_settings: {
      data_collection: {
        their_answer: {
          type: "string",
          description: "In one or two short sentences, what the other person said in answer to the goal of the call, written in the third person, naming them if you know their name and otherwise saying \"they\", never \"the user\" (for example: \"Alex said 3pm works.\"). If they gave no answer, say so.",
        },
      },
    },
  };
}

/** The voice sample in mouth/private/: the largest audio file there, or null. */
export function findSample(dir = privateDir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && AUDIO.test(f.name));
  if (!files.length) return null;
  const size = (f) => readFileSync(join(dir, f.name)).length;
  return join(dir, files.sort((a, b) => size(b) - size(a))[0].name);
}

/** Small API client over an injectable fetch. Never logs headers (they carry the keys). */
export function clients(env, doFetch = fetch) {
  async function req(base, method, path, { json, form, multipart, headers = {} } = {}) {
    let body;
    if (json !== undefined) { body = JSON.stringify(json); headers["Content-Type"] = "application/json"; }
    if (form) {
      body = Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (multipart) body = multipart;
    const res = await doFetch(`${base}${path}`, { method, headers, body });
    const text = await res.text();
    let out;
    try { out = JSON.parse(text); } catch { out = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = out;
      throw err;
    }
    return out;
  }
  const el = (method, path, opts = {}) =>
    req(API, method, path, { ...opts, headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "" } });
  const tw = (method, path, opts = {}) =>
    req(TWILIO_API, method, `/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, {
      ...opts, headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` },
    });
  return { el, tw };
}

async function findAgent(el, savedId, name) {
  if (savedId) {
    try { await el("GET", `/v1/convai/agents/${savedId}`); return savedId; } catch (e) { if (e.status !== 404) throw e; }
  }
  const list = await el("GET", `/v1/convai/agents?search=${encodeURIComponent(name)}&page_size=100`);
  return (list.agents || []).find((a) => a.name === name && !a.archived)?.agent_id || "";
}

async function upsertAgent(el, savedId, body, log) {
  let id = await findAgent(el, savedId, body.name);
  if (id) {
    await el("PATCH", `/v1/convai/agents/${id}`, { json: body });
    log(`updated agent ${body.name} (${id})`);
  } else {
    id = (await el("POST", "/v1/convai/agents/create", { json: body })).agent_id;
    log(`created agent ${body.name} (${id})`);
  }
  return id;
}

/** Step 1. */
export async function setupBobby({ el, env, prompt, log }) {
  const id = await upsertAgent(el, env.ELEVENLABS_BOBBY_AGENT_ID, agentBody(prompt), log);
  const realtime = env.MOUTH_REALTIME_MODEL || "eleven_realtime_v1_mini";
  let mode = "standard";
  try {
    await el("PATCH", `/v1/convai/agents/${id}`, { json: { conversation_config: { realtime_model: realtime } } });
    mode = `realtime (${realtime})`;
  } catch (e) {
    log(`Realtime not set (${e.message.slice(0, 160)}). Staying on the standard voice mode; re-run later to switch.`);
  }
  log(`voice mode: ${mode}`);
  return id;
}

/** Step 2. Returns {voiceId, cloned}. Reuses an earlier clone unless --reclone. */
export async function setupVoice({ el, env, sample, reclone, readFile = readFileSync, log, todo }) {
  const fallback = env.MOUTH_CALLER_FALLBACK_VOICE_ID || DEFAULT_FALLBACK_VOICE_ID;
  if (!sample) {
    log(`no voice sample in mouth/private/: the caller agent uses the ready-made voice ${fallback}`);
    todo.push("Put 1-2 minutes of the owner talking in mouth/private/ (any common audio format), then run `node mouth/agent/setup.mjs` again: it clones the voice and switches the caller agent to it.");
    return { voiceId: fallback, cloned: false };
  }
  const found = await el("GET", `/v2/voices?search=${encodeURIComponent(VOICE_NAME)}&page_size=100`);
  const existing = (found.voices || []).find((v) => v.name === VOICE_NAME);
  if (existing && !reclone) {
    log(`voice clone ${VOICE_NAME} already exists (${existing.voice_id}); --reclone makes it again`);
    return { voiceId: existing.voice_id, cloned: true };
  }
  if (existing) await el("DELETE", `/v1/voices/${existing.voice_id}`);
  const fd = new FormData();
  fd.append("name", VOICE_NAME);
  fd.append("description", "The phone owner's voice, for Bobby's calls.");
  fd.append("remove_background_noise", "false");
  fd.append("files", new Blob([readFile(sample)]), basename(sample));
  const made = await el("POST", "/v1/voices/add", { multipart: fd });
  log(`cloned ${VOICE_NAME} from ${basename(sample)} (${made.voice_id})`);
  if (made.requires_verification) {
    todo.push(`ElevenLabs wants the voice clone "${VOICE_NAME}" verified: elevenlabs.io > Voices > My voices > ${VOICE_NAME} > Verify, then read the sentence it shows.`);
  }
  return { voiceId: made.voice_id, cloned: true };
}

/** Step 3. */
export async function setupCallerAgent({ el, env, prompt, voiceId, log }) {
  return upsertAgent(el, env.ELEVENLABS_CALLER_AGENT_ID, callerAgentBody(prompt, voiceId, env.MOUTH_CALLER_TTS_MODEL), log);
}

/** Step 4. Returns the ElevenLabs phone_number_id of the imported Twilio number, or "". */
export async function setupPhone({ el, tw, env, log, todo }) {
  const owned = (await tw("GET", "/IncomingPhoneNumbers.json?PageSize=50")).incoming_phone_numbers || [];
  const want = env.MOUTH_TWILIO_NUMBER || "";
  const pick = want ? owned.find((n) => n.phone_number === want) : owned[0];
  if (!pick) {
    todo.push(want
      ? `MOUTH_TWILIO_NUMBER (${want}) isn't a number on this Twilio account. Fix it or remove the line.`
      : "Buy one phone number in Twilio (Console > Phone Numbers > Buy a number, with Voice), then run setup.mjs again.");
    return "";
  }
  if (!want && owned.length > 1) log(`the Twilio account has ${owned.length} numbers; using ${pick.phone_number} (set MOUTH_TWILIO_NUMBER to choose)`);
  const imported = await el("GET", "/v1/convai/phone-numbers");
  const list = Array.isArray(imported) ? imported : imported.phone_numbers || [];
  let id = list.find((n) => n.phone_number === pick.phone_number)?.phone_number_id || "";
  if (id) {
    log(`Twilio number ${pick.phone_number} already imported (${id})`);
  } else {
    id = (await el("POST", "/v1/convai/phone-numbers", {
      json: { provider: "twilio", phone_number: pick.phone_number, label: PHONE_LABEL, sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN },
    })).phone_number_id;
    log(`imported Twilio number ${pick.phone_number} into ElevenLabs (${id})`);
  }

  if (env.OWNER_NUMBER) {
    const ids = await tw("GET", `/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(env.OWNER_NUMBER)}`);
    const ownsIt = owned.some((n) => n.phone_number === env.OWNER_NUMBER);
    if ((ids.outgoing_caller_ids || []).length || ownsIt) log("OWNER_NUMBER is a verified caller ID in Twilio");
    else todo.push("Verify OWNER_NUMBER as a caller ID in Twilio: Console > Phone Numbers > Manage > Verified Caller IDs > Add a new Caller ID, then answer the code call on the owner's phone. Until then calls come from the bought number.");
  } else {
    todo.push("Set OWNER_NUMBER in the root .env (the owner's mobile, verified in Twilio as a caller ID). Until then calls come from the bought number.");
  }
  return id;
}

/** Runs every step it has keys for. Returns the ids to save and the human's to-do list. */
export async function runSetup({ env, doFetch = fetch, sample = findSample(), reclone = false, log = console.log, readFile = readFileSync }) {
  const { el, tw } = clients(env, doFetch);
  const todo = [];
  const ids = {};
  ids.ELEVENLABS_BOBBY_AGENT_ID = await setupBobby({ el, env, prompt: readFileSync(join(here, "bobby-prompt.md"), "utf8").trim(), log });

  const { voiceId } = await setupVoice({ el, env, sample, reclone, readFile, log, todo });
  const callerPrompt = readFileSync(join(here, "caller-prompt.md"), "utf8").trim();
  ids.ELEVENLABS_CALLER_AGENT_ID = await setupCallerAgent({ el, env, prompt: callerPrompt, voiceId, log });

  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    const phoneId = await setupPhone({ el, tw, env, log, todo });
    if (phoneId) ids.ELEVENLABS_PHONE_NUMBER_ID = phoneId;
  } else {
    todo.push("Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to the root .env (Twilio Console home page > Account Info), then run setup.mjs again to import the number.");
  }
  return { ids, todo };
}

/** For --dry-run: a fetch that prints each request (never headers or keys) and answers like an empty account. */
export function dryRunFetch(print = console.log) {
  return async (url, init = {}) => {
    const method = init.method || "GET";
    const path = url.replace(API, "").replace(TWILIO_API, "twilio:").replace(/Accounts\/[^/]+/, "Accounts/<sid>");
    let shown = "";
    if (typeof init.body === "string") shown = init.body.replace(/(token|sid)("?\s*[:=]\s*"?)[^"&,]+/gi, "$1$2<redacted>");
    else if (init.body) shown = "(multipart form: name, description, files)";
    print(`${method} ${path}${shown ? `\n  ${shown.slice(0, 2000)}` : ""}`);
    let out = {};
    if (/agents\/create$/.test(url)) out = { agent_id: "dry_run_agent" };
    else if (/voices\/add$/.test(url)) out = { voice_id: "dry_run_voice", requires_verification: false };
    else if (/convai\/phone-numbers$/.test(url) && method === "POST") out = { phone_number_id: "dry_run_phone" };
    else if (/convai\/phone-numbers$/.test(url)) out = [];
    else if (/IncomingPhoneNumbers/.test(url)) out = { incoming_phone_numbers: [{ phone_number: "+15555550199" }] };
    else if (/OutgoingCallerIds/.test(url)) out = { outgoing_caller_ids: [] };
    else if (/agents\/[^/?]+$/.test(url) && method === "GET") return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const fileEnv = existsSync(rootEnvPath) ? parseEnv(readFileSync(rootEnvPath, "utf8")) : {};
  if (dryRun) {
    // Placeholder keys so every step runs; nothing leaves this machine and nothing is written.
    const env = { ...fileEnv, ELEVENLABS_API_KEY: "dry-run", TWILIO_ACCOUNT_SID: "ACdryrun", TWILIO_AUTH_TOKEN: "dry-run", OWNER_NUMBER: fileEnv.OWNER_NUMBER || "+15555550100" };
    const { ids, todo } = await runSetup({ env, doFetch: dryRunFetch(), sample: findSample(), readFile: () => new Uint8Array(0) });
    console.log(`dry run: would write ${Object.keys(ids).join(", ")}`);
    for (const t of todo) console.log(`dry run: human list: ${t}`);
    return;
  }
  if (!fileEnv.ELEVENLABS_API_KEY) {
    console.error(`No ELEVENLABS_API_KEY in ${rootEnvPath}. Copy env/mouth.env to .env at the repo root and fill it in.`);
    process.exit(2);
  }
  const { ids, todo } = await runSetup({ env: fileEnv, reclone: process.argv.includes("--reclone") });

  for (const [k, v] of Object.entries(ids)) setEnvLine(rootEnvPath, k, v);
  setEnvLine(exampleEnvPath, "EXPO_PUBLIC_ELEVENLABS_BOBBY_AGENT_ID", ids.ELEVENLABS_BOBBY_AGENT_ID);
  if (!existsSync(exampleEnvPath) || !/EXPO_PUBLIC_HUB_URL=/.test(readFileSync(exampleEnvPath, "utf8"))) {
    setEnvLine(exampleEnvPath, "EXPO_PUBLIC_HUB_URL", "ws://10.0.2.2:8765");
  }
  console.log(`wrote ${Object.keys(ids).join(", ")} to .env, and the Bobby agent id to mouth/example/.env`);
  if (todo.length) {
    console.log("\nStill for a person:");
    todo.forEach((t, i) => console.log(`${i + 1}. ${t}`));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
