"""Builders for the frames the Caller sends (CONTRACT.md, "Connecting" and "Caller")."""

from __future__ import annotations

from typing import Literal, TypedDict

PROTOCOL_VERSION = 2
ROLE = "caller"

Status = Literal["dialing", "answered", "ended", "failed"]
CallError = Literal["not_allowed", "no_answer", "busy", "failed"]
STATUSES: tuple[str, ...] = ("dialing", "answered", "ended", "failed")
ERRORS: tuple[str, ...] = ("not_allowed", "no_answer", "busy", "failed")


class Turn(TypedDict):
    who: Literal["me", "them"]
    text: str


def hello() -> dict:
    return {"type": "hello", "role": ROLE, "v": PROTOCOL_VERSION}


def call_status(re: str, status: Status) -> dict:
    assert status in STATUSES, status
    return {"type": "call_status", "re": re, "status": status}


def call_result_ok(re: str, summary: str, transcript: list[Turn]) -> dict:
    return {
        "type": "call_result",
        "re": re,
        "ok": True,
        "summary": summary,
        "transcript": [{"who": t["who"], "text": t["text"]} for t in transcript],
    }


def call_result_error(re: str, error: CallError, summary: str | None = None,
                      transcript: list[Turn] | None = None) -> dict:
    assert error in ERRORS, error
    msg: dict = {"type": "call_result", "re": re, "ok": False, "error": error}
    # Extra fields are allowed by the contract; include what we heard if anything.
    if summary:
        msg["summary"] = summary
    if transcript:
        msg["transcript"] = [{"who": t["who"], "text": t["text"]} for t in transcript]
    return msg
