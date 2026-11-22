package dev.bobby.hands

import android.app.Notification
import android.app.NotificationManager
import android.content.pm.ApplicationInfo
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Sends each new notification to the Mind as a contract `notification` message.
 * Skips ongoing notifications, group summaries, silent notifications from system apps,
 * and anything from this app or any `dev.bobby.*` app.
 */
class HandsNotificationListener : NotificationListenerService() {
  private val lastSent = object : LinkedHashMap<String, String>(64, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 200
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?, rankingMap: RankingMap?) {
    val s = sbn ?: return
    try { handle(s, rankingMap) } catch (e: Exception) { Hub.log("notification failed: ${e.message}") }
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) = onNotificationPosted(sbn, null)

  private fun handle(s: StatusBarNotification, ranking: RankingMap?) {
    val pkg = s.packageName ?: return
    if (pkg == packageName || pkg.startsWith("dev.bobby.")) return
    val n = s.notification ?: return
    if (s.isOngoing || (n.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0) return
    if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return

    var importance = NotificationManager.IMPORTANCE_DEFAULT
    if (ranking != null) {
      val r = Ranking()
      if (ranking.getRanking(s.key, r)) importance = r.importance
    }
    if (importance < NotificationManager.IMPORTANCE_DEFAULT && isSystem(pkg)) return
    if (importance == NotificationManager.IMPORTANCE_MIN || importance == NotificationManager.IMPORTANCE_NONE) return

    val ex = n.extras
    val title = (ex.getCharSequence(Notification.EXTRA_TITLE_BIG) ?: ex.getCharSequence(Notification.EXTRA_TITLE))
      ?.toString()?.trim() ?: ""
    val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))
      ?.toString()?.trim() ?: ""
    if (title.isEmpty() && text.isEmpty()) return

    val sig = "$title\u0000$text"
    synchronized(lastSent) {
      if (lastSent[s.key] == sig) return // an update that changed nothing we send
      lastSent[s.key] = sig
    }
    Hub.fromHands(Protocol.notification(pkg, title, text, s.postTime).toString())
  }

  private fun isSystem(pkg: String): Boolean = try {
    val ai = packageManager.getApplicationInfo(pkg, 0)
    (ai.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0
  } catch (e: Exception) { pkg == "android" }
}
