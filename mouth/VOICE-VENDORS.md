# Voice vendors for Bobby's front end (checked 2026-11-24)

Bobby's voice model has one job in v2: own the conversation, call the Mind's tools (`request`, `amend`, `cancel`, `confirm`, `status`), acknowledge at once, and speak outcomes only when the Mind sends them (`mind/PROTOCOL-V2.md`). What matters: time to first audio, barge-in, how tool calls behave while work runs, cost per minute, session limits, and whether it runs from React Native.

No vendor publishes comparable latency numbers, so `mouth/tools/voice-bench.mjs` measures them on a fixed script (below). **It has only been run in `--dry-run` (no `OPENAI_API_KEY` here)**; the table's latency column is what the vendors claim, not measurements.

## Comparison

| | OpenAI `gpt-realtime-2.1-mini` (**default**) | OpenAI `gpt-realtime-2.1` | OpenAI `gpt-live-1.1` (GPT-Live) | ElevenLabs Agents (Realtime v1 Mini; **removed** 2026-11-26) | Gemini Live `gemini-3.8-live` |
|---|---|---|---|---|---|
| What it is | Speech-to-speech reasoning model with tools, "distilled ... faster, lower-cost" | Full Realtime reasoning model with tools, configurable reasoning effort | Full-duplex voice model that delegates work to your backend | Agent platform (STT + LLM + TTS pipeline, Realtime voice mode) | Audio-to-audio live model |
| Time to first audio (vendor claim) | none published | none published | none published | Realtime v1 Mini "620ms", Max "570ms"; measured in our emulator: `say` → `say_started` 0.26–0.28 s (mouth/STATUS.md) | "low-latency", no figure |
| Barge-in | Server VAD (`semantic_vad`, `interrupt_response`); over WebRTC the server truncates unplayed audio; `response.cancel` + `output_audio_buffer.clear` for push-to-talk | same | Full duplex: listens while it speaks; backend work continues through interruptions | Yes (turn-taking model) | "Users can interrupt the model at any time" |
| Tool calls while work runs | A function call ends the model's turn. Bobby's tools return at once (`{"accepted":true}`), so they are effectively non-blocking; results arrive later as UPDATE lines. (`async: true` tools are Responses-API only.) | same | Designed for it: delegation runs in the background, the model keeps talking, results come back via `session.commentary.append` / `session.thinking.append` (500 tokens each). Client delegation carries no task text: the app reads transcripts | Client tools; blocking unless set to not wait | `behavior: NON_BLOCKING` functions with result `scheduling` `INTERRUPT` / `WHEN_IDLE` / `SILENT` (our `progress.priority` mirrors this) |
| Price | audio in $10 / out $20 per 1M tokens (cached $0.30); text $0.60/$2.40. ≈ $0.006 per min of user speech + $0.024 per min of Bobby speech, plus the re-sent conversation each turn (mostly cached) | audio in $32 / out $64 per 1M (cached $0.40) ≈ $0.019 + $0.077 per min | $0.05/min active, $0.02/min standby (WebRTC paused), per second; backend billed separately | $0.08/min + LLM tokens (Realtime v1 Mini $0.20/$6.00 per 1M) | audio in $0.005/min, out $0.018/min (text $0.75/$4.50 per 1M) |
| Session limits | 60 min per Realtime session | 60 min | not listed for WebRTC; SIP: 3 min ringing, 2 h connected | per-agent max duration (configurable) | audio-only 15 min without context compression; connection ~10 min (session resumption) |
| React Native | WebRTC with any stack: we use `@livekit/react-native-webrtc` (already installed); ephemeral client secret from `/v1/realtime/client_secrets` | same | WebRTC recommended for mobile; session created server-side (`POST /v1/live/sessions`), so the phone would need the key or a small server; third-party RN SDK (Switchboard) is iOS-only | Official `@elevenlabs/react-native` SDK (LiveKit); agent id only, no key on the phone | WebSocket (raw PCM) natively; WebRTC only via partners; ephemeral tokens recommended |
| Fit for Bobby | Tools map 1:1 to the Mind's protocol; cheapest OpenAI option; no new native code | Better instruction-following if mini mis-routes; ~3x the audio price | OpenAI's recommended path for new voice apps; strongest at "keep talking while the Mind works"; needs a different adapter (delegation + transcripts instead of named tools) | Was the v1 voice; removed from the code base, with voice cloning, on 2026-11-26; not all-OpenAI | Cheapest; non-blocking tools are a great match; WebSocket audio plumbing in RN is new work; not OpenAI |

