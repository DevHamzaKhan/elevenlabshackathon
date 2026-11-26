package dev.bobby.hands

import org.json.JSONArray
import org.json.JSONObject

/** Thrown when a frame doesn't match the contract. Maps to `error: "bad_request"`. */
class BadRequest(message: String) : Exception(message)

/**
 * The target forms of CONTRACT.md: `{n}`, `{text}`, `{x,y}`, plus two additive ones:
 * `{id}` (a view's resource id, full `pkg:id/name` or short `name`) and `{key}` (a node's
 * stable `key` from a screen_result).
 */
sealed class Target {
  data class Index(val n: Int) : Target()
  data class Text(val text: String) : Target()
  data class Point(val x: Int, val y: Int) : Target()
  data class Id(val id: String) : Target()
  data class Key(val key: String) : Target()
}

data class Act(
  val id: String?,
  val what: String,
  val on: Target? = null,
  val text: String? = null,
  val dir: String? = null,
  val name: String? = null,
  val app: String? = null,
  val ms: Long? = null,
  // `open`
  val uri: String? = null,
  val action: String? = null,
  val pkg: String? = null,
  val mime: String? = null,
  val extras: Map<String, Any> = emptyMap(),
  // options on any act
  val thenScreen: Boolean = false,
  val compact: Boolean = false,
  val fast: Boolean = false,
  /** `launch` only: start the app at its first screen instead of resuming where it was. */
  val fresh: Boolean = false,
)

/** One entry of `screen_result.nodes`. `bounds` is [left, top, right, bottom]. */
data class ScreenNode(
  val n: Int,
  val text: String,
  val desc: String,
  val cls: String,
  val bounds: IntArray,
  val tap: Boolean,
  val edit: Boolean,
  val scroll: Boolean,
  /** Extra (not in the contract): an empty field's hint text, e.g. "Compose email". */
  val hint: String = "",
  /** Not sent: the platform node this came from, so `type` can set its text. */
  val ref: Any? = null,
  /** Extra: null unless the node is checkable. */
  val checked: Boolean? = null,
  val disabled: Boolean = false,
  val focused: Boolean = false,
  val selected: Boolean = false,
  val password: Boolean = false,
  /** Extra: short resource id name ("compose_button"). [viewId] keeps the full one. */
  val id: String = "",
  /** Extra: stable across reads of an unchanged screen. */
  val key: String = "",
  /** Extra: the directions the node can scroll ("up", "down", "left", "right"). */
  val scrollDirs: List<String> = emptyList(),
  /** Not sent: the full resource id ("com.google.android.gm:id/compose_button"). */
  val viewId: String = "",
  /** Not sent: the package of the window this node is in. */
  val pkg: String = "",
) {
  val centerX: Int get() = (bounds[0] + bounds[2]) / 2
  val centerY: Int get() = (bounds[1] + bounds[3]) / 2

  /**
   * v1 fields are always present unless [compact], which drops false booleans and empty
   * strings. The extra fields are only ever sent when set (`checked` whenever checkable).
   */
  fun toJson(compact: Boolean = false): JSONObject = JSONObject().apply {
    put("n", n)
    if (!compact || text.isNotEmpty()) put("text", text)
    if (!compact || desc.isNotEmpty()) put("desc", desc)
    if (!compact || cls.isNotEmpty()) put("cls", cls)
    put("bounds", JSONArray().apply { bounds.forEach { put(it) } })
    if (!compact || tap) put("tap", tap)
    if (!compact || edit) put("edit", edit)
    if (!compact || scroll) put("scroll", scroll)
    if (hint.isNotEmpty()) put("hint", hint)
    if (checked != null) put("checked", checked)
    if (disabled) put("disabled", true)
    if (focused) put("focused", true)
    if (selected) put("selected", true)
    if (password) put("password", true)
    if (id.isNotEmpty()) put("id", id)
    if (key.isNotEmpty()) put("key", key)
    if (scrollDirs.isNotEmpty()) put("scrollDirs", JSONArray().apply { scrollDirs.forEach { put(it) } })
  }

  override fun equals(other: Any?): Boolean =
    other is ScreenNode && n == other.n && text == other.text && desc == other.desc && cls == other.cls &&
      bounds.contentEquals(other.bounds) && tap == other.tap && edit == other.edit && scroll == other.scroll &&
      hint == other.hint && checked == other.checked && disabled == other.disabled && focused == other.focused &&
      selected == other.selected && password == other.password && id == other.id && key == other.key &&
      scrollDirs == other.scrollDirs

  override fun hashCode(): Int = n * 31 + text.hashCode()
}

