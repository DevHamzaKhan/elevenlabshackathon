package dev.bobby.hands

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Act additions: open, id/key targets, options, intents, launch ranking, settle, caps. */
class ActV2Test {
  private fun act(s: String) = Protocol.parseAct(j(s))
  private fun bad(s: String) {
    try { act(s); fail("expected BadRequest for $s") } catch (e: BadRequest) { /* ok */ }
  }

  // --- parsing ---

  @Test fun newTargets() {
    assertEquals(Target.Id("compose_button"), act("""{"do":"tap","on":{"id":"compose_button"}}""").on)
    assertEquals(Target.Id("com.google.android.gm:id/compose_button"), act("""{"do":"tap","on":{"id":"com.google.android.gm:id/compose_button"}}""").on)
    assertEquals(Target.Key("k1a2b3c4d"), act("""{"do":"tap","on":{"key":"k1a2b3c4d"}}""").on)
    bad("""{"do":"tap","on":{"id":""}}""")
    bad("""{"do":"tap","on":{"key":"  "}}""")
    bad("""{"do":"tap","on":{"foo":1}}""")
    // The v1 forms still win when present.
    assertEquals(Target.Index(3), act("""{"do":"tap","on":{"n":3,"key":"k"}}""").on)
  }

  @Test fun optionsDefaultOff() {
    val a = act("""{"do":"key","name":"back"}""")
    assertFalse(a.thenScreen); assertFalse(a.compact); assertFalse(a.fast)
    val b = act("""{"do":"tap","on":{"text":"Reply"},"then_screen":true,"compact":true,"fast":true}""")
    assertTrue(b.thenScreen); assertTrue(b.compact); assertTrue(b.fast)
  }

  @Test fun openParsing() {
    val a = act("""{"type":"act","to":"hands","id":"m1","do":"open","uri":"mailto:sam@x.com?subject=Hi&body=Hello"}""")
    assertEquals("open", a.what); assertEquals("mailto:sam@x.com?subject=Hi&body=Hello", a.uri); assertNull(a.action)
    val b = act("""{"do":"open","action":"android.intent.action.SET_ALARM","extras":{"android.intent.extra.alarm.HOUR":7,"android.intent.extra.alarm.MINUTES":30,"android.intent.extra.alarm.SKIP_UI":true,"android.intent.extra.alarm.MESSAGE":"Gym"}}""")
    assertEquals("android.intent.action.SET_ALARM", b.action); assertNull(b.uri)
    assertEquals(7, b.extras["android.intent.extra.alarm.HOUR"])
    assertEquals(true, b.extras["android.intent.extra.alarm.SKIP_UI"])
    assertEquals("Gym", b.extras["android.intent.extra.alarm.MESSAGE"])
    val c = act("""{"do":"open","uri":"content://com.android.calendar/events","action":"android.intent.action.INSERT","type_mime":"vnd.android.cursor.dir/event","pkg":"com.google.android.calendar"}""")
    assertEquals("vnd.android.cursor.dir/event", c.mime); assertEquals("com.google.android.calendar", c.pkg)
    bad("""{"do":"open"}""")
    bad("""{"do":"open","uri":"  "}""")
    bad("""{"do":"open","uri":null,"action":null}""")
  }

  @Test fun extrasTypes() {
    val e = Protocol.parseExtras(j("""{"s":"x","i":3,"d":2.5,"big":5000000000,"neg":-2,"t":true,"arr":["a","b"],"f":3.0}"""))
    assertEquals("x", e["s"]); assertEquals(3, e["i"]); assertEquals(2.5, e["d"]); assertEquals(5000000000L, e["big"])
    assertEquals(-2, e["neg"]); assertEquals(true, e["t"]); assertEquals(3, e["f"])
    assertArrayEquals(arrayOf("a", "b"), e["arr"] as Array<*>)
    for (s in listOf("""{"o":{"a":1}}""", """{"a":[1,2]}""", """{"n":null}""")) {
      try { Protocol.parseExtras(j(s)); fail(s) } catch (_: BadRequest) {}
    }
    try { Protocol.parseExtras("nope"); fail() } catch (_: BadRequest) {}
    assertTrue(Protocol.parseExtras(null).isEmpty())
  }