Sources:
- OpenAI models: https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini, https://developers.openai.com/api/docs/models/gpt-realtime-2.1, https://developers.openai.com/api/docs/models/gpt-live-1.1
- OpenAI pricing: https://developers.openai.com/api/docs/pricing (GPT-Live per minute; Realtime per token)
- Audio token rates (user 1 token / 100 ms, assistant 1 token / 50 ms) and Realtime costs: https://developers.openai.com/api/docs/guides/voice-latency-cost
- Realtime WebRTC + ephemeral keys: https://developers.openai.com/api/docs/guides/voice-webrtc ; conversations, function calling, interruption: https://developers.openai.com/api/docs/guides/realtime-conversations ; 60-minute limit: same page
- GPT-Live, delegation, transcripts: https://developers.openai.com/api/docs/guides/live, https://developers.openai.com/api/docs/guides/live-delegation, https://developers.openai.com/api/docs/guides/live-conversations
- Async tools (Responses only): https://developers.openai.com/api/docs/guides/async-tool-calling
- ElevenLabs pricing and latency claims: https://elevenlabs.io/pricing/api
- Gemini Live: https://aistudio.google.com/docs/live-api, https://aistudio.google.com/docs/models/gemini-3.8-live (pricing), https://aistudio.google.com/docs/live-api/tools (NON_BLOCKING, scheduling), https://aistudio.google.com/docs/live-api/session-management (limits)

## Decision

- **Default: `gpt-realtime-2.1-mini`** (`MOUTH_VOICE_MODEL`). Bobby's voice only acknowledges, relays and reads lines; the reasoning is in the Mind. Mini supports function calling and image/audio input, is about a third of the full model's audio price, and runs over WebRTC with libraries the app already has. Switch to `gpt-realtime-2.1` with one env change if the bench or the phone shows mis-routed tool calls.
- **Next to evaluate: GPT-Live 1.1 with client delegation.** OpenAI now points new voice apps at it, and full duplex plus background delegation is exactly "keep talking while the phone is driven". It needs a second adapter: `session.delegation.created` → `request` with the transcript since the last turn, `progress` → `session.commentary.append`, `whisper` → `session.thinking.append`, and the confirmation question through `session.instructions.append`. The session is created with the API key (`POST /v1/live/sessions`), so either keep minting on the phone or add a tiny token server.
- **ElevenLabs** was removed on 2026-11-26 (with the cloned-voice caller); the row above is kept for comparison only.

## The bench

`node mouth/tools/voice-bench.mjs [--runs 3] [--targets realtime:gpt-realtime-2.1-mini,realtime:gpt-realtime-2.1,live:gpt-live-1.1]` (needs `OPENAI_API_KEY` in the root `.env`), or `--dry-run` against a local fake server. Over WebSocket from the laptop, so phone WebRTC setup is excluded. Per target and run it records:

| Field | Realtime | GPT-Live |
|---|---|---|
| `connectMs` | socket open → `session.created` | socket open → `session.started` |
| `sayFirstAudioMs` | `response.create` with a SAY line → first `response.output_audio.delta` | `session.commentary.append` → first `session.output_audio.delta` |
| `chatFirstAudioMs` | typed "Hi Bobby, how are you?" → first audio | n/a (audio input only) |
| `toolCallMs` | typed "Text Alex I'm running late" → `request` function call | n/a |
| `ackFirstAudioMs` | `function_call_output` + `response.create` → first audio of the acknowledgement | n/a |

Output: `mouth/logs/voice-bench-<time>.json`. Dry run seen working (2026-11-24): all targets complete with the fake server's fixed delays. Real numbers: not yet (needs the key).
