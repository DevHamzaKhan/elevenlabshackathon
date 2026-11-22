"""Turns a `call` frame into call_status frames and exactly one call_result."""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from . import messages as m
from .dialer import CallRequest, Dialer
from .phone import is_allowed

log = logging.getLogger("caller.handler")

Send = Callable[[dict], Awaitable[None]]


class CallHandler:
    """One call at a time. Every `call` with an id gets exactly one `call_result`."""

    def __init__(self, dialer: Dialer, allowlist: frozenset[str], send: Send):
        self.dialer = dialer
        self.allowlist = allowlist
        self.send = send
        self._current: asyncio.Task | None = None

    @property
    def busy(self) -> bool:
        return self._current is not None and not self._current.done()

    async def on_call(self, frame: dict) -> asyncio.Task | None:
        """Handle one incoming `call`. Returns the running call task, if one was started."""
        call_id = frame.get("id")
        if not isinstance(call_id, str) or not call_id:
            log.warning("ignoring call without an id")
            return None
        to = frame.get("to")
        if not is_allowed(to, self.allowlist):
            log.warning("call %s refused: number not in CALL_ALLOWLIST or not E.164", call_id)
            await self.send(m.call_result_error(call_id, "not_allowed"))
            return None
        if self.busy:
            log.warning("call %s refused: already on a call", call_id)
            await self.send(m.call_result_error(call_id, "busy"))
            return None
        call = CallRequest(
            id=call_id,
            to=to,
            goal=_str(frame.get("goal")),
            context=_str(frame.get("context")),
        )
        self._current = asyncio.create_task(self._run(call), name=f"call-{call_id}")
        return self._current

    async def _run(self, call: CallRequest) -> None:
        async def on_status(status: m.Status) -> None:
            await self.send(m.call_status(call.id, status))

        try:
            outcome = await self.dialer.dial(call, on_status)
        except asyncio.CancelledError:
            await self.send(m.call_result_error(call.id, "failed"))
            raise
        except Exception:
            log.exception("call %s crashed", call.id)
            await self.send(m.call_result_error(call.id, "failed"))
            return
        if outcome.ok:
            await self.send(m.call_result_ok(call.id, outcome.summary, outcome.transcript))
        else:
            await self.send(m.call_result_error(call.id, outcome.error or "failed",
                                                outcome.summary, outcome.transcript))


def _str(v: object) -> str:
    return v if isinstance(v, str) else ""
