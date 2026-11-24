package dev.bobby.hands

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Folding, the extra node fields, keys, hash, compact output and `since`. */
class ScreenV2Test {
  private val W = 1080
  private val H = 2400
  private fun b(l: Int, t: Int, r: Int, bt: Int) = intArrayOf(l, t, r, bt)
  private fun flat(vararg roots: RawNode) = NodeFilter.flatten(roots.toList(), W, H)

  /** A Gmail-like inbox row: a clickable container with no label, and plain text children. */
  private fun row(top: Int, from: String, subject: String) = RawNode(
    cls = "android.view.ViewGroup", bounds = b(0, top, W, top + 240), clickable = true, pkg = "com.google.android.gm",
    viewId = "com.google.android.gm:id/viewified_conversation_item_view",
    children = listOf(
      RawNode(text = from, cls = "android.widget.TextView", bounds = b(160, top + 20, 700, top + 80), pkg = "com.google.android.gm"),
      RawNode(text = subject, cls = "android.widget.TextView", bounds = b(160, top + 90, 1000, top + 150), pkg = "com.google.android.gm"),
    ),
  )

  // --- folding ---

  @Test fun plainChildrenFoldIntoUnlabelledTappableRow() {
    val out = flat(row(400, "Sarah Chen", "Running late"))
    assertEquals(1, out.size)
    assertEquals("Sarah Chen · Running late", out[0].text)
    assertTrue(out[0].tap)
    assertEquals(0, out[0].n)
  }

  @Test fun labelledAncestorDoesNotFold() {
    val r = RawNode(desc = "Open", clickable = true, bounds = b(0, 0, 500, 200),
      children = listOf(RawNode(text = "Inner", bounds = b(10, 10, 200, 100))))
    val out = flat(r)
    assertEquals(listOf("", "Inner"), out.map { it.text })
    assertEquals("Open", out[0].desc)
  }

  @Test fun tappableOrEditableChildIsNotFolded() {
    val r = RawNode(clickable = true, bounds = b(0, 0, 1000, 300), children = listOf(
      RawNode(text = "Title", bounds = b(10, 10, 400, 100)),
      RawNode(text = "Star", clickable = true, bounds = b(900, 10, 1000, 100)),
      RawNode(text = "", editable = true, bounds = b(10, 150, 900, 250)),
    ))
    val out = flat(r)
    assertEquals(listOf("Title", "Star", ""), out.map { it.text })
    assertTrue(out[1].tap); assertTrue(out[2].edit)
  }

  @Test fun foldIsCappedAndOverflowStaysSeparate() {
    val kids = (1..6).map { RawNode(text = "word$it".repeat(5), bounds = b(0, it * 10, 500, it * 10 + 9)) }
    val out = flat(RawNode(clickable = true, bounds = b(0, 0, 500, 100), children = kids))
    assertTrue(out[0].text.length <= NodeFilter.MAX_FOLD)
    // Whatever didn't fit is still on screen as its own node: nothing is lost.
    val all = out.joinToString(" ") { it.text }
    for (i in 1..6) assertTrue(all.contains("word$i"))
  }

  @Test fun hugeTappableContainerDoesNotSwallowTheScreen() {
    val out = flat(RawNode(clickable = true, bounds = b(0, 0, W, H), children = listOf(
      RawNode(text = "A", bounds = b(0, 0, 100, 100)), RawNode(text = "B", bounds = b(0, 200, 100, 300)))))
    assertEquals(listOf("", "A", "B"), out.map { it.text })
  }

  @Test fun nestedTappableFoldsIntoNearestOnly() {
    val inner = RawNode(clickable = true, bounds = b(800, 10, 1000, 100), children = listOf(RawNode(desc = "Reply", bounds = b(820, 20, 980, 90))))
    val out = flat(RawNode(clickable = true, bounds = b(0, 0, W, 300), children = listOf(RawNode(text = "Sarah", bounds = b(0, 10, 500, 100)), inner)))
    assertEquals(listOf("Sarah", "Reply"), out.map { it.text })
  }

