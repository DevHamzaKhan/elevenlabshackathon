package dev.bobby.hands

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * Invisible activity that asks Android to show the PIN keypad (requestDismissKeyguard) and
 * stays up while Hands types, so the keypad isn't closed under it. Finishes when the phone
 * unlocks, when the request is cancelled, when Hands calls [close], or after 20 s at most.
 */
class BouncerActivity : Activity() {
  companion object {
    @Volatile private var current: BouncerActivity? = null

    fun open(ctx: Context) {
      ctx.startActivity(Intent(ctx, BouncerActivity::class.java).addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS))
    }

    fun close() {
      val a = current ?: return
      a.runOnUiThread { a.done() }
    }
  }

  private val main = Handler(Looper.getMainLooper())

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    getSystemService(KeyguardManager::class.java).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
      override fun onDismissSucceeded() = done()
      override fun onDismissCancelled() = done()
      override fun onDismissError() = done()
    })
    main.postDelayed({ done() }, 20_000)
  }

  private fun done() {
    if (isFinishing) return
    finish()
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }

  override fun onDestroy() {
    main.removeCallbacksAndMessages(null)
    if (current === this) current = null
    super.onDestroy()
  }
}
