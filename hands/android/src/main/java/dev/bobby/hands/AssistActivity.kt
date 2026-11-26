package dev.bobby.hands

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * Makes the app selectable as the phone's digital assistant (Settings → Apps → Default apps →
 * Digital assistant app). Holding the side button then sends ACTION_ASSIST here, and this opens
 * the app's main screen, which wakes Bobby. Invisible: it finishes straight away.
 *
 * On a PIN-locked phone with Bobby's unlock armed, it wakes Bobby over the lock screen instead
 * (keep-alive plus an `onAssist` event to the app's JavaScript), so he can listen for the phrase
 * without anyone typing the PIN first. If the app's JavaScript isn't running, it falls back to
 * the usual path: Android asks for the PIN, then the app opens.
 */
class AssistActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Hub.log("assist: side button held, waking Bobby")
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    val km = getSystemService(KeyguardManager::class.java)
    if (km.isKeyguardLocked && km.isDeviceSecure && UnlockVault.status(this).armed && BobbyHandsModule.listeningForAssist()) {
      // Started while this activity is on screen, so Android lets the service use the microphone.
      try { KeepAliveService.start(this, "Bobby is listening") } catch (e: Exception) { Hub.log("assist: keep-alive failed: ${e.message}") }
      BobbyHandsModule.emitAssist()
      Hub.log("assist: phone locked, woke Bobby over the lock screen")
      // Stay (invisibly) for a moment so the Mouth opens the microphone while the app is in front.
      Handler(Looper.getMainLooper()).postDelayed({ close() }, 1500)
      return
    }
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
    close()
  }

  private fun close() {
    if (isFinishing) return
    finish()
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }
}
