package dev.bobby.hands

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Teaching by showing: the recorder's rules (frames, order, what is never recorded). */
class ObserveTest {
  private val fabRef = Any()
  private val fieldRef = Any()
  private val createRef = Any()

  private fun node(n: Int, text: String = "", ref: Any? = null, id: String = "", hint: String = "", edit: Boolean = false, tap: Boolean = true, b: IntArray = intArrayOf(0, n * 100, 500, n * 100 + 90), password: Boolean = false) =
    ScreenNode(n, text, "", if (edit) "EditText" else "Button", b, tap, edit, false, hint = hint, ref = ref, id = id, key = "k$n", viewId = if (id.isEmpty()) "" else "com.x:id/$id", pkg = "com.x", password = password)

  private fun snap(hash: String, vararg nodes: ScreenNode, app: String = "com.x") = Snap(app, 1080, 2400, nodes.toList(), hash)

  private val list = snap("h-list", node(0, "Projects", tap = false), node(1, "New project", fabRef, "fab_new"))
  private val dialog = snap("h-dialog", node(0, "Create a project", tap = false), node(1, "", fieldRef, "name_input", hint = "Project name", edit = true), node(2, "Create", createRef, "create"))
  private val after = snap("h-after", node(0, "Projects", tap = false), node(1, "test test"), node(2, "New project", fabRef, "fab_new"))

  private class Rig(now: LongArray = longArrayOf(1000)) {
    val out = ArrayList<JSONObject>()
    val clock = now
    val rec = Recorder("dev.bobby.app", "com.kb", { out.add(it) }, { clock[0] })
    fun kinds() = out.map { it.getString("kind") }
  }

  private fun click(ref: Any?, pkg: String = "com.x", text: String = "") = SeenEvent(Recorder.TYPE_VIEW_CLICKED, pkg, "android.widget.Button", text, ref = ref)
  private fun typed(text: String, password: Boolean = false) = SeenEvent(Recorder.TYPE_VIEW_TEXT_CHANGED, "com.x", "android.widget.EditText", text, ref = fieldRef, password = password, editable = true)

  @Test fun aWholeDemoComesOutInOrder() {
    val r = Rig()
    r.rec.start(list)
    r.rec.event(click(fabRef))
    r.rec.screen(dialog)
    r.rec.event(typed("t"))
    r.rec.screen(snap("h-typing-1", dialog.nodes[0], node(1, "t", fieldRef, "name_input", hint = "Project name", edit = true), dialog.nodes[2]))
    r.rec.event(typed("test test"))
    r.rec.event(click(createRef))
    r.rec.screen(after)
    r.rec.flush()
    // The start screen is in observe_result, so the first frame is the tap on it.
    assertEquals(listOf("tap", "screen", "type", "screen", "tap", "screen"), r.kinds())
    assertEquals((1..6).toList(), r.out.map { it.getInt("seq") })
    val tap = r.out[0]
    assertEquals("h-list", tap.getString("hash"))
    assertEquals("com.x", tap.getString("app"))
    assertEquals("New project", tap.getJSONObject("node").getString("text"))
    assertEquals("fab_new", tap.getJSONObject("node").getString("id"))
    assertEquals("k1", tap.getJSONObject("node").getString("key"))
    assertEquals("h-dialog", r.out[1].getJSONObject("screen").getString("hash"))
    assertFalse("a screen body has no type", r.out[1].getJSONObject("screen").has("type"))
    val type = r.out[2]
    assertEquals("one frame for the burst, with the final text", "test test", type.getString("text"))
    assertEquals("from before the first keystroke", "h-dialog", type.getString("hash"))
    assertEquals("Project name", type.getJSONObject("node").getString("hint"))
    assertEquals("the screen the typing left goes out before the next tap", "h-typing-1", r.out[3].getJSONObject("screen").getString("hash"))
    assertEquals("Create", r.out[4].getJSONObject("node").getString("text"))
    assertEquals("h-after", r.out[5].getJSONObject("screen").getString("hash"))
  }

  @Test fun typingGoesOutWhenItGoesQuiet() {
    val now = longArrayOf(1000)
    val r = Rig(now)
    r.rec.start(dialog)
    r.rec.event(typed("te"))
    now[0] += 300
    r.rec.idle()
    assertTrue("still typing", r.out.isEmpty())
    r.rec.event(typed("test"))
    now[0] += Recorder.TYPING_IDLE_MS
    r.rec.idle()
    assertEquals(listOf("type"), r.kinds())
    assertEquals("test", r.out[0].getString("text"))
  }

