// What the Mouth needs from a speech agent session (protocol v2: a voice model with Bobby's tools).
// openai.ts implements it (OpenAI Realtime over WebRTC). Tests use a fake.

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
  onToolCall(name: string, args: Record<string, unknown>, callId: string): void;
  /** The user started talking (voice activity), e.g. over Bobby or during a task. */
  onSpeechStarted(): void;
}

export interface VoiceSession {
  /** A typed user turn: the agent answers it as if spoken. Test only (`test_user_turn`). */
  sendUserMessage(text: string): void;
  /** Silent background knowledge. */
  sendContextualUpdate(text: string): void;
  /** Stop the agent's audio now. */
  interrupt(): void;
  /** Push-to-talk: close (true) or open (false) the microphone. The agent keeps speaking. */
  setMicMuted(muted: boolean): void;
  end(): Promise<void>;
  /** Say this line now, in Bobby's voice. */
  speak(text: string): void;
  /** Return a tool's result; `respond` lets the model speak after it. */
  toolResult(callId: string, output: string, respond: boolean): void;
}

export type VoiceFactory = (cb: VoiceCallbacks) => Promise<VoiceSession>;
