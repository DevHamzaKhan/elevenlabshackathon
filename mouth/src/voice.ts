// What the Mouth needs from a speech agent session. One vendor file implements it:
// openai.ts (OpenAI Realtime over WebRTC, the default) or elevenlabs.ts. Tests use a fake.

export type VoiceMode = "speaking" | "listening";

export interface VoiceCallbacks {
  onConnect(): void;
  /** The session ended for any reason other than our own end(). */
  onDisconnect(reason: string): void;
  /** A final transcript of what the user said (the raw speech-to-text, not the model's reading). */
  onUserTranscript(text: string): void;
  /** What the agent said in one turn. */
  onAgentResponse(text: string): void;
  onModeChange(mode: VoiceMode): void;
  onError(message: string): void;
  /** The voice model called one of Bobby's tools (request, amend, cancel, confirm, answer, status). */
  onToolCall?(name: string, args: Record<string, unknown>, callId: string): void;
  /** The user started talking (voice activity), e.g. over Bobby or during a task. */
  onSpeechStarted?(): void;
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
  /** Optional: say this line now (instead of a tagged user message). */
  speak?(text: string): void;
  /** Optional: return a tool's result; `respond` lets the model speak after it. */
  toolResult?(callId: string, output: string, respond: boolean): void;
  /** Optional: this vendor supports Bobby's tools (protocol v2). */
  readonly tools?: boolean;
}

export type VoiceFactory = (cb: VoiceCallbacks) => Promise<VoiceSession>;
