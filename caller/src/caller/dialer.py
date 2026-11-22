"""Dialers: a dry-run fake and the real ElevenLabs Agents + Twilio outbound call.

A dialer takes one validated call and an `on_status` callback, and returns a CallOutcome.
It never sends `call_result` itself; the CallHandler does that exactly once.

ElevenLabs endpoints used (checked against the docs on 2026-11-22):
- POST /v1/convai/twilio/outbound-call
  https://elevenlabs.io/docs/api-reference/twilio/outbound-call
- GET  /v1/convai/conversations/{conversation_id}
  https://elevenlabs.io/docs/api-reference/conversations/get
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

import httpx

from .messages import CallError, Status, Turn

log = logging.getLogger("caller.dialer")

OnStatus = Callable[[Status], Awaitable[None]]


@dataclass(frozen=True)
class CallRequest:
    id: str
    to: str
    goal: str
    context: str


@dataclass
class CallOutcome:
    ok: bool
    summary: str = ""
    transcript: list[Turn] = field(default_factory=list)
    error: CallError | None = None


class Dialer(Protocol):
    async def dial(self, call: CallRequest, on_status: OnStatus) -> CallOutcome: ...


# --------------------------------------------------------------------------- dry run

class DryRunDialer:
    """Fakes the whole call with a canned transcript. No network."""

    def __init__(self, ring_s: float = 1.2, talk_s: float = 2.5, wrap_s: float = 0.5):
        self.ring_s, self.talk_s, self.wrap_s = ring_s, talk_s, wrap_s

    async def dial(self, call: CallRequest, on_status: OnStatus) -> CallOutcome:
        await on_status("dialing")
        await asyncio.sleep(self.ring_s)
        await on_status("answered")
        await asyncio.sleep(self.talk_s)
        await on_status("ended")
        await asyncio.sleep(self.wrap_s)
        goal = call.goal.strip() or "pass on a quick message"
        transcript: list[Turn] = [
            {"who": "me", "text": "Hey, it's me, calling quickly."},
            {"who": "them", "text": "Oh hey! What's up?"},
            {"who": "me", "text": f"I wanted to {_lower_first(goal.rstrip('.'))}."},
            {"who": "them", "text": "Sure, no problem, that works for me."},
            {"who": "me", "text": "Great, thanks. Talk soon!"},
            {"who": "them", "text": "See you then, bye."},
        ]
        return CallOutcome(
            ok=True,
            summary="(dry run) They said that works for them.",
            transcript=transcript,
        )


def _lower_first(s: str) -> str:
    return s[:1].lower() + s[1:] if s else s


# --------------------------------------------------------------------------- ElevenLabs

# Conversation.status values: initiated, in-progress, processing, done, failed.
_ENDED_STATES = {"processing", "done"}
_FINAL_STATES = {"done", "failed"}
# metadata.phone_call.call_result values: answered, voicemail, busy, no_answer, failed.
_PHONE_RESULT_ERRORS: dict[str, CallError] = {
    "busy": "busy",
    "no_answer": "no_answer",
    "voicemail": "no_answer",
    "failed": "failed",
}


class ElevenLabsDialer:
    """Places a real outbound call through ElevenLabs' native Twilio integration."""

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        phone_number_id: str,
        *,
        api_base: str = "https://api.elevenlabs.io",
        timeout_s: float = 180.0,
        poll_interval_s: float = 2.0,
        ringing_timeout_s: int = 40,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._api_key = api_key
        self.agent_id = agent_id
        self.phone_number_id = phone_number_id
        self.api_base = api_base.rstrip("/")
        self.timeout_s = timeout_s
        self.poll_interval_s = poll_interval_s
        self.ringing_timeout_s = ringing_timeout_s
        self._transport = transport

    def outbound_body(self, call: CallRequest) -> dict:
        """Request body for POST /v1/convai/twilio/outbound-call.

        goal and context go in as dynamic variables {{goal}} and {{context}}, which the
        caller agent's system prompt and first message reference (see SETUP.md). Dynamic
        variables need no override permissions on the agent.
        """
        return {
            "agent_id": self.agent_id,
            "agent_phone_number_id": self.phone_number_id,
            "to_number": call.to,
            "conversation_initiation_client_data": {
                "dynamic_variables": {"goal": call.goal, "context": call.context},
            },
            "telephony_call_config": {"ringing_timeout_secs": self.ringing_timeout_s},
        }

    async def dial(self, call: CallRequest, on_status: OnStatus) -> CallOutcome:
        state = _CallState(on_status)
        async with httpx.AsyncClient(
            base_url=self.api_base,
            headers={"xi-api-key": self._api_key},
            timeout=httpx.Timeout(15.0),
            transport=self._transport,
        ) as client:
            try:
                return await asyncio.wait_for(self._run(client, call, state), self.timeout_s)
            except (TimeoutError, asyncio.TimeoutError):
                log.warning("call %s timed out after %.0fs", call.id, self.timeout_s)
                await state.set("failed")
                return CallOutcome(ok=False, error="failed", transcript=state.transcript,
                                   summary=summarize(state.transcript, None) if state.transcript else "")
            except httpx.HTTPError as e:
                log.error("call %s: ElevenLabs request failed: %s", call.id, type(e).__name__)
                await state.set("failed")
                return CallOutcome(ok=False, error="failed", transcript=state.transcript)

    async def _run(self, client: httpx.AsyncClient, call: CallRequest, state: "_CallState") -> CallOutcome:
        await state.set("dialing")
        resp = await client.post("/v1/convai/twilio/outbound-call", json=self.outbound_body(call))
        data = _json(resp)
        conversation_id = data.get("conversation_id")
        if resp.status_code >= 400 or not data.get("success") or not conversation_id:
            log.error("call %s: outbound-call refused (HTTP %s): %s",
                      call.id, resp.status_code, str(data.get("message") or data.get("detail") or "")[:200])
            await state.set("failed")
            return CallOutcome(ok=False, error="failed")
        log.info("call %s: conversation %s, callSid %s", call.id, conversation_id, data.get("callSid"))

        while True:
            await asyncio.sleep(self.poll_interval_s)
            r = await client.get(f"/v1/convai/conversations/{conversation_id}")
            if r.status_code == 404:
                continue  # not visible yet
            if r.status_code >= 400:
                log.warning("call %s: conversation poll HTTP %s", call.id, r.status_code)
                continue
            conv = _json(r)
            status = conv.get("status")
            state.transcript = transcript_from(conv)
            phone_result = _phone_call_result(conv)

            if phone_result in _PHONE_RESULT_ERRORS and not state.transcript:
                await state.set("failed")
                return CallOutcome(ok=False, error=_PHONE_RESULT_ERRORS[phone_result])
            if status == "in-progress" or state.transcript or phone_result == "answered":
                await state.set("answered")
            if status in _ENDED_STATES:
                if state.seen("answered"):
                    await state.set("ended")
                if status != "done":
                    continue  # processing: analysis not ready yet
            if status == "failed":
                await state.set("failed")
                return CallOutcome(ok=False, error="failed", transcript=state.transcript)
            if status == "done":
                if not state.transcript:
                    await state.set("failed")
                    err = _PHONE_RESULT_ERRORS.get(phone_result or "", "no_answer")
                    return CallOutcome(ok=False, error=err)
                summary = summarize(state.transcript, (conv.get("analysis") or {}).get("transcript_summary"))
                return CallOutcome(ok=True, summary=summary, transcript=state.transcript)