  @Test fun passwordsAreNeverRecorded() {
    val r = Rig()
    r.rec.start(dialog)
    r.rec.event(typed("hunter2", password = true))
    r.rec.flush()
    assertEquals(true, r.out[0].getBoolean("password"))
    assertFalse(r.out[0].has("text"))
    assertFalse(r.out.toString().contains("hunter2"))
  }

  @Test fun thisAppAndTheKeyboardAreIgnored() {
    val r = Rig()
    r.rec.start(list)
    r.rec.event(click(Any(), pkg = "dev.bobby.app"))
    r.rec.event(click(Any(), pkg = "com.kb", text = "q"))
    r.rec.screen(snap("h-bobby", node(0, "Bobby"), app = "dev.bobby.app"))
    r.rec.flush()
    assertTrue(r.out.isEmpty())
    // Starting with this app in front (it was just opened by the side button): no start screen.
    val r2 = Rig()
    r2.rec.start(snap("h-bobby", node(0, "Bobby"), app = "dev.bobby.app"))
    r2.rec.screen(list)
    assertEquals(listOf("screen"), r2.kinds())
  }

  @Test fun anUnchangedScreenIsNotSentTwice() {
    val r = Rig()
    r.rec.start(list)
    r.rec.screen(list)
    r.rec.screen(snap("h-list", list.nodes[0]))
    assertTrue(r.out.isEmpty())
  }

  @Test fun scrollsOncePerBurstWithTheFingersDirection() {
    assertEquals("up", Recorder.scrollDir(0, 420))
    assertEquals("down", Recorder.scrollDir(0, -90))
    assertEquals("left", Recorder.scrollDir(300, 10))
    assertEquals("right", Recorder.scrollDir(-300, 10))
    assertNull(Recorder.scrollDir(0, 0))
    val r = Rig()
    r.rec.start(list)
    val scroll = SeenEvent(Recorder.TYPE_VIEW_SCROLLED, "com.x", "RecyclerView", dy = 400)
    r.rec.event(scroll)
    r.rec.event(scroll)
    r.rec.screen(after)
    r.rec.event(scroll)
    assertEquals(listOf("scroll", "screen"), r.kinds())
    assertEquals("up", r.out[0].getString("dir"))
    r.rec.event(click(fabRef))
    r.rec.event(SeenEvent(Recorder.TYPE_VIEW_SCROLLED, "com.x", "RecyclerView"))
    assertEquals(listOf("scroll", "screen", "tap", "scroll"), r.kinds())
    assertFalse("no direction when the app gave none", r.out[3].has("dir"))
    // A field scrolling its own text as it fills is not a scroll.
    r.rec.event(SeenEvent(Recorder.TYPE_VIEW_SCROLLED, "com.x", "EditText", editable = true, dx = 30))
    assertEquals(4, r.out.size)
  }

  @Test fun matchingFallsBackFromNodeToIdToPlaceToWords() {
    val nodes = after.nodes
    assertEquals(2, Recorder.match(nodes, click(fabRef))!!.n)
    // No platform node (a view that was already gone): the resource id, at that place.
    assertEquals(2, Recorder.match(nodes, SeenEvent(Recorder.TYPE_VIEW_CLICKED, "com.x", viewId = "com.x:id/fab_new", bounds = intArrayOf(0, 200, 500, 290)))!!.n)
    assertEquals(1, Recorder.match(nodes, SeenEvent(Recorder.TYPE_VIEW_CLICKED, "com.x", bounds = intArrayOf(10, 110, 400, 180)))!!.n)
    assertEquals(1, Recorder.match(nodes, SeenEvent(Recorder.TYPE_VIEW_CLICKED, "com.x", text = "test test"))!!.n)
    assertNull(Recorder.match(nodes, SeenEvent(Recorder.TYPE_VIEW_CLICKED, "com.x", text = "Nope")))
    // Nothing matches: the frame still says what the event knew.
    val r = Rig()
    r.rec.start(list)
    r.rec.event(SeenEvent(Recorder.TYPE_VIEW_CLICKED, "com.x", "android.widget.ImageButton", desc = "More options", viewId = "com.x:id/overflow"))
    val n = r.out[0].getJSONObject("node")
    assertEquals("More options", n.getString("desc")); assertEquals("overflow", n.getString("id")); assertEquals(false, n.getBoolean("matched"))
  }

  @Test fun launchFreshIsAnOption() {
    assertTrue(Protocol.parseAct(j("""{"do":"launch","app":"Projects","fresh":true}""")).fresh)
    assertFalse(Protocol.parseAct(j("""{"do":"launch","app":"Projects"}""")).fresh)
    assertTrue(Caps.FEATURES.containsAll(listOf("observe", "launch_fresh")))
  }
}
