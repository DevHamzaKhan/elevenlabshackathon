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
  /** Full resource id, e.g. "com.google.android.gm:id/compose_button". */
  val viewId: String = "",
  val pkg: String = "",
  val checkable: Boolean = false,
  val checked: Boolean = false,
  val enabled: Boolean = true,
  val focused: Boolean = false,
  val selected: Boolean = false,
  val password: Boolean = false,
  /** Directions this node can scroll, from its scroll actions. */
  val scrollDirs: List<String> = emptyList(),
)

object NodeFilter {
  private const val MAX_TEXT = 400
  /** Most characters of children's labels folded into one tappable ancestor. */
  const val MAX_FOLD = 120
  const val FOLD_SEP = " · "
  /** Ancestors bigger than this share of the screen don't take folded labels (whole-screen containers). */
  private const val MAX_FOLD_AREA = 0.34

  private fun clean(s: String?): String {
    if (s == null) return ""
    val t = s.replace(Regex("\\s+"), " ").trim()
    return if (t.length > MAX_TEXT) t.substring(0, MAX_TEXT) + "…" else t
  }

  fun shortClass(cls: String): String = cls.substringAfterLast('.')

  /** "com.google.android.gm:id/compose_button" -> "compose_button". */
  fun shortId(viewId: String): String = viewId.substringAfterLast('/')

  /** A tappable ancestor with no label of its own, collecting its children's labels. */
  private class Fold(val index: Int, val box: IntArray, val canFold: Boolean) {
    val parts = ArrayList<String>()
    var len = 0
    var checked: Boolean? = null
  }

  /**
   * Flattens trees (topmost window first) into the contract's node list:
   * only nodes visible on screen right now that have text, a description, or one of
   * the three flags set. Bounds are clipped to the screen; nodes with no area are dropped.
   *
   * Folding: a plain (not tappable, editable or scrollable) text/description node inside a
   * tappable ancestor that has no label of its own becomes part of that ancestor's `text`
   * (joined with " · ", at most [MAX_FOLD] characters) instead of a node of its own. A checkable
   * plain child (a row's switch) lends the ancestor its `checked` state.
   */
  fun flatten(roots: List<RawNode>, width: Int, height: Int, fold: Boolean = true): List<ScreenNode> {
    val out = ArrayList<ScreenNode>()
    val folds = HashMap<Int, Fold>()
    val screenArea = width.toLong() * height
    fun visit(node: RawNode, depth: Int, parent: ScreenNode?, foldInto: Fold?) {
      if (depth > 80) return
      var emitted: ScreenNode? = null
      var nextFold = foldInto
      if (node.visible) {
        val l = node.bounds[0].coerceIn(0, width)
        val t = node.bounds[1].coerceIn(0, height)
        val r = node.bounds[2].coerceIn(0, width)
        val b = node.bounds[3].coerceIn(0, height)
        if (r > l && b > t) {
          var text = if (node.password) "" else clean(node.text)
          var hint = clean(node.hint)
          if (node.showingHint) {
            // The field is empty and the platform reports its hint as text.
            if (hint.isEmpty()) hint = if (node.password) "" else clean(node.text)
            text = ""
          }
          if (hint == text) hint = ""
          val desc = clean(node.desc)
          val tap = node.clickable || node.longClickable
          val plain = !tap && !node.editable && !node.scrollable
          val box = intArrayOf(l, t, r, b)
          // A plain label that only repeats its parent's label over the same box (common in
          // web pages: a link plus its text) adds nothing; skip it.
          val duplicate = parent != null && plain &&
            parent.bounds.contentEquals(box) &&
            (text.isEmpty() || text.equals(parent.text, true) || text.equals(parent.desc, true)) &&
            (desc.isEmpty() || desc.equals(parent.text, true) || desc.equals(parent.desc, true)) &&
            (text.isNotEmpty() || desc.isNotEmpty())
          var folded = false
          if (fold && plain && foldInto != null && node.checkable && foldInto.checked == null) foldInto.checked = node.checked
          if (fold && plain && foldInto != null && foldInto.canFold) {
            val label = when {
              text.isNotEmpty() && desc.isNotEmpty() && !desc.equals(text, true) -> "$text $desc"
              text.isNotEmpty() -> text
              else -> desc
            }
            if (label.isEmpty()) {
              folded = true
            } else if (!duplicate) {
              val add = (if (foldInto.parts.isEmpty()) 0 else FOLD_SEP.length) + label.length
              if (foldInto.parts.none { it.equals(label, true) } && foldInto.len + add <= MAX_FOLD) {
                foldInto.parts.add(label); foldInto.len += add
                folded = true
              } else if (foldInto.parts.any { it.equals(label, true) }) {
                folded = true // same words twice in one row: once is enough
              }
            }
          }
          if (!duplicate && !folded && (text.isNotEmpty() || desc.isNotEmpty() || tap || node.editable || node.scrollable)) {
            emitted = ScreenNode(
              n = out.size,
              text = text,
              desc = desc,
              cls = shortClass(node.cls),
              bounds = box,
              tap = tap,
              edit = node.editable,
              scroll = node.scrollable,
              hint = hint,
              ref = node.ref,
              checked = if (node.checkable) node.checked else null,
              disabled = !node.enabled,
              focused = node.focused,
              selected = node.selected,
              password = node.password,
              id = shortId(node.viewId),
              scrollDirs = if (node.scrollable) node.scrollDirs else emptyList(),
              viewId = node.viewId,
              pkg = node.pkg,
            )
            out.add(emitted)
            if (tap) {
              val area = (r - l).toLong() * (b - t)
              val f = Fold(emitted.n, box, text.isEmpty() && desc.isEmpty() && !node.editable && !node.scrollable &&
                area <= screenArea * MAX_FOLD_AREA)
              folds[emitted.n] = f
              nextFold = f
            } else if (!plain) {
              nextFold = null // an editable or scrollable node starts its own context
            }
          }
        }
      }
      for (c in node.children) visit(c, depth + 1, emitted ?: parent, nextFold)
    }
    roots.forEach { visit(it, 0, null, null) }
    for ((i, f) in folds) {
      if (f.parts.isEmpty() && f.checked == null) continue
      val n = out[i]
      out[i] = n.copy(
        text = if (f.parts.isEmpty()) n.text else f.parts.joinToString(FOLD_SEP),
        checked = n.checked ?: f.checked,
      )
    }
    return withKeys(out, width, height)
  }

