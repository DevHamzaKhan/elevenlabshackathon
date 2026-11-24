package dev.bobby.hands

/** What `do:"open"` will start, before it becomes an android.content.Intent. Pure, for tests. */
data class IntentPlan(
  val action: String,
  val uri: String?,
  val pkg: String?,
  val mime: String?,
  val extras: Map<String, Any>,
) {
  /** For error messages: "mailto:" or the action. */
  val what: String get() = Intents.scheme(uri)?.let { "$it:" } ?: action
}

object Intents {
  const val VIEW = "android.intent.action.VIEW"
  const val SENDTO = "android.intent.action.SENDTO"
  const val DIAL = "android.intent.action.DIAL"
  /** Actions that would place a call without the user: always turned into [DIAL]. */
  val CALLS = setOf(
    "android.intent.action.CALL",
    "android.intent.action.CALL_PRIVILEGED",
    "android.intent.action.CALL_EMERGENCY",
  )

  /** "mailto:sam@x.com" -> "mailto". Null when there is no scheme. */
  fun scheme(uri: String?): String? {
    if (uri == null) return null
    val i = uri.indexOf(':')
    if (i <= 0) return null
    val s = uri.substring(0, i)
    return if (s.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) s.lowercase() else null
  }

  /** mailto/sms/smsto -> SENDTO, tel -> DIAL (never CALL), everything else -> VIEW. */
  fun defaultAction(scheme: String?): String = when (scheme) {
    "mailto", "sms", "smsto", "mms", "mmsto" -> SENDTO
    "tel" -> DIAL
    else -> VIEW
  }

  /** Builds the plan for an `open` act. Throws [BadRequest]. */
  fun plan(a: Act): IntentPlan {
    if (a.uri == null && a.action == null) throw BadRequest("open needs uri or action")
    val sch = scheme(a.uri)
    if (a.uri != null && sch == null) throw BadRequest("uri needs a scheme, like mailto: or https:")
    var action = a.action ?: defaultAction(sch)
    if (action in CALLS) action = DIAL
    return IntentPlan(action, a.uri, a.pkg, a.mime, a.extras)
  }
}