  @Test fun actResultCarriesWhyAndDetail() {
    val r = Protocol.actResult("m1", false, "not_found", "stale")
    assertEquals("stale", r.getString("why")); assertEquals("stale", r.getString("detail"))
    assertFalse(Protocol.actResult("m1", true).has("why"))
  }

  // --- intents ---

  private fun plan(s: String) = Intents.plan(act(s))

  @Test fun defaultActionsByScheme() {
    assertEquals(Intents.SENDTO, plan("""{"do":"open","uri":"mailto:sam@x.com?subject=Hi"}""").action)
    assertEquals(Intents.SENDTO, plan("""{"do":"open","uri":"sms:+14155550123?body=hi"}""").action)
    assertEquals(Intents.SENDTO, plan("""{"do":"open","uri":"smsto:+14155550123"}""").action)
    assertEquals(Intents.DIAL, plan("""{"do":"open","uri":"tel:+14155550123"}""").action)
    for (u in listOf("geo:0,0?q=coffee", "google.navigation:q=Toronto", "https://example.com", "spotify:track:123", "HTTPS://X.COM")) {
      assertEquals(u, Intents.VIEW, plan("""{"do":"open","uri":"$u"}""").action)
    }
  }

  @Test fun actionOverridesAndCallBecomesDial() {
    assertEquals("android.intent.action.WEB_SEARCH", plan("""{"do":"open","action":"android.intent.action.WEB_SEARCH","extras":{"query":"weather"}}""").action)
    assertEquals(Intents.DIAL, plan("""{"do":"open","uri":"tel:123","action":"android.intent.action.CALL"}""").action)
    assertEquals(Intents.DIAL, plan("""{"do":"open","uri":"tel:123","action":"android.intent.action.CALL_PRIVILEGED"}""").action)
  }

  @Test fun planDescribesItselfForErrors() {
    assertEquals("mailto:", plan("""{"do":"open","uri":"mailto:a@b.c"}""").what)
    assertEquals("android.intent.action.SET_TIMER", plan("""{"do":"open","action":"android.intent.action.SET_TIMER"}""").what)
  }

  @Test fun uriWithoutSchemeIsBad() {
    try { plan("""{"do":"open","uri":"example.com"}"""); fail() } catch (_: BadRequest) {}
    assertNull(Intents.scheme("no scheme")); assertEquals("geo", Intents.scheme("geo:1,2")); assertNull(Intents.scheme(":x"))
  }

  // --- targets by id / key, folded labels ---

  private fun node(n: Int, text: String, id: String = "", tap: Boolean = true, key: String = "") =
    ScreenNode(n, text, "", "Button", intArrayOf(0, n * 100, 100, n * 100 + 90), tap, false, false,
      id = id.substringAfterLast('/'), viewId = id, key = key)

  @Test fun byIdShortAndFull() {
    val nodes = listOf(node(0, "Title", "com.x:id/title", tap = false), node(1, "Compose", "com.x:id/compose_button"), node(2, "Other", "com.y:id/compose_button"))
    assertEquals(1, TargetMatcher.byId(nodes, "compose_button")?.n)
    assertEquals(1, TargetMatcher.byId(nodes, "id/compose_button")?.n)
    assertEquals(2, TargetMatcher.byId(nodes, "com.y:id/compose_button")?.n)
    assertEquals(0, TargetMatcher.byId(nodes, "title")?.n)
    assertNull(TargetMatcher.byId(nodes, "nope"))
    assertNull(TargetMatcher.byId(nodes, "com.z:id/title"))
  }

  @Test fun tappableIdMatchBeatsPlain() {
    val nodes = listOf(node(0, "Label", "com.x:id/send", tap = false), node(1, "Send", "com.x:id/send"))
    assertEquals(1, TargetMatcher.byId(nodes, "send")?.n)
  }

  @Test fun byKeyExact() {
    val nodes = listOf(node(0, "A", key = "k1"), node(1, "B", key = "k2"), node(2, "B", key = "k2-2"))
    assertEquals(1, TargetMatcher.byKey(nodes, "k2")?.n)
    assertEquals(2, TargetMatcher.byKey(nodes, "k2-2")?.n)
    assertNull(TargetMatcher.byKey(nodes, "k3"))
  }

