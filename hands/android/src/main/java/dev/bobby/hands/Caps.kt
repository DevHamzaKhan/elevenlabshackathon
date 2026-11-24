package dev.bobby.hands

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

/**
 * `caps`: what this phone is and what Hands can do on it. Best effort: any field may be null.
 */
object Caps {
  /** Protocol additions this Hands understands, so a Mind can check before relying on them. */
  val FEATURES = listOf("open", "since", "compact", "then_screen", "fast", "target_id", "target_key", "locked", "caps")

  /** "com.samsung.android.honeyboard/.service.HoneyBoardService" -> "com.samsung.android.honeyboard". */
  fun imePackage(id: String?): String? = id?.substringBefore('/')?.trim()?.ifEmpty { null }

  /** Settings.Secure "navigation_mode": 0 three-button, 1 two-button, 2 gestures. */
  fun gestureNav(mode: Int?): Boolean? = when (mode) { 0, 1 -> false; 2 -> true; else -> null }

  fun orientation(o: Int): String? = when (o) {
    Configuration.ORIENTATION_PORTRAIT -> "portrait"
    Configuration.ORIENTATION_LANDSCAPE -> "landscape"
    else -> null
  }

  private fun <T> safe(f: () -> T?): Any = try { f() ?: JSONObject.NULL } catch (e: Exception) { JSONObject.NULL }

  fun collect(svc: AccessibilityService, re: String?, width: Int, height: Int): JSONObject {
    val cr = svc.contentResolver
    val km = svc.getSystemService(android.app.KeyguardManager::class.java)
    val info = try { svc.serviceInfo } catch (e: Exception) { null }
    return JSONObject().apply {
      put("type", "caps_result")
      if (re != null) put("re", re)
      put("sdk", Build.VERSION.SDK_INT)
      put("release", safe { Build.VERSION.RELEASE })
      put("oem", safe { Build.MANUFACTURER?.lowercase() })
      put("brand", safe { Build.BRAND })
      put("model", safe { Build.MODEL })
      put("locale", safe { svc.resources.configuration.locales[0].toLanguageTag() })
      put("size", JSONArray().put(width).put(height))
      put("density", safe { svc.resources.displayMetrics.density.toDouble() })
      put("orientation", safe { orientation(svc.resources.configuration.orientation) })
      put("launcher", safe {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        svc.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
          ?.takeIf { it != "android" } // "android" is the chooser: no default launcher
      })
      put("ime", safe { imePackage(Settings.Secure.getString(cr, Settings.Secure.DEFAULT_INPUT_METHOD)) })
      put("secureLock", safe { km?.isDeviceSecure })
      put("locked", safe { km?.isKeyguardLocked })
      put("gestureNav", safe { gestureNav(Settings.Secure.getInt(cr, "navigation_mode", -1)) })
      put("imeTyping", safe {
        Build.VERSION.SDK_INT >= 33 && info != null &&
          (info.flags and AccessibilityServiceInfo.FLAG_INPUT_METHOD_EDITOR) != 0
      })
      put("screenshot", safe {
        info != null && (info.capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_TAKE_SCREENSHOT) != 0
      })
      put("displays", safe { svc.getSystemService(android.hardware.display.DisplayManager::class.java)?.displays?.size })
      put("features", JSONArray().apply { FEATURES.forEach { put(it) } })
    }
  }
}