  /**
   * Stable keys: package + resource id + class + label prefix + a rough position bucket,
   * hashed. Editable fields use their hint/description, not the text being typed, so a field
   * keeps its key while it fills. Identical twins get "-2", "-3" in reading order.
   */
  fun withKeys(nodes: List<ScreenNode>, width: Int, height: Int): List<ScreenNode> {
    val seen = HashMap<String, Int>()
    val cw = (width / 8).coerceAtLeast(1)
    val ch = (height / 16).coerceAtLeast(1)
    return nodes.map { n ->
      val label = (if (n.edit) n.hint.ifEmpty { n.desc } else n.text.ifEmpty { n.desc }).take(24)
      val raw = "${n.pkg}|${n.viewId}|${n.cls}|$label|${n.centerX / cw},${n.centerY / ch}"
      val base = "k" + ScreenHash.fnv32(raw)
      val count = (seen[base] ?: 0) + 1
      seen[base] = count
      n.copy(key = if (count == 1) base else "$base-$count")
    }
  }

  /** True for a class name that is (or wraps) a web view. */
  fun isWebView(cls: String): Boolean = cls == "android.webkit.WebView" || cls.endsWith(".WebView") || cls == "WebView"

  /** A web view that's still loading: no content yet. Checked by class, not by its (localized) description. */
  fun hasEmptyWebView(n: RawNode): Boolean =
    (isWebView(n.cls) && (n.children.isEmpty() || n.children.all { it.children.isEmpty() && it.text.isEmpty() })) ||
      n.children.any { hasEmptyWebView(it) }
}

/** Window rules for reading the screen, kept pure for tests. */
object WindowRules {
  /**
   * An application window this big hides the ones below it. Tolerant of taskbars, nav bars and
   * cutouts (most of the width, 80% of the height); split-screen halves don't cover each other.
   */
  fun covers(left: Int, top: Int, right: Int, bottom: Int, width: Int, height: Int): Boolean =
    (right - left) >= width * 0.9 && (bottom - top) >= height * 0.8
}

/** The `hash` of a screen: what it shows, not when. */
object ScreenHash {
  const val LOCKED = "locked"
  private const val SYSTEMUI = "com.android.systemui"
  private val CLOCK = Regex("\\b\\d{1,2}[:.]\\d{2}\\b|\\b\\d{1,3}\\s?%")

  /**
   * Hashes the app and every node's labels, flags and bounds (rounded to 8 px). System UI
   * nodes in the status-bar strip are left out, and clock/battery numbers in system UI text
   * are masked, so a ticking clock doesn't change the hash.
   */
  fun of(app: String, width: Int, height: Int, nodes: List<ScreenNode>): String {
    val sb = StringBuilder()
    sb.append(app).append('|').append(width).append('x').append(height).append('\n')
    val strip = (height * 0.06).toInt()
    for (n in nodes) {
      val sys = n.pkg == SYSTEMUI
      if (sys && n.bounds[3] <= strip) continue
      fun t(s: String) = if (sys) CLOCK.replace(s, "#") else s
      sb.append(t(n.text)).append('\u0001').append(t(n.desc)).append('\u0001').append(n.hint).append('\u0001')
        .append(n.cls).append('\u0001').append(n.id).append('\u0001')
      for (v in n.bounds) sb.append((v + 4) / 8).append(',')
      sb.append(if (n.tap) 't' else '-').append(if (n.edit) 'e' else '-').append(if (n.scroll) 's' else '-')
        .append(when (n.checked) { true -> 'C'; false -> 'c'; null -> '-' })
        .append(if (n.disabled) 'd' else '-').append(if (n.focused) 'f' else '-').append(if (n.selected) 'S' else '-')
        .append('\n')
    }
    return sha16(sb.toString())
  }

