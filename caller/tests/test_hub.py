"""HubClient against an in-process websockets server."""

import asyncio
import json

from websockets.asyncio.server import serve

from caller.hub import HubClient, backoff_delay, hub_endpoint


def test_endpoint_and_backoff():
    assert hub_endpoint("ws://h:8765/", "a b") == "ws://h:8765/caller?token=a%20b"
    assert [backoff_delay(i) for i in range(6)] == [1, 2, 5, 5, 5, 5]


def test_hello_welcome_call_then_4001_exits():
    async def go():
        got = []
        handled = []

        async def server(ws):
            got.append(ws.request.path)
            got.append(json.loads(await ws.recv()))
            await ws.send(json.dumps({"type": "welcome", "v": 2}))
            await ws.send("not json")
            await ws.send(json.dumps({"type": "mystery", "z": 1}))
            await ws.send(json.dumps({"type": "call", "id": "o1"}))
            got.append(json.loads(await ws.recv()))
            await ws.close(4001, "replaced")

        async def on_frame(frame):
            handled.append(frame)
            if frame["type"] == "call":
                await client.send({"type": "call_result", "re": "o1", "ok": False, "error": "busy"})

        async with serve(server, "localhost", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = HubClient(f"ws://localhost:{port}", "tok", on_frame, backoff=(0.05,))
            await asyncio.wait_for(client.run(), 5)  # returns only because of 4001
        return got, handled

    got, handled = asyncio.run(go())
    assert got[0] == "/caller?token=tok"
    assert got[1] == {"type": "hello", "role": "caller", "v": 2}
    assert got[2]["type"] == "call_result"
    assert [f["type"] for f in handled] == ["mystery", "call"]


def test_reconnects_after_drop_and_4003():
    async def go():
        connects = 0

        async def server(ws):
            nonlocal connects
            connects += 1
            await ws.recv()
            if connects == 1:
                await ws.close(4003, "bad token")
            elif connects == 2:
                await ws.close(1011)
            else:
                await ws.close(4001)

        async with serve(server, "localhost", 0) as srv:
            port = srv.sockets[0].getsockname()[1]

            async def on_frame(f):
                pass

            client = HubClient(f"ws://localhost:{port}", "tok", on_frame, backoff=(0.01, 0.02))
            await asyncio.wait_for(client.run(), 5)
        return connects

    assert asyncio.run(go()) == 3


def test_sends_queue_while_disconnected_and_flush_after_welcome():
    async def go():
        received = []

        async def server(ws):
            await ws.recv()
            await ws.send(json.dumps({"type": "welcome", "v": 2}))
            received.append(json.loads(await ws.recv()))
            await ws.close(4001)

        async def on_frame(f):
            pass

        async with serve(server, "localhost", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = HubClient(f"ws://localhost:{port}", "tok", on_frame, backoff=(0.01,))
            await client.send({"type": "call_result", "re": "o5", "ok": False, "error": "failed"})
            await asyncio.wait_for(client.run(), 5)
        return received

    assert asyncio.run(go()) == [{"type": "call_result", "re": "o5", "ok": False, "error": "failed"}]