  @Test fun checkableChildLendsCheckedToRow() {
    val r = RawNode(clickable = true, bounds = b(0, 0, W, 200), children = listOf(
      RawNode(text = "Wi-Fi", bounds = b(40, 20, 600, 100)),
      RawNode(cls = "android.widget.Switch", checkable = true, checked = true, bounds = b(900, 40, 1040, 160)),
    ))
    val out = flat(r)
    assertEquals(1, out.size)
    assertEquals("Wi-Fi", out[0].text)
    assertEquals(true, out[0].checked)
  }

  @Test fun repeatedLabelFoldedOnce() {
    val r = RawNode(clickable = true, bounds = b(0, 0, 500, 200), children = listOf(
      RawNode(text = "Gmail", bounds = b(0, 0, 200, 100)), RawNode(desc = "Gmail", bounds = b(0, 100, 200, 200))))
    assertEquals(listOf("Gmail"), flat(r).map { it.text })
  }

  @Test fun foldingCanBeTurnedOff() {
    assertEquals(3, NodeFilter.flatten(listOf(row(400, "A", "B")), W, H, fold = false).size)
  }

  // --- extra fields ---

  @Test fun extraFieldsComeThrough() {
    val out = flat(
      RawNode(text = "Wi-Fi", cls = "android.widget.Switch", checkable = true, checked = false, clickable = true, bounds = b(0, 0, 100, 100)),
      RawNode(text = "Send", clickable = true, enabled = false, bounds = b(0, 100, 100, 200), viewId = "com.x:id/send"),
      RawNode(text = "Inbox", selected = true, focused = true, clickable = true, bounds = b(0, 200, 100, 300)),
      RawNode(cls = "androidx.recyclerview.widget.RecyclerView", scrollable = true, scrollDirs = listOf("up", "down"), bounds = b(0, 300, 100, 2000)),
    )
    assertEquals(false, out[0].checked)
    assertTrue(out[1].disabled); assertEquals("send", out[1].id); assertEquals("com.x:id/send", out[1].viewId)
    assertTrue(out[2].selected); assertTrue(out[2].focused)
    assertEquals(listOf("up", "down"), out[3].scrollDirs)
    assertNull(out[1].checked)
  }

  @Test fun passwordTextIsNeverSent() {
    val out = flat(RawNode(text = "hunter2", password = true, editable = true, cls = "android.widget.EditText", bounds = b(0, 0, 500, 100)))
    assertEquals("", out[0].text)
    assertTrue(out[0].password)
    val j = out[0].toJson()
    assertFalse(j.toString().contains("hunter2"))
    assertEquals(true, j.getBoolean("password"))
    // A password field showing its hint keeps the hint, not some text.
    val h = flat(RawNode(text = "Password", showingHint = true, password = true, editable = true, bounds = b(0, 0, 500, 100)))
    assertEquals("", h[0].text)
  }

  @Test fun extraFieldsOmittedWhenUnset() {
    val j = flat(RawNode(text = "Hi", bounds = b(0, 0, 10, 10)))[0].toJson()
    for (k in listOf("checked", "disabled", "focused", "selected", "password", "id", "scrollDirs", "hint")) assertFalse(k, j.has(k))
    assertTrue(j.has("key"))
  }

  // --- keys ---

  @Test fun keysAreStableAcrossReads() {
    val screen = listOf(row(400, "Sarah Chen", "Running late"), row(640, "Alex", "Lunch"),
      RawNode(text = "Compose", clickable = true, bounds = b(640, 2050, 1040, 2180), viewId = "com.google.android.gm:id/compose_button", pkg = "com.google.android.gm"))
    val a = NodeFilter.flatten(screen, W, H).map { it.key }
    val bKeys = NodeFilter.flatten(screen, W, H).map { it.key }
    assertEquals(a, bKeys)
    assertEquals(a.size, a.toSet().size) // all different
    assertTrue(a.all { it.startsWith("k") })
  }

  @Test fun keySurvivesAnUnrelatedChangeElsewhere() {
    val compose = RawNode(text = "Compose", clickable = true, bounds = b(640, 2050, 1040, 2180), viewId = "x:id/compose")
    val k1 = flat(RawNode(text = "1 new", bounds = b(0, 0, 200, 100)), compose).last().key
    val k2 = flat(RawNode(text = "Header", bounds = b(0, 0, 200, 100)), RawNode(text = "Banner", bounds = b(0, 100, 200, 200)), compose).last().key
    assertEquals(k1, k2) // index n changed, key didn't
  }

