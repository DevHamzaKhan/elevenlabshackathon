package dev.bobby.hands

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * Invisible activity that turns the screen on and dismisses a non-secure lock screen, then
 * finishes. Hands starts it when an action arrives while the screen is off or locked.
 */
class WakeActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    val km = getSystemService(KeyguardManager::class.java)
    km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
      override fun onDismissSucceeded() = finish()
      override fun onDismissCancelled() = finish()
      override fun onDismissError() = finish()
    })
    Handler(Looper.getMainLooper()).postDelayed({ if (!isFinishing) finish() }, 2000)
  }

  override fun finish() {
    super.finish()
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }
}
