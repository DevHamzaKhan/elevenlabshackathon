import json

from caller import messages as m


def test_hello():
    assert m.hello() == {"type": "hello", "role": "caller", "v": 2}


def test_contract_examples_round_trip(caller_examples):
    by_type = {o["type"]: o for o in caller_examples}
    assert set(by_type) == {"call", "call_status", "call_result"}

    status = by_type["call_status"]
    built = m.call_status(status["re"], status["status"])
    assert built == status
    assert json.loads(json.dumps(built)) == status

    result = by_type["call_result"]
    built = m.call_result_ok(result["re"], result["summary"], result["transcript"])
    assert built == result
    assert json.loads(json.dumps(built)) == result


def test_error_result_shape():
    assert m.call_result_error("o9", "not_allowed") == {
        "type": "call_result", "re": "o9", "ok": False, "error": "not_allowed"}


def test_all_statuses_build():
    for s in ("dialing", "answered", "ended", "failed"):
        assert m.call_status("o1", s)["status"] == s
