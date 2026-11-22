"""Hub client for contract v2, role `caller`.

Connects to ws://<host>:8765/caller?token=..., sends hello, expects welcome, and
reconnects forever (1 s, 2 s, 5 s, then every 5 s) except after close code 4001.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from typing import Awaitable, Callable
from urllib.parse import quote

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidURI

from . import messages as m
from .framelog import FrameLog, NullLog

log = logging.getLogger("caller.hub")

BACKOFF = (1.0, 2.0, 5.0)
CLOSE_REPLACED = 4001
CLOSE_BAD_VERSION = 4002
CLOSE_BAD_TOKEN = 4003

OnFrame = Callable[[dict], Awaitable[None]]


def hub_endpoint(hub_url: str, token: str) -> str:
    return f"{hub_url.rstrip('/')}/{m.ROLE}?token={quote(token, safe='')}"


def backoff_delay(attempt: int, schedule: tuple[float, ...] = BACKOFF) -> float:
    return schedule[min(attempt, len(schedule) - 1)]


class Replaced(Exception):
    """The hub closed us with 4001: a newer caller took over. Never reconnect."""


class HubClient:
    def __init__(self, hub_url: str, token: str, on_frame: OnFrame,
                 frame_log: FrameLog | NullLog | None = None,
                 backoff: tuple[float, ...] = BACKOFF):
        self.url = hub_endpoint(hub_url, token)
        self.safe_url = f"{hub_url.rstrip('/')}/{m.ROLE}?token=***"
        self.on_frame = on_frame
        self.frame_log = frame_log or NullLog()
        self.backoff = backoff
        self._ws: ClientConnection | None = None
        self._outbox: deque[dict] = deque()
        self._tasks: set[asyncio.Task] = set()

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def send(self, frame: dict) -> None:
        """Send now, or queue until the next welcome if the hub is unreachable."""
        ws = self._ws
        if ws is None:
            self._outbox.append(frame)
            return
        try:
            await self._send_raw(ws, frame)
        except ConnectionClosed:
            self._outbox.append(frame)

    async def _send_raw(self, ws: ClientConnection, frame: dict) -> None:
        await ws.send(json.dumps(frame))
        self.frame_log.write("out", frame)

    async def run(self) -> None:
        """Run until replaced (4001). Returns normally in that case."""
        attempt = 0
        while True:
            try:
                welcomed = await self._session()
                if welcomed:
                    attempt = 0
            except Replaced:
                log.error("hub closed with 4001: another caller replaced this one; exiting")
                return
            delay = backoff_delay(attempt, self.backoff)
            attempt += 1
            log.info("reconnecting in %.0f s", delay)
            await asyncio.sleep(delay)

    async def _session(self) -> bool:
        welcomed = False
        try:
            log.info("connecting to %s", self.safe_url)
            async with connect(self.url, open_timeout=5, ping_interval=20) as ws:
                await self._send_raw(ws, m.hello())
                async for raw in ws:
                    frame = self._parse(raw)
                    if frame is None:
                        continue
                    if not welcomed:
                        if frame.get("type") != "welcome":
                            log.warning("expected welcome, got %r; ignoring", frame.get("type"))
                            continue
                        welcomed = True
                        self._ws = ws
                        log.info("welcomed by hub (v=%s)", frame.get("v"))
                        await self._flush()
                        continue
                    task = asyncio.create_task(self._dispatch(frame))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
                self._closed(ws.close_code, ws.close_reason)
        except ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd else None
            self._closed(code, e.rcvd.reason if e.rcvd else "")
        except (OSError, InvalidHandshake, InvalidURI, TimeoutError) as e:
            log.warning("hub unreachable: %s", type(e).__name__)
        finally:
            self._ws = None
        return welcomed

    def _closed(self, code: int | None, reason: str | None) -> None:
        self.frame_log.write("event", {"closed": code, "reason": reason or ""})
        if code == CLOSE_REPLACED:
            raise Replaced()
        if code == CLOSE_BAD_TOKEN:
            log.error("hub closed with 4003: wrong HUB_TOKEN. Fix HUB_TOKEN in the root .env.")
        elif code == CLOSE_BAD_VERSION:
            log.error("hub closed with 4002: protocol version mismatch (caller speaks v%d).",
                      m.PROTOCOL_VERSION)
        else:
            log.warning("hub connection closed (code=%s)", code)

    async def _flush(self) -> None:
        while self._outbox and self._ws is not None:
            frame = self._outbox.popleft()
            try:
                await self._send_raw(self._ws, frame)
            except ConnectionClosed:
                self._outbox.appendleft(frame)
                return

    def _parse(self, raw: str | bytes) -> dict | None:
        try:
            frame = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            self.frame_log.write("in", None, raw=str(raw)[:500], error="bad_json")
            log.warning("ignoring non-JSON frame")
            return None
        self.frame_log.write("in", frame)
        if not isinstance(frame, dict):
            return None
        return frame

    async def _dispatch(self, frame: dict) -> None:
        try:
            await self.on_frame(frame)
        except Exception:
            log.exception("error handling %r frame", frame.get("type"))
