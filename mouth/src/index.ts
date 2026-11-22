// bobby-mouth entry points (CONTRACT.md v1, "Packages").
import { connectHub } from "./hub";
import { Mouth } from "./mouth";
import { elevenLabsVoice } from "./elevenlabs";
import { startCallerWith } from "./caller";

export interface Config {
  hubUrl: string;
  token: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

/** Connects to the hub as `mouth`. wake() starts a session with the Bobby agent and sends `wake`.
 *  status() is an extra for test screens: "disconnected" (no hub), "idle", "starting" or "live". */
export function startMouth(config: Config): { wake(): void; stop(): void; status(): string } {
  const agentId = config.env.ELEVENLABS_BOBBY_AGENT_ID ?? "";
  let mouth: Mouth;
  const hub = connectHub({
    hubUrl: config.hubUrl,
    token: config.token,
    role: "mouth",
    log: config.log,
    onMessage: (m) => mouth.onHub(m),
  });
  mouth = new Mouth({ send: (m) => hub.send(m), voice: elevenLabsVoice(agentId, config.log), log: config.log });
  return {
    wake() {
      if (!agentId) {
        config.log("ELEVENLABS_BOBBY_AGENT_ID is missing: run mouth/agent/setup.mjs");
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
