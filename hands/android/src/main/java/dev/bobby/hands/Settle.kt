package dev.bobby.hands

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Event-driven "the screen has settled". Accessibility events signal a condition; a waiter
 * wakes only when something happens or a deadline passes (no polling).
 *
 * Rules (all times from the start of the wait):
 *  - no qualifying event at all within [SettleTiming.firstEventMs]: done (nothing is changing);
 *  - otherwise done once [SettleTiming.quietMs] pass with no event;
 *  - never before `minMs`, never after [SettleTiming.capMs].
 * Events count from a [Mark] taken just before the action, so ones the action fired while the
 * cursor was still pressing are not missed.
 */
data class SettleTiming(val firstEventMs: Long = 400, val quietMs: Long = 150, val capMs: Long = 2000) {
  companion object {
    /** Every act. */
    val ACT = SettleTiming()
    /** `launch` and `open`: window transitions start late, so wait longer for the first event. */
    val LAUNCH = SettleTiming(firstEventMs = 1000, quietMs = 150, capMs = 2500)
    /** The floor after launch/open: never report before this. */
    const val LAUNCH_FLOOR_MS = 250L
    /** launch/open keep waiting (up to this) until the expected app is in front. */
    const val LAUNCH_APP_MAX_MS = 3500L
    /** launch/open: two reads this far apart must match (slide-in animations send no events). */
    const val STABLE_GAP_MS = 100L
    /** After an act that changed a window: at most this long waiting for the screen to stop moving. */
    const val STABLE_MAX_MS = 600L
  }
}

class Settler(private val clock: () -> Long = { System.nanoTime() / 1_000_000 }) {
  class Mark(val count: Long, val at: Long, val windows: Long = 0)
  /** What a wait saw: ms waited, qualifying events, and how many were window-level (a window or activity changed). */
  data class Settled(val ms: Long, val events: Long, val windowEvents: Long)

  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private var count = 0L
  private var lastAt = 0L
  private var windows = 0L

  companion object {
    // AccessibilityEvent constants, copied so this stays pure.
    const val TYPE_WINDOW_STATE_CHANGED = 0x20
    const val TYPE_WINDOW_CONTENT_CHANGED = 0x800
    const val TYPE_WINDOWS_CHANGED = 0x400000
    private const val SYSTEMUI = "com.android.systemui"

    /** Only window changes from apps count: not system UI (clock, status bar), not our own overlay. */
    fun counts(type: Int, pkg: String?, ownPkg: String?): Boolean {
      if (type != TYPE_WINDOW_STATE_CHANGED && type != TYPE_WINDOW_CONTENT_CHANGED && type != TYPE_WINDOWS_CHANGED) return false
      // TYPE_WINDOWS_CHANGED has no package; it still counts (a window came or went).
      if (pkg == SYSTEMUI) return false
      if (ownPkg != null && pkg == ownPkg) return false
      return true
    }

    /**
     * The decision, pure: 0 when settled, else how long to wait (ms) before looking again.
     * [events] is how many qualifying events happened since the mark; [lastEventAt] the newest.
     */
    fun next(now: Long, start: Long, events: Long, lastEventAt: Long, minMs: Long, t: SettleTiming): Long {
      val elapsed = now - start
      if (elapsed >= t.capMs) return 0
      val left = t.capMs - elapsed
      if (events == 0L) {
        val until = maxOf(t.firstEventMs, minMs)
        return if (elapsed >= until) 0 else minOf(until - elapsed, left)
      }
      val quiet = now - lastEventAt
      if (quiet >= t.quietMs && elapsed >= minMs) return 0
      return minOf(maxOf(t.quietMs - quiet, minMs - elapsed, 1), left)
    }
  }

  fun onEvent(type: Int = TYPE_WINDOW_CONTENT_CHANGED) = lock.withLock {
    count++
    if (type != TYPE_WINDOW_CONTENT_CHANGED) windows++
    lastAt = clock()
    changed.signalAll()
  }

  fun mark(): Mark = lock.withLock { Mark(count, clock(), windows) }

  /** Blocks until settled. */
  fun await(mark: Mark = mark(), minMs: Long = 0, t: SettleTiming = SettleTiming.ACT): Settled {
    lock.lock()
    try {
      val start = clock()
      while (true) {
        val events = count - mark.count
        val wait = next(clock(), start, events, lastAt, minMs, t)
        if (wait <= 0) return Settled(clock() - start, events, windows - mark.windows)
        changed.await(wait, TimeUnit.MILLISECONDS)
      }
    } finally {
      lock.unlock()
    }
  }
}
