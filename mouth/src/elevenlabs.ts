// The only file that talks to ElevenLabs. React Native only. Importing
// "@elevenlabs/react-native" installs its native WebRTC audio setup into @elevenlabs/client
// (a side effect); we then drive the client's imperative Conversation API. The app must have
// exactly one copy of @elevenlabs/client: the version @elevenlabs/react-native depends on.
import "@elevenlabs/react-native";
import { VoiceConversation } from "@elevenlabs/client";
import type { VoiceFactory } from "./voice";

export function elevenLabsVoice(agentId: string, log: (l: string) => void): VoiceFactory {
  return async (cb) => {
    let ending = false;
    let muted = false; // hush: the SDK has no public interrupt, so silence the output until Bobby stops
    let session: VoiceConversation | null = null;
    const conv = (session = await VoiceConversation.startSession({
      agentId,
      connectionType: "webrtc",
      onConnect: () => cb.onConnect(),
      onDisconnect: (d: { reason: string }) => {
        if (!ending) cb.onDisconnect(d.reason);
      },
      onError: (m: string) => cb.onError(m),
      onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => {
        if (mode === "listening" && muted) {
          muted = false;
          session?.setVolume({ volume: 1 });
        }
        cb.onModeChange(mode);
      },
      onMessage: (m: { message: string; role?: string; source?: string }) => {
        const who = m.role ?? (m.source === "ai" ? "agent" : "user");
        if (who === "user") cb.onUserTranscript(m.message);
        else cb.onAgentResponse(m.message);
      },
    }));
    log(`elevenlabs session ${conv.getId()} started`);
    return {
      sendUserMessage: (t) => conv.sendUserMessage(t),
      sendContextualUpdate: (t) => conv.sendContextualUpdate(t),
      setMicMuted: (m) => conv.setMicMuted(m),
      interrupt: () => {
        muted = true;
        conv.setVolume({ volume: 0 });
      },
      end: async () => {
        ending = true;
        await conv.endSession();
      },
    };
  };
}