  @Test fun textMatchesAPartOfAFoldedLabel() {
    val nodes = listOf(node(0, "Inbox · Sarah Chen"), node(1, "Sarah Chen · Running late"))
    // exact part beats a plain contains: both contain "Running", but only #1 has "Running late" as a part
    assertEquals(1, TargetMatcher.byText(nodes, "running late")?.n)
    assertEquals(0, TargetMatcher.byText(nodes, "Inbox")?.n)
  }

  @Test fun fastGlide() {
    for (d in listOf(0f, 300f, 3000f)) {
      val f = TargetMatcher.glideMs(0f, 0f, d, 0f, 1080, 2400, fast = true)
      assertTrue("$f", f in 120..250)
      val s = TargetMatcher.glideMs(0f, 0f, d, 0f, 1080, 2400)
      assertTrue("$s", s in 400..900)
    }
  }

  // --- launch ranking ---

  private fun c(pkg: String, label: String, shown: Boolean = true) = LaunchCandidate(pkg, label, shown)

  @Test fun launchRanking() {
    val apps = listOf(
      c("com.google.android.apps.maps", "Maps"),
      c("com.example.mapsplus", "Maps Plus"),
      c("com.google.android.gm", "Gmail"),
      c("com.google.android.gm.lite", "Gmail Go"),
      c("com.sec.android.app.myfiles", "My Files"),
      c("com.example.roadmaps", "Roadmaps"),
      c("com.google.android.apps.messaging", "Messages"),
      c("com.samsung.android.messaging", "Messages", shown = false),
    )
    assertEquals("com.google.android.apps.maps", LaunchRanker.pick("maps", apps)?.pkg) // exact beats prefix and contains
    assertEquals("com.google.android.gm", LaunchRanker.pick("GMAIL", apps)?.pkg)
    assertEquals("com.example.mapsplus", LaunchRanker.pick("Maps P", apps)?.pkg) // prefix
    assertEquals("com.sec.android.app.myfiles", LaunchRanker.pick("files", apps)?.pkg) // word prefix
    assertEquals("com.example.roadmaps", LaunchRanker.pick("admap", apps)?.pkg) // contains
    assertEquals("com.google.android.apps.messaging", LaunchRanker.pick("messages", apps)?.pkg) // tie: launcher-visible
    assertEquals("com.google.android.gm.lite", LaunchRanker.pick("com.google.android.gm.lite", apps)?.pkg) // package exact
    assertNull(LaunchRanker.pick("whatsapp", apps))
    assertNull(LaunchRanker.pick("  ", apps))
  }

  @Test fun contentReadyNeedsTwoUsefulNodesFromTheApp() {
    fun n(text: String, pkg: String, tap: Boolean = false, scroll: Boolean = false) =
      ScreenNode(0, text, "", "View", intArrayOf(0, 0, 10, 10), tap, false, scroll, pkg = pkg)
    assertFalse(LaunchRanker.contentReady(emptyList(), "a"))
    assertFalse(LaunchRanker.contentReady(listOf(n("", "a", scroll = true)), "a")) // an empty list: still drawing
    assertFalse(LaunchRanker.contentReady(listOf(n("Hi", "a"), n("Other app", "b")), "a"))
    assertTrue(LaunchRanker.contentReady(listOf(n("Welcome", "a"), n("", "a", tap = true)), "a"))
  }

  @Test fun prefixTieShorterLabelWins() {
    val apps = listOf(c("a", "Google Play Store"), c("b", "Google"), c("c", "Google Photos"))
    assertEquals("b", LaunchRanker.pick("goo", apps)?.pkg)
  }

  // --- settle ---

  private val t = SettleTiming(firstEventMs = 400, quietMs = 150, capMs = 2000)

  @Test fun settleNoEventsReturnsAtFirstEventWindow() {
    assertEquals(400, Settler.next(now = 0, start = 0, events = 0, lastEventAt = 0, minMs = 0, t = t))
    assertEquals(100, Settler.next(now = 300, start = 0, events = 0, lastEventAt = 0, minMs = 0, t = t))
    assertEquals(0, Settler.next(now = 400, start = 0, events = 0, lastEventAt = 0, minMs = 0, t = t))
    // a floor longer than the window holds it
    assertEquals(200, Settler.next(now = 400, start = 0, events = 0, lastEventAt = 0, minMs = 600, t = t))
  }

