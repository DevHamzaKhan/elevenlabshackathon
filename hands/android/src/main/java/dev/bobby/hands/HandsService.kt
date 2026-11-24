package dev.bobby.hands

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
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
    private const val SCREENSHOT_RETRY_MS = 350L
  }

  /** Thrown while resolving a target: maps to `not_found` with this `why`. */
  private class NotFound(val why: String) : Exception(why)

  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "bobby-hands").apply { isDaemon = true } }
  /** `caps` answers even while an act (a long `wait`) holds the worker. */
  private val side = Executors.newSingleThreadExecutor { r -> Thread(r, "bobby-hands-caps").apply { isDaemon = true } }
  private val settler = Settler()
  private var cursor: CursorOverlay? = null
  /** Nodes from the latest `screen_result`; `{n}` targets refer to these. */
  @Volatile private var lastNodes: List<ScreenNode> = emptyList()
  /** Options of the act being performed (worker thread only). */
  private var fast = false
  /** The package in front after a launch/open (worker thread only). */
  private var frontAfter: String? = null
  /** True while Hands has hidden the keyboard with the soft-keyboard controller. */
  private var keyboardHiddenByUs = false

  // --- lifecycle ---

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    cursor = CursorOverlay(this).also { it.attach() }
    // In case an earlier run died while the keyboard was hidden.
    try { softKeyboardController.showMode = SHOW_MODE_AUTO } catch (_: Exception) {}
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
    if (Settler.counts(e.eventType, e.packageName?.toString(), packageName)) settler.onEvent(e.eventType)
  }

  override fun onInterrupt() {}

  /** Shows Bobby's line (or what he heard) in a caption at the bottom of the screen. */
  fun caption(text: String, heard: Boolean) = cursor?.caption(text, heard)


  // --- frames from the hub ---

  fun onHandsFrame(raw: String) {
    val o = try { JSONObject(raw) } catch (e: Exception) { return }
    when (o.optString("type")) {
      "cursor" -> cursor?.show(o.optBoolean("show", true))
      "screen" -> worker.execute { reply(safeScreen(o)) }
      "act" -> worker.execute { reply(handleAct(o)) }
      "caps" -> side.execute {
        val (w, h) = screenSize()
        reply(try { Caps.collect(this, reId(o), w, h) } catch (e: Exception) {
          JSONObject().put("type", "caps_result").apply { reId(o)?.let { put("re", it) } }.put("error", e.toString())
        })
      }
    }
  }

  private fun reply(o: JSONObject) = Hub.fromHands(o.toString())

  private fun reId(o: JSONObject): String? = if (o.has("id") && !o.isNull("id")) o.get("id").toString() else null

  /**
   * Odd state: the screen is off or on a non-secure lock screen (Swipe). Turns the screen on
   * and swipes the lock away, so the Mind's action lands on the real screen. A secure lock
   * (PIN, pattern, password) stays: see [secureLocked].
   */
  @Suppress("DEPRECATION")
  private fun ensureAwake() {
    val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
    val km = getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager
    if (!pm.isInteractive) {
      Hub.log("screen is off: waking it")
      val wl = pm.newWakeLock(
        android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
        "bobby:wake",
      )
      wl.acquire(3000)
      var until = SystemClock.uptimeMillis() + 600
      while (!pm.isInteractive && SystemClock.uptimeMillis() < until) Thread.sleep(50)
      if (!pm.isInteractive || (km.isKeyguardLocked && !km.isDeviceSecure)) startWake()
      until = SystemClock.uptimeMillis() + 2000
      while ((!pm.isInteractive || (km.isKeyguardLocked && !km.isDeviceSecure)) && SystemClock.uptimeMillis() < until) Thread.sleep(50)
      Thread.sleep(300)
    }
    if (km.isKeyguardLocked && !km.isDeviceSecure) {
      Hub.log("lock screen showing: swiping it away")
      val (w, h) = screenSize()
      for (i in 0 until 2) {
        gesture(Path().apply { moveTo(w / 2f, h * 0.85f); lineTo(w / 2f, h * 0.25f) }, 250)
        Thread.sleep(500)
        if (!km.isKeyguardLocked) break
      }
      settler.await()
    }
  }

  /** A PIN/pattern/password/biometric lock is showing: Hands must not read or touch it. */
  private fun secureLocked(): Boolean {
    val km = getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager
    return km.isKeyguardLocked && km.isDeviceSecure && km.isDeviceLocked
  }

  private fun startWake() {
    try {
      startActivity(Intent(this, WakeActivity::class.java).addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS))
    } catch (e: Exception) { Hub.log("wake activity failed: ${e.message}") }
  }

  private fun safeScreen(o: JSONObject): JSONObject = try { handleScreen(o) } catch (e: Exception) {
    Hub.log("screen failed: $e")
    val (w, h) = screenSize()
    Protocol.screenResult(reId(o), "", w, h, emptyList(), "error").put("error", e.toString())
  }

  private fun handleScreen(o: JSONObject): JSONObject {
    ensureAwake()
    val req = ScreenRequest.parse(o)
    val res = readScreen(reId(o), req)
    if (req.image && !res.optBoolean("same") && !res.optBoolean("locked")) {
      val (img, err) = screenshotJpeg()
      if (img != null) res.put("image", img) else res.put("image_error", err ?: "screenshot unavailable")
    }
    return res
  }

  /** Reads the screen into a `screen_result` (honouring `since` and `compact`). Updates `{n}`. */
  private fun readScreen(re: String?, req: ScreenRequest): JSONObject {
    if (secureLocked()) {
      lastNodes = emptyList()
      val (w, h) = screenSize()
      return Protocol.lockedScreen(re, w, h)
    }
    val snap = snapshot()
    lastNodes = snap.nodes
    return Protocol.screenReply(re, snap.app, snap.width, snap.height, snap.nodes, snap.hash, req)
  }

  /**
   * Base64 JPEG of the screen (extra `image` field), scaled to 720 px wide, with the cursor
   * overlay hidden. Returns (image, null) or (null, error): "secure" for a secure window,
   * "rate_limited" when Android refused twice in a row.
   */
  private fun screenshotJpeg(): Pair<String?, String?> {
    cursor?.beginCapture()
    try {
      var r = screenshotOnce()
      if (r.second == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
        Thread.sleep(SCREENSHOT_RETRY_MS)
        r = screenshotOnce()
      }
      if (r.first != null) return r.first to null
      val err = when (r.second) {
        ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "secure"
        ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "rate_limited"
        ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "no_permission"
        null -> "screenshot unavailable"
        else -> "screenshot failed (${r.second})"
      }
      return null to err
    } finally {
      cursor?.endCapture()
    }
  }

  /** One takeScreenshot: (jpeg base64, null) or (null, Android's error code or null). */
  private fun screenshotOnce(): Pair<String?, Int?> {
    val latch = CountDownLatch(1)
    var out: String? = null
    var code: Int? = null
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
          Hub.log("screenshot failed: $errorCode"); code = errorCode; latch.countDown()
        }
      })
    } catch (e: Exception) {
      Hub.log("screenshot failed: ${e.message}"); latch.countDown()
    }
    latch.await(3, TimeUnit.SECONDS)
    return out to code
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
    fast = act.fast
    frontAfter = null
    var locked = false
    val res = try {
      if (act.what != "wait") ensureAwake()
      if (act.what != "wait" && secureLocked()) {
        locked = true
        Protocol.actResult(re, false, "no_permission", "locked")
      } else {
        val err = perform(act)
        if (err == null) Protocol.actResult(re, true) else Protocol.actResult(re, false, err.first, err.second)
      }
    } catch (e: Exception) {
      Hub.log("act failed: $e")
      Protocol.actResult(re, false, "timeout", e.toString())
    } finally {
      restoreKeyboard()
      cursor?.scheduleFade()
    }
    frontAfter?.let { res.put("app", it) }
    if (act.thenScreen) {
      val s = try {
        if (locked) { val (w, h) = screenSize(); Protocol.lockedScreen(null, w, h) }
        else readScreen(null, ScreenRequest(compact = act.compact))
      } catch (e: Exception) { null }
      s?.let { res.put("screen", Protocol.embedded(it)) }
    }
    return res
  }

  // --- screen reading ---

  class Snapshot(val app: String, val width: Int, val height: Int, val nodes: List<ScreenNode>) {
    val hash: String by lazy { ScreenHash.of(app, width, height, nodes) }
  }

  private fun screenSize(): Pair<Int, Int> {
    val b = (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).currentWindowMetrics.bounds
    return b.width() to b.height()
  }

  fun snapshot(): Snapshot {
    val first = snapshotOnce()
    // A web view that's still loading shows up with no content yet; give it a moment.
    if (first.second) {
      Thread.sleep(700)
      return snapshotOnce().first
    }
    return first.first
  }

  /** The package of the topmost app window: what's "in front". */
  private fun frontApp(): String? {
    val wins = try { windows } catch (e: Exception) { emptyList<AccessibilityWindowInfo>() }
    for (win in wins.sortedByDescending { it.layer }) {
      if (win.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
      val p = win.root?.packageName?.toString()
      if (!p.isNullOrEmpty()) return p
    }
    return rootInActiveWindow?.packageName?.toString()
  }

  /** Returns the snapshot and whether it contains an empty (loading) web view. */
  private fun snapshotOnce(): Pair<Snapshot, Boolean> {
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
      val pkg = root.packageName?.toString() ?: ""
      if (app.isEmpty() && type == AccessibilityWindowInfo.TYPE_APPLICATION) app = pkg
      roots.add(toRaw(root, 0, pkg))
      if (type == AccessibilityWindowInfo.TYPE_APPLICATION && WindowRules.covers(r.left, r.top, r.right, r.bottom, w, h)) coveredByApp = true
    }
    if (roots.isEmpty()) {
      rootInActiveWindow?.let {
        app = it.packageName?.toString() ?: ""
        roots.add(toRaw(it, 0, app))
      }
    }
    if (app.isEmpty()) app = rootInActiveWindow?.packageName?.toString() ?: ""
    return Snapshot(app, w, h, NodeFilter.flatten(roots, w, h)) to roots.any { NodeFilter.hasEmptyWebView(it) }
  }

  private fun scrollDirs(n: AccessibilityNodeInfo): List<String> {
    if (!n.isScrollable) return emptyList()
    val ids = n.actionList.map { it.id }.toSet()
    val out = LinkedHashSet<String>()
    if (AccessibilityAction.ACTION_SCROLL_UP.id in ids) out.add("up")
    if (AccessibilityAction.ACTION_SCROLL_DOWN.id in ids) out.add("down")
    if (AccessibilityAction.ACTION_SCROLL_LEFT.id in ids) out.add("left")
    if (AccessibilityAction.ACTION_SCROLL_RIGHT.id in ids) out.add("right")
    if (out.isEmpty()) {
      // Only the generic actions: forward/backward along the list's main axis (assume vertical
      // unless the class says horizontal).
      val horiz = (n.className?.toString() ?: "").contains("Horizontal") || (n.collectionInfo?.let { it.columnCount > 1 && it.rowCount <= 1 } ?: false)
      if (AccessibilityAction.ACTION_SCROLL_BACKWARD.id in ids) out.add(if (horiz) "left" else "up")
      if (AccessibilityAction.ACTION_SCROLL_FORWARD.id in ids) out.add(if (horiz) "right" else "down")
    }
    return out.toList()
  }

  @Suppress("DEPRECATION") // isChecked: the tri-state replacement is API 36 only
  private fun toRaw(n: AccessibilityNodeInfo, depth: Int, pkg: String): RawNode {
    val r = Rect(); n.getBoundsInScreen(r)
    val kids = ArrayList<RawNode>()
    if (depth < 80) {
      for (i in 0 until n.childCount) {
        val c = try { n.getChild(i) } catch (e: Exception) { null } ?: continue
        kids.add(toRaw(c, depth + 1, pkg))
      }
    }
    return RawNode(
      text = if (n.isPassword) "" else n.text?.toString() ?: "",
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
      viewId = n.viewIdResourceName ?: "",
      pkg = n.packageName?.toString() ?: pkg,
      checkable = n.isCheckable,
      checked = n.isChecked,
      enabled = n.isEnabled,
      focused = n.isFocused,
      selected = n.isSelected,
      password = n.isPassword,
      scrollDirs = try { scrollDirs(n) } catch (e: Exception) { emptyList() },
    )
  }

  // --- actions ---

  private class Resolved(val x: Int, val y: Int, val node: ScreenNode?)

  /**
   * Resolves a target to a point (and node when known). Throws [NotFound].
   * `{n}` re-reads the node from the app first, so a stale node is caught, not tapped blind.
   */
  private fun resolve(t: Target): Resolved {
    fun hit(n: ScreenNode?, why: String) = n?.let { Resolved(it.centerX, it.centerY, it) } ?: throw NotFound(why)
    return when (t) {
      is Target.Index -> fresh(lastNodes.getOrNull(t.n) ?: throw NotFound("no node ${t.n} in the latest screen_result"))
      is Target.Text -> hit(TargetMatcher.byText(snapshot().nodes, t.text), "nothing on screen matches '${t.text}'")
      is Target.Id -> hit(TargetMatcher.byId(snapshot().nodes, t.id), "no view with id '${t.id}' on screen")
      is Target.Key -> hit(TargetMatcher.byKey(snapshot().nodes, t.key), "no node with key '${t.key}' on screen (it moved, changed or went)")
      is Target.Point -> Resolved(t.x, t.y, null)
    }
  }

  /** Refreshes a node from the latest screen_result; throws NotFound("stale") if it's gone or hidden. */
  private fun fresh(n: ScreenNode): Resolved {
    val ref = n.ref as? AccessibilityNodeInfo ?: return Resolved(n.centerX, n.centerY, n)
    val alive = try { ref.refresh() } catch (e: Exception) { false }
    if (!alive || !ref.isVisibleToUser) throw NotFound("stale")
    val r = Rect(); ref.getBoundsInScreen(r)
    val (w, h) = screenSize()
    val b = intArrayOf(r.left.coerceIn(0, w), r.top.coerceIn(0, h), r.right.coerceIn(0, w), r.bottom.coerceIn(0, h))
    if (b[2] <= b[0] || b[3] <= b[1]) throw NotFound("stale")
    val moved = n.copy(bounds = b)
    return Resolved(moved.centerX, moved.centerY, moved)
  }

  private fun glide(x: Number, y: Number, w: Int, h: Int) = cursor?.glideTo(x.toFloat(), y.toFloat(), w, h, fast)

  /** Performs one act. Returns null on success, or (error, detail). */
  private fun perform(a: Act): Pair<String, String?>? {
    val (w, h) = screenSize()
    when (a.what) {
      "wait" -> { Thread.sleep(a.ms!!.coerceAtMost(60_000)); return null }
      "key" -> return key(a.name!!)
      "launch" -> return launch(a.app!!)
      "open" -> return open(a)
    }
    val target = try { a.on?.let { resolve(it) } } catch (e: NotFound) { return "not_found" to e.why }
    if (target != null && (target.x !in 0 until w || target.y !in 0 until h)) return "bad_request" to "point off screen"
    when (a.what) {
      "point" -> {
        glide(target!!.x, target.y, w, h)
        return null
      }
      "tap", "long_press" -> {
        var t = target!!
        val kb = keyboardBounds()
        if (kb != null && kb.contains(t.x, t.y) && a.on !is Target.Point) {
          // The keyboard covers the target: hide it, then find the target again.
          hideKeyboard()
          t = try {
            val before = t.node
            if (a.on is Target.Index && before != null) fresh(before) else resolve(a.on!!)
          } catch (e: NotFound) { return "not_found" to "the target was under the keyboard and is gone now" }
        }
        glide(t.x, t.y, w, h)
        val long = a.what == "long_press"
        val hold = if (long) 700L else 60L
        cursor?.press(hold)
        val mark = settler.mark()
        val p = Path().apply { moveTo(t.x.toFloat(), t.y.toFloat()) }
        if (!gesture(p, hold)) {
          Hub.log("gesture cancelled; trying the accessibility click instead")
          if (!clickFallback(t, long)) return "timeout" to "gesture was cancelled and the node refused the click"
        }
        settle(mark)
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
        glide(sx, sy, w, h)
        cursor?.press(0)
        val mark = settler.mark()
        val p = Path().apply { moveTo(sx, sy); lineTo(ex, ey) }
        val ok = gesture(p, 280)
        glide(ex, ey, w, h)
        if (!ok) return "timeout" to "gesture was cancelled"
        settle(mark)
        return null
      }
      "type" -> return type(a.text!!, target, w, h)
    }
    return "bad_request" to "unknown do"
  }

  /**
   * When a gesture is cancelled (another touch, a system gesture), click through accessibility
   * instead: on the node, or its nearest clickable ancestor.
   */
  private fun clickFallback(t: Resolved, long: Boolean): Boolean {
    var ref = t.node?.ref as? AccessibilityNodeInfo
    if (ref == null) {
      val nodes = snapshot().nodes
      val at = TargetMatcher.atPoint(nodes, t.x, t.y) { it.tap } ?: TargetMatcher.atPoint(nodes, t.x, t.y)
      ref = at?.ref as? AccessibilityNodeInfo
    }
    var n = ref
    var depth = 0
    val action = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
    while (n != null && depth < 10) {
      if (if (long) n.isLongClickable else n.isClickable) return n.performAction(action)
      n = n.parent
      depth++
    }
    return false
  }

  /**
   * Hides the keyboard. First the soft-keyboard controller (no Back press, so nothing else
   * closes); restored to normal after the act. Falls back to Back if the keyboard stays.
   */
  private fun hideKeyboard() {
    val mark = settler.mark()
    val ok = try { softKeyboardController.setShowMode(SHOW_MODE_HIDDEN) } catch (e: Exception) { false }
    if (ok) {
      keyboardHiddenByUs = true
      settler.await(mark)
      if (keyboardBounds() == null) { Hub.log("keyboard hidden (soft-keyboard controller)"); return }
      restoreKeyboard()
    }
    Hub.log("keyboard hidden (back)")
    val m2 = settler.mark()
    performGlobalAction(GLOBAL_ACTION_BACK)
    settler.await(m2)
  }

  private fun restoreKeyboard() {
    if (!keyboardHiddenByUs) return
    keyboardHiddenByUs = false
    try { softKeyboardController.setShowMode(SHOW_MODE_AUTO) } catch (_: Exception) {}
  }

  private fun focusedInput(): AccessibilityNodeInfo? =
    findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }

  private fun type(text: String, target: Resolved?, w: Int, h: Int): Pair<String, String?>? {
    var node: AccessibilityNodeInfo? = null
    if (target != null) {
      var sn = target.node
      if (sn == null) sn = TargetMatcher.atPoint(snapshot().nodes, target.x, target.y) { it.edit }
      glide(target.x, target.y, w, h)
      val ref = sn?.ref as? AccessibilityNodeInfo
      if (ref != null && sn.edit) {
        node = ref
      } else {
        // Not a text field itself (or a web view): tap it, then type into whatever got focus.
        cursor?.press(60)
        val mark = settler.mark()
        gesture(Path().apply { moveTo(target.x.toFloat(), target.y.toFloat()) }, 60)
        settler.await(mark)
        node = focusedInput()
        if (node == null) return if (commitViaInputMethod(text)) { settler.await(); null }
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
          glide(r.exactCenterX(), r.exactCenterY(), w, h)
        }
        return if (commitViaInputMethod(text) || (any != null && paste(any, text))) { settler.await(); null }
          else "not_found" to "no text field has focus"
      }
      val r = Rect(); node.getBoundsInScreen(r)
      glide(r.exactCenterX(), r.exactCenterY(), w, h)
    }
    val mark = settler.mark()
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
        if (commitViaInputMethod(text) || paste(node, text)) { settler.await(mark); return null }
        return "not_editable" to "the field refused the text"
      }
    }
    // Put the caret at the end, like a person who just typed.
    val sel = Bundle().apply {
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, text.length)
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, text.length)
    }
    node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
    settler.await(mark)
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
    val mark = settler.mark()
    val ok = when (name) {
      "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
      "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
      "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
      "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
      "enter" -> {
        val f = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return "not_found" to "no text field has focus"
        f.performAction(AccessibilityAction.ACTION_IME_ENTER.id)
      }
      else -> return "bad_request" to "unknown key"
    }
    if (!ok) return "no_permission" to "Android refused the $name action"
    settle(mark)
    return null
  }

  /** Every launcher activity, as candidates for [LaunchRanker]. */
  private fun launchCandidates(): List<LaunchCandidate> {
    val pm = packageManager
    val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(main, PackageManager.MATCH_ALL).map {
      val ai = it.activityInfo
      // Disabled (or disabled-until-used) activities don't show in the launcher.
      val shown = ai.enabled && ai.applicationInfo.enabled
      LaunchCandidate(ai.packageName, it.loadLabel(pm).toString(), shown, it)
    }
  }

  private fun launch(app: String): Pair<String, String?>? {
    val pm = packageManager
    var intent = try { pm.getLaunchIntentForPackage(app.trim()) } catch (e: Exception) { null }
    if (intent == null) {
      val hit = LaunchRanker.pick(app, launchCandidates())
      val ai = (hit?.ref as? android.content.pm.ResolveInfo)?.activityInfo
      if (ai != null) {
        intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setClassName(ai.packageName, ai.name)
      }
    }
    if (intent == null) return "not_found" to "no app called '$app'"
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    val expected = intent.component?.packageName ?: intent.`package`
    val mark = settler.mark()
    try { startActivity(intent) } catch (e: Exception) { return "no_permission" to e.message }
    frontAfter = waitForApp(expected, mark)
    return null
  }

  /** `do:"open"`: an intent from uri/action/pkg/extras. */
  private fun open(a: Act): Pair<String, String?>? {
    val plan = try { Intents.plan(a) } catch (e: BadRequest) { return "bad_request" to e.message }
    val intent = Intent(plan.action)
    val uri = plan.uri?.let { Uri.parse(it) }
    when {
      uri != null && plan.mime != null -> intent.setDataAndType(uri, plan.mime)
      uri != null -> intent.data = uri
      plan.mime != null -> intent.type = plan.mime
    }
    plan.pkg?.let { intent.setPackage(it) }
    for ((k, v) in plan.extras) when (v) {
      is String -> intent.putExtra(k, v)
      is Int -> intent.putExtra(k, v)
      is Long -> intent.putExtra(k, v)
      is Double -> intent.putExtra(k, v)
      is Boolean -> intent.putExtra(k, v)
      is Array<*> -> intent.putExtra(k, v.map { it.toString() }.toTypedArray())
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pm = packageManager
    // Package visibility can hide handlers from queries but never from startActivity, so an
    // empty query is only a hint; ActivityNotFoundException is the real "nothing handles it".
    val resolved = try { pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) } catch (e: Exception) { null }
    val expected = resolved?.activityInfo?.packageName
    val mark = settler.mark()
    try {
      startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      return "not_found" to "no app handles ${plan.what}"
    } catch (e: SecurityException) {
      return "no_permission" to (e.message ?: "Android refused ${plan.what}")
    }
    Hub.log("open ${plan.action} ${plan.uri ?: ""} -> ${expected ?: "?"}")
    frontAfter = waitForApp(expected, mark)
    return null
  }

  /**
   * After launch/open: a floor (window transitions start late), settle, and keep settling until
   * [expected] is in front (or [SettleTiming.LAUNCH_APP_MAX_MS]). Returns the package in front.
   */
  private fun waitForApp(expected: String?, mark: Settler.Mark): String? {
    val start = SystemClock.uptimeMillis()
    settler.await(mark, minMs = SettleTiming.LAUNCH_FLOOR_MS, t = SettleTiming.LAUNCH)
    var front = frontApp()
    val more = SettleTiming(firstEventMs = 300, quietMs = 150, capMs = 1000)
    while (expected != null && front != expected && SystemClock.uptimeMillis() - start < SettleTiming.LAUNCH_APP_MAX_MS) {
      settler.await(settler.mark(), t = more)
      front = frontApp()
    }
    // A cold start goes quiet between the splash and the first real frame, and slide-in
    // animations send no events: wait (same budget) for readable content that holds still.
    if (front != null) waitStable(SettleTiming.LAUNCH_APP_MAX_MS - (SystemClock.uptimeMillis() - start), front)
    front = frontApp() ?: front
    return front
  }

  /** Settles after an act; when a window or activity changed, also waits for the screen to stop moving. */
  private fun settle(mark: Settler.Mark) {
    val s = settler.await(mark)
    if (s.windowEvents > 0) waitStable(SettleTiming.STABLE_MAX_MS, null)
  }

  /**
   * Waits (event-driven, at most [budgetMs]) until two reads [SettleTiming.STABLE_GAP_MS] apart
   * hash the same and, when [pkg] is given, that app shows readable content
   * ([LaunchRanker.contentReady]). Slide-in animations and a cold start's splash send no events.
   */
  private fun waitStable(budgetMs: Long, pkg: String?) {
    val start = SystemClock.uptimeMillis()
    val glance = SettleTiming(firstEventMs = SettleTiming.STABLE_GAP_MS, quietMs = SettleTiming.STABLE_GAP_MS, capMs = 500)
    val more = SettleTiming(firstEventMs = 300, quietMs = 150, capMs = 1000)
    var prev: String? = null
    while (SystemClock.uptimeMillis() - start < budgetMs) {
      val snap = try { snapshotOnce().first } catch (e: Exception) { return }
      if (pkg == null || LaunchRanker.contentReady(snap.nodes, pkg)) {
        if (snap.hash == prev) return
        prev = snap.hash
        settler.await(settler.mark(), t = glance)
      } else {
        prev = null
        settler.await(settler.mark(), t = more)
      }
    }
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
}
