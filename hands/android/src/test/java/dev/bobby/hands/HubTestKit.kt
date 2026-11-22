package dev.bobby.hands

import org.json.JSONObject

class FakeConn(val name: String = "conn") : HubConn {
  val sent = mutableListOf<String>()
  val closes = mutableListOf<Int>()
  override fun send(text: String) { sent.add(text) }
  override fun close(code: Int, reason: String) { closes.add(code) }
  fun frames(): List<JSONObject> = sent.map { JSONObject(it) }
  fun ofType(t: String) = frames().filter { it.optString("type") == t }
  fun lastPeers(): JSONObject = ofType("peers").last()
  fun clear() = sent.clear()
  override fun toString() = name
}

class HubKit(token: String? = "tok", now: Long = 1790000000000L) {
  val toHands = mutableListOf<String>()
  val hub = HubCore(token, { toHands.add(it) }, clock = { now })

  fun open(role: String, token: String? = "tok"): FakeConn {
    val c = FakeConn(role)
    hub.onOpen(c, if (token == null) "/$role" else "/$role?token=$token")
    return c
  }

  fun join(role: String): FakeConn {
    val c = open(role)
    hub.onMessage(c, """{"type":"hello","role":"$role","v":1}""")
    return c
  }
}
