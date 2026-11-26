// End-to-end on the laptop: the real Mind (scripted fake OpenAI behind its real model door, no
// API key) + the Mind's fake hub and phone + the REAL Mouth and Caller code, with the voice
// session simulated as an OpenAI Realtime session with Bobby's tools (request/confirm/answer)
// and progress lines from the Mind (protocol v2).
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

async function pass(port: number) {
  console.log("\n== v2: tool-calling voice (OpenAI Realtime shape)");
  const hub = startFakeHub({ port, log: log("hub"), speed: 0 });
  await hub.ready;
  const url = `ws://localhost:${port}`;
  const ai = fakeOpenAI();
  const mind = startMind({ hubUrl: url, token: "t", env: { CONTACTS: "Alex=+14155550123,Hamza=+14155550111|hamza@example.com,Sam Lee=+14155550144,Sam Park=+14155550155" }, log: log("mind"), hints: [], model: makeModel({ apiKey: "fake", log: log("model"), fetch: ai.fetch }) });
  const spoken: string[] = [];
  const context: string[] = [];
  let cb: any;
  const talk = (t: string) => {
    setTimeout(() => { cb.onModeChange("speaking"); spoken.push(t); cb.onAgentResponse(t); }, 30);
    setTimeout(() => cb.onModeChange("listening"), 180);
  };
  const voice = async (c: any) => {
    cb = c;
    return {
      speak: talk,
      toolResult: (_id: string, out: string) => lines.push(`voice: tool result ${out}`),
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
  const tag = "v2";

  await until(() => mouthHub.state === "live");
  hub.notify("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?");
  await sleep(300);
  await mouth.wake();
  check(`${tag}: Mind gets wake from the Mouth`, await until(() => wire().includes("mouth->mind wake")));
  check(`${tag}: Mouth announces voice_caps v2`, wire().includes("mouth->mind voice_caps"));

  {
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
  {
    cb.onUserTranscript("Call Alex and tell him I'm running late");
    cb.onToolCall("request", { text: "Call Alex and tell him I'm running late" }, "call_3");
    await until(() => context.filter((c) => /CONFIRM id=/.test(c)).length >= 2, 5000);
    const id = /CONFIRM id=(\S+):/.exec(context.filter((c) => /CONFIRM id=/.test(c))[1] ?? "")?.[1];
    cb.onUserTranscript("yes");
    cb.onToolCall("confirm", { id, answer: "yes" }, "call_4");
  }
  check(`${tag}: Mind sends call to the Caller`, await until(() => wire().includes("mind->caller call")));
  check(`${tag}: Caller answers with call_status and call_result`, await until(() => wire().includes("caller->mind call_result")));

  // A question back to the user: two contacts are called Sam, so the Mind asks which, with options.
  const asked = () => spoken.some((s) => /Which Sam\? Option one: Sam Lee\. Option two: Sam Park\./.test(s));
  const confirms = () => context.filter((c) => /CONFIRM id=/.test(c)).length;
  const before = confirms();
  await mouth.wake();
  cb.onUserTranscript("text Sam I'm running late");
  cb.onToolCall("request", { text: "Text Sam I'm running late" }, "call_5");
  check(`${tag}: the Mind's question is spoken with its options`, await until(asked, 8000));
  {
    const qid = /QUESTION id=(\S+):/.exec(context.find((c) => /QUESTION id=/.test(c)) ?? "")?.[1];
    cb.onUserTranscript("uh, the second one");
    cb.onToolCall("answer", { id: qid, option: 2, text: "the second one" }, "call_6");
    check(`${tag}: ask_reply carries the pick and the raw transcript`, await until(() => hub.wire.some((w: any) => w.msg.type === "ask_reply" && w.msg.option === 2 && /second one/.test(w.msg.heard)), 3000));
    await until(() => confirms() > before, 5000);
    const id = /CONFIRM id=(\S+):/.exec(context.filter((c) => /CONFIRM id=/.test(c)).pop() ?? "")?.[1];
    cb.onUserTranscript("yes");
    cb.onToolCall("confirm", { id, answer: "yes" }, "call_7");
  }
  check(`${tag}: the text goes to the Sam the user picked`, await until(() => hub.phone.texts.some((x: any) => x.to === "+14155550155"), 8000) && !hub.phone.texts.some((x: any) => x.to === "+14155550144"));

  console.log(`Bobby said ${spoken.length} lines, e.g.: ${spoken.slice(0, 4).join(" | ")}`);
  mind.stop(); mouthHub.stop(); caller.stop(); await mouth.stop();
  await hub.close();
}

await pass(18791);
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${failed ? "FAIL" : "PASS"}: ${results.length - failed}/${results.length}`);
if (failed) for (const l of lines.slice(-40)) console.log(l);
process.exit(failed ? 1 : 0);
