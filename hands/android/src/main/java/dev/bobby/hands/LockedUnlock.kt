package dev.bobby.hands

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.PowerManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Unlocks a PIN-locked phone when Bobby hears the owner's phrase while the trusted earbuds are
 * connected. It types the PIN stored in [UnlockVault] on the lock screen's own keypad, the way
 * an accessibility user would. There is one attempt per lock session, and a failed attempt
 * disarms the feature until the owner sets it up again in the app, so Bobby can never run the
 * phone into Android's lockout timers.
 *
 * Runs on the Hands worker thread, so the Mind's next `screen` or `act` waits until it's done.
 */
class LockedUnlock(
  private val svc: AccessibilityService,
  /** Turns the screen on (Hands' usual wake: wake lock, then the invisible WakeActivity). */
  private val wakeScreen: () -> Unit,
  /** Hides the cursor and captions, so nobody watching sees which keys are pressed. */
  private val hideOverlay: () -> Unit,
  private val showOverlay: () -> Unit,
) {
  companion object {
    private val EARBUD_TYPES = setOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_HEARING_AID,
    )
    private const val SYSTEMUI = "com.android.systemui"

    /** Connected Bluetooth audio outputs as (name, address). The setup screen lists these. */
    fun connectedEarbuds(ctx: Context): List<Pair<String, String>> {
      val am = ctx.getSystemService(AudioManager::class.java) ?: return emptyList()
      return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .filter { it.type in EARBUD_TYPES }
        .map { (it.productName?.toString() ?: "").trim() to (it.address ?: "") }
        .filter { it.first.isNotEmpty() }
        .distinctBy { it.first to UnlockLogic.addressTail(it.second) }
    }

    fun secureLocked(ctx: Context): Boolean {
      val km = ctx.getSystemService(KeyguardManager::class.java)
      return km.isKeyguardLocked && km.isDeviceSecure && km.isDeviceLocked
    }
  }

  private val km = svc.getSystemService(KeyguardManager::class.java)
  private val pm = svc.getSystemService(PowerManager::class.java)

  /** True while the PIN is being typed: Hands shows no captions then. */
  @Volatile var busy = false
    private set

  private fun trustedEarbudsConnected(): Boolean {
    val (name, tail) = UnlockVault.earbuds(svc)
    return connectedEarbuds(svc).any { UnlockLogic.sameEarbuds(name, tail, it.first, it.second) }
  }

  /**
   * Bobby heard [text]. When every rule in [UnlockLogic.gate] passes, unlocks the phone.
   * Logs only the outcome, never the transcript, the phrase or the PIN.
   */
  fun onHeard(text: String) {
    val locked = secureLocked(svc)
    if (!locked) return
    val facts = UnlockVault.facts(svc, locked, trustedEarbudsConnected())
    if (!facts.setUp) return
    val gate = UnlockLogic.gate(facts) {
      val p = UnlockVault.phrase(svc) ?: return@gate false
      UnlockLogic.heardPhrase(text, p.words, p.salt, p.hash, p.iterations)
    }
    when (gate) {
      UnlockLogic.Gate.GO -> attempt()
      UnlockLogic.Gate.WRONG_PHRASE -> {
        UnlockVault.wrongPhrase(svc)
        UnlockVault.note(svc, "heard something other than the phrase")
        Hub.log("unlock: not the phrase (${facts.wrongThisLock + 1} of ${UnlockLogic.MAX_WRONG_PHRASES} this lock)")
      }
      else -> {
        val why = gate.name.lowercase()
        if (gate != UnlockLogic.Gate.DISARMED) UnlockVault.note(svc, "skipped: $why")
        Hub.log("unlock: skipped ($why)")
      }
    }
  }

  private class Key(val node: AccessibilityNodeInfo, val bounds: Rect, val byId: Boolean = false)

  /** The lock screen's keypad (digits and Enter), or null when no full PIN keypad is showing. */
  private fun findKeypad(): Pair<Map<Int, Key>, Key?>? {
    val wins = try { svc.windows } catch (e: Exception) { emptyList() }
    val roots = wins.mapNotNull { w -> w.root?.takeIf { it.packageName?.toString() == SYSTEMUI } }
    val digits = ArrayList<Pair<Int, Key>>()
    var enter: Key? = null
    fun walk(n: AccessibilityNodeInfo, depth: Int) {
      if (depth > 60 || !n.isVisibleToUser) return
      val id = n.viewIdResourceName ?: ""
      val text = n.text?.toString() ?: ""
      val desc = n.contentDescription?.toString() ?: ""
      val r = Rect(); n.getBoundsInScreen(r)
      if (!r.isEmpty) {
        val d = UnlockLogic.digitOf(id, text, desc)
        if (d != null && (n.isClickable || id.isNotEmpty())) digits.add(d to Key(n, r, UnlockLogic.isKeyId(id)))
        else if (enter == null && n.isEnabled && UnlockLogic.isEnterKey(id, text, desc)) enter = Key(n, r)
      }
      for (i in 0 until n.childCount) {
        val c = try { n.getChild(i) } catch (e: Exception) { null } ?: continue
        walk(c, depth + 1)
      }
    }
    for (r in roots) walk(r, 0)
    // The keypad's own keys (ids key0..key9) win when all ten are there; otherwise labels, keeping
    // the outermost node per digit (a key's label can sit in a child of the key itself).
    val ids = digits.filter { it.second.byId }
    val pad = UnlockLogic.keypad(ids) ?: run {
      val outer = digits.filter { (d, k) -> digits.none { (d2, k2) -> d2 == d && k2 !== k && k2.bounds.contains(k.bounds) && k2.bounds != k.bounds } }
      UnlockLogic.keypad(outer)
    } ?: return null
    return pad to enter
  }

  /**
   * Brings up the PIN keypad without typing anything. Tries, in order: it's already showing;
   * tapping the lock screen's unlock icon (how TalkBack users open it); Android's own
   * requestDismissKeyguard from [BouncerActivity], which stays up while the PIN is typed; a
   * swipe up. Returns how it got there and the keypad, or null.
   */
  private fun openKeypad(): Pair<String, Pair<Map<Int, Key>, Key?>?> {
    waitForKeypad(500)?.let { return "showing" to it }
    val icon = findUnlockIcon()
    if (icon != null && icon.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
      waitForKeypad(1500)?.let { return "icon" to it }
    }
    BouncerActivity.open(svc)
    waitForKeypad(2500)?.let { return "dismiss" to it }
    val (w, h) = screenSize()
    swipe(w / 2f, h * 0.85f, h * 0.25f)
    waitForKeypad(2000)?.let { return "swipe" to it }
    return "none" to null
  }

  /** The lock screen's unlock icon ("Unlock" / the lock icon), or null. */
  private fun findUnlockIcon(): AccessibilityNodeInfo? {
    val wins = try { svc.windows } catch (e: Exception) { emptyList() }
    for (w in wins) {
      val root = w.root ?: continue
      if (root.packageName?.toString() != SYSTEMUI) continue
      val found = ArrayList<AccessibilityNodeInfo>()
      fun walk(n: AccessibilityNodeInfo, depth: Int) {
        if (depth > 40) return
        val id = n.viewIdResourceName ?: ""
        val desc = (n.contentDescription?.toString() ?: "").lowercase()
        if (n.isClickable && n.isVisibleToUser &&
          (id.endsWith(":id/lock_icon_view") || id.endsWith(":id/device_entry_icon_view") || id.endsWith(":id/lock_icon") || desc == "unlock")) found.add(n)
        for (i in 0 until n.childCount) {
          val c = try { n.getChild(i) } catch (e: Exception) { null } ?: continue
          walk(c, depth + 1)
        }
      }
      walk(root, 0)
      found.firstOrNull()?.let { return it }
    }
    return null
  }

  private fun waitForKeypad(ms: Long): Pair<Map<Int, Key>, Key?>? {
    val until = SystemClock.uptimeMillis() + ms
    while (SystemClock.uptimeMillis() < until) {
      findKeypad()?.let { return it }
      Thread.sleep(100)
    }
    return null
  }

  private fun waitUnlocked(ms: Long): Boolean {
    val until = SystemClock.uptimeMillis() + ms
    while (SystemClock.uptimeMillis() < until) {
      if (!km.isKeyguardLocked) return true
      Thread.sleep(50)
    }
    return !km.isKeyguardLocked
  }

  private fun attempt() {
    Hub.log("unlock: phrase and earbuds match; opening the keypad")
    hideOverlay()
    busy = true
    var started = false
    try {
      if (!pm.isInteractive) {
        wakeScreen()
        // The invisible WakeActivity may still be up (it finishes within 2 s). Wait it out, so
        // a keypad that closes along with it can't cut a PIN in half.
        Thread.sleep(2000)
      }
      var pad = openKeypad().second
      if (pad == null) {
        // Nothing typed, so no attempt used against Android's counter. Still one try per lock.
        UnlockVault.note(svc, "no PIN keypad found (is the lock a PIN?)")
        markSessionUsedWithoutTyping()
        Hub.log("unlock: no PIN keypad on the lock screen; typed nothing")
        return
      }
      Thread.sleep(250)
      pad = findKeypad() ?: run {
        UnlockVault.note(svc, "the keypad went away before typing")
        markSessionUsedWithoutTyping()
        return
      }
      val (keys, enterKey) = pad
      val clickable = keys.values.all { it.node.isClickable }

      val pin = UnlockVault.beginAttempt(svc) ?: run {
        Hub.log("unlock: attempt already used or the PIN couldn't be read; typed nothing")
        return
      }
      started = true
      var ok = false
      var failed: String? = null
      try {
        for (b in pin) {
          val k = keys[b.toInt() - '0'.code]
          if (k == null || !press(k, clickable)) { failed = "a key press failed mid-PIN"; break }
          Thread.sleep(90)
        }
        if (failed == null) {
          // Some phones confirm a PIN by themselves once it's long enough.
          ok = waitUnlocked(900)
          if (!ok) {
            val enter = enterKey ?: findKeypad()?.second
            if (enter != null) press(enter, enter.node.isClickable)
            ok = waitUnlocked(3000)
          }
          if (!ok) failed = "the PIN didn't unlock the phone"
        }
      } finally {
        pin.fill(0)
      }
      val why = failed ?: "unlocked"
      UnlockVault.finishAttempt(svc, ok, why)
      Hub.log(if (ok) "unlock: unlocked" else "unlock: failed ($why); disarmed until set up again")
    } catch (e: Exception) {
      if (started) {
        // Digits may have been typed: this was the attempt, and it failed.
        UnlockVault.finishAttempt(svc, false, "error during PIN entry")
        Hub.log("unlock: error ${e.javaClass.simpleName} during PIN entry; disarmed until set up again")
      } else {
        UnlockVault.note(svc, "error before typing")
        markSessionUsedWithoutTyping()
        Hub.log("unlock: error ${e.javaClass.simpleName} before typing; typed nothing")
      }
    } finally {
      busy = false
      BouncerActivity.close()
      showOverlay()
    }
  }

  /**
   * Read-only check for setting this up on a new phone: wakes the screen, brings up the PIN
   * keypad if needed and reports whether Hands can see a full one. Never types and never uses
   * the lock session's attempt.
   */
  fun probe(re: String?): org.json.JSONObject {
    val out = org.json.JSONObject().put("type", "unlock_probe_result")
    re?.let { out.put("re", it) }
    val locked = secureLocked(svc)
    out.put("locked", locked).put("earbudsConnected", trustedEarbudsConnected())
      .put("armed", UnlockVault.status(svc).armed)
    if (!locked) return out.put("keypad", false)
    if (!pm.isInteractive) { wakeScreen(); Thread.sleep(2000) }
    val (how, pad) = openKeypad()
    BouncerActivity.close()
    out.put("keypad", pad != null).put("how", how)
    if (pad != null) {
      out.put("enter", pad.second != null)
        .put("clickable", pad.first.values.all { it.node.isClickable })
        .put("byId", pad.first.values.all { it.byId })
    }
    return out
  }

  /** A gate past the phrase failed before typing: no second try this lock session. */
  private fun markSessionUsedWithoutTyping() = UnlockVault.useSession(svc)

  /** One press: ACTION_CLICK when the keypad's keys are clickable, else a tap. Never both. */
  private fun press(k: Key, clickable: Boolean): Boolean {
    if (clickable) return k.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    return tap(k.bounds.exactCenterX(), k.bounds.exactCenterY())
  }

  private fun screenSize(): Pair<Int, Int> {
    val b = (svc.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager).currentWindowMetrics.bounds
    return b.width() to b.height()
  }

  private fun tap(x: Float, y: Float) = gesture(Path().apply { moveTo(x, y) }, 40)
  private fun swipe(x: Float, fromY: Float, toY: Float) = gesture(Path().apply { moveTo(x, fromY); lineTo(x, toY) }, 250)

  private fun gesture(path: Path, ms: Long): Boolean {
    val latch = CountDownLatch(1)
    var ok = false
    val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
    val sent = svc.dispatchGesture(g, object : AccessibilityService.GestureResultCallback() {
      override fun onCompleted(gestureDescription: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
    }, null)
    if (!sent) return false
    latch.await(ms + 2000, TimeUnit.MILLISECONDS)
    return ok
  }
}
