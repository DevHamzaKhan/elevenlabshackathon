# Caller

Mac-side client that places outbound phone calls for Bobby: "call Alex and tell him I'm running
late". It has no task logic. The Orchestrator sends `call`; the Caller checks the number against
`CALL_ALLOWLIST`, dials through ElevenLabs Agents + Twilio with the owner's cloned voice, sends
`call_status` on each change and exactly one `call_result` (see `CONTRACT.md`, "Caller").

- Role on the wire: `caller`, contract v2.
- Dry run (`CALLER_DRY_RUN=1`, the default) fakes the whole call: no accounts, no network besides the hub.
- One call at a time; a second `call` while busy gets `call_result ok:false error:"busy"`.
- Gives up after 3 minutes with `error:"failed"`.
- Every frame sent/received is logged as one JSON line in `caller/logs/` (gitignored). Keys and
  the hub token are never logged.

## Run

```sh
cd caller
uv run caller
```

Config comes from the repo-root `.env` (real environment variables win):

| Variable | Default | Meaning |
|---|---|---|
| `HUB_URL` | `ws://localhost:8765` | Hub base URL; the Caller appends `/caller?token=…` |
| `HUB_TOKEN` | empty | Shared hub secret |
| `CALL_ALLOWLIST` | empty (refuse all) | Comma-separated E.164 numbers the Caller may dial |
| `CALLER_DRY_RUN` | `1` | `0` places real calls |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_CALLER_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID` | | Needed only when `CALLER_DRY_RUN=0` |
| `OWNER_NUMBER` | | The owner's phone, for the real test call |
| `CALLER_TIMEOUT_S` | `180` | Overall per-call timeout (extra `CALLER_` variable) |
| `CALLER_API_BASE` | `https://api.elevenlabs.io` | ElevenLabs API host, e.g. a data-residency host (extra `CALLER_` variable) |

Real calls need the human setup in [SETUP.md](SETUP.md).

## Run against the fake hub

```sh
cd caller
uv run fakes/hub.py                    # terminal 1: pretend Orchestrator on :8765, sends one call
CALL_ALLOWLIST=+14155550123 uv run caller   # terminal 2
```

The fake hub prints every frame, validates the `call_status` sequence and the `call_result`
shape, and exits 0 on a well-formed result (1 on timeout or anything malformed).
Flags: `--port`, `--to`, `--goal`, `--context`, `--token`, `--timeout`, `--expect-error`.

## Checks

```sh
./check.sh
```

Runs the unit tests (allowlist, E.164, message shapes vs the contract examples, not_allowed,
busy, dry-run sequence, hub client reconnect/4001, the ElevenLabs client against a mocked API
including timeout/busy/no-answer) and two dry-run calls end to end against `fakes/hub.py` on
port 8799 (an allowed call and a refused one). It never places a real call.

## How a real call works

1. `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` with `agent_id`,
   `agent_phone_number_id`, `to_number`, and
   `conversation_initiation_client_data.dynamic_variables = {goal, context}`; the caller agent's
   prompt uses `{{goal}}` and `{{context}}` (no overrides needed). → `call_status dialing`.
2. Poll `GET /v1/convai/conversations/{conversation_id}` every 2 s:
   `in-progress` or any transcript → `answered`; `processing`/`done` → `ended`;
   `failed`, or `metadata.phone_call.call_result` of `busy`/`no_answer`/`voicemail`/`failed`
   with nobody heard → `failed` with `busy`/`no_answer`/`failed`.
3. On `done`: transcript from `transcript[]` (`agent` → `me`, `user` → `them`), summary from
   `analysis.transcript_summary`, else a short digest of what they said → `call_result ok:true`.

## Stitching day: connect to the real Orchestrator

1. In the root `.env` set `HUB_URL=ws://<mac-tailscale-name>:8765` (or `ws://localhost:8765` if
   the Orchestrator runs on the same Mac) and the team's `HUB_TOKEN`.
2. Set `CALL_ALLOWLIST` to the numbers that may be called in the demo (at minimum `OWNER_NUMBER`;
   `CONTACTS` numbers the Orchestrator might dial must also be listed or they are refused).
3. `cd caller && uv run caller`. Look for `welcomed by hub` on stderr; the dashboard's `caller`
   peer light turns on.
4. Leave `CALLER_DRY_RUN=1` for rehearsals; set `0` only for the real demo call.
5. If it logs `4003`: wrong `HUB_TOKEN`. `4002`: version mismatch. If it exits after `4001`,
   another Caller instance connected and replaced it: stop the other one.
