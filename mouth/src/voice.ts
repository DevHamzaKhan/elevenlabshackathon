// What the Mouth needs from a speech agent session. The ElevenLabs implementation is in
// elevenlabs.ts (React Native only); tests use a fake.

export type VoiceMode = "speaking" | "listening";

export interface VoiceCallbacks {
  onConnect(): void;
  /** The session ended for any reason other than our own end(). */
  onDisconnect(reason: string): void;
  /** A final transcript of what the user said. */
  onUserTranscript(text: string): void;
  /** What the agent said in one turn. */
  onAgentResponse(text: string): void;
  onModeChange(mode: VoiceMode): void;
  onError(message: string): void;
}

export interface VoiceSession {
  /** A typed user turn: the agent answers it as if spoken. */
  sendUserMessage(text: string): void;
  /** Silent background knowledge. */
  sendContextualUpdate(text: string): void;
  /** Stop the agent's audio now. */
  interrupt(): void;
  /** Push-to-talk: close (true) or open (false) the microphone. The agent keeps speaking. */
  setMicMuted(muted: boolean): void;
  end(): Promise<void>;
}

export type VoiceFactory = (cb: VoiceCallbacks) => Promise<VoiceSession>;
