package dev.bobby.hands

/**
 * A platform-free copy of one accessibility node, so the filtering and matching rules can be
 * unit-tested on the JVM. [ref] carries the real AccessibilityNodeInfo on the phone.
 */
data class RawNode(
  val text: String = "",
  val desc: String = "",
  val hint: String = "",
  val showingHint: Boolean = false,
  val cls: String = "",
  val bounds: IntArray = intArrayOf(0, 0, 0, 0),
  val visible: Boolean = true,
  val clickable: Boolean = false,
  val longClickable: Boolean = false,
  val editable: Boolean = false,
  val scrollable: Boolean = false,
  val children: List<RawNode> = emptyList(),
  val ref: Any? = null,
)

object NodeFilter {
  private const val MAX_TEXT = 400

  private fun clean(s: String?): String {
    if (s == null) return ""
    val t = s.replace(Regex("\\s+"), " ").trim()
    return if (t.length > MAX_TEXT) t.substring(0, MAX_TEXT) + "…" else t
  }

  fun shortClass(cls: String): String = cls.substringAfterLast('.')

  /**
   * Flattens trees (topmost window first) into the contract's node list:
   * only nodes visible on screen right now that have text, a description, or one of
   * the three flags set. Bounds are clipped to the screen; nodes with no area are dropped.
   */
  fun flatten(roots: List<RawNode>, width: Int, height: Int): List<ScreenNode> {
    val out = ArrayList<ScreenNode>()
    fun visit(node: RawNode, depth: Int) {
      if (depth > 80) return
      if (node.visible) {
        val l = node.bounds[0].coerceIn(0, width)
        val t = node.bounds[1].coerceIn(0, height)
        val r = node.bounds[2].coerceIn(0, width)
        val b = node.bounds[3].coerceIn(0, height)
        if (r > l && b > t) {
          var text = clean(node.text)
          var hint = clean(node.hint)
          if (node.showingHint) {
            // The field is empty and the platform reports its hint as text.
            if (hint.isEmpty()) hint = text
            text = ""
          }
          if (hint == text) hint = ""
          val desc = clean(node.desc)
          val tap = node.clickable || node.longClickable
          if (text.isNotEmpty() || desc.isNotEmpty() || tap || node.editable || node.scrollable) {
            out.add(
              ScreenNode(
                n = out.size,
                text = text,
                desc = desc,
                cls = shortClass(node.cls),
                bounds = intArrayOf(l, t, r, b),
                tap = tap,
                edit = node.editable,
                scroll = node.scrollable,
                hint = hint,
                ref = node.ref,
              ),
            )
          }
        }
      }
      for (c in node.children) visit(c, depth + 1)
    }
    roots.forEach { visit(it, 0) }
    return out
  }
}

object TargetMatcher {
  private fun norm(s: String) = s.trim().lowercase()

  /**
   * The first visible node whose text or description matches, ignoring case.
   * An exact match wins over a "contains" match. A field's hint is tried last.
   */
  fun byText(nodes: List<ScreenNode>, query: String): ScreenNode? {
    val q = norm(query)
    if (q.isEmpty()) return null
    nodes.firstOrNull { norm(it.text) == q || norm(it.desc) == q }?.let { return it }
    nodes.firstOrNull { norm(it.text).contains(q) || norm(it.desc).contains(q) }?.let { return it }
    nodes.firstOrNull { norm(it.hint) == q }?.let { return it }
    return nodes.firstOrNull { norm(it.hint).contains(q) }
  }

  /** The smallest node containing the point that satisfies [pred]. */
  fun atPoint(nodes: List<ScreenNode>, x: Int, y: Int, pred: (ScreenNode) -> Boolean = { true }): ScreenNode? =
    nodes.filter { x >= it.bounds[0] && x < it.bounds[2] && y >= it.bounds[1] && y < it.bounds[3] && pred(it) }
      .minByOrNull { (it.bounds[2] - it.bounds[0]).toLong() * (it.bounds[3] - it.bounds[1]) }

  /** Glide duration for the cursor: 400 ms to 900 ms depending on distance. */
  fun glideMs(fromX: Float, fromY: Float, toX: Float, toY: Float, width: Int, height: Int): Long {
    val d = Math.hypot((toX - fromX).toDouble(), (toY - fromY).toDouble())
    val diag = Math.hypot(width.toDouble(), height.toDouble()).coerceAtLeast(1.0)
    return (400 + 500 * (d / diag * 1.6).coerceIn(0.0, 1.0)).toLong()
  }
}
