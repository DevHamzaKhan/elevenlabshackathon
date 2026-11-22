package dev.bobby.hands

import org.json.JSONArray
import org.json.JSONObject

/** Thrown when a frame doesn't match the contract. Maps to `error: "bad_request"`. */
class BadRequest(message: String) : Exception(message)

/** The three target forms of CONTRACT.md: `{n}`, `{text}`, `{x,y}`. */
sealed class Target {
  data class Index(val n: Int) : Target()
  data class Text(val text: String) : Target()
  data class Point(val x: Int, val y: Int) : Target()
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
) {
  val centerX: Int get() = (bounds[0] + bounds[2]) / 2
  val centerY: Int get() = (bounds[1] + bounds[3]) / 2

  fun toJson(): JSONObject = JSONObject().apply {
    put("n", n)
    put("text", text)
    put("desc", desc)
    put("cls", cls)
    put("bounds", JSONArray().apply { bounds.forEach { put(it) } })
    put("tap", tap)
    put("edit", edit)
    put("scroll", scroll)
    if (hint.isNotEmpty()) put("hint", hint)
  }

  override fun equals(other: Any?): Boolean =
    other is ScreenNode && n == other.n && text == other.text && desc == other.desc && cls == other.cls &&
      bounds.contentEquals(other.bounds) && tap == other.tap && edit == other.edit && scroll == other.scroll &&
      hint == other.hint

  override fun hashCode(): Int = n * 31 + text.hashCode()
}

object Protocol {
  val DOS = setOf("tap", "long_press", "point", "type", "swipe", "key", "launch", "wait")
  val DIRS = setOf("left", "right", "up", "down")
  val KEYS = setOf("home", "back", "recents", "notifications", "enter")
  val ERRORS = setOf("not_found", "not_editable", "no_permission", "timeout", "bad_request")

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
      else -> throw BadRequest("on needs n, text, or x and y")
    }
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
    )
    when (what) {
      "tap", "long_press", "point" -> if (on == null) throw BadRequest("$what needs on")
      "type" -> if (act.text == null) throw BadRequest("type needs text")
      "swipe" -> if (act.dir !in DIRS) throw BadRequest("swipe needs dir: left, right, up or down")
      "key" -> if (act.name !in KEYS) throw BadRequest("key needs name: ${KEYS.joinToString()}")
      "launch" -> if (act.app.isNullOrBlank()) throw BadRequest("launch needs app")
      "wait" -> if (act.ms == null || act.ms < 0) throw BadRequest("wait needs ms >= 0")
    }
    return act
  }

  fun screenResult(re: String?, app: String, width: Int, height: Int, nodes: List<ScreenNode>): JSONObject =
    JSONObject().apply {
      put("type", "screen_result")
      if (re != null) put("re", re)
      put("app", app)
      put("size", JSONArray().put(width).put(height))
      put("nodes", JSONArray().apply { nodes.forEach { put(it.toJson()) } })
    }

  fun actResult(re: String?, ok: Boolean, error: String? = null, detail: String? = null): JSONObject =
    JSONObject().apply {
      put("type", "act_result")
      if (re != null) put("re", re)
      put("ok", ok)
      if (!ok) put("error", error ?: "bad_request")
      if (detail != null) put("detail", detail)
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
