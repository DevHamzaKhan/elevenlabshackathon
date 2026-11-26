package dev.bobby.hands

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BobbyHandsModule : Module() {
  companion object {
    @Volatile private var live: BobbyHandsModule? = null
    @Volatile private var assistListeners = false

    /** True when the app's JavaScript is running and listening for `onAssist`. */
    fun listeningForAssist(): Boolean = live != null && assistListeners

    /** Tells the app's JavaScript the side button was held on a locked phone. */
    fun emitAssist(): Boolean {
      val m = live ?: return false
      if (!assistListeners) return false
      return try { m.sendEvent("onAssist", mapOf("locked" to true)); true } catch (e: Exception) { false }
    }
  }

  /** Set when the activity receives an intent from Bobby's keep-alive notification. */
  @Volatile private var fromNotification = false

  private val ctx: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no React context")

  override fun definition() = ModuleDefinition {
    Name("BobbyHands")

    Events("onAssist")
    OnStartObserving("onAssist") { assistListeners = true }
    OnStopObserving("onAssist") { assistListeners = false }

    OnDestroy {
      if (live === this@BobbyHandsModule) { live = null; assistListeners = false }
    }

    OnCreate {
      live = this@BobbyHandsModule
      fromNotification = appContext.currentActivity?.intent
        ?.getBooleanExtra(KeepAliveService.FROM_NOTIFICATION, false) ?: false
    }

    // React Native doesn't call setIntent() for new intents, so track them here.
    OnNewIntent { intent ->
      fromNotification = intent.getBooleanExtra(KeepAliveService.FROM_NOTIFICATION, false)
    }

    Function("configure") { options: Map<String, Any?> ->
      val token = options["token"]?.toString() ?: throw IllegalArgumentException("configure needs {token}")
      HandsPrefs.setToken(ctx, token)
      Hub.setToken(token)
    }

    Function("status") {
      val c = ctx
      val core = Hub.core
      val peers = core?.peers()
      mapOf(
        "accessibility" to accessibilityEnabled(c),
        "serviceRunning" to (HandsService.instance != null),
        "notificationAccess" to c.getSystemService(NotificationManager::class.java)
          .isNotificationListenerAccessGranted(ComponentName(c, HandsNotificationListener::class.java)),
        "notifications" to c.getSystemService(NotificationManager::class.java).areNotificationsEnabled(),
        "microphone" to (c.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED),
        "hubRunning" to Hub.running,
        "tokenSet" to !HandsPrefs.token(c).isNullOrEmpty(),
        "keepAlive" to KeepAliveService.running,
        "peers" to mapOf(
          "hands" to (HandsService.instance != null),
          "mind" to (peers?.optBoolean("mind") ?: false),
          "mouth" to (peers?.optBoolean("mouth") ?: false),
          "caller" to (peers?.optBoolean("caller") ?: false),
          "watch" to (peers?.optInt("watch") ?: 0),
        ),
      )
    }

    Function("openSettings") { which: String ->
      val c = ctx
      val pkg = c.packageName
      val intent = when (which) {
        "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        "notificationAccess" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
          Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
          ComponentName(c, HandsNotificationListener::class.java).flattenToString(),
        )
        "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
        else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        c.startActivity(intent)
      } catch (e: Exception) {
        // Some Samsung builds lack the detail page; fall back to the list.
        val fallback = if (which == "notificationAccess") Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        c.startActivity(fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    Function("moveToBack") {
      appContext.currentActivity?.moveTaskToBack(true) ?: false
    }

    Function("startKeepAlive") { text: String? ->
      KeepAliveService.start(ctx, text ?: "Bobby is listening")
    }

    Function("stopKeepAlive") {
      KeepAliveService.stop(ctx)
    }

    /** True when the current activity was opened from Bobby's own notification. */
    Function("openedFromNotification") {
      fromNotification || (appContext.currentActivity?.intent
        ?.getBooleanExtra(KeepAliveService.FROM_NOTIFICATION, false) ?: false)
    }

    /** Bobby's locked-phone unlock: whether it's set up and armed. Never any secret. */
    Function("unlockStatus") {
      val c = ctx
      val st = UnlockVault.status(c)
      mapOf(
        "setUp" to st.setUp,
        "armed" to st.armed,
        "earbuds" to st.earbuds,
        "earbudsConnected" to LockedUnlock.connectedEarbuds(c).any {
          val (name, tail) = UnlockVault.earbuds(c)
          UnlockLogic.sameEarbuds(name, tail, it.first, it.second)
        },
        "disarmedReason" to st.disarmedReason,
        "lastResult" to st.lastResult,
        "lastAt" to st.lastAt.toDouble(),
        "secureLockSet" to c.getSystemService(android.app.KeyguardManager::class.java).isDeviceSecure,
      )
    }

    /** Opens the native setup screen (PIN, phrase, earbuds). The PIN never reaches JavaScript. */
    Function("openUnlockSetup") {
      val c = ctx
      c.startActivity(Intent(c, UnlockSetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Forgets the stored PIN, phrase and key. Needs no confirmation: it only removes access. */
    Function("turnOffUnlock") {
      UnlockVault.turnOff(ctx)
      Hub.log("unlock: turned off from the app")
    }

    Function("clearOpenedFromNotification") {
      fromNotification = false
      appContext.currentActivity?.intent?.removeExtra(KeepAliveService.FROM_NOTIFICATION)
      Unit
    }
  }

  private fun accessibilityEnabled(c: Context): Boolean {
    val list = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
    val me = ComponentName(c, HandsService::class.java)
    return list.split(':').any { ComponentName.unflattenFromString(it) == me }
  }
}