class _CallState:
    """Sends one call_status per change, never repeating or going backwards."""

    ORDER = {"dialing": 0, "answered": 1, "ended": 2, "failed": 2}

    def __init__(self, on_status: OnStatus):
        self._on_status = on_status
        self._sent: list[str] = []
        self.transcript: list[Turn] = []

    def seen(self, status: str) -> bool:
        return status in self._sent

    async def set(self, status: Status) -> None:
        if status in self._sent:
            return
        if self._sent and self.ORDER[status] < self.ORDER[self._sent[-1]]:
            return
        if self._sent and self._sent[-1] in ("ended", "failed"):
            return
        self._sent.append(status)
        await self._on_status(status)


def _json(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _phone_call_result(conv: dict) -> str | None:
    phone = (conv.get("metadata") or {}).get("phone_call") or {}
    result = phone.get("call_result") if isinstance(phone, dict) else None
    return result if isinstance(result, str) else None


def transcript_from(conv: dict) -> list[Turn]:
    """ElevenLabs transcript (role agent|user, message) -> contract turns (me|them)."""
    turns: list[Turn] = []
    for item in conv.get("transcript") or []:
        if not isinstance(item, dict):
            continue
        text = item.get("message")
        if not isinstance(text, str) or not text.strip():
            continue  # tool calls etc. have no message
        who = "me" if item.get("role") == "agent" else "them"
        turns.append({"who": who, "text": text.strip()})
    return turns


def summarize(transcript: list[Turn], analysis_summary: str | None, limit: int = 240) -> str:
    """Prefer ElevenLabs' analysis summary; else a short digest of what they said."""
    if isinstance(analysis_summary, str) and analysis_summary.strip():
        return _clip(analysis_summary.strip(), limit)
    theirs = [t["text"] for t in transcript if t["who"] == "them"]
    if not theirs:
        return "The call connected but they didn't say anything."
    picked = theirs if len(theirs) <= 2 else [theirs[0], theirs[-1]]
    quoted = " … ".join(f"“{_clip(t, 100)}”" for t in picked)
    return _clip(f"They said: {quoted}", limit)


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"

