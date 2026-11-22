package dev.bobby.hands

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HubCoreTest {
  private val NOW = 1790000000000L

  // --- connecting ---

  @Test fun badTokenClosed4003() {
    val k = HubKit()
    val c = FakeConn()
    assertFalse(k.hub.onOpen(c, "/mind?token=nope"))
    assertEquals(listOf(4003), c.closes)
    // And it is not registered: its hello does nothing.
    k.hub.onMessage(c, """{"type":"hello","role":"mind","v":1}""")
    assertTrue(c.sent.isEmpty())
  }

  @Test fun missingTokenClosed4003() {
    val k = HubKit()
    val c = k.open("mind", token = null)
    assertEquals(listOf(4003), c.closes)
    val d = k.open("mind", token = "")
    assertEquals(listOf(4003), d.closes)
  }

  @Test fun unconfiguredHubRefuses() {
    val k = HubKit(token = null)
    val c = k.open("mind", token = "anything")
    assertEquals(listOf(4003), c.closes)
  }

  @Test fun urlEncodedTokenAccepted() {
    val k = HubKit(token = "a b+c")
    val c = FakeConn()
    assertTrue(k.hub.onOpen(c, "/mind?token=a%20b%2Bc"))
    assertTrue(c.closes.isEmpty())
  }

  @Test fun unknownRoleClosed() {
    val k = HubKit()
    for (role in listOf("hands", "admin", "")) {
      val c = FakeConn()
      assertFalse(k.hub.onOpen(c, "/$role?token=tok"))
      assertEquals(1, c.closes.size)
    }
  }

  @Test fun parsePath() {
    assertEquals("mind" to "tok", HubCore.parsePath("/mind?token=tok"))
    assertEquals("watch" to "t", HubCore.parsePath("/watch?x=1&token=t"))
    assertEquals("mouth" to null, HubCore.parsePath("/mouth"))
  }

  @Test fun helloGetsWelcomeThenPeers() {
    val k = HubKit()
    val m = k.join("mind")
    val f = m.frames()
    assertJsonEq(JSONObject("""{"type":"welcome","v":1}"""), f[0])
    assertEquals("peers", f[1].getString("type"))
    assertTrue(f[1].getBoolean("mind"))
    assertTrue(f[1].getBoolean("hands"))
    assertFalse(f[1].getBoolean("mouth"))
    assertFalse(f[1].getBoolean("caller"))
  }

  @Test fun framesBeforeHelloIgnored() {
    val k = HubKit()
    val m = k.open("mind")
    k.hub.onMessage(m, """{"type":"screen","to":"hands","id":"m1"}""")
    assertTrue(k.toHands.isEmpty())
    assertTrue(m.sent.isEmpty())
    // Mouth before hello: not delivered to the mind.
    val mind = k.join("mind"); mind.clear()
    val mouth = k.open("mouth")
    k.hub.onMessage(mouth, """{"type":"heard","text":"hi"}""")
    assertTrue(mind.sent.isEmpty())
    // Not even registered as a peer yet.
    k.hub.onMessage(mouth, """{"type":"hello","role":"mouth","v":1}""")
    assertTrue(mind.lastPeers().getBoolean("mouth"))
  }

  @Test fun invalidJsonIgnored() {
    val k = HubKit()
    val m = k.join("mind"); m.clear()
    k.hub.onMessage(m, "not json")
    k.hub.onMessage(m, "")
    k.hub.onMessage(m, "[1,2]")
    k.hub.fromHands("{broken")
    assertTrue(k.toHands.isEmpty())
    assertTrue(m.sent.isEmpty())
    assertTrue(m.closes.isEmpty())
  }

  // --- peers ---

  @Test fun peersBroadcastOnConnectAndDrop() {
    val k = HubKit()
    val m = k.join("mind")
    val w = k.join("watch")
    assertTrue(w.ofType("welcome").isNotEmpty())
    assertTrue(w.lastPeers().getBoolean("mind"))
    m.clear(); w.clear()

    val mouth = k.join("mouth")
    assertTrue(m.lastPeers().getBoolean("mouth"))
    assertTrue(w.lastPeers().getBoolean("mouth"))
    assertTrue(mouth.ofType("peers").isEmpty()) // peers only go to the mind and watches

    val caller = k.join("caller")
    assertTrue(m.lastPeers().getBoolean("caller"))
    assertTrue(w.lastPeers().getBoolean("caller"))

    m.clear(); w.clear()
    k.hub.onClose(mouth)
    assertFalse(m.lastPeers().getBoolean("mouth"))
    assertFalse(w.lastPeers().getBoolean("mouth"))
    assertTrue(w.lastPeers().getBoolean("caller"))

    w.clear()
    k.hub.onClose(m)
    assertFalse(w.lastPeers().getBoolean("mind"))
    k.hub.onClose(caller)
    assertFalse(w.lastPeers().getBoolean("caller"))
  }

  @Test fun closeBeforeHelloDoesNotBroadcast() {
    val k = HubKit()
    val m = k.join("mind"); m.clear()
    val mouth = k.open("mouth")
    k.hub.onClose(mouth)
    assertTrue(m.sent.isEmpty())
  }

  @Test fun handsOffDropsHandsFramesAndReportsIt() {
    val k = HubKit()
    val m = k.join("mind")
    val w = k.join("watch")
    m.clear(); w.clear()
    k.hub.handsOn = false
    assertFalse(m.lastPeers().getBoolean("hands"))
    assertFalse(w.lastPeers().getBoolean("hands"))
    assertFalse(k.hub.peers().getBoolean("hands"))
    w.clear()
    k.hub.onMessage(m, """{"type":"screen","to":"hands","id":"m1"}""")
    assertTrue(k.toHands.isEmpty())
    assertTrue(w.ofType("wire").isEmpty())
    k.hub.handsOn = true
    assertTrue(m.lastPeers().getBoolean("hands"))
    k.hub.onMessage(m, """{"type":"screen","to":"hands","id":"m1"}""")
    assertEquals(1, k.toHands.size)
  }

  // --- replacement ---

  @Test fun secondMindReplacesFirst() {
    val k = HubKit()
    val m1 = k.join("mind")
    val w = k.join("watch")
    val m2 = k.join("mind")
    assertEquals(listOf(4001), m1.closes)
    assertTrue(m2.closes.isEmpty())
    assertJsonEq(JSONObject("""{"type":"welcome","v":1}"""), m2.frames()[0])

    // The old socket's close arrives later: the new mind stays registered.
    w.clear(); m2.clear()
    k.hub.onClose(m1)
    assertTrue(k.hub.peers().getBoolean("mind"))
    assertTrue(w.ofType("peers").isEmpty() || w.lastPeers().getBoolean("mind"))

    // Frames go to the new mind only.
    m1.clear()
    k.hub.fromHands("""{"type":"act_result","re":"m2","ok":true}""")
    assertEquals(1, m2.ofType("act_result").size)
    assertTrue(m1.sent.isEmpty())

    // The old socket can't send anymore.
    k.hub.onMessage(m1, """{"type":"screen","to":"hands","id":"old"}""")
    assertTrue(k.toHands.isEmpty())
    k.hub.onMessage(m2, """{"type":"screen","to":"hands","id":"new"}""")
    assertEquals(1, k.toHands.size)
  }

  @Test fun secondMouthAndCallerReplaceFirst() {
    for (role in listOf("mouth", "caller")) {
      val k = HubKit()
      val mind = k.join("mind")
      val a = k.join(role)
      val b = k.join(role)
      assertEquals(listOf(4001), a.closes)
      k.hub.onClose(a)
      assertTrue(k.hub.peers().getBoolean(role))
      mind.clear()
      k.hub.onMessage(mind, """{"type":"say","to":"$role","id":"m5","text":"hi"}""")
      assertTrue(a.ofType("say").isEmpty())
      assertEquals(1, b.ofType("say").size)
    }
  }

  @Test fun manyWatchesAllowed() {
    val k = HubKit()
    val ws = (1..3).map { k.join("watch") }
    ws.forEach { assertTrue(it.closes.isEmpty()) }
    assertEquals(3, k.hub.peers().getInt("watch"))
  }

  // --- routing ---

  @Test fun mindToHandsRawUnchanged() {
    val k = HubKit()
    val m = k.join("mind")
    val raw = """{ "type":"act", "to":"hands","id":"m2","do":"tap","on":{"text":"Reply"}, "extra": [1, 2.50] }"""
    k.hub.onMessage(m, raw)
    assertEquals(listOf(raw), k.toHands)
  }

  @Test fun mindToMouthAndCallerUnchangedWhenConnected() {
    val k = HubKit()
    val m = k.join("mind")
    val mouth = k.join("mouth"); val caller = k.join("caller")
    mouth.clear(); caller.clear()
    val say = """{"type":"say","to":"mouth","id":"m5","text":"On it.",  "x":1.0}"""
    val call = """{"type":"call","to":"caller","id":"m9","number":"+14155550123","goal":"g","context":"c"}"""
    k.hub.onMessage(m, say)
    k.hub.onMessage(m, call)
    assertEquals(listOf(say), mouth.sent)
    assertEquals(listOf(call), caller.sent)
    assertTrue(k.toHands.isEmpty())
  }

  @Test fun mindToMissingPartDropped() {
    val k = HubKit()
    val m = k.join("mind")
    val w = k.join("watch")
    w.clear()
    k.hub.onMessage(m, """{"type":"say","to":"mouth","id":"m5","text":"x"}""")
    k.hub.onMessage(m, """{"type":"call","to":"caller","id":"m9","number":"+1"}""")
    assertTrue(w.ofType("wire").isEmpty())
    // A mouth that later joins doesn't get the dropped frame.
    val mouth = k.join("mouth")
    assertTrue(mouth.ofType("say").isEmpty())
  }

  @Test fun mindFramesWithoutKnownToDropped() {
    val k = HubKit()
    val m = k.join("mind")
    val mouth = k.join("mouth"); mouth.clear()
    val w = k.join("watch"); w.clear()
    k.hub.onMessage(m, """{"type":"say","id":"m5","text":"x"}""")
    k.hub.onMessage(m, """{"type":"say","to":"mind","id":"m6","text":"x"}""")
    k.hub.onMessage(m, """{"type":"say","to":"nobody","id":"m7","text":"x"}""")
    assertTrue(mouth.sent.isEmpty()); assertTrue(k.toHands.isEmpty()); assertTrue(w.sent.isEmpty())
    assertTrue(m.closes.isEmpty())
  }

  @Test fun mouthAndCallerGoToMindUnchanged() {
    val k = HubKit()
    val m = k.join("mind")
    val mouth = k.join("mouth"); val caller = k.join("caller")
    m.clear()
    val heard = """{"type":"heard","text":"reply to Sarah, tell her 3 works"}"""
    val status = """{"type":"call_status","re":"m9","status":"dialing"}"""
    k.hub.onMessage(mouth, heard)
    k.hub.onMessage(caller, status)
    assertEquals(listOf(heard, status), m.sent)
    // A mouth frame carrying `to` still goes to the mind.
    m.clear()
    val odd = """{"type":"spoke","to":"hands","text":"x"}"""
    k.hub.onMessage(mouth, odd)
    assertEquals(listOf(odd), m.sent)
    assertTrue(k.toHands.isEmpty())
  }

  @Test fun fromMindlessPartsDroppedWhenNoMind() {
    val k = HubKit()
    val mouth = k.join("mouth")
    val w = k.join("watch"); w.clear()
    k.hub.onMessage(mouth, """{"type":"heard","text":"x"}""")
    k.hub.fromHands("""{"type":"notification","app":"a","title":"t","text":"x","at":1}""")
    assertTrue(w.ofType("wire").isEmpty())
  }

  @Test fun fromHandsGoesToMind() {
    val k = HubKit()
    val m = k.join("mind"); m.clear()
    val raw = """{"type":"screen_result","re":"m1","app":"x","size":[1,2],"nodes":[]}"""
    k.hub.fromHands(raw)
    assertEquals(listOf(raw), m.sent)
  }

  // --- watch ---

  @Test fun watchGetsWireForEveryDeliveredFrame() {
    val k = HubKit(now = NOW)
    val m = k.join("mind")
    val mouth = k.join("mouth"); val caller = k.join("caller")
    val w = k.join("watch")
    w.clear()

    val toHands = """{"type":"screen","to":"hands","id":"m1"}"""
    val toMouth = """{"type":"say","to":"mouth","id":"m5","text":"hi"}"""
    val toCaller = """{"type":"call","to":"caller","id":"m9","number":"+14155550123"}"""
    val fromMouth = """{"type":"say_done","re":"m5"}"""
    val fromCaller = """{"type":"call_status","re":"m9","status":"dialing"}"""
    val fromHands = """{"type":"act_result","re":"m2","ok":true}"""
    k.hub.onMessage(m, toHands)
    k.hub.onMessage(m, toMouth)
    k.hub.onMessage(m, toCaller)
    k.hub.onMessage(mouth, fromMouth)
    k.hub.onMessage(caller, fromCaller)
    k.hub.fromHands(fromHands)

    val wires = w.ofType("wire")
    val expected = listOf(
      Triple("mind", "hands", toHands), Triple("mind", "mouth", toMouth), Triple("mind", "caller", toCaller),
      Triple("mouth", "mind", fromMouth), Triple("caller", "mind", fromCaller), Triple("hands", "mind", fromHands),
    )
    assertEquals(expected.size, wires.size)
    for ((i, e) in expected.withIndex()) {
      val wire = wires[i]
      assertEquals(setOf("type", "from", "to", "at", "msg"), wire.keyNames())
      assertEquals(e.first, wire.getString("from"))
      assertEquals(e.second, wire.getString("to"))
      assertEquals(NOW, wire.getLong("at"))
      assertJsonEq(JSONObject(e.third), wire.getJSONObject("msg"))
    }
  }

  @Test fun noWireForHelloWelcomeOrToWatch() {
    val k = HubKit()
    val w = k.join("watch")
    val m = k.join("mind")
    k.join("mouth")
    k.hub.onMessage(m, """{"type":"step","to":"watch","task":"t1","n":1,"status":"running"}""")
    k.hub.onMessage(m, """{"type":"hello","role":"mind","v":1}""") // repeated hello: ignored
    assertTrue(w.ofType("wire").isEmpty())
    assertEquals(1, w.ofType("step").size)
    assertEquals(1, w.ofType("welcome").size)
  }

  @Test fun toWatchDeliveredUnchangedToEveryWatch() {
    val k = HubKit()
    val m = k.join("mind")
    val w1 = k.join("watch"); val w2 = k.join("watch")
    w1.clear(); w2.clear()
    val raw = """{"type":"step","to":"watch","task":"t1","n":1,"status":"running"}"""
    k.hub.onMessage(m, raw)
    assertEquals(listOf(raw), w1.sent)
    assertEquals(listOf(raw), w2.sent)
  }

  @Test fun watchFramesIgnored() {
    val k = HubKit()
    val m = k.join("mind")
    val mouth = k.join("mouth")
    val w = k.join("watch")
    m.clear(); mouth.clear(); w.clear()
    k.hub.onMessage(w, """{"type":"screen","to":"hands","id":"w1"}""")
    k.hub.onMessage(w, """{"type":"say","to":"mouth","id":"w2","text":"x"}""")
    k.hub.onMessage(w, """{"type":"heard","text":"x"}""")
    assertTrue(k.toHands.isEmpty())
    assertTrue(m.sent.isEmpty()); assertTrue(mouth.sent.isEmpty()); assertTrue(w.sent.isEmpty())
  }

  @Test fun watchDropRemovesFromPeers() {
    val k = HubKit()
    val m = k.join("mind")
    val w = k.join("watch")
    assertEquals(1, k.hub.peers().getInt("watch"))
    m.clear()
    k.hub.onClose(w)
    assertEquals(0, k.hub.peers().getInt("watch"))
    assertTrue(m.ofType("peers").isNotEmpty())
  }

  @Test fun taskAndPlanReplayedWhileStarted() {
    val k = HubKit()
    val m = k.join("mind")
    val task = """{"type":"task","to":"watch","task":"t1","title":"Reply to Sarah","status":"started"}"""
    val plan = """{"type":"plan","to":"watch","task":"t1","steps":[{"n":1,"do":"Open Gmail","why":"Sarah's message is an email"}]}"""
    k.hub.onMessage(m, task)
    k.hub.onMessage(m, plan)
    val w = k.join("watch")
    val f = w.frames()
    assertEquals("welcome", f[0].getString("type"))
    assertJsonEq(JSONObject(task), w.ofType("task").single())
    assertJsonEq(JSONObject(plan), w.ofType("plan").single())
    assertEquals(1, w.ofType("peers").size)
  }

  @Test fun latestPlanReplayed() {
    val k = HubKit()
    val m = k.join("mind")
    k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t1","title":"T","status":"started"}""")
    k.hub.onMessage(m, """{"type":"plan","to":"watch","task":"t1","steps":[{"n":1,"do":"a","why":"b"}]}""")
    k.hub.onMessage(m, """{"type":"plan","to":"watch","task":"t1","steps":[{"n":1,"do":"a","why":"b"},{"n":2,"do":"c","why":"d"}]}""")
    val w = k.join("watch")
    assertEquals(2, w.ofType("plan").single().getJSONArray("steps").length())
  }

  @Test fun noReplayAfterTaskEnds() {
    for (status in listOf("done", "failed", "cancelled")) {
      val k = HubKit()
      val m = k.join("mind")
      k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t1","title":"T","status":"started"}""")
      k.hub.onMessage(m, """{"type":"plan","to":"watch","task":"t1","steps":[]}""")
      k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t1","title":"T","status":"$status"}""")
      val w = k.join("watch")
      assertTrue(status, w.ofType("task").isEmpty())
      assertTrue(status, w.ofType("plan").isEmpty())
    }
  }

  @Test fun newTaskClearsPlan() {
    val k = HubKit()
    val m = k.join("mind")
    k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t1","title":"A","status":"started"}""")
    k.hub.onMessage(m, """{"type":"plan","to":"watch","task":"t1","steps":[{"n":1,"do":"a","why":"b"}]}""")
    k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t2","title":"B","status":"started"}""")
    val w = k.join("watch")
    assertEquals("t2", w.ofType("task").single().getString("task"))
    assertTrue(w.ofType("plan").isEmpty())
  }

  @Test fun sameTaskUpdateKeepsPlan() {
    val k = HubKit()
    val m = k.join("mind")
    k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t1","title":"A","status":"started"}""")
    k.hub.onMessage(m, """{"type":"plan","to":"watch","task":"t1","steps":[]}""")
    k.hub.onMessage(m, """{"type":"task","to":"watch","task":"t1","title":"A, renamed","status":"started"}""")
    val w = k.join("watch")
    assertEquals("A, renamed", w.ofType("task").single().getString("title"))
    assertEquals(1, w.ofType("plan").size)
  }

  @Test fun noReplayWithoutTask() {
    val k = HubKit()
    val m = k.join("mind")
    k.hub.onMessage(m, """{"type":"plan","to":"watch","task":"t1","steps":[]}""")
    val w = k.join("watch")
    assertTrue(w.ofType("plan").isEmpty())
  }

  @Test fun closeAllClosesEveryone() {
    val k = HubKit()
    val a = k.join("mind"); val b = k.join("watch"); val c = k.open("mouth")
    k.hub.closeAll()
    listOf(a, b, c).forEach { assertEquals(1, it.closes.size) }
    assertFalse(k.hub.peers().getBoolean("mind"))
  }
}
