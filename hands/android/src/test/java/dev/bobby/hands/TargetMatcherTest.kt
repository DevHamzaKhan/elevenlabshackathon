package dev.bobby.hands

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TargetMatcherTest {
  private fun node(n: Int, text: String = "", desc: String = "", hint: String = "", bounds: IntArray = intArrayOf(0, 0, 10, 10), tap: Boolean = false) =
    ScreenNode(n, text, desc, "View", bounds, tap, false, false, hint)

  @Test fun exactBeatsContains() {
    val nodes = listOf(node(0, "Reply all"), node(1, "Reply"))
    assertEquals(1, TargetMatcher.byText(nodes, "Reply")!!.n)
  }

  @Test fun containsWhenNoExact() {
    val nodes = listOf(node(0, "Inbox"), node(1, "Reply all"), node(2, "Reply to sender"))
    assertEquals(1, TargetMatcher.byText(nodes, "reply")!!.n)
  }

  @Test fun caseInsensitive() {
    val nodes = listOf(node(0, "REPLY"))
    assertEquals(0, TargetMatcher.byText(nodes, "reply")!!.n)
    assertEquals(0, TargetMatcher.byText(nodes, "  rEpLy ")!!.n)
  }

  @Test fun textOrDesc() {
    val nodes = listOf(node(0, text = "Inbox"), node(1, desc = "Search"))
    assertEquals(1, TargetMatcher.byText(nodes, "search")!!.n)
    // An exact desc match beats a contains text match.
    val nodes2 = listOf(node(0, text = "Send later"), node(1, desc = "Send"))
    assertEquals(1, TargetMatcher.byText(nodes2, "send")!!.n)
    // Exact text and exact desc are equal rank: first in order wins.
    val nodes3 = listOf(node(0, desc = "Send"), node(1, text = "Send"))
    assertEquals(0, TargetMatcher.byText(nodes3, "send")!!.n)
  }

  @Test fun hintIsLast() {
    val nodes = listOf(node(0, hint = "Compose email"), node(1, text = "Compose email draft"))
    assertEquals(1, TargetMatcher.byText(nodes, "compose email")!!.n) // contains text beats exact hint
    val nodes2 = listOf(node(0, hint = "Subject line"), node(1, hint = "Subject"))
    assertEquals(1, TargetMatcher.byText(nodes2, "subject")!!.n) // exact hint beats contains hint
    assertEquals(0, TargetMatcher.byText(listOf(node(0, hint = "Search mail")), "search")!!.n)
  }

  @Test fun firstInOrderWins() {
    val nodes = listOf(node(0, "Other"), node(1, "OK"), node(2, "OK"))
    assertEquals(1, TargetMatcher.byText(nodes, "ok")!!.n)
  }

  @Test fun noMatchAndEmptyQuery() {
    assertNull(TargetMatcher.byText(listOf(node(0, "Reply")), "Forward"))
    assertNull(TargetMatcher.byText(listOf(node(0, "Reply")), ""))
    assertNull(TargetMatcher.byText(listOf(node(0, "Reply")), "   "))
    assertNull(TargetMatcher.byText(emptyList(), "x"))
  }

  @Test fun atPointSmallestContaining() {
    val big = node(0, bounds = intArrayOf(0, 0, 1000, 1000))
    val mid = node(1, bounds = intArrayOf(100, 100, 600, 600))
    val small = node(2, bounds = intArrayOf(200, 200, 300, 300))
    val elsewhere = node(3, bounds = intArrayOf(700, 700, 710, 710))
    val nodes = listOf(big, mid, small, elsewhere)
    assertEquals(2, TargetMatcher.atPoint(nodes, 250, 250)!!.n)
    assertEquals(1, TargetMatcher.atPoint(nodes, 500, 500)!!.n)
    assertEquals(0, TargetMatcher.atPoint(nodes, 900, 50)!!.n)
    assertNull(TargetMatcher.atPoint(nodes, 2000, 2000))
    // Right/bottom edges are exclusive.
    assertEquals(1, TargetMatcher.atPoint(nodes, 300, 250)!!.n)
  }

  @Test fun atPointPredicate() {
    val big = node(0, bounds = intArrayOf(0, 0, 1000, 1000), tap = true)
    val small = node(1, bounds = intArrayOf(200, 200, 300, 300), tap = false)
    assertEquals(0, TargetMatcher.atPoint(listOf(big, small), 250, 250) { it.tap }!!.n)
  }

  @Test fun glideWithinRange() {
    val w = 1080; val h = 2400
    assertEquals(400L, TargetMatcher.glideMs(100f, 100f, 100f, 100f, w, h))
    val far = TargetMatcher.glideMs(0f, 0f, w.toFloat(), h.toFloat(), w, h)
    assertEquals(900L, far)
    for (i in 0..50) {
      val g = TargetMatcher.glideMs(0f, 0f, i * 50f, i * 70f, w, h)
      assertTrue("glide $g out of range", g in 400..900)
    }
    // Degenerate screen size doesn't blow up.
    assertTrue(TargetMatcher.glideMs(0f, 0f, 10f, 10f, 0, 0) in 400..900)
  }

  @Test fun glideMonotonicInDistance() {
    val w = 1080; val h = 2400
    var prev = -1L
    for (d in 0..3000 step 25) {
      val g = TargetMatcher.glideMs(500f, 500f, 500f + d, 500f, w, h)
      assertTrue("glide not monotonic at d=$d: $g < $prev", g >= prev)
      prev = g
    }
    assertTrue(TargetMatcher.glideMs(0f, 0f, 300f, 0f, w, h) > TargetMatcher.glideMs(0f, 0f, 50f, 0f, w, h))
  }
}
