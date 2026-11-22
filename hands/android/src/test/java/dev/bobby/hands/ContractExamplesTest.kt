package dev.bobby.hands

import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test
import java.io.File

/** Every JSON example in CONTRACT.md parses, and the ones Hands or the hub handle round-trip. */
class ContractExamplesTest {
  companion object {
    private lateinit var contract: String
    /** Objects from ```json blocks. */
    private lateinit var blockExamples: List<JSONObject>
    /** Objects from inline `{"...}` code spans (the tables). */
    private lateinit var inlineExamples: List<JSONObject>
    private val all get() = blockExamples + inlineExamples
    private const val NOW = 1790000000000L

    fun findContract(): File {
      var dir: File? = File(System.getProperty("user.dir")).absoluteFile
      while (dir != null) {
        val f = File(dir, "CONTRACT.md")
        if (f.isFile) return f
        dir = dir.parentFile
      }
      throw AssertionError("CONTRACT.md not found above ${System.getProperty("user.dir")}")
    }

    fun parseAll(src: String, where: String): List<JSONObject> {
      val out = ArrayList<JSONObject>()
      val t = JSONTokener(src)
      while (true) {
        val c = t.nextClean()
        if (c == 0.toChar()) break
        t.back()
        val v = try { t.nextValue() } catch (e: Exception) { throw AssertionError("bad JSON in $where: ${e.message}\n$src", e) }
        if (v !is JSONObject) throw AssertionError("non-object JSON in $where: $v")
        out.add(v)
      }
      return out
    }

    @BeforeClass @JvmStatic fun load() {
      contract = findContract().readText()
      val blocks = Regex("```json\\s*\\n(.*?)```", RegexOption.DOT_MATCHES_ALL).findAll(contract).map { it.groupValues[1] }.toList()
      blockExamples = blocks.flatMapIndexed { i, b -> parseAll(b, "json block #$i") }
      val spans = Regex("`(\\{\"[^`]*\\})`").findAll(contract).map { it.groupValues[1] }.toList()
      inlineExamples = spans.flatMap { parseAll(it, "inline `$it`") }
    }

    fun examples(type: String) = all.filter { it.optString("type") == type }
  }

  @Test fun everyJsonBlockParses() {
    val blocks = Regex("```json").findAll(contract).count()
    assertTrue("expected json blocks in CONTRACT.md", blocks >= 6)
    assertTrue(blockExamples.size >= blocks)
    // The act_result block holds two objects on consecutive lines.
    assertEquals(2, blockExamples.count { it.optString("type") == "act_result" })
  }

  @Test fun coversTheTypesHandsAndHubHandle() {
    val types = all.map { it.optString("type") }.toSet()
    for (t in listOf("screen", "act", "screen_result", "act_result", "notification", "peers", "wire", "task", "plan", "hello", "welcome")) {
      assertTrue("CONTRACT.md has no example of '$t' (found $types)", t in types)
    }
  }

  @Test fun screenExampleRoutedToHandsUnchanged() {
    for (ex in examples("screen")) {
      assertEquals("hands", ex.getString("to"))
      assertNotNull(ex.optString("id", null))
      val k = HubKit()
      val m = k.join("mind")
      k.hub.onMessage(m, ex.toString())
      assertEquals(1, k.toHands.size)
      assertJsonEq(ex, JSONObject(k.toHands[0]))
    }
  }

  @Test fun actExamplesDecode() {
    val acts = examples("act")
    assertTrue(acts.isNotEmpty())
    for (ex in acts) {
      val a = Protocol.parseAct(ex)
      assertEquals(ex.getString("do"), a.what)
      assertEquals(ex.optString("id"), a.id)
    }
    val first = Protocol.parseAct(acts.first { it.optString("id") == "m2" })
    assertEquals("tap", first.what)
    assertEquals(Target.Text("Reply"), first.on)
  }

  @Test fun targetFormExamplesDecode() {
    val targets = inlineExamples.filter { !it.has("type") && (it.has("n") || it.has("text") || it.has("x")) }
    val parsed = targets.map { Protocol.parseTarget(it) }
    assertTrue(Target.Index(0) in parsed)
    assertTrue(Target.Text("Reply") in parsed)
    assertTrue(Target.Point(540, 1200) in parsed)
  }

  @Test fun screenResultExampleReencodes() {
    for (ex in examples("screen_result")) {
      val size = ex.getJSONArray("size")
      val arr = ex.getJSONArray("nodes")
      val nodes = (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        val b = o.getJSONArray("bounds")
        ScreenNode(
          o.getInt("n"), o.getString("text"), o.getString("desc"), o.getString("cls"),
          IntArray(4) { b.getInt(it) }, o.getBoolean("tap"), o.getBoolean("edit"), o.getBoolean("scroll"),
          hint = o.optString("hint", ""),
        )
      }
      val got = Protocol.screenResult(ex.optString("re", null), ex.getString("app"), size.getInt(0), size.getInt(1), nodes)
      assertJsonEq(ex, got)
    }
  }

