// The only file that talks to OpenAI Realtime from the phone. React Native only.
// WebRTC through @livekit/react-native-webrtc (installed in the app with LiveKit), audio
// routing (earbuds first) through @livekit/react-native's AudioSession. Flow, per the docs
// (developers.openai.com/api/docs/guides/voice-webrtc): mint an ephemeral client secret with the
// session config, open a peer connection with the microphone track and the "oai-events" data
// channel, POST the SDP offer to /v1/realtime/calls, apply the answer. Events go through
// realtime.ts. Minting from the key on the phone is acceptable for now (see MERGE.md).

import { RTCPeerConnection, mediaDevices } from "@livekit/react-native-webrtc";
import { AudioSession, AndroidAudioTypePresets } from "@livekit/react-native";
import type { VoiceFactory, VoiceSession } from "./voice";
import { ev, exchangeSdp, mintClientSecret, sessionConfig, translator, type RealtimeOptions } from "./realtime";

export function openAIVoice(apiKey: string, opts: RealtimeOptions, log: (l: string) => void): VoiceFactory {
  return async (cb) => {
    const f = (globalThis as any).fetch;
    const t0 = Date.now();
    await AudioSession.configureAudio({ android: { preferredOutputList: ["bluetooth", "headset", "speaker"], audioTypeOptions: AndroidAudioTypePresets.communication } });
    await AudioSession.startAudioSession();
    const secret = await mintClientSecret(apiKey, sessionConfig(opts), f);
    const pc: any = new RTCPeerConnection({});
    const mic: any = await mediaDevices.getUserMedia({ audio: true });
    const track = mic.getAudioTracks()[0];
    pc.addTrack(track, mic);
    const dc: any = pc.createDataChannel("oai-events");
    let ending = false;
    const onEvent = translator(cb, log);
    const queue: string[] = [];
    let open = false;
    const send = (e: object) => {
      const s = JSON.stringify(e);
      if (open) dc.send(s);
      else queue.push(s);
    };
    dc.addEventListener("open", () => {
      open = true;
      for (const s of queue.splice(0)) dc.send(s);
      log(`openai realtime: data channel open after ${Date.now() - t0} ms`);
    });
    dc.addEventListener("message", (m: any) => {
      try {
        onEvent(JSON.parse(String(m.data)));
      } catch (e) {
        log(`openai realtime: bad event: ${String(e)}`);
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      const st = pc.connectionState;
      if ((st === "failed" || st === "closed" || st === "disconnected") && !ending) cb.onDisconnect(st);
    });
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    const answer = await exchangeSdp(secret, offer.sdp, f);
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    log(`openai realtime: ${opts.model ?? "default model"} connected in ${Date.now() - t0} ms`);

    const session: VoiceSession = {
      sendUserMessage: (t) => {
        send(ev.userText(t));
        send(ev.respond());
      },
      sendContextualUpdate: (t) => send(ev.context(t)),
      speak: (t) => send(ev.say(t)),
      toolResult: (callId, output, respond) => {
        send(ev.toolOutput(callId, output));
        if (respond) send(ev.respond());
      },
      interrupt: () => {
        send(ev.cancel());
        send(ev.clearAudio());
      },
      setMicMuted: (m) => {
        track.enabled = !m;
      },
      end: async () => {
        ending = true;
        try {
          dc.close();
          track.stop();
          pc.close();
        } finally {
          await AudioSession.stopAudioSession();
        }
      },
    };
    return session;
  };
}
