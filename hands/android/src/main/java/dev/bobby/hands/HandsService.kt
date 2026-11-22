package dev.bobby.hands

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Hands accessibility service: reads the screen, performs the Mind's actions with a cursor
 * leading each one, and hosts the hub. The hub starts and stops with this service.
 */
class HandsService : AccessibilityService() {
  companion object {
    @Volatile var instance: HandsService? = null
      private set
    private const val SETTLE_QUIET_MS = 300L
    private const val SETTLE_MAX_MS = 3000L
  }

  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "bobby-hands").apply { isDaemon = true } }
  @Volatile private var lastEventAt = 0L
  private var cursor: CursorOverlay? = null
  /** Nodes from the latest `screen_result`; `{n}` targets refer to these. */
  @Volatile private var lastNodes: List<ScreenNode> = emptyList()

  // --- lifecycle ---

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    cursor = CursorOverlay(this).also { it.attach() }
    Hub.start(this, ::onHandsFrame)
    Hub.log("Hands service connected")
  }

  override fun onUnbind(intent: Intent?): Boolean {
    shutdown()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    shutdown()
    super.onDestroy()
  }

  private fun shutdown() {
    if (instance !== this) return
    instance = null
    Hub.stop()
    cursor?.detach()
    cursor = null
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val e = event ?: return
    when (e.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
      AccessibilityEvent.TYPE_WINDOWS_CHANGED,
      AccessibilityEvent.TYPE_VIEW_SCROLLED,
      AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
      AccessibilityEvent.TYPE_VIEW_FOCUSED,
      AccessibilityEvent.TYPE_VIEW_SELECTED -> lastEventAt = SystemClock.uptimeMillis()
    }
  }

  override fun onInterrupt() {}

  // --- frames from the hub ---

  fun onHandsFrame(raw: String) {
    val o = try { JSONObject(raw) } catch (e: Exception) { return }
    when (o.optString("type")) {
      "cursor" -> cursor?.show(o.optBoolean("show", true))
      "screen" -> worker.execute { reply(handleScreen(o)) }
      "act" -> worker.execute { reply(handleAct(o)) }
    }
  }

  private fun reply(o: JSONObject) = Hub.fromHands(o.toString())

  private fun reId(o: JSONObject): String? = if (o.has("id") && !o.isNull("id")) o.get("id").toString() else null

  private fun handleScreen(o: JSONObject): JSONObject {
    val snap = snapshot()
    lastNodes = snap.nodes
    val res = Protocol.screenResult(reId(o), snap.app, snap.width, snap.height, snap.nodes)
    if (o.optBoolean("image", false)) {
      screenshotJpeg()?.let { res.put("image", it) } ?: res.put("image_error", "screenshot unavailable")
    }
    return res
  }

  /** Base64 JPEG of the screen (extra `image` field), scaled to 720 px wide. Hides the cursor. */
  private fun screenshotJpeg(): String? {
    val latch = CountDownLatch(1)
    var out: String? = null
    try {
      takeScreenshot(android.view.Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
        override fun onSuccess(shot: ScreenshotResult) {
          try {
            val hw = android.graphics.Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)
            if (hw != null) {
              val bmp = hw.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
              val scale = 720f / bmp.width
              val small = if (scale < 1f) android.graphics.Bitmap.createScaledBitmap(
                bmp, 720, (bmp.height * scale).toInt(), true) else bmp
              val bos = java.io.ByteArrayOutputStream()
              small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, bos)
              out = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP)
            }
            shot.hardwareBuffer.close()
          } catch (e: Exception) {
            Hub.log("screenshot encode failed: ${e.message}")
          } finally { latch.countDown() }
        }
        override fun onFailure(errorCode: Int) {
          Hub.log("screenshot failed: $errorCode"); latch.countDown()
        }
      })
    } catch (e: Exception) {
      Hub.log("screenshot failed: ${e.message}"); latch.countDown()
    }
    latch.await(3, TimeUnit.SECONDS)
    return out
  }

  /** The on-screen keyboard's bounds, or null when it isn't showing. */
  private fun keyboardBounds(): Rect? {
    val wins = try { windows } catch (e: Exception) { return null }
    for (w in wins) if (w.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
      val r = Rect(); w.getBoundsInScreen(r)
      if (r.height() > 0) return r
    }
    return null
  }

  private fun handleAct(o: JSONObject): JSONObject {
    val re = reId(o)
    val act = try { Protocol.parseAct(o) } catch (e: BadRequest) {
      return Protocol.actResult(re, false, "bad_request", e.message)
    }
    return try {
      val err = perform(act)
      if (err == null) Protocol.actResult(re, true) else Protocol.actResult(re, false, err.first, err.second)
    } catch (e: Exception) {
      Hub.log("act failed: $e")
      Protocol.actResult(re, false, "timeout", e.toString())
    } finally {
      cursor?.scheduleFade()
    }
  }

  // --- screen reading ---

  class Snapshot(val app: String, val width: Int, val height: Int, val nodes: List<ScreenNode>)

  private fun screenSize(): Pair<Int, Int> {
    val b = (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).currentWindowMetrics.bounds
    return b.width() to b.height()
  }

  fun snapshot(): Snapshot {
    val (w, h) = screenSize()
    val roots = ArrayList<RawNode>()
    var app = ""
    val wins = try { windows } catch (e: Exception) { emptyList<AccessibilityWindowInfo>() }
    val sorted = wins.sortedByDescending { it.layer }
    var coveredByApp = false
    for (win in sorted) {
      val type = win.type
      if (type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue
      if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue
      if (type == AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER) continue
      val r = Rect(); win.getBoundsInScreen(r)
      if (type == AccessibilityWindowInfo.TYPE_SYSTEM) {
        // Status and navigation bars are noise; include system windows only when they're
        // big (the notification shade, a system dialog) or focused.
        if (!(win.isActive || win.isFocused || r.height() > h / 3)) continue
      } else if (type == AccessibilityWindowInfo.TYPE_APPLICATION) {
        if (coveredByApp) continue
      }
      val root = win.root ?: continue
      if (app.isEmpty() && type == AccessibilityWindowInfo.TYPE_APPLICATION) app = root.packageName?.toString() ?: ""
      roots.add(toRaw(root, 0))
      if (type == AccessibilityWindowInfo.TYPE_APPLICATION && r.width() >= w && r.height() >= h * 0.9) coveredByApp = true
    }
    if (roots.isEmpty()) {
      rootInActiveWindow?.let {
        roots.add(toRaw(it, 0))
        app = it.packageName?.toString() ?: ""
      }
    }
    if (app.isEmpty()) app = rootInActiveWindow?.packageName?.toString() ?: ""
    return Snapshot(app, w, h, NodeFilter.flatten(roots, w, h))
  }

  private fun toRaw(n: AccessibilityNodeInfo, depth: Int): RawNode {
    val r = Rect(); n.getBoundsInScreen(r)
    val kids = ArrayList<RawNode>()
    if (depth < 80) {
      for (i in 0 until n.childCount) {
        val c = try { n.getChild(i) } catch (e: Exception) { null } ?: continue
        kids.add(toRaw(c, depth + 1))
      }
    }
    return RawNode(
      text = n.text?.toString() ?: "",
      desc = n.contentDescription?.toString() ?: "",
      hint = n.hintText?.toString() ?: "",
      showingHint = n.isShowingHintText,
      cls = n.className?.toString() ?: "",
      bounds = intArrayOf(r.left, r.top, r.right, r.bottom),
      visible = n.isVisibleToUser,
      clickable = n.isClickable,
      longClickable = n.isLongClickable,
      editable = n.isEditable,
      scrollable = n.isScrollable,
      children = kids,
      ref = n,
    )
  }

  // --- actions ---

  private class Resolved(val x: Int, val y: Int, val node: ScreenNode?)

  /** Resolves a target to a point (and node when known). Returns null when nothing matches. */
  private fun resolve(t: Target): Resolved? = when (t) {
    is Target.Index -> lastNodes.getOrNull(t.n)?.let { Resolved(it.centerX, it.centerY, it) }
    is Target.Text -> TargetMatcher.byText(snapshot().nodes, t.text)?.let { Resolved(it.centerX, it.centerY, it) }
    is Target.Point -> Resolved(t.x, t.y, null)
  }

  /** Performs one act. Returns null on success, or (error, detail). */
  private fun perform(a: Act): Pair<String, String?>? {
    val (w, h) = screenSize()
    when (a.what) {
      "wait" -> { Thread.sleep(a.ms!!.coerceAtMost(60_000)); return null }
      "key" -> return key(a.name!!)
      "launch" -> return launch(a.app!!)
    }
    val target = a.on?.let { resolve(it) ?: return "not_found" to describe(it) }
    if (target != null && (target.x !in 0 until w || target.y !in 0 until h)) return "bad_request" to "point off screen"
    when (a.what) {
      "point" -> {
        cursor?.glideTo(target!!.x.toFloat(), target.y.toFloat(), w, h)
        return null
      }
      "tap", "long_press" -> {
        var t = target!!
        val kb = keyboardBounds()
        if (kb != null && kb.contains(t.x, t.y) && a.on !is Target.Point) {
          // The keyboard covers the target: hide it, then find the target again.
          performGlobalAction(GLOBAL_ACTION_BACK)
          waitSettled()
          t = resolve(a.on!!) ?: return "not_found" to "the target was under the keyboard and is gone now"
        }
        cursor?.glideTo(t.x.toFloat(), t.y.toFloat(), w, h)
        val hold = if (a.what == "tap") 60L else 700L
        cursor?.press(hold)
        val p = Path().apply { moveTo(t.x.toFloat(), t.y.toFloat()) }
        if (!gesture(p, hold)) return "timeout" to "gesture was cancelled"
        waitSettled()
        return null
      }
      "swipe" -> {
        val box = target?.node?.bounds ?: intArrayOf(0, 0, w, h)
        val bw = box[2] - box[0]; val bh = box[3] - box[1]
        val cx = (box[0] + box[2]) / 2f; val cy = (box[1] + box[3]) / 2f
        val (sx, sy, ex, ey) = when (a.dir) {
          "left" -> listOf(box[0] + bw * 0.8f, cy, box[0] + bw * 0.2f, cy)
          "right" -> listOf(box[0] + bw * 0.2f, cy, box[0] + bw * 0.8f, cy)
          "up" -> listOf(cx, box[1] + bh * 0.72f, cx, box[1] + bh * 0.28f)
          else -> listOf(cx, box[1] + bh * 0.28f, cx, box[1] + bh * 0.72f)
        }
        cursor?.glideTo(sx, sy, w, h)
        cursor?.press(0)
        val p = Path().apply { moveTo(sx, sy); lineTo(ex, ey) }
        val ok = gesture(p, 280)
        cursor?.glideTo(ex, ey, w, h)
        if (!ok) return "timeout" to "gesture was cancelled"
        waitSettled()
        return null
      }
      "type" -> return type(a.text!!, target, w, h)
    }
    return "bad_request" to "unknown do"
  }

  private fun describe(t: Target) = when (t) {
    is Target.Index -> "no node ${t.n} in the latest screen_result"
    is Target.Text -> "nothing on screen matches '${t.text}'"
    is Target.Point -> "(${t.x}, ${t.y})"
  }

  private fun focusedInput(): AccessibilityNodeInfo? =
    findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }

  private fun type(text: String, target: Resolved?, w: Int, h: Int): Pair<String, String?>? {
    var node: AccessibilityNodeInfo? = null
    if (target != null) {
      var sn = target.node
      if (sn == null) sn = TargetMatcher.atPoint(snapshot().nodes, target.x, target.y) { it.edit }
      cursor?.glideTo(target.x.toFloat(), target.y.toFloat(), w, h)
      val ref = sn?.ref as? AccessibilityNodeInfo
      if (ref != null && sn.edit) {
        node = ref
      } else {
        // Not a text field itself (or a web view): tap it, then type into whatever got focus.
        cursor?.press(60)
        gesture(Path().apply { moveTo(target.x.toFloat(), target.y.toFloat()) }, 60)
        waitSettled()
        node = focusedInput()
        if (node == null) return if (commitViaInputMethod(text)) { waitSettled(); null }
          else "not_editable" to "the target isn't a text field"
      }
    } else {
      node = focusedInput()
      if (node == null) {
        // Web views (e.g. Gmail's reply body) hide their editor from the tree, but the
        // focused editor still has an input connection.
        val any = findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (any != null) {
          val r = Rect(); any.getBoundsInScreen(r)
          cursor?.glideTo(r.exactCenterX(), r.exactCenterY(), w, h)
        }
        return if (commitViaInputMethod(text) || (any != null && paste(any, text))) { waitSettled(); null }
          else "not_found" to "no text field has focus"
      }
      val r = Rect(); node.getBoundsInScreen(r)
      cursor?.glideTo(r.exactCenterX(), r.exactCenterY(), w, h)
    }
    node.refresh()
    if (!node.isFocused) node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val args = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
      // Some fields only accept text once they've been clicked.
      node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      Thread.sleep(150)
      if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
        if (commitViaInputMethod(text) || paste(node, text)) { waitSettled(); return null }
        return "not_editable" to "the field refused the text"
      }
    }
    // Put the caret at the end, like a person who just typed.
    val sel = Bundle().apply {
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, text.length)
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, text.length)
    }
    node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
    waitSettled()
    return null
  }

  /** Types through the service's own input-method connection (Android 13+). */
  private fun commitViaInputMethod(text: String): Boolean {
    if (android.os.Build.VERSION.SDK_INT < 33) return false
    return try {
      val ic = inputMethod?.currentInputConnection ?: return false
      ic.commitText(text, 1, null)
      true
    } catch (e: Exception) {
      Hub.log("input-method typing failed: ${e.message}")
      false
    }
  }

  /** Last resort: put the text on the clipboard and paste it into [node]. */
  private fun paste(node: AccessibilityNodeInfo, text: String): Boolean = try {
    val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
    val latch = CountDownLatch(1)
    android.os.Handler(mainLooper).post {
      try { cm.setPrimaryClip(android.content.ClipData.newPlainText("bobby", text)) } finally { latch.countDown() }
    }
    latch.await(1, TimeUnit.SECONDS)
    node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
  } catch (e: Exception) { false }

  private fun key(name: String): Pair<String, String?>? {
    val ok = when (name) {
      "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
      "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
      "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
      "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
      "enter" -> {
        val f = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return "not_found" to "no text field has focus"
        f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
      }
      else -> return "bad_request" to "unknown key"
    }
    if (!ok) return "no_permission" to "Android refused the $name action"
    waitSettled()
    return null
  }

  private fun launch(app: String): Pair<String, String?>? {
    val pm = packageManager
    var intent = try { pm.getLaunchIntentForPackage(app) } catch (e: Exception) { null }
    if (intent == null) {
      val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
      val acts = pm.queryIntentActivities(main, PackageManager.MATCH_ALL)
      val q = app.trim().lowercase()
      val labeled = acts.map { it to it.loadLabel(pm).toString().trim().lowercase() }
      val hit = labeled.firstOrNull { it.second == q } ?: labeled.firstOrNull { it.second.contains(q) }
      if (hit != null) {
        val ai = hit.first.activityInfo
        intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setClassName(ai.packageName, ai.name)
      }
    }
    if (intent == null) return "not_found" to "no app called '$app'"
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    try { startActivity(intent) } catch (e: Exception) { return "no_permission" to e.message }
    waitSettled(minMs = 600)
    return null
  }

  private fun gesture(path: Path, durationMs: Long): Boolean {
    val latch = CountDownLatch(1)
    var ok = false
    val g = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1)))
      .build()
    val sent = dispatchGesture(g, object : GestureResultCallback() {
      override fun onCompleted(gestureDescription: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
    }, null)
    if (!sent) return false
    latch.await(durationMs + 3000, TimeUnit.MILLISECONDS)
    return ok
  }

  /** Waits until the UI has had no change for 300 ms, or 3 s at most. */
  private fun waitSettled(minMs: Long = 0) {
    val start = SystemClock.uptimeMillis()
    while (true) {
      val now = SystemClock.uptimeMillis()
      if (now - start >= SETTLE_MAX_MS) return
      val quietSince = maxOf(start, lastEventAt)
      if (now - quietSince >= SETTLE_QUIET_MS && now - start >= minMs) return
      Thread.sleep(40)
    }
  }
}
