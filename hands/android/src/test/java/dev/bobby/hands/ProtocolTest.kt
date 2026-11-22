package dev.bobby.hands

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ProtocolTest {
  private fun act(s: String) = Protocol.parseAct(j(s))

  private fun bad(s: String) {
    try {
      Protocol.parseAct(j(s))
      fail("expected BadRequest for $s")
    } catch (_: BadRequest) {
    }
  }

  // --- targets ---

  @Test fun targetIndex() {
    assertEquals(Target.Index(0), act("""{"type":"act","to":"hands","id":"a","do":"tap","on":{"n":0}}""").on)
    assertEquals(Target.Index(7), act("""{"do":"tap","on":{"n":7}}""").on)
  }

  @Test fun targetText() {
    assertEquals(Target.Text("Reply"), act("""{"do":"tap","on":{"text":"Reply"}}""").on)
  }

  @Test fun targetPoint() {
    assertEquals(Target.Point(540, 1200), act("""{"do":"tap","on":{"x":540,"y":1200}}""").on)
  }

  @Test fun targetBadForms() {
    bad("""{"do":"tap","on":{}}""")
    bad("""{"do":"tap","on":{"x":5}}""")
    bad("""{"do":"tap","on":{"y":5}}""")
    bad("""{"do":"tap","on":{"x":"a","y":1}}""")
    bad("""{"do":"tap","on":{"n":"zero"}}""")
    bad("""{"do":"tap","on":{"text":""}}""")
    bad("""{"do":"tap","on":{"text":"   "}}""")
    bad("""{"do":"tap","on":"Reply"}""")
    bad("""{"do":"tap","on":[1,2]}""")
  }

  @Test fun nullOnIsAbsent() {
    assertNull(Protocol.parseTarget(null))
    assertNull(act("""{"do":"swipe","dir":"up","on":null}""").on)
  }

  // --- every `do` ---

  @Test fun idKept() {
    assertEquals("m2", act("""{"type":"act","to":"hands","id":"m2","do":"tap","on":{"text":"Reply"}}""").id)
    assertNull(act("""{"do":"key","name":"home"}""").id)
  }

  @Test fun tapLongPressPointNeedOn() {
    for (d in listOf("tap", "long_press", "point")) {
      val a = act("""{"do":"$d","on":{"n":1}}""")
      assertEquals(d, a.what)
      assertEquals(Target.Index(1), a.on)
      bad("""{"do":"$d"}""")
    }
  }

  @Test fun typeNeedsText() {
    val a = act("""{"do":"type","text":"3 works"}""")
    assertEquals("type", a.what); assertEquals("3 works", a.text); assertNull(a.on)
    val b = act("""{"do":"type","text":"hi","on":{"text":"Compose"}}""")
    assertEquals(Target.Text("Compose"), b.on)
    assertEquals("", act("""{"do":"type","text":""}""").text)
    bad("""{"do":"type"}""")
    bad("""{"do":"type","text":null}""")
  }

  @Test fun swipeDir() {
    for (d in listOf("left", "right", "up", "down")) {
      assertEquals(d, act("""{"do":"swipe","dir":"$d"}""").dir)
    }
    assertEquals(Target.Point(10, 20), act("""{"do":"swipe","dir":"left","on":{"x":10,"y":20}}""").on)
    bad("""{"do":"swipe"}""")
    bad("""{"do":"swipe","dir":"sideways"}""")
    bad("""{"do":"swipe","dir":""}""")
  }

  @Test fun keyNames() {
    for (k in listOf("home", "back", "recents", "notifications", "enter")) {
      assertEquals(k, act("""{"do":"key","name":"$k"}""").name)
    }
    bad("""{"do":"key"}""")
    bad("""{"do":"key","name":"power"}""")
  }

  @Test fun launchApp() {
    assertEquals("Gmail", act("""{"do":"launch","app":"Gmail"}""").app)
    assertEquals("com.google.android.gm", act("""{"do":"launch","app":"com.google.android.gm"}""").app)
    bad("""{"do":"launch"}""")
    bad("""{"do":"launch","app":""}""")
    bad("""{"do":"launch","app":"  "}""")
  }

  @Test fun waitMs() {
    assertEquals(500L, act("""{"do":"wait","ms":500}""").ms)
    assertEquals(0L, act("""{"do":"wait","ms":0}""").ms)
    bad("""{"do":"wait"}""")
    bad("""{"do":"wait","ms":-1}""")
    bad("""{"do":"wait","ms":"500"}""")
  }

  @Test fun unknownOrMissingDo() {
    bad("""{"type":"act","to":"hands","id":"x"}""")
    bad("""{"do":"fly"}""")
    bad("""{"do":""}""")
  }

  @Test fun unknownFieldsIgnored() {
    val a = act("""{"type":"act","to":"hands","id":"z","do":"key","name":"back","future":{"x":1},"why":"because"}""")
    assertEquals("back", a.name)
  }

  @Test fun tablesMatchContract() {
    assertEquals(setOf("tap", "long_press", "point", "type", "swipe", "key", "launch", "wait"), Protocol.DOS)
    assertEquals(setOf("left", "right", "up", "down"), Protocol.DIRS)
    assertEquals(setOf("home", "back", "recents", "notifications", "enter"), Protocol.KEYS)
    assertEquals(setOf("not_found", "not_editable", "no_permission", "timeout", "bad_request"), Protocol.ERRORS)
  }

  // --- encoding ---

  @Test fun screenResultMatchesContractExample() {
    val node = ScreenNode(0, "Reply", "", "Button", intArrayOf(840, 2100, 1040, 2220), tap = true, edit = false, scroll = false)
    val got = Protocol.screenResult("m1", "com.google.android.gm", 1080, 2400, listOf(node))
    assertJsonEq(
      j(
        """{"type":"screen_result","re":"m1","app":"com.google.android.gm","size":[1080,2400],
           "nodes":[{"n":0,"text":"Reply","desc":"","cls":"Button","bounds":[840,2100,1040,2220],
           "tap":true,"edit":false,"scroll":false}]}""",
      ),
      got,
    )
  }

  @Test fun screenResultHintOnlyWhenSet() {
    val n = ScreenNode(3, "", "", "EditText", intArrayOf(0, 0, 10, 10), false, true, false, hint = "Compose email")
    val o = Protocol.screenResult(null, "a", 1, 1, listOf(n))
    assertFalse(o.has("re"))
    val nj = o.getJSONArray("nodes").getJSONObject(0)
    assertEquals("Compose email", nj.getString("hint"))
    assertFalse(nj.has("ref"))
    assertEquals(0, Protocol.screenResult("r", "a", 1, 1, emptyList()).getJSONArray("nodes").length())
  }

  @Test fun actResultOk() {
    assertJsonEq(j("""{"type":"act_result","re":"m2","ok":true}"""), Protocol.actResult("m2", true))
  }

  @Test fun actResultError() {
    assertJsonEq(
      j("""{"type":"act_result","re":"m2","ok":false,"error":"not_found"}"""),
      Protocol.actResult("m2", false, "not_found"),
    )
    // Every listed error round-trips; a missing error defaults to bad_request.
    for (e in Protocol.ERRORS) assertEquals(e, Protocol.actResult("r", false, e).getString("error"))
    assertEquals("bad_request", Protocol.actResult("r", false).getString("error"))
    assertFalse(Protocol.actResult("r", true, "not_found").has("error"))
    assertTrue(Protocol.actResult("r", false, "timeout", "took too long").has("detail"))
  }

  @Test fun notificationMatchesContractExample() {
    assertJsonEq(
      j(
        """{"type":"notification","app":"com.google.android.gm","title":"Sarah Chen",
           "text":"Running late, can we push to 3?","at":1790000000000}""",
      ),
      Protocol.notification("com.google.android.gm", "Sarah Chen", "Running late, can we push to 3?", 1790000000000L),
    )
  }
}