  @Test fun actResultExamplesReencode() {
    val ex = examples("act_result")
    assertTrue(ex.isNotEmpty())
    for (e in ex) {
      val got = Protocol.actResult(e.optString("re", null), e.getBoolean("ok"), e.optString("error", null))
      assertJsonEq(e, got)
      if (!e.getBoolean("ok")) assertTrue(e.getString("error") in Protocol.ERRORS)
    }
  }

  @Test fun notificationExampleReencodes() {
    for (e in examples("notification")) {
      assertJsonEq(e, Protocol.notification(e.getString("app"), e.getString("title"), e.getString("text"), e.getLong("at")))
    }
  }

  @Test fun helloWelcomeExamples() {
    val hello = examples("hello").first()
    val welcome = examples("welcome").first()
    val k = HubKit()
    val c = k.open(hello.getString("role"))
    k.hub.onMessage(c, hello.toString())
    assertJsonEq(welcome, c.frames()[0])
  }

  @Test fun peersExampleMatchesHub() {
    for (ex in examples("peers")) {
      val k = HubKit()
      val roles = listOf("mind", "mouth", "caller").filter { ex.getBoolean(it) }
      val conns = roles.map { k.join(it) }
      k.hub.handsOn = ex.getBoolean("hands")
      val got = k.hub.peers()
      // Every contract field is present with the same value (extra fields are allowed).
      for (key in ex.keyNames()) assertEquals(key, ex.get(key), got.get(key))
      // And the mind actually receives that frame.
      val mind = conns[roles.indexOf("mind")]
      val last = mind.lastPeers()
      for (key in ex.keyNames()) assertEquals(key, ex.get(key), last.get(key))
    }
  }

  @Test fun wireExampleProducedByHub() {
    for (ex in examples("wire")) {
      val from = ex.getString("from"); val to = ex.getString("to")
      val k = HubKit(now = ex.getLong("at"))
      val m = k.join("mind")
      val others = listOf("mouth", "caller").associateWith { k.join(it) }
      val w = k.join("watch"); w.clear()
      val msg = ex.getJSONObject("msg").toString()
      when (from) {
        "mind" -> k.hub.onMessage(m, msg)
        "hands" -> k.hub.fromHands(msg)
        else -> k.hub.onMessage(others.getValue(from), msg)
      }
      val wire = w.ofType("wire").single()
      assertEquals(to, wire.getString("to"))
      assertJsonEq(ex, wire)
    }
  }

  @Test fun watchExamplesForwardedAndReplayed() {
    val task = examples("task").first()
    val plan = examples("plan").first()
    val step = examples("step").firstOrNull()
    val k = HubKit()
    val m = k.join("mind")
    val w1 = k.join("watch"); w1.clear()
    k.hub.onMessage(m, task.toString())
    k.hub.onMessage(m, plan.toString())
    step?.let { k.hub.onMessage(m, it.toString()) }
    assertJsonEq(task, w1.ofType("task").single())
    assertJsonEq(plan, w1.ofType("plan").single())
    step?.let { assertJsonEq(it, w1.ofType("step").single()) }
    assertTrue(w1.ofType("wire").isEmpty())
    if (task.getString("status") == "started") {
      val w2 = k.join("watch")
      assertJsonEq(task, w2.ofType("task").single())
      assertJsonEq(plan, w2.ofType("plan").single())
    }
  }

  @Test fun mouthAndCallerExamplesRoutedUnchanged() {
    val k = HubKit()
    val m = k.join("mind")
    val mouth = k.join("mouth"); val caller = k.join("caller")
    m.clear(); mouth.clear(); caller.clear()
    var n = 0
    for (ex in all) {
      val type = ex.optString("type")
      val to = ex.optString("to", "")
      if (to == "mouth" || to == "caller") {
        k.hub.onMessage(m, ex.toString())
        val target = if (to == "mouth") mouth else caller
        assertJsonEq(ex, target.frames().last()); n++
      } else if (type in setOf("wake", "heard", "spoke", "say_started", "say_done", "asleep")) {
        k.hub.onMessage(mouth, ex.toString())
        assertJsonEq(ex, m.frames().last()); n++
      } else if (type in setOf("call_status", "call_result")) {
        k.hub.onMessage(caller, ex.toString())
        assertJsonEq(ex, m.frames().last()); n++
      }
    }
    assertTrue("expected Mouth/Caller examples, routed $n", n >= 10)
  }

  @Test fun cursorExamplesGoToHands() {
    val cursors = examples("cursor")
    val k = HubKit()
    val m = k.join("mind")
    for (c in cursors) {
      assertEquals("hands", c.getString("to"))
      assertTrue(c.get("show") is Boolean)
      k.hub.onMessage(m, c.toString())
    }
    assertEquals(cursors.size, k.toHands.size)
  }

  @Test fun everyFrameExampleHasType() {
    for (ex in blockExamples) {
      if (!ex.has("type")) fail("json block example without type: $ex")
    }
  }
}
