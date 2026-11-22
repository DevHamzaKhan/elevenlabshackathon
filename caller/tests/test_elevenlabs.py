"""Real-mode dialer against a mocked ElevenLabs API (httpx.MockTransport). No network."""

import asyncio
import json

import httpx

from caller.dialer import CallRequest, ElevenLabsDialer, summarize, transcript_from

CALL = CallRequest(id="o9", to="+14155550123", goal="Say I'm late.", context="Alex is a friend.")
KEY = "sk_test_not_a_real_key"


class FakeEleven:
    """Scripted ElevenLabs: outbound-call response + a list of conversation snapshots."""

    def __init__(self, snapshots, outbound=None, outbound_status=200):
        self.snapshots = list(snapshots)
        self.outbound = outbound or {"success": True, "message": "ok",
                                     "conversation_id": "conv_1", "callSid": "CA123"}
        self.outbound_status = outbound_status
        self.requests: list[httpx.Request] = []
        self.polls = 0

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        if req.method == "POST" and req.url.path == "/v1/convai/twilio/outbound-call":
            return httpx.Response(self.outbound_status, json=self.outbound)
        if req.method == "GET" and req.url.path == "/v1/convai/conversations/conv_1":
            snap = self.snapshots[min(self.polls, len(self.snapshots) - 1)]
            self.polls += 1
            if isinstance(snap, int):
                return httpx.Response(snap, json={"detail": "nope"})
            return httpx.Response(200, json=snap)
        return httpx.Response(404)


def conv(status, transcript=(), summary=None, call_result=None):
    c = {"conversation_id": "conv_1", "agent_id": "agent_1", "status": status,
         "transcript": [{"role": r, "message": msg, "time_in_call_secs": i}
                        for i, (r, msg) in enumerate(transcript)],
         "metadata": {"start_time_unix_secs": 0, "call_duration_secs": 12,
                      "phone_call": {"type": "twilio", "direction": "outbound",
                                     "call_result": call_result}}}
    if summary is not None:
        c["analysis"] = {"call_successful": "success", "transcript_summary": summary}
    return c


TALK = [("agent", "Hey Alex, it's me."), ("user", "Hi!"), ("agent", None),
        ("agent", "I'm running 20 minutes late, does 3pm still work?"), ("user", "Sure, 3 is fine.")]


def run(fake, **kw):
    dialer = ElevenLabsDialer(KEY, "agent_1", "phnum_1", poll_interval_s=0.01,
                              transport=httpx.MockTransport(fake), **kw)
    statuses: list[str] = []

    async def on_status(s):
        statuses.append(s)

    outcome = asyncio.run(dialer.dial(CALL, on_status))
    return outcome, statuses


def test_happy_path():
    fake = FakeEleven([404, conv("initiated"), conv("in-progress", TALK[:2]),
                       conv("in-progress", TALK), conv("processing", TALK),
                       conv("done", TALK, summary="Alex said 3pm works.", call_result="answered")])
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "answered", "ended"]
    assert outcome.ok and outcome.summary == "Alex said 3pm works."
    assert outcome.transcript == [
        {"who": "me", "text": "Hey Alex, it's me."}, {"who": "them", "text": "Hi!"},
        {"who": "me", "text": "I'm running 20 minutes late, does 3pm still work?"},
        {"who": "them", "text": "Sure, 3 is fine."}]


def test_outbound_request_shape_and_auth():
    fake = FakeEleven([conv("done", TALK, summary="ok")])
    run(fake)
    post = fake.requests[0]
    assert post.headers["xi-api-key"] == KEY
    body = json.loads(post.content)
    assert body["agent_id"] == "agent_1"
    assert body["agent_phone_number_id"] == "phnum_1"
    assert body["to_number"] == "+14155550123"
    assert body["conversation_initiation_client_data"]["dynamic_variables"] == {
        "goal": "Say I'm late.", "context": "Alex is a friend."}


def test_timeout_is_failed():
    fake = FakeEleven([conv("in-progress", TALK[:2])])
    outcome, statuses = run(fake, timeout_s=0.2)
    assert statuses == ["dialing", "answered", "failed"]
    assert not outcome.ok and outcome.error == "failed"


def test_timeout_while_ringing():
    fake = FakeEleven([conv("initiated")])
    outcome, statuses = run(fake, timeout_s=0.15)
    assert statuses == ["dialing", "failed"]
    assert outcome.error == "failed"


def test_busy():
    fake = FakeEleven([conv("initiated"), conv("done", call_result="busy")])
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "failed"]
    assert outcome.error == "busy"


def test_no_answer():
    fake = FakeEleven([conv("initiated"), conv("failed", call_result="no_answer")])
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "failed"] and outcome.error == "no_answer"


def test_done_without_transcript_is_no_answer():
    fake = FakeEleven([conv("done")])
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "failed"] and outcome.error == "no_answer"


def test_conversation_failed_after_answer():
    fake = FakeEleven([conv("in-progress", TALK[:2]), conv("failed", TALK[:2])])
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "answered", "failed"] and outcome.error == "failed"


def test_outbound_refused():
    fake = FakeEleven([], outbound={"success": False, "message": "bad number",
                                    "conversation_id": None, "callSid": None})
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "failed"] and outcome.error == "failed"


def test_outbound_http_error():
    fake = FakeEleven([], outbound={"detail": [{"msg": "invalid"}]}, outbound_status=422)
    outcome, statuses = run(fake)
    assert statuses == ["dialing", "failed"] and outcome.error == "failed"


def test_network_error_is_failed():
    def boom(req):
        raise httpx.ConnectError("down")

    dialer = ElevenLabsDialer(KEY, "a", "p", poll_interval_s=0.01, transport=httpx.MockTransport(boom))
    statuses = []

    async def on_status(s):
        statuses.append(s)

    outcome = asyncio.run(dialer.dial(CALL, on_status))
    assert statuses == ["dialing", "failed"] and outcome.error == "failed"


def test_summary_fallback_from_their_turns():
    tr = transcript_from(conv("done", TALK))
    s = summarize(tr, None)
    assert "Hi!" in s and "Sure, 3 is fine." in s
    assert summarize(tr, "  ") == s
    assert summarize([], None)