  @Test fun editableKeyIgnoresTypedText() {
    fun field(t: String) = flat(RawNode(text = t, hint = "Subject", editable = true, bounds = b(0, 500, 1000, 600))).single().key
    assertEquals(field(""), field("Hello there"))
  }

  @Test fun identicalTwinsGetSuffixes() {
    val n = RawNode(text = "Like", clickable = true, bounds = b(0, 0, 50, 50))
    val keys = flat(n, n.copy(bounds = b(5, 5, 55, 55))).map { it.key }
    assertEquals(keys[0] + "-2", keys[1])
  }

  // --- hash ---

  private fun snap(vararg roots: RawNode) = NodeFilter.flatten(roots.toList(), W, H)

  @Test fun hashStableForSameScreen() {
    val s = listOf(row(400, "Sarah", "Late"))
    assertEquals(ScreenHash.of("gm", W, H, NodeFilter.flatten(s, W, H)), ScreenHash.of("gm", W, H, NodeFilter.flatten(s, W, H)))
    assertEquals(16, ScreenHash.of("gm", W, H, emptyList()).length)
  }

  @Test fun hashChangesWithContentFlagsAppAndBounds() {
    val base = snap(RawNode(text = "A", clickable = true, bounds = b(0, 0, 100, 100)))
    val h = ScreenHash.of("app", W, H, base)
    assertNotEquals(h, ScreenHash.of("other", W, H, base))
    assertNotEquals(h, ScreenHash.of("app", W, H, snap(RawNode(text = "B", clickable = true, bounds = b(0, 0, 100, 100)))))
    assertNotEquals(h, ScreenHash.of("app", W, H, snap(RawNode(text = "A", bounds = b(0, 0, 100, 100)))))
    assertNotEquals(h, ScreenHash.of("app", W, H, snap(RawNode(text = "A", clickable = true, bounds = b(0, 300, 100, 400)))))
    assertNotEquals(h, ScreenHash.of("app", W, H, snap(RawNode(text = "A", clickable = true, checkable = true, checked = true, bounds = b(0, 0, 100, 100)))))
    // A 2 px wobble (rounding) doesn't.
    assertEquals(h, ScreenHash.of("app", W, H, snap(RawNode(text = "A", clickable = true, bounds = b(1, 1, 101, 101)))))
  }

  @Test fun hashIgnoresSystemUiClockAndStatusBar() {
    val app = RawNode(text = "Inbox", bounds = b(0, 300, 500, 400), pkg = "com.google.android.gm")
    fun shade(clock: String, battery: String) = snap(
      app,
      RawNode(text = clock, bounds = b(0, 0, 200, 80), pkg = "com.android.systemui"),
      RawNode(text = "Tue, Nov 24 · $clock", desc = "Battery $battery", bounds = b(0, 200, 800, 280), pkg = "com.android.systemui"),
    )
    assertEquals(ScreenHash.of("gm", W, H, shade("12:01", "80%")), ScreenHash.of("gm", W, H, shade("12:02", "79%")))
    // But real system UI content (a shade notification) still counts.
    val more = shade("12:01", "80%") + snap(RawNode(text = "New message", bounds = b(0, 600, 800, 700), pkg = "com.android.systemui"))
    assertNotEquals(ScreenHash.of("gm", W, H, shade("12:01", "80%")), ScreenHash.of("gm", W, H, more))
  }

  // --- compact + since ---

  @Test fun compactDropsFalseAndEmpty() {
    val n = ScreenNode(0, "", "Navigate up", "ImageButton", b(0, 0, 10, 10), tap = true, edit = false, scroll = false, key = "k1")
    val c = n.toJson(compact = true)
    assertFalse(c.has("text")); assertFalse(c.has("edit")); assertFalse(c.has("scroll"))
    assertTrue(c.getBoolean("tap")); assertEquals("Navigate up", c.getString("desc"))
    val full = n.toJson()
    assertEquals("", full.getString("text")); assertFalse(full.getBoolean("edit")); assertFalse(full.getBoolean("scroll"))
    // checked:false is meaningful for a checkable node, so compact keeps it.
    assertEquals(false, n.copy(checked = false).toJson(compact = true).getBoolean("checked"))
  }

