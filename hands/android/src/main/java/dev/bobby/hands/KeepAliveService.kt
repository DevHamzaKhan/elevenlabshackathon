package dev.bobby.hands

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager

/**
 * A foreground service that keeps the app's JavaScript (Mind, Mouth, Caller) alive while other
 * apps are on screen. Started when Bobby wakes. Uses the microphone type when RECORD_AUDIO is
 * granted (the Mouth listens), otherwise dataSync.
 */
class KeepAliveService : Service() {
  companion object {
    const val CHANNEL = "bobby_keepalive"
    const val ID = 8765
    const val EXTRA_TEXT = "text"
    /** Extra on the launch intent when the app is opened from this notification. */
    const val FROM_NOTIFICATION = "bobby_from_notification"
    @Volatile var running = false
      private set

    fun start(ctx: Context, text: String) {
      val i = Intent(ctx, KeepAliveService::class.java).putExtra(EXTRA_TEXT, text)
      ctx.startForegroundService(i)
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, KeepAliveService::class.java))
    }
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Bobby is listening"
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Bobby", NotificationManager.IMPORTANCE_LOW))
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      putExtra(FROM_NOTIFICATION, true)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val pi = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val n = Notification.Builder(this, CHANNEL)
      .setContentTitle("Bobby")
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(pi)
      .build()
    val mic = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val type = if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    try {
      startForeground(ID, n, type)
    } catch (e: Exception) {
      Hub.log("keep-alive: microphone type refused (${e.message}); falling back to dataSync")
      startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }
    if (wake == null) {
      wake = (getSystemService(POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bobby:keepalive").apply { acquire(30 * 60 * 1000L) }
    }
    running = true
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }
}
