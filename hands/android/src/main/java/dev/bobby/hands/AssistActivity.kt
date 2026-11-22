package dev.bobby.hands

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle

/**
 * Makes the app selectable as the phone's digital assistant (Settings → Apps → Default apps →
 * Digital assistant app). Holding the side button then sends ACTION_ASSIST here, and this opens
 * the app's main screen, which wakes Bobby. Invisible: it finishes straight away.
 */
class AssistActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Hub.log("assist: side button held, waking Bobby")
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    val km = getSystemService(KeyguardManager::class.java)
    if (km.isKeyguardLocked) {
      km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = openApp()
        override fun onDismissCancelled() = finish()
        override fun onDismissError() = openApp()
      })
    } else {
      openApp()
    }
  }

  private fun openApp() {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      try { startActivity(launch) } catch (e: Exception) { Hub.log("assist: can't open the app: ${e.message}") }
    }
    finish()
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }
}