  @Test fun screenReplySameWhenSinceMatches() {
    val nodes = snap(RawNode(text = "A", bounds = b(0, 0, 100, 100)))
    val h = ScreenHash.of("app", W, H, nodes)
    val same = Protocol.screenReply("m1", "app", W, H, nodes, h, ScreenRequest(since = h))
    assertJsonEq(j("""{"type":"screen_result","re":"m1","same":true,"hash":"$h","app":"app","size":[1080,2400]}"""), same)
    val diff = Protocol.screenReply("m2", "app", W, H, nodes, h, ScreenRequest(since = "0000"))
    assertEquals(1, diff.getJSONArray("nodes").length()); assertEquals(h, diff.getString("hash")); assertFalse(diff.has("same"))
    val none = Protocol.screenReply("m3", "app", W, H, nodes, h, ScreenRequest())
    assertTrue(none.has("nodes")); assertTrue(none.getJSONArray("nodes").getJSONObject(0).has("tap"))
    val compact = Protocol.screenReply("m4", "app", W, H, nodes, h, ScreenRequest(compact = true))
    assertFalse(compact.getJSONArray("nodes").getJSONObject(0).has("tap"))
  }

  @Test fun screenRequestParsing() {
    assertEquals(ScreenRequest(), ScreenRequest.parse(j("""{"type":"screen","to":"hands","id":"m1"}""")))
    assertEquals(ScreenRequest("abc", true, true), ScreenRequest.parse(j("""{"type":"screen","since":"abc","compact":true,"image":true}""")))
    assertNull(ScreenRequest.parse(j("""{"type":"screen","since":null}""")).since)
    assertNull(ScreenRequest.parse(j("""{"type":"screen","since":""}""")).since)
  }

  @Test fun lockedScreenHasNoNodes() {
    val o = Protocol.lockedScreen("m1", W, H)
    assertTrue(o.getBoolean("locked"))
    assertEquals(0, o.getJSONArray("nodes").length())
    assertEquals("screen_result", o.getString("type"))
    assertEquals(ScreenHash.LOCKED, o.getString("hash"))
  }

  @Test fun embeddedScreenDropsTypeAndRe() {
    val s = Protocol.screenResult("m1", "app", W, H, emptyList(), "h")
    val e = Protocol.embedded(s)
    assertFalse(e.has("type")); assertFalse(e.has("re"))
    assertEquals("h", e.getString("hash")); assertEquals("app", e.getString("app"))
    assertTrue(s.has("type")) // the original is untouched
  }

  // --- web views and windows ---

  @Test fun emptyWebViewByClassNotDescription() {
    assertTrue(NodeFilter.hasEmptyWebView(RawNode(cls = "android.webkit.WebView")))
    assertTrue(NodeFilter.hasEmptyWebView(RawNode(children = listOf(RawNode(cls = "android.webkit.WebView", desc = "Vue Web", children = listOf(RawNode()))))))
    assertFalse(NodeFilter.hasEmptyWebView(RawNode(cls = "android.webkit.WebView", children = listOf(RawNode(text = "Hello")))))
    assertFalse(NodeFilter.hasEmptyWebView(RawNode(desc = "Web View", cls = "android.widget.FrameLayout", children = listOf(RawNode(text = "x")))))
  }

  @Test fun coverRuleToleratesTaskbarsButNotSplitScreen() {
    assertTrue(WindowRules.covers(0, 0, W, H, W, H))
    assertTrue(WindowRules.covers(0, 0, W, H - 160, W, H)) // taskbar / nav bar
    assertFalse(WindowRules.covers(0, 0, W, H / 2, W, H)) // split screen, top half
    assertFalse(WindowRules.covers(0, 0, W / 2, H, W, H)) // split screen, left half
    assertFalse(WindowRules.covers(100, 600, 980, 1600, W, H)) // a dialog
  }
}
