import asyncio

from caller.dialer import CallOutcome, DryRunDialer
from caller.handler import CallHandler
from caller.phone import parse_allowlist

ALLOW = parse_allowlist("+14155550123")
CALL = {"type": "call", "id": "o9", "to": "+14155550123",
        "goal": "Say I'm running 20 minutes late and ask if 3pm still works.",
        "context": "You are speaking as the phone's owner."}


def fast_dry():
    return DryRunDialer(ring_s=0.01, talk_s=0.01, wrap_s=0.01)


async def run_calls(dialer, *frames):
    sent: list[dict] = []

    async def send(f):
        sent.append(f)

    h = CallHandler(dialer, ALLOW, send)
    tasks = [await h.on_call(f) for f in frames]
    await asyncio.gather(*(t for t in tasks if t))
    return sent


def results(sent):
    return [f for f in sent if f["type"] == "call_result"]


def test_dry_run_sequence():
    sent = asyncio.run(run_calls(fast_dry(), CALL))
    statuses = [f["status"] for f in sent if f["type"] == "call_status"]
    assert statuses == ["dialing", "answered", "ended"]
    assert all(f["re"] == "o9" for f in sent)
    [res] = results(sent)
    assert sent[-1] is res
    assert res["ok"] is True and res["summary"]
    assert res["transcript"] and {t["who"] for t in res["transcript"]} == {"me", "them"}
    assert all(isinstance(t["text"], str) for t in res["transcript"])


def test_not_allowed_number():
    sent = asyncio.run(run_calls(fast_dry(), {**CALL, "to": "+14155550999"}))
    assert sent == [{"type": "call_result", "re": "o9", "ok": False, "error": "not_allowed"}]


def test_not_e164_is_not_allowed():
    sent = asyncio.run(run_calls(fast_dry(), {**CALL, "to": "4155550123"}))
    assert sent == [{"type": "call_result", "re": "o9", "ok": False, "error": "not_allowed"}]


def test_missing_to_is_not_allowed():
    c = dict(CALL)
    del c["to"]
    sent = asyncio.run(run_calls(fast_dry(), c))
    assert sent == [{"type": "call_result", "re": "o9", "ok": False, "error": "not_allowed"}]


def test_busy_second_call():
    sent = asyncio.run(run_calls(fast_dry(), CALL, {**CALL, "id": "o10"}))
    by_re = {}
    for f in results(sent):
        by_re.setdefault(f["re"], []).append(f)
    assert by_re["o10"] == [{"type": "call_result", "re": "o10", "ok": False, "error": "busy"}]
    assert len(by_re["o9"]) == 1 and by_re["o9"][0]["ok"] is True
    assert not [f for f in sent if f["type"] == "call_status" and f["re"] == "o10"]


def test_next_call_after_first_finishes():
    async def go():
        sent = []

        async def send(f):
            sent.append(f)

        h = CallHandler(fast_dry(), ALLOW, send)
        await (await h.on_call(CALL))
        await (await h.on_call({**CALL, "id": "o10"}))
        return sent

    sent = asyncio.run(go())
    assert [r["ok"] for r in results(sent)] == [True, True]


def test_crashing_dialer_still_sends_one_result():
    class Boom:
        async def dial(self, call, on_status):
            await on_status("dialing")
            raise RuntimeError("kaboom")

    sent = asyncio.run(run_calls(Boom(), CALL))
    assert results(sent) == [{"type": "call_result", "re": "o9", "ok": False, "error": "failed"}]


def test_failed_outcome_maps_error():
    class NoAnswer:
        async def dial(self, call, on_status):
            await on_status("dialing")
            await on_status("failed")
            return CallOutcome(ok=False, error="no_answer")

    sent = asyncio.run(run_calls(NoAnswer(), CALL))
    assert results(sent) == [{"type": "call_result", "re": "o9", "ok": False, "error": "no_answer"}]


def test_call_without_id_ignored():
    c = dict(CALL)
    del c["id"]
    assert asyncio.run(run_calls(fast_dry(), c)) == []
