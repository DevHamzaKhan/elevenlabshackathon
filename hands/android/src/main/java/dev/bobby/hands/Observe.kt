package dev.bobby.hands

import org.json.JSONArray
import org.json.JSONObject

/**
 * One accessibility event about something the user did, copied out of the platform object so the
 * recorder's rules can be unit-tested on the JVM. [ref] is the event's source node on the phone.
 */
class SeenEvent(
  val type: Int,
  val pkg: String,
  val cls: String = "",
  val text: String = "",
  val desc: String = "",
  val ref: Any? = null,
  /** Full resource id of the source, e.g. "com.example.projects:id/fab_new". */
  val viewId: String = "",
  /** Source bounds on screen, [left, top, right, bottom], when known. */
  val bounds: IntArray? = null,
  val password: Boolean = false,
  val editable: Boolean = false,
  val dx: Int = 0,
  val dy: Int = 0,
)

/** A settled screen as the recorder sees it. */
class Snap(val app: String, val width: Int, val height: Int, val nodes: List<ScreenNode>, val hash: String)

/**
 * Teaching by showing: turns what the user does into `observed` frames for the Mind.
 *
 *  - `kind:"screen"`: a settled screen (`screen`: a compact screen_result body). Sent when it
 *    differs from the last one sent, and always before an action that refers to it.
 *  - `kind:"tap"` / `"long_press"`: `app`, `hash` (the screen it happened on), `node` (that
 *    screen's node, with `n`, `key`, `id`; or what the event itself said, with `matched:false`).
 *  - `kind:"type"`: one frame per burst of typing into a field, with the final `text`; `hash` and
 *    `node` are from before the first keystroke. A password field sends `password:true`, no text.
 *  - `kind:"scroll"`: the first scroll of a burst, with `dir` as the finger moved (`up` shows
 *    what is further down), or no `dir` when the app didn't say.
 *
 * Nothing from this app or the keyboard is recorded. Every method is synchronized, so frames
 * leave in order.
 */
