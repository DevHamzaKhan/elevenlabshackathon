// bobby-mouth entry points (CONTRACT.md v1 "Packages"; protocol v2 in mind/PROTOCOL-V2.md).
import { connectHub } from "./hub";
import { Mouth } from "./mouth";
import { openAIVoice } from "./openai";
import { startCallerWith } from "./caller";
import type { VoiceFactory } from "./voice";
import { voiceChoice } from "./vendors";

export { voiceChoice } from "./vendors";

export interface Config {
  hubUrl: string;
  token: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

/** Connects to the hub as `mouth`. wake() starts a voice session and sends `wake`.
 *  status() is an extra for test screens: "disconnected" (no hub), "idle", "starting" or "live". */
export function startMouth(config: Config): { wake(): void; stop(): void; status(): string } {
  const env = config.env;
  const choice = voiceChoice(env);
  let mouth: Mouth;
  const hub = connectHub({
    hubUrl: config.hubUrl,
    token: config.token,
    role: "mouth",
    log: config.log,
    onMessage: (m) => mouth.onHub(m),
  });
  const voice: VoiceFactory = openAIVoice(
    env.OPENAI_API_KEY ?? "",
    { model: choice.model, voice: env.MOUTH_VOICE || undefined, transcribeModel: env.MOUTH_TRANSCRIBE_MODEL || undefined },
    config.log,
  );
  mouth = new Mouth({ send: (m) => hub.send(m), voice, log: config.log });
  config.log(`mouth: voice openai ${choice.model}`);
  return {
    wake() {
      if (choice.missing) {
        config.log(`mouth: ${choice.missing} is missing; can't start a voice session`);
        return;
      }
      void mouth.wake();
    },
    stop() {
      void mouth.stop();
      hub.stop();
    },
    status() {
      if (hub.state !== "live") return "disconnected";
      return mouth.status === "asleep" ? "idle" : mouth.status;
    },
  };
}

/** Connects to the hub as `caller`. Every call is a dry run unless env.CALLER_DRY_RUN is exactly "0". */
export function startCaller(config: Config): { stop(): void } {
  const { stop } = startCallerWith({ hubUrl: config.hubUrl, token: config.token, log: config.log, env: config.env });
  return { stop };
}

export { Mouth } from "./mouth";
