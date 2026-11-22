// End-to-end on the laptop: the real Mind (its test stand-in model, no API key) + the Mind's fake
// hub and phone + the REAL Mouth and Caller code, with the ElevenLabs session simulated.
// Checks the contract between the parts, not the AI. Needs mind/node_modules:
//   cd mind && npm install && npx tsx ../mouth/tools/integration-with-mind.mts
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { startMind } = await import(`${R}/mind/src/index.ts`);
const { startFakeHub } = await import(`${R}/mind/fakes/hub.ts`);
const { stubModel } = await import(`${R}/mind/test/helpers.ts`);
const { connectHub } = await import(`${R}/mouth/src/hub.ts`);
const { Mouth } = await import(`${R}/mouth/src/mouth.ts`);
const { startCallerWith } = await import(`${R}/mouth/src/caller.ts`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
const log = (who: string) => (s: string) => lines.push(`${who}: ${s}`);
const port = 18790;
const hub = startFakeHub({ port, log: log("hub"), speed: 0 });
await hub.ready;
const url = `ws://localhost:${port}`;

const mind = startMind({ hubUrl: url, token: "t", env: { CONTACTS: "Alex=+14155550123" }, log: log("mind"), hints: [], model: stubModel().fn });

// Simulated ElevenLabs session: every [SAY]/[CORRECT] line is "spoken" for 150 ms.
const spoken: string[] = [];
let cb: any;
const voice = async (c: any) => {
  cb = c;
  return {
    sendUserMessage(t: string) {
      setTimeout(() => { cb.onModeChange("speaking"); spoken.push(t); cb.onAgentResponse(t.replace(/^\[(SAY|CORRECT)\] /, "")); }, 30);
      setTimeout(() => cb.onModeChange("listening"), 180);
    },
    sendContextualUpdate(t: string) { lines.push(`voice: (whisper) ${t}`); },
    interrupt() { lines.push("voice: (hush)"); },
    async end() {},
  };
};
let mouth: any;
const mouthHub = connectHub({ hubUrl: url, token: "t", role: "mouth", log: log("mouth"), onMessage: (m: any) => mouth.onHub(m) });
mouth = new Mouth({ send: (m: any) => mouthHub.send(m), voice, log: log("mouth"), listenSettleMs: 50 });
const caller = startCallerWith({ hubUrl: url, token: "t", log: log("caller"), env: { CALL_ALLOWLIST: "+14155550123" }, stepMs: 50 });

const wire = () => hub.wire.map((w: any) => `${w.from}->${w.to} ${w.msg.type}`);
const until = async (pred: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(50); return pred(); };
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

await until(() => mouthHub.state === "live");
hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
await sleep(300);
await mouth.wake();
check("Mind gets wake from the Mouth", await until(() => wire().includes("mouth->mind wake")));

cb.onUserTranscript("Reply to Sarah and tell her 3 works");
check("heard reaches the Mind", await until(() => wire().includes("mouth->mind heard")));
check("Mind sends say to the Mouth", await until(() => wire().includes("mind->mouth say")));
check("Mouth answers say with say_started and say_done", await until(() => wire().includes("mouth->mind say_started") && wire().includes("mouth->mind say_done")));
check("task runs on the phone to done (email sent)", await until(() => hub.watched.some((m: any) => m.type === "task" && m.status === "done"), 30000));

cb.onUserTranscript("Call Alex and tell him I'm running late");
check("Mind sends call to the Caller", await until(() => wire().includes("mind->caller call")));
check("Caller answers with call_status and call_result", await until(() => wire().includes("caller->mind call_result")));

cb.onUserTranscript("thanks, bye");
check("Mind sends sleep, Mouth answers asleep", await until(() => wire().includes("mouth->mind asleep"), 15000));

await sleep(300);
const sayIds = hub.wire.filter((w: any) => w.msg.type === "say").map((w: any) => w.msg.id);
const doneIds = hub.wire.filter((w: any) => w.msg.type === "say_done").map((w: any) => w.msg.re);
check(`every say got exactly one say_done (${sayIds.length} says, ${doneIds.length} say_done)`,
  sayIds.length === doneIds.length && sayIds.every((id: string) => doneIds.filter((r: string) => r === id).length === 1));
console.log(`\nBobby said ${spoken.length} lines, e.g.:`);
for (const s of spoken.slice(0, 6)) console.log("  " + s);
console.log("\nwire (types only):", [...new Set(wire())].join(" | "));
mind.stop(); mouthHub.stop(); caller.stop(); await mouth.stop();
const failed = results.filter(([, ok]) => !ok).length;
if (failed) console.log("\nlast log lines:\n" + lines.slice(-25).join("\n"));
process.exit(failed ? 1 : 0);
