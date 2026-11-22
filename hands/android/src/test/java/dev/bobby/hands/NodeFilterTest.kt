package dev.bobby.hands

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeFilterTest {
  private val W = 1080
  private val H = 2400
  private fun b(l: Int, t: Int, r: Int, bt: Int) = intArrayOf(l, t, r, bt)
  private fun flat(vararg roots: RawNode) = NodeFilter.flatten(roots.toList(), W, H)

  @Test fun invisibleDropped() {
    val out = flat(RawNode(text = "Hidden", bounds = b(0, 0, 100, 100), visible = false))
    assertTrue(out.isEmpty())
  }

  @Test fun visibleWithTextKept() {
    val out = flat(RawNode(text = "Reply", cls = "android.widget.Button", bounds = b(840, 2100, 1040, 2220), clickable = true))
    assertEquals(1, out.size)
    val n = out[0]
    assertEquals(0, n.n); assertEquals("Reply", n.text); assertEquals("Button", n.cls)
    assertArrayEquals(b(840, 2100, 1040, 2220), n.bounds)
    assertTrue(n.tap); assertFalse(n.edit); assertFalse(n.scroll)
  }

  @Test fun inclusionRules() {
    val bx = b(0, 0, 10, 10)
    assertTrue(flat(RawNode(bounds = bx)).isEmpty()) // nothing set
    assertEquals(1, flat(RawNode(text = "t", bounds = bx)).size)
    assertEquals(1, flat(RawNode(desc = "d", bounds = bx)).size)
    assertTrue(flat(RawNode(clickable = true, bounds = bx))[0].tap)
    assertTrue(flat(RawNode(longClickable = true, bounds = bx))[0].tap)
    assertTrue(flat(RawNode(editable = true, bounds = bx))[0].edit)
    assertTrue(flat(RawNode(scrollable = true, bounds = bx))[0].scroll)
    assertTrue(flat(RawNode(text = "   \n\t", bounds = bx)).isEmpty()) // whitespace only is not text
    assertTrue(flat(RawNode(hint = "only a hint", bounds = bx)).isEmpty()) // hint alone does not qualify
  }

  @Test fun boundsClippedToScreen() {
    val out = flat(RawNode(text = "x", bounds = b(-50, -20, 2000, 3000)))
    assertArrayEquals(b(0, 0, W, H), out[0].bounds)
    val out2 = flat(RawNode(text = "x", bounds = b(1000, 2300, 1200, 2500)))
    assertArrayEquals(b(1000, 2300, W, H), out2[0].bounds)
  }

  @Test fun zeroAreaDropped() {
    assertTrue(flat(RawNode(text = "x", bounds = b(10, 10, 10, 50))).isEmpty())
    assertTrue(flat(RawNode(text = "x", bounds = b(10, 10, 50, 10))).isEmpty())
    assertTrue(flat(RawNode(text = "x", bounds = b(50, 50, 10, 10))).isEmpty()) // inverted
    assertTrue(flat(RawNode(text = "x", bounds = b(2000, 100, 2100, 200))).isEmpty()) // fully off-screen right
    assertTrue(flat(RawNode(text = "x", bounds = b(0, -300, 100, -100))).isEmpty()) // fully above
  }

  @Test fun showingHintBecomesHint() {
    val out = flat(RawNode(text = "Compose email", showingHint = true, editable = true, cls = "android.widget.EditText", bounds = b(0, 0, 100, 100)))
    assertEquals(1, out.size)
    assertEquals("", out[0].text)
    assertEquals("Compose email", out[0].hint)
    assertEquals("Compose email", out[0].toJson().getString("hint"))
    assertEquals("", out[0].toJson().getString("text"))
  }

  @Test fun showingHintKeepsExplicitHint() {
    val out = flat(RawNode(text = "Search", hint = "Search mail", showingHint = true, editable = true, bounds = b(0, 0, 100, 100)))
    assertEquals("", out[0].text)
    assertEquals("Search mail", out[0].hint)
  }

  @Test fun hintEqualToTextDropped() {
    val out = flat(RawNode(text = "To", hint = "To", editable = true, bounds = b(0, 0, 100, 100)))
    assertEquals("To", out[0].text)
    assertEquals("", out[0].hint)
    assertFalse(out[0].toJson().has("hint"))
  }

  @Test fun whitespaceCollapsed() {
    val out = flat(RawNode(text = "  Running\n late,\t\tcan  we ", desc = " a \n b ", bounds = b(0, 0, 100, 100)))
    assertEquals("Running late, can we", out[0].text)
    assertEquals("a b", out[0].desc)
  }

  @Test fun longTextTruncated() {
    val out = flat(RawNode(text = "a".repeat(1000), bounds = b(0, 0, 100, 100)))
    assertTrue(out[0].text.length <= 401)
  }

  @Test fun sequentialDepthFirstAcrossRoots() {
    val bx = b(0, 0, 10, 10)
    val root1 = RawNode(
      text = "A", bounds = bx,
      children = listOf(
        RawNode(text = "B", bounds = bx, children = listOf(RawNode(text = "C", bounds = bx))),
        RawNode(bounds = bx, children = listOf(RawNode(text = "D", bounds = bx))), // skipped container
        RawNode(text = "E", bounds = bx),
      ),
    )
    val root2 = RawNode(bounds = bx, children = listOf(RawNode(text = "F", bounds = bx), RawNode(text = "G", bounds = bx)))
    val out = flat(root1, root2)
    assertEquals(listOf("A", "B", "C", "D", "E", "F", "G"), out.map { it.text })
    assertEquals((0 until 7).toList(), out.map { it.n })
  }

  @Test fun invisibleParentDoesNotNumber() {
    val bx = b(0, 0, 10, 10)
    val out = flat(RawNode(text = "hidden", visible = false, bounds = bx, children = listOf(RawNode(text = "child", bounds = bx))), RawNode(text = "next", bounds = bx))
    assertFalse(out.any { it.text == "hidden" })
    assertEquals((0 until out.size).toList(), out.map { it.n })
  }

  @Test fun classShortName() {
    assertEquals("Button", NodeFilter.shortClass("android.widget.Button"))
    assertEquals("Button", NodeFilter.shortClass("Button"))
    assertEquals("", NodeFilter.shortClass(""))
    assertEquals("RecyclerView", NodeFilter.shortClass("androidx.recyclerview.widget.RecyclerView"))
  }

  @Test fun refCarried() {
    val r = Any()
    assertTrue(flat(RawNode(text = "x", bounds = b(0, 0, 1, 1), ref = r))[0].ref === r)
  }

  @Test fun childRepeatingParentLabelOverSameBoxDropped() {
    val link = RawNode(desc = "Google", clickable = true, bounds = b(10, 10, 100, 50),
      children = listOf(RawNode(text = "Google", bounds = b(10, 10, 100, 50))))
    val out = flat(link)
    assertEquals(1, out.size)
    assertEquals("Google", out[0].desc)
  }

  @Test fun childWithDifferentBoxOrLabelKept() {
    val row = RawNode(desc = "Hamza Khan", clickable = true, bounds = b(0, 0, 1000, 200), children = listOf(
      RawNode(text = "Hamza Khan", bounds = b(10, 10, 300, 60)),
      RawNode(text = "Other", bounds = b(0, 0, 1000, 200)),
    ))
    assertEquals(3, flat(row).size)
  }
}