class Recorder(
  private val ownPkg: String?,
  private val imePkg: String?,
  private val emit: (JSONObject) -> Unit,
  private val clock: () -> Long = { System.currentTimeMillis() },
) {
  companion object {
    // AccessibilityEvent constants, copied so this stays pure.
    const val TYPE_VIEW_CLICKED = 0x1
    const val TYPE_VIEW_LONG_CLICKED = 0x2
    const val TYPE_VIEW_TEXT_CHANGED = 0x10
    const val TYPE_VIEW_SCROLLED = 0x1000
    /** Event types the service also asks for while observing. */
    const val EVENTS = TYPE_VIEW_CLICKED or TYPE_VIEW_LONG_CLICKED or TYPE_VIEW_TEXT_CHANGED or TYPE_VIEW_SCROLLED
    /** Typing counts as finished after this long without a keystroke. */
    const val TYPING_IDLE_MS = 900L

    fun wanted(type: Int): Boolean = type == TYPE_VIEW_CLICKED || type == TYPE_VIEW_LONG_CLICKED ||
      type == TYPE_VIEW_TEXT_CHANGED || type == TYPE_VIEW_SCROLLED

    /**
     * The way the finger moved, from the content's scroll deltas (a positive delta means later
     * content came into view, i.e. the finger went up or left). Null when the app gave none.
     */
    fun scrollDir(dx: Int, dy: Int): String? = when {
      dx == 0 && dy == 0 -> null
      Math.abs(dy) >= Math.abs(dx) -> if (dy > 0) "up" else "down"
      else -> if (dx > 0) "left" else "right"
    }

    /**
     * The node of a settled screen an event came from: the same platform node, else the same
     * resource id at the same place, else the tappable (or editable) node under the event's
     * centre, else the first node with the event's words.
     */
    fun match(nodes: List<ScreenNode>, e: SeenEvent, wantEdit: Boolean = false): ScreenNode? {
      if (e.ref != null) nodes.firstOrNull { it.ref != null && it.ref == e.ref }?.let { return it }
      val b = e.bounds
      val cx = if (b != null) (b[0] + b[2]) / 2 else -1
      val cy = if (b != null) (b[1] + b[3]) / 2 else -1
      fun holds(n: ScreenNode) = b == null || (cx >= n.bounds[0] && cx < n.bounds[2] && cy >= n.bounds[1] && cy < n.bounds[3])
      if (e.viewId.isNotEmpty()) {
        val same = nodes.filter { it.viewId == e.viewId }
        same.firstOrNull { holds(it) && b != null }?.let { return it }
        if (same.size == 1) return same[0]
      }
      if (b != null) {
        TargetMatcher.atPoint(nodes, cx, cy) { if (wantEdit) it.edit else it.tap || it.edit }?.let { return it }
      }
      val words = e.text.ifEmpty { e.desc }
      if (!wantEdit && words.isNotEmpty()) return TargetMatcher.byText(nodes, words)
      return null
    }

    /** What an event alone says about its source, when no node of the screen matches it. */
    fun bare(e: SeenEvent): JSONObject = JSONObject().apply {
      if (e.text.isNotEmpty() && !e.editable) put("text", e.text)
      if (e.desc.isNotEmpty()) put("desc", e.desc)
      if (e.cls.isNotEmpty()) put("cls", NodeFilter.shortClass(e.cls))
      if (e.viewId.isNotEmpty()) put("id", NodeFilter.shortId(e.viewId))
      e.bounds?.let { b -> put("bounds", JSONArray().apply { b.forEach { put(it) } }) }
      if (e.editable) put("edit", true)
      put("matched", false)
    }
  }

  private class Typing(val field: String, val ref: Any?, val node: JSONObject, val hash: String?, val app: String) {
    var text = ""
    var password = false
    var lastAt = 0L
  }

  var seq = 0
    private set
  private var current: Snap? = null
  private var sentHash: String? = null
  private var typing: Typing? = null
  private var lastKind = ""

  /** The screen when observing starts: adopted without a frame (it goes in `observe_result`). */
  @Synchronized
  fun start(s: Snap?) {
    if (s == null || s.app == ownPkg) return
    current = s
    sentHash = s.hash
  }

  /** A newly settled screen. Screens of this app (it comes forward for a moment on a wake) are skipped. */
  @Synchronized
  fun screen(s: Snap) {
    if (ownPkg != null && s.app == ownPkg) return
    current = s
    // While the user types, every keystroke is a new screen; one is sent when the burst ends.
    if (typing == null) sendScreen()
  }

  @Synchronized
  fun event(e: SeenEvent) {
    if (e.pkg.isEmpty() || e.pkg == ownPkg || e.pkg == imePkg) return
    when (e.type) {
      TYPE_VIEW_CLICKED, TYPE_VIEW_LONG_CLICKED -> {
        flushTyping()
        sendScreen()
        val node = current?.let { match(it.nodes, e) }
        action(if (e.type == TYPE_VIEW_CLICKED) "tap" else "long_press", e.pkg, current?.hash, node?.toJson(true) ?: bare(e))
      }
      TYPE_VIEW_TEXT_CHANGED -> {
        if (!e.editable && !e.cls.endsWith("EditText")) return
        val node = current?.let { match(it.nodes, e, wantEdit = true) }
        val field = node?.key?.ifEmpty { null } ?: "${e.viewId}@${e.bounds?.joinToString(",")}"
        // The same field while its text changes: the same platform node, or the same key.
        typing?.let { t -> if (!((t.ref != null && t.ref == e.ref) || t.field == field)) flushTyping() }
        if (typing == null) {
          sendScreen()
          typing = Typing(field, e.ref, node?.toJson(true) ?: bare(e), current?.hash, e.pkg)
        }
        typing!!.let {
          it.password = e.password
          it.text = if (e.password) "" else e.text
          it.lastAt = clock()
        }
      }
      TYPE_VIEW_SCROLLED -> {
        // A field scrolls its own text as it fills, and one swipe is many events: neither is news.
        if (e.editable || typing != null || lastKind == "scroll") return
        sendScreen()
        val node = current?.let { match(it.nodes, e) }
        val frame = frame("scroll", e.pkg, current?.hash, node?.toJson(true))
        scrollDir(e.dx, e.dy)?.let { frame.put("dir", it) }
        send("scroll", frame)
      }
    }
  }

  /** Called now and then: a burst of typing that has gone quiet is sent, then the screen it left. */
  @Synchronized
  fun idle() {
    val t = typing ?: return
    if (clock() - t.lastAt < TYPING_IDLE_MS) return
    flushTyping()
    sendScreen()
  }

  /** Observing ends: whatever was still being collected goes out. */
  @Synchronized
  fun flush() {
    flushTyping()
    sendScreen()
  }

  private fun flushTyping() {
    val t = typing ?: return
    typing = null
    val f = frame("type", t.app, t.hash, t.node)
    if (t.password) f.put("password", true) else f.put("text", t.text)
    send("type", f)
  }

  private fun action(kind: String, app: String, hash: String?, node: JSONObject?) = send(kind, frame(kind, app, hash, node))

  private fun frame(kind: String, app: String, hash: String?, node: JSONObject?): JSONObject = JSONObject().apply {
    put("type", "observed")
    put("kind", kind)
    put("app", app)
    if (hash != null) put("hash", hash)
    if (node != null) put("node", node)
    put("at", clock())
  }

  private fun send(kind: String, f: JSONObject) {
    if (kind != "screen") lastKind = kind
    f.put("seq", ++seq)
    emit(f)
  }

  private fun sendScreen() {
    val s = current ?: return
    if (s.hash == sentHash) return
    sentHash = s.hash
    val body = Protocol.embedded(Protocol.screenResult(null, s.app, s.width, s.height, s.nodes, s.hash, compact = true))
    send("screen", JSONObject().put("type", "observed").put("kind", "screen").put("screen", body))
  }
}
