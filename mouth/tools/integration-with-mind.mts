// End-to-end on the laptop: the real Mind (scripted fake OpenAI behind its real model door, no
// API key) + the Mind's fake hub and phone + the REAL Mouth and Caller code, with the voice
// session simulated. Two passes:
//   v1: an ElevenLabs-style session (heard/say), Send confirmed by a spoken "yes" after a press.
//   v2: an OpenAI-Realtime-style session with Bobby's tools (request/confirm), progress lines.
// Checks the contract between the parts, not the AI. Needs mind/node_modules:
//   cd mind && npm ci && npx tsx ../mouth/tools/integration-with-mind.mts
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { startMind } = await import(`${R}/mind/src/index.ts`);
const { makeModel } = await import(`${R}/mind/src/model.ts`);
const { startFakeHub } = await import(`${R}/mind/fakes/hub.ts`);
const { fakeOpenAI } = await import(`${R}/mind/fakes/openai.ts`);
const { connectHub } = await import(`${R}/mouth/src/hub.ts`);
const { Mouth } = await import(`${R}/mouth/src/mouth.ts`);
const { startCallerWith } = await import(`${R}/mouth/src/caller.ts`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
const log = (who: string) => (s: string) => lines.push(`${who}: ${s}`);
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const until = async (pred: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(50); return pred(); };

async function pass(v2: boolean, port: number) {
  console.log(`\n== ${v2 ? "v2: tool-calling voice (OpenAI Realtime shape)" : "v1: heard/say voice (ElevenLabs shape)"}`);
  const hub = startFakeHub({ port, log: log("hub"), speed: 0 });
  await hub.ready;
  const url = `ws://localhost:${port}`;
  const ai = fakeOpenAI();
  const mind = startMind({ hubUrl: url, token: "t", env: { CONTACTS: "Alex=+14155550123,Hamza=+14155550111|hamza@example.com" }, log: log("mind"), hints: [], model: makeModel({ apiKey: "fake", log: log("model"), fetch: ai.fetch }) });
  const spoken: string[] = [];
  const context: string[] = [];
  let cb: any;
  const talk = (t: string) => {
    setTimeout(() => { cb.onModeChange("speaking"); spoken.push(t); cb.onAgentResponse(t.replace(/^\[(SAY|CORRECT)\] /, "")); }, 30);
    setTimeout(() => cb.onModeChange("listening"), 180);
  };
  const voice = async (c: any) => {
    cb = c;
    return {
      ...(v2 ? { tools: true, speak: talk, toolResult: (_id: string, out: string) => lines.push(`voice: tool result ${out}`) } : {}),
      sendUserMessage: talk,
      sendContextualUpdate(t: string) { context.push(t); },
      interrupt() { lines.push("voice: (hush)"); },
      setMicMuted(m: boolean) { lines.push(`voice: (mic ${m ? "closed" : "open"})`); },
      async end() {},
    };
  };
  let mouth: any;
  const mouthHub = connectHub({ hubUrl: url, token: "t", role: "mouth", log: log("mouth"), onMessage: (m: any) => mouth.onHub(m) });
  mouth = new Mouth({ send: (m: any) => mouthHub.send(m), voice, log: log("mouth"), listenSettleMs: 50 });
  const caller = startCallerWith({ hubUrl: url, token: "t", log: log("caller"), env: { CALL_ALLOWLIST: "+14155550123" }, stepMs: 50 });
  const wire = () => hub.wire.map((w: any) => `${w.from}->${w.to} ${w.msg.type}`);
  const tag = v2 ? "v2" : "v1";

  await until(() => mouthHub.state === "live");
  hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
  await sleep(300);
  await mouth.wake();
  check(`${tag}: Mind gets wake from the Mouth`, await until(() => wire().includes("mouth->mind wake")));
  if (v2) check(`${tag}: Mouth announces voice_caps v2`, wire().includes("mouth->mind voice_caps"));

  if (!v2) {
    cb.onUserTranscript("Reply to Sarah and tell her 3 works");
    check(`${tag}: heard reaches the Mind`, await until(() => wire().includes("mouth->mind heard")));
    check(`${tag}: Mind asks before sending (say)`, await until(() => spoken.some((s) => /Should I go ahead/.test(s)), 15000));
    await mouth.wake();
    cb.onUserTranscript("yes, send it");
    check(`${tag}: task runs on the phone to done (email sent)`, await until(() => hub.phone.sent?.text === "3 works for me.", 15000));
    check(`${tag}: Mouth answers says with say_started and say_done`, wire().includes("mouth->mind say_started") && wire().includes("mouth->mind say_done"));
  } else {
    cb.onUserTranscript("send an email to Hamza saying I'm late");
    cb.onToolCall("request", { text: "Send an email to Hamza saying I'm late" }, "call_1");
    check(`${tag}: request reaches the Mind (no debounce)`, await until(() => wire().includes("mouth->mind request"), 2000));
    check(`${tag}: Mind opens the mailto draft (shortcut, no model call)`, await until(() => hub.wire.some((w: any) => w.msg.type === "act" && w.msg.do === "open"), 3000) && ai.calls.length === 0);
    check(`${tag}: confirm_request is spoken as a question`, await until(() => spoken.some((s) => /Email to Hamza.*Should I go ahead/.test(s)), 5000));
    const id = /CONFIRM id=(\S+):/.exec(context.find((c) => /CONFIRM id=/.test(c)) ?? "")?.[1];
    cb.onUserTranscript("yes send it");
    cb.onToolCall("confirm", { id, answer: "yes" }, "call_2");
    check(`${tag}: confirm_reply carries the raw transcript`, await until(() => hub.wire.some((w: any) => w.msg.type === "confirm_reply" && w.msg.ok === true && /yes send it/.test(w.msg.heard)), 3000));
    check(`${tag}: email sent on the phone`, await until(() => hub.phone.mails.length === 1, 5000));
    check(`${tag}: the outcome comes from the Mind as progress and is spoken`, await until(() => spoken.some((s) => /Sent it to Hamza/.test(s)), 5000));
  }

  await mouth.wake();
  if (v2) {
    cb.onUserTranscript("Call Alex and tell him I'm running late");
    cb.onToolCall("request", { text: "Call Alex and tell him I'm running late" }, "call_3");
    await until(() => context.filter((c) => /CONFIRM id=/.test(c)).length >= 2, 5000);
    const id = /CONFIRM id=(\S+):/.exec(context.filter((c) => /CONFIRM id=/.test(c))[1] ?? "")?.[1];
    cb.onUserTranscript("yes");
    cb.onToolCall("confirm", { id, answer: "yes" }, "call_4");
  } else {
    cb.onUserTranscript("Call Alex and tell him I'm running late");
    await until(() => spoken.filter((s) => /Should I go ahead/.test(s)).length >= 2, 10000);
    await mouth.wake();
    cb.onUserTranscript("yes");
  }
  check(`${tag}: Mind sends call to the Caller`, await until(() => wire().includes("mind->caller call")));
  check(`${tag}: Caller answers with call_status and call_result`, await until(() => wire().includes("caller->mind call_result")));

  if (!v2) {
    await mouth.wake();
    cb.onUserTranscript("thanks, bye");
    check(`${tag}: Mind sends sleep, Mouth answers asleep`, await until(() => wire().includes("mouth->mind asleep"), 15000));
    await sleep(300);
    const sayIds = hub.wire.filter((w: any) => w.msg.type === "say").map((w: any) => w.msg.id);
    const doneIds = hub.wire.filter((w: any) => w.msg.type === "say_done").map((w: any) => w.msg.re);
    check(`${tag}: every say got exactly one say_done (${sayIds.length} says)`, sayIds.length === doneIds.length && sayIds.every((id: string) => doneIds.filter((r: string) => r === id).length === 1));
  }
  console.log(`Bobby said ${spoken.length} lines, e.g.: ${spoken.slice(0, 4).join(" | ")}`);
  mind.stop(); mouthHub.stop(); caller.stop(); await mouth.stop();
  await hub.close();
}

await pass(false, 18790);
await pass(true, 18791);
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${failed ? "FAIL" : "PASS"}: ${results.length - failed}/${results.length}`);
if (failed) for (const l of lines.slice(-40)) console.log(l);
process.exit(failed ? 1 : 0);