  @Test fun settleWaitsForQuiet() {
    assertEquals(100, Settler.next(now = 250, start = 0, events = 3, lastEventAt = 200, minMs = 0, t = t))
    assertEquals(0, Settler.next(now = 350, start = 0, events = 3, lastEventAt = 200, minMs = 0, t = t))
    // events from during the gesture (before the wait began) count, so a quiet screen returns at once
    assertEquals(0, Settler.next(now = 1000, start = 1000, events = 1, lastEventAt = 700, minMs = 0, t = t))
    // floor
    assertEquals(50, Settler.next(now = 200, start = 0, events = 1, lastEventAt = 10, minMs = 250, t = t))
  }

  @Test fun settleHardCap() {
    assertEquals(0, Settler.next(now = 2000, start = 0, events = 99, lastEventAt = 1999, minMs = 0, t = t))
    assertEquals(50, Settler.next(now = 1950, start = 0, events = 99, lastEventAt = 1949, minMs = 0, t = t))
  }

  @Test fun settleEventFilter() {
    assertTrue(Settler.counts(Settler.TYPE_WINDOW_STATE_CHANGED, "com.google.android.gm", "dev.bobby.app"))
    assertTrue(Settler.counts(Settler.TYPE_WINDOW_CONTENT_CHANGED, "com.google.android.gm", "dev.bobby.app"))
    assertTrue(Settler.counts(Settler.TYPE_WINDOWS_CHANGED, null, "dev.bobby.app"))
    assertFalse(Settler.counts(Settler.TYPE_WINDOW_CONTENT_CHANGED, "com.android.systemui", "dev.bobby.app"))
    assertFalse(Settler.counts(Settler.TYPE_WINDOW_CONTENT_CHANGED, "dev.bobby.app", "dev.bobby.app"))
    assertFalse(Settler.counts(1 /* TYPE_VIEW_CLICKED */, "com.google.android.gm", "dev.bobby.app"))
  }

  @Test fun settlerReallyWaitsOnTheCondition() {
    val fastT = SettleTiming(firstEventMs = 80, quietMs = 60, capMs = 1000)
    val s = Settler()
    // No events: returns after ~80 ms.
    val (ms0, ev0) = s.await(t = fastT)
    assertEquals(0L, ev0); assertTrue("$ms0", ms0 in 70..300)
    // Events every 20 ms for 200 ms: returns ~60 ms after the last one.
    val mark = s.mark()
    val th = Thread { repeat(10) { Thread.sleep(20); s.onEvent() } }
    th.start()
    val (ms1, ev1) = s.await(mark, t = fastT)
    th.join()
    assertTrue("events $ev1", ev1 >= 5)
    assertTrue("$ms1", ms1 in 200..700)
  }

  @Test fun settlerCountsWindowLevelEventsSeparately() {
    val fastT = SettleTiming(firstEventMs = 20, quietMs = 10, capMs = 200)
    val s = Settler()
    val m = s.mark()
    s.onEvent(Settler.TYPE_WINDOW_CONTENT_CHANGED); s.onEvent(Settler.TYPE_WINDOW_CONTENT_CHANGED)
    val a = s.await(m, t = fastT)
    assertEquals(2L, a.events); assertEquals(0L, a.windowEvents)
    val m2 = s.mark()
    s.onEvent(Settler.TYPE_WINDOW_STATE_CHANGED); s.onEvent(Settler.TYPE_WINDOW_CONTENT_CHANGED)
    val b = s.await(m2, t = fastT)
    assertEquals(2L, b.events); assertEquals(1L, b.windowEvents)
  }

  // --- caps helpers ---

  @Test fun capsHelpers() {
    assertEquals("com.samsung.android.honeyboard", Caps.imePackage("com.samsung.android.honeyboard/.service.HoneyBoardService"))
    assertNull(Caps.imePackage(null)); assertNull(Caps.imePackage(""))
    assertEquals(true, Caps.gestureNav(2)); assertEquals(false, Caps.gestureNav(0)); assertNull(Caps.gestureNav(-1))
    assertEquals("portrait", Caps.orientation(1)); assertEquals("landscape", Caps.orientation(2)); assertNull(Caps.orientation(0))
    assertTrue("open" in Caps.FEATURES && "since" in Caps.FEATURES)
  }
}