/** What a `screen` request asked for (all optional). */
data class ScreenRequest(val since: String? = null, val compact: Boolean = false, val image: Boolean = false) {
  companion object {
    fun parse(o: JSONObject) = ScreenRequest(
      since = Protocol.str(o, "since"),
      compact = o.optBoolean("compact", false),
      image = o.optBoolean("image", false),
    )
  }
}

object Protocol {
  val DOS = setOf("tap", "long_press", "point", "type", "swipe", "key", "launch", "wait", "open")
  val DIRS = setOf("left", "right", "up", "down")
  val KEYS = setOf("home", "back", "recents", "notifications", "enter")
  val ERRORS = setOf("not_found", "not_editable", "no_permission", "timeout", "bad_request")

  /** A trimmed non-empty string field, or null (missing, JSON null, or blank). */
  fun str(o: JSONObject, key: String): String? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.get(key).toString().trim().ifEmpty { null }
  }

  fun parseTarget(o: Any?): Target? {
    if (o == null || o == JSONObject.NULL) return null
    if (o !is JSONObject) throw BadRequest("on must be an object")
    return when {
      o.has("n") -> {
        val n = o.opt("n")
        if (n !is Number) throw BadRequest("on.n must be a number")
        Target.Index(n.toInt())
      }
      o.has("text") -> {
        val t = o.optString("text", "")
        if (t.isBlank()) throw BadRequest("on.text is empty")
        Target.Text(t)
      }
      o.has("x") && o.has("y") -> {
        val x = o.opt("x"); val y = o.opt("y")
        if (x !is Number || y !is Number) throw BadRequest("on.x and on.y must be numbers")
        Target.Point(x.toInt(), y.toInt())
      }
      o.has("id") -> {
        val t = o.optString("id", "").trim()
        if (t.isEmpty()) throw BadRequest("on.id is empty")
        Target.Id(t)
      }
      o.has("key") -> {
        val t = o.optString("key", "").trim()
        if (t.isEmpty()) throw BadRequest("on.key is empty")
        Target.Key(t)
      }
      else -> throw BadRequest("on needs n, text, x and y, id, or key")
    }
  }

  /**
   * Intent extras for `open`: string, number (Int when integral and in range, Long when
   * integral and bigger, else Double), boolean, or an array of strings.
   */
  fun parseExtras(o: Any?): Map<String, Any> {
    if (o == null || o == JSONObject.NULL) return emptyMap()
    if (o !is JSONObject) throw BadRequest("extras must be an object")
    val out = LinkedHashMap<String, Any>()
    for (k in o.keys()) {
      val v = o.get(k)
      out[k] = when (v) {
        is String -> v
        is Boolean -> v
        is Number -> {
          val d = v.toDouble()
          when {
            d == Math.floor(d) && !d.isInfinite() && d >= Int.MIN_VALUE && d <= Int.MAX_VALUE -> d.toInt()
            d == Math.floor(d) && !d.isInfinite() && Math.abs(d) < 9.007199254740992E15 -> d.toLong()
            else -> d
          }
        }
        is JSONArray -> Array(v.length()) { i ->
          val e = v.get(i)
          if (e !is String) throw BadRequest("extras.$k: arrays may hold strings only")
          e
        }
        else -> throw BadRequest("extras.$k must be a string, number, boolean or array of strings")
      }
    }
    return out
  }

  /** Parses and validates an `act` frame. Throws [BadRequest]. */
  fun parseAct(o: JSONObject): Act {
    val id = if (o.has("id") && !o.isNull("id")) o.get("id").toString() else null
    val what = o.optString("do", "")
    if (what !in DOS) throw BadRequest("unknown do: '$what'")
    val on = parseTarget(o.opt("on"))
    val act = Act(
      id = id,
      what = what,
      on = on,
      text = if (o.has("text") && !o.isNull("text")) o.get("text").toString() else null,
      dir = o.optString("dir", "").ifEmpty { null },
      name = o.optString("name", "").ifEmpty { null },
      app = o.optString("app", "").ifEmpty { null },
      ms = if (o.has("ms")) (o.opt("ms") as? Number)?.toLong() ?: throw BadRequest("ms must be a number") else null,
      uri = str(o, "uri"),
      action = str(o, "action"),
      pkg = str(o, "pkg"),
      mime = str(o, "type_mime"),
      extras = parseExtras(o.opt("extras")),
      thenScreen = o.optBoolean("then_screen", false),
      compact = o.optBoolean("compact", false),
      fast = o.optBoolean("fast", false),
      fresh = o.optBoolean("fresh", false),
    )
    when (what) {
      "tap", "long_press", "point" -> if (on == null) throw BadRequest("$what needs on")
      "type" -> if (act.text == null) throw BadRequest("type needs text")
      "swipe" -> if (act.dir !in DIRS) throw BadRequest("swipe needs dir: left, right, up or down")
      "key" -> if (act.name !in KEYS) throw BadRequest("key needs name: ${KEYS.joinToString()}")
      "launch" -> if (act.app.isNullOrBlank()) throw BadRequest("launch needs app")
      "wait" -> if (act.ms == null || act.ms < 0) throw BadRequest("wait needs ms >= 0")
      "open" -> if (act.uri == null && act.action == null) throw BadRequest("open needs uri or action")
    }
    return act
  }

  fun screenResult(
    re: String?, app: String, width: Int, height: Int, nodes: List<ScreenNode>,
    hash: String? = null, compact: Boolean = false,
  ): JSONObject =
    JSONObject().apply {
      put("type", "screen_result")
      if (re != null) put("re", re)
      put("app", app)
      put("size", JSONArray().put(width).put(height))
      if (hash != null) put("hash", hash)
      put("nodes", JSONArray().apply { nodes.forEach { put(it.toJson(compact)) } })
    }

  /**
   * The reply to a `screen` request: `same:true` with no nodes when the screen's hash equals
   * the request's `since`, otherwise a full result. Always carries `hash`.
   */
  fun screenReply(re: String?, app: String, width: Int, height: Int, nodes: List<ScreenNode>, hash: String, req: ScreenRequest): JSONObject {
    if (req.since != null && req.since == hash) {
      return JSONObject().apply {
        put("type", "screen_result")
        if (re != null) put("re", re)
        put("same", true)
        put("hash", hash)
        put("app", app)
        put("size", JSONArray().put(width).put(height))
      }
    }
    return screenResult(re, app, width, height, nodes, hash, req.compact)
  }

  /** The screen while a secure lock (PIN, pattern, password, biometric) is showing: no nodes. */
  fun lockedScreen(re: String?, width: Int, height: Int): JSONObject =
    screenResult(re, "", width, height, emptyList(), ScreenHash.LOCKED).put("locked", true)

  /** A screen_result body for `then_screen`: the same object without `type` and `re`. */
  fun embedded(screen: JSONObject): JSONObject {
    val o = JSONObject(screen.toString())
    o.remove("type"); o.remove("re")
    return o
  }

  /**
   * `detail` is the v1 field name; `why` carries the same text (the name newer Minds read).
   */
  fun actResult(re: String?, ok: Boolean, error: String? = null, detail: String? = null): JSONObject =
    JSONObject().apply {
      put("type", "act_result")
      if (re != null) put("re", re)
      put("ok", ok)
      if (!ok) put("error", error ?: "bad_request")
      if (detail != null) { put("detail", detail); put("why", detail) }
    }

  fun notification(app: String, title: String, text: String, at: Long): JSONObject =
    JSONObject().apply {
      put("type", "notification")
      put("app", app)
      put("title", title)
      put("text", text)
      put("at", at)
    }
}
