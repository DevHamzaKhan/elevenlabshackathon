# /// script
# requires-python = ">=3.12"
# dependencies = ["websockets>=13"]
# ///
"""Pretend Orchestrator for the Caller (contract v2).

Listens on ws://localhost:<port>/caller, accepts the caller's hello with welcome,
sends one `call`, prints every frame, and exits:
  0  when a well-formed call_result arrives (status sequence and shape valid)
  1  on timeout or a malformed frame/sequence

    uv run fakes/hub.py                      # port 8765, calls +14155550123
    uv run fakes/hub.py --port 8799 --to +15550000000 --expect-error not_allowed
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

from websockets.asyncio.server import ServerConnection, serve

STATUSES = ("dialing", "answered", "ended", "failed")
ERRORS = ("not_allowed", "no_answer", "busy", "failed")
GOAL = "Say I'm running 20 minutes late and ask if 3pm still works."
CONTEXT = "You are speaking as the phone's owner. Alex is a friend and expects this call."


def say(direction: str, frame: object) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"{stamp} {direction} {json.dumps(frame)}", flush=True)


def check_status_sequence(seq: list[str]) -> str | None:
    """Statuses must be unique, each a valid value, in order dialing → answered → ended|failed."""
    order = {"dialing": 0, "answered": 1, "ended": 2, "failed": 2}
    for s in seq:
        if s not in STATUSES:
            return f"unknown status {s!r}"
    if len(set(seq)) != len(seq):
        return f"repeated status in {seq}"
    if [order[s] for s in seq] != sorted(order[s] for s in seq):
        return f"statuses out of order: {seq}"
    if "ended" in seq and "failed" in seq:
        return f"both ended and failed: {seq}"
    return None


def check_result(frame: dict, call_id: str, statuses: list[str]) -> str | None:
    if frame.get("re") != call_id:
        return f"call_result re={frame.get('re')!r}, expected {call_id!r}"
    ok = frame.get("ok")
    if not isinstance(ok, bool):
        return "call_result.ok must be a boolean"
    if ok:
        if not isinstance(frame.get("summary"), str) or not frame["summary"]:
            return "ok call_result needs a non-empty summary"
        tr = frame.get("transcript")
        if not isinstance(tr, list) or not tr:
            return "ok call_result needs a non-empty transcript list"
        for t in tr:
            if not (isinstance(t, dict) and t.get("who") in ("me", "them") and isinstance(t.get("text"), str)):
                return f"bad transcript turn {t!r}"
        if statuses != ["dialing", "answered", "ended"]:
            return f"ok call expected dialing, answered, ended; got {statuses}"
    else:
        if frame.get("error") not in ERRORS:
            return f"call_result.error must be one of {ERRORS}, got {frame.get('error')!r}"
        if frame["error"] in ("not_allowed", "busy") and statuses:
            return f"{frame['error']} must come with no call_status, got {statuses}"
    return None


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--to", default="+14155550123")
    ap.add_argument("--goal", default=GOAL)
    ap.add_argument("--context", default=CONTEXT)
    ap.add_argument("--token", default=None, help="if set, refuse other tokens with close 4003")
    ap.add_argument("--timeout", type=float, default=30.0, help="seconds to wait for call_result")
    ap.add_argument("--expect-error", choices=ERRORS, default=None,
                    help="require ok:false with this error (default: any well-formed result)")
    args = ap.parse_args()

    done: asyncio.Future[int] = asyncio.get_running_loop().create_future()

    def finish(code: int, why: str) -> None:
        print(("PASS: " if code == 0 else "FAIL: ") + why, flush=True)
        if not done.done():
            done.set_result(code)

    async def handler(ws: ServerConnection) -> None:
        path = ws.request.path if ws.request else ""
        if not path.startswith("/caller"):
            print(f"rejecting connection on {path.split('?')[0]!r}", flush=True)
            await ws.close(1008, "only /caller here")
            return
        if args.token is not None and f"token={args.token}" not in path:
            await ws.close(4003, "bad token")
            return
        hello = json.loads(await ws.recv())
        say("<-", hello)
        if hello.get("type") != "hello" or hello.get("role") != "caller":
            finish(1, f"first frame must be hello role caller, got {hello}")
            await ws.close(1008)
            return
        if hello.get("v") != 2:
            await ws.close(4002, "want v2")
            finish(1, f"hello v={hello.get('v')!r}, expected 2")
            return
        for frame in ({"type": "welcome", "v": 2},
                      {"type": "peers", "exec": True, "caller": True, "future_field": 1},
                      {"type": "something_new", "x": 1}):  # caller must ignore these
            await ws.send(json.dumps(frame))
            say("->", frame)
        call = {"type": "call", "id": "o9", "to": args.to, "goal": args.goal, "context": args.context}
        await ws.send(json.dumps(call))
        say("->", call)

        statuses: list[str] = []
        async for raw in ws:
            frame = json.loads(raw)
            say("<-", frame)
            kind = frame.get("type")
            if kind == "call_status":
                if frame.get("re") != call["id"]:
                    finish(1, f"call_status re={frame.get('re')!r}")
                    return
                statuses.append(frame.get("status"))
                problem = check_status_sequence(statuses)
                if problem:
                    finish(1, problem)
                    return
            elif kind == "call_result":
                problem = check_result(frame, call["id"], statuses)
                if not problem and args.expect_error and (frame.get("ok") or frame.get("error") != args.expect_error):
                    problem = f"expected error {args.expect_error!r}, got ok={frame.get('ok')} error={frame.get('error')!r}"
                if problem:
                    finish(1, problem)
                else:
                    finish(0, f"call_result ok={frame['ok']} after statuses {statuses}")
                # Wait briefly for any (illegal) second call_result.
                try:
                    extra = await asyncio.wait_for(ws.recv(), 1.0)
                    if json.loads(extra).get("type") == "call_result":
                        print("FAIL: a second call_result arrived", flush=True)
                        done_code[0] = 1
                except (asyncio.TimeoutError, TimeoutError, Exception):
                    pass
                return

    done_code = [0]
    async with serve(handler, args.host, args.port):
        print(f"fake hub listening on ws://{args.host}:{args.port}/caller", flush=True)
        try:
            code = await asyncio.wait_for(done, args.timeout)
        except (asyncio.TimeoutError, TimeoutError):
            print(f"FAIL: no call_result within {args.timeout:.0f}s", flush=True)
            return 1
        # give the handler its 1 s window to spot a duplicate call_result
        await asyncio.sleep(1.1)
        return code or done_code[0]


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
