package dev.bobby.hands

import android.accessibilityservice.AccessibilityService
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.view.animation.PathInterpolator
import dev.bobby.hands.lib.R
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.hypot

/**
 * The only thing Bobby draws: a cursor that glides to each target before Hands acts.
 * Drawn in an accessibility overlay window, so it needs no extra permission and never
 * takes touches. The artwork is the drawable `cursor.xml`, hotspot at its exact centre.
 *
 * All public methods may be called from any thread; the blocking ones wait for the animation.
 */
class CursorOverlay(private val service: AccessibilityService) {
  private val main = Handler(Looper.getMainLooper())
  private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private var view: CursorView? = null
  private val fade = Runnable { animateAlpha(0f, 300) }

  /** Screen position (pixels) of the hotspot. */
  @Volatile var curX = -1f
    private set
  @Volatile var curY = -1f
    private set

  fun attach() = main.post {
    if (view != null) return@post
    val v = CursorView(service)
    val lp = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    )
    lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    lp.title = "BobbyCursor"
    try {
      wm.addView(v, lp)
      view = v
    } catch (e: Exception) {
      Hub.log("cursor overlay failed: ${e.message}")
    }
  }

  fun detach() = main.post {
    main.removeCallbacks(fade)
    view?.let { try { wm.removeViewImmediate(it) } catch (_: Exception) {} }
    view = null
  }

  /** Glides the hotspot to screen point ([tx], [ty]) and blocks until it arrives. */
  fun glideTo(tx: Float, ty: Float, screenW: Int, screenH: Int) {
    val done = CountDownLatch(1)
    var ms = 0L
    main.post {
      val v = view
      if (v == null) { done.countDown(); return@post }
      main.removeCallbacks(fade)
      v.animator?.cancel()
      val wasHidden = v.alpha < 0.05f || curX < 0
      if (curX < 0) { curX = screenW / 2f; curY = screenH * 0.62f }
      val fx = curX; val fy = curY
      ms = TargetMatcher.glideMs(fx, fy, tx, ty, screenW, screenH)
      if (wasHidden) { v.alpha = 1f; v.invalidate() } else v.alpha = 1f
      // A gentle arc: the control point sits off the straight line, so the motion feels natural.
      val dx = tx - fx; val dy = ty - fy
      val dist = hypot(dx, dy)
      val bend = (dist * 0.12f).coerceAtMost(90f)
      val cx = (fx + tx) / 2 - dy / (dist.coerceAtLeast(1f)) * bend
      val cy = (fy + ty) / 2 + dx / (dist.coerceAtLeast(1f)) * bend
      val a = ValueAnimator.ofFloat(0f, 1f)
      a.duration = ms
      a.interpolator = PathInterpolator(0.45f, 0f, 0.2f, 1f)
      a.addUpdateListener {
        val t = it.animatedValue as Float
        val u = 1 - t
        curX = u * u * fx + 2 * u * t * cx + t * t * tx
        curY = u * u * fy + 2 * u * t * cy + t * t * ty
        v.invalidate()
      }
      a.addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: android.animation.Animator) {
          curX = tx; curY = ty; v.invalidate(); done.countDown()
        }
        override fun onAnimationCancel(animation: android.animation.Animator) { done.countDown() }
      })
      v.animator = a
      a.start()
    }
    done.await(2, TimeUnit.SECONDS)
  }

  /** Press animation and ripple at the current position. [holdMs] keeps it pressed. */
  fun press(holdMs: Long = 0) = main.post {
    val v = view ?: return@post
    v.alpha = 1f
    v.pressStart = System.currentTimeMillis()
    v.pressHold = holdMs
    v.rippleStart = System.currentTimeMillis() + holdMs
    v.rippleX = curX; v.rippleY = curY
    v.invalidate()
  }

  /** Called after each action: the cursor fades out 2 s after the last one. */
  fun scheduleFade() = main.post {
    main.removeCallbacks(fade)
    main.postDelayed(fade, 2000)
  }

  fun show(visible: Boolean) = main.post {
    main.removeCallbacks(fade)
    val v = view ?: return@post
    v.animator?.cancel()
    if (visible) {
      if (curX < 0) {
        val m = wm.currentWindowMetrics.bounds
        curX = m.width() / 2f; curY = m.height() * 0.62f
      }
      v.alpha = 1f
      v.invalidate()
      main.postDelayed(fade, 2000)
    } else {
      v.alpha = 0f
      v.invalidate()
    }
  }

  private fun animateAlpha(to: Float, ms: Long) {
    val v = view ?: return
    val a = ValueAnimator.ofFloat(v.alpha, to)
    a.duration = ms
    a.addUpdateListener { v.alpha = it.animatedValue as Float; v.invalidate() }
    a.start()
  }

  private inner class CursorView(ctx: Context) : View(ctx) {
    var animator: ValueAnimator? = null
    var pressStart = 0L
    var pressHold = 0L
    var rippleStart = 0L
    var rippleX = 0f
    var rippleY = 0f
    private val loc = IntArray(2)
    private val density = ctx.resources.displayMetrics.density
    private val sizePx = (48 * density).toInt()
    private val icon: Drawable? = ctx.getDrawable(R.drawable.cursor)
    private val ripple = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 3 * density
      color = 0xFF7C5CFF.toInt()
    }
    private val rippleFill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.FILL
      color = 0xFF7C5CFF.toInt()
    }

    init {
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      alpha = 0f
      setLayerType(LAYER_TYPE_HARDWARE, null)
    }

    override fun onDraw(canvas: Canvas) {
      getLocationOnScreen(loc)
      val now = System.currentTimeMillis()
      var again = false

      // Ripple: an expanding ring after a tap.
      val rt = now - rippleStart
      if (rippleStart > 0 && rt in 0..450) {
        val p = rt / 450f
        val r = (10 + 34 * p) * density
        ripple.alpha = ((1 - p) * 220).toInt()
        rippleFill.alpha = ((1 - p) * 70).toInt()
        val rx = rippleX - loc[0]; val ry = rippleY - loc[1]
        canvas.drawCircle(rx, ry, r, rippleFill)
        canvas.drawCircle(rx, ry, r, ripple)
        again = true
      } else if (rippleStart > now) {
        again = true
      }

      // Press: shrink slightly while pressed, then spring back.
      var scale = 1f
      val pt = now - pressStart
      if (pressStart > 0 && pt in 0..(pressHold + 260)) {
        scale = when {
          pt < 90 -> 1f - 0.18f * (pt / 90f)
          pt < 90 + pressHold -> 0.82f
          else -> 0.82f + 0.18f * ((pt - 90 - pressHold) / 170f).coerceIn(0f, 1f)
        }
        again = true
      }

      if (curX >= 0) {
        val d = icon ?: return
        val half = (sizePx * scale / 2).toInt()
        val cx = (curX - loc[0]).toInt(); val cy = (curY - loc[1]).toInt()
        d.setBounds(cx - half, cy - half, cx + half, cy + half)
        d.draw(canvas)
      }
      if (again) postInvalidateOnAnimation()
    }
  }
}