  fun sha16(s: String): String {
    val d = java.security.MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8))
    val sb = StringBuilder()
    for (i in 0 until 8) sb.append(String.format("%02x", d[i]))
    return sb.toString()
  }

  /** 32-bit FNV-1a as 8 hex characters. */
  fun fnv32(s: String): String {
    var h = 0x811c9dc5.toInt()
    for (b in s.toByteArray(Charsets.UTF_8)) { h = h xor (b.toInt() and 0xff); h *= 16777619 }
    return String.format("%08x", h)
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
    // A folded row label ("Sarah Chen · Running late") matches any of its parts exactly.
    nodes.firstOrNull { n -> n.text.split(NodeFilter.FOLD_SEP).any { norm(it) == q } }?.let { return it }
    nodes.firstOrNull { norm(it.text).contains(q) || norm(it.desc).contains(q) }?.let { return it }
    nodes.firstOrNull { norm(it.hint) == q }?.let { return it }
    return nodes.firstOrNull { norm(it.hint).contains(q) }
  }

  /**
   * By resource id: the full "pkg:id/name" or the short "name" (also "id/name").
   * A tappable or editable match wins over a plain one.
   */
  fun byId(nodes: List<ScreenNode>, id: String): ScreenNode? {
    val q = id.trim()
    if (q.isEmpty()) return null
    val short = q.substringAfterLast('/')
    val full = q.contains(':')
    val hits = nodes.filter { if (full) it.viewId == q else it.id == short }
    return hits.firstOrNull { it.tap || it.edit } ?: hits.firstOrNull()
  }

  fun byKey(nodes: List<ScreenNode>, key: String): ScreenNode? = nodes.firstOrNull { it.key == key.trim() }

  /** The smallest node containing the point that satisfies [pred]. */
  fun atPoint(nodes: List<ScreenNode>, x: Int, y: Int, pred: (ScreenNode) -> Boolean = { true }): ScreenNode? =
    nodes.filter { x >= it.bounds[0] && x < it.bounds[2] && y >= it.bounds[1] && y < it.bounds[3] && pred(it) }
      .minByOrNull { (it.bounds[2] - it.bounds[0]).toLong() * (it.bounds[3] - it.bounds[1]) }

  /**
   * Glide duration for the cursor: 400 ms to 900 ms depending on distance,
   * or 120 ms to 250 ms when [fast].
   */
  fun glideMs(fromX: Float, fromY: Float, toX: Float, toY: Float, width: Int, height: Int, fast: Boolean = false): Long {
    val d = Math.hypot((toX - fromX).toDouble(), (toY - fromY).toDouble())
    val diag = Math.hypot(width.toDouble(), height.toDouble()).coerceAtLeast(1.0)
    val f = (d / diag * 1.6).coerceIn(0.0, 1.0)
    return if (fast) (120 + 130 * f).toLong() else (400 + 500 * f).toLong()
  }
}

/** One app `launch` could open. */
data class LaunchCandidate(val pkg: String, val label: String, val launcherVisible: Boolean, val ref: Any? = null)

object LaunchRanker {
  private fun norm(s: String) = s.replace(Regex("\\s+"), " ").trim().lowercase()

  /**
   * The app [query] means. A package name matches exactly. Otherwise, by label ignoring case:
   * exact beats prefix beats contains (a word prefix like "Maps" in "Google Maps" counts as a
   * prefix). Ties prefer an app the launcher shows, then the shorter label.
   */
  fun pick(query: String, candidates: List<LaunchCandidate>): LaunchCandidate? {
    val q = norm(query)
    if (q.isEmpty()) return null
    candidates.filter { it.pkg.equals(query.trim(), ignoreCase = true) }
      .minWithOrNull(compareBy({ if (it.launcherVisible) 0 else 1 }))?.let { return it }
    fun rank(c: LaunchCandidate): Int {
      val l = norm(c.label)
      return when {
        l == q -> 0
        l.startsWith(q) -> 1
        Regex("(^|[\\s(])" + Regex.escape(q)).containsMatchIn(l) -> 2 // a word starts with it: "Maps" in "Google Maps"
        l.contains(q) -> 3
        else -> 9
      }
    }
    return candidates.map { it to rank(it) }.filter { it.second < 9 }
      .minWithOrNull(compareBy({ it.second }, { if (it.first.launcherVisible) 0 else 1 }, { it.first.label.length }))
      ?.first
  }
}
