package dev.bobby.hands

import dev.bobby.hands.UnlockLogic.Facts
import dev.bobby.hands.UnlockLogic.Gate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UnlockLogicTest {
  // Few iterations: the tests check matching, not PBKDF2's cost.
  private val iters = 1000

  private fun stored(phrase: String): Triple<ByteArray, ByteArray, Int> {
    val n = UnlockLogic.normalize(phrase)
    val salt = UnlockLogic.newSalt()
    return Triple(salt, UnlockLogic.hashPhrase(n, salt, iters), UnlockLogic.words(n).size)
  }

  private fun heard(text: String, phrase: String): Boolean {
    val (salt, hash, words) = stored(phrase)
    return UnlockLogic.heardPhrase(text, words, salt, hash, iters)
  }

  @Test fun normalizeDropsCaseApostrophesAndPunctuation() {
    assertEquals("hey its james", UnlockLogic.normalize("Hey, it's  James!"))
    assertEquals("hey its james", UnlockLogic.normalize("hey it’s james."))
  }

  @Test fun phraseAnywhereInWhatWasHeard() {
    assertTrue(heard("Hey, it's James.", "hey it's james"))
    assertTrue(heard("Okay hey it's James, read my email", "Hey, it's James"))
    assertFalse(heard("hey it's jane", "hey it's james"))
    assertFalse(heard("it's james", "hey it's james"))
    assertFalse(heard("", "hey it's james"))
  }

  @Test fun wordsMustBeConsecutive() {
    assertFalse(heard("hey there it's james", "hey it's james"))
  }

  @Test fun phraseAndPinRules() {
    assertNotNull(UnlockLogic.phraseProblem("james"))
    assertNotNull(UnlockLogic.phraseProblem("hi yo"))
    assertNull(UnlockLogic.phraseProblem("hey it's james"))
    assertNull(UnlockLogic.pinProblem("1234".toCharArray()))
    assertNotNull(UnlockLogic.pinProblem("123".toCharArray()))
    assertNotNull(UnlockLogic.pinProblem("12a4".toCharArray()))
    assertNotNull(UnlockLogic.pinProblem("12345678901234567".toCharArray()))
  }

  @Test fun earbudsMatchByNameAndAddressTail() {
    val tail = UnlockLogic.addressTail("AA:BB:CC:DD:12:34")
    assertEquals("12:34", tail)
    assertTrue(UnlockLogic.sameEarbuds("Galaxy Buds2", tail, "Galaxy Buds2", "AA:BB:CC:DD:12:34"))
    // Android anonymises all but the last two bytes for some apps.
    assertTrue(UnlockLogic.sameEarbuds("Galaxy Buds2", tail, "Galaxy Buds2", "XX:XX:XX:XX:12:34"))
    assertFalse(UnlockLogic.sameEarbuds("Galaxy Buds2", tail, "Galaxy Buds2", "XX:XX:XX:XX:99:99"))
    assertFalse(UnlockLogic.sameEarbuds("Galaxy Buds2", tail, "Car speaker", "XX:XX:XX:XX:12:34"))
    assertTrue(UnlockLogic.sameEarbuds("Galaxy Buds2", tail, "Galaxy Buds2", ""))
    assertFalse(UnlockLogic.sameEarbuds("", "", "Galaxy Buds2", ""))
  }

  @Test fun keypadDigits() {
    assertEquals(7, UnlockLogic.digitOf("com.android.systemui:id/key7", "", ""))
    assertEquals(2, UnlockLogic.digitOf("", "2 ABC", ""))
    assertEquals(2, UnlockLogic.digitOf("", "2\nABC", ""))
    assertEquals(0, UnlockLogic.digitOf("", "0 +", ""))
    assertEquals(5, UnlockLogic.digitOf("", "", "5"))
    assertNull(UnlockLogic.digitOf("", "12", ""))
    assertNull(UnlockLogic.digitOf("com.android.systemui:id/key_enter", "", "Enter"))
    assertNull(UnlockLogic.digitOf("", "Emergency call", ""))
    assertTrue(UnlockLogic.isKeyId("com.android.systemui:id/key0"))
    assertFalse(UnlockLogic.isKeyId("com.android.systemui:id/key_enter"))
    assertFalse(UnlockLogic.isKeyId(""))
  }

  @Test fun enterKeyNeverDeleteOrEmergency() {
    assertTrue(UnlockLogic.isEnterKey("com.android.systemui:id/key_enter", "", ""))
    assertTrue(UnlockLogic.isEnterKey("", "OK", ""))
    assertTrue(UnlockLogic.isEnterKey("", "", "Enter"))
    assertFalse(UnlockLogic.isEnterKey("", "", "Delete"))
    assertFalse(UnlockLogic.isEnterKey("", "Emergency call", ""))
    assertFalse(UnlockLogic.isEnterKey("com.android.systemui:id/delete_button", "", "Backspace"))
  }

  @Test fun keypadNeedsEachDigitExactlyOnce() {
    val full = (0..9).map { it to "k$it" }
    assertEquals("k3", UnlockLogic.keypad(full)!![3])
    assertNull(UnlockLogic.keypad(full.filter { it.first != 4 }))
    assertNull(UnlockLogic.keypad(full + (4 to "again")))
    assertNull(UnlockLogic.keypad(emptyList<Pair<Int, String>>()))
  }

  private val ready = Facts(setUp = true, armed = true, secureLocked = true, usedThisLock = false, wrongThisLock = 0, earbudsConnected = true)

  @Test fun gateGoesOnlyWhenEverythingHolds() {
    assertEquals(Gate.GO, UnlockLogic.gate(ready) { true })
    assertEquals(Gate.WRONG_PHRASE, UnlockLogic.gate(ready) { false })
    assertEquals(Gate.NOT_SET_UP, UnlockLogic.gate(ready.copy(setUp = false)) { true })
    assertEquals(Gate.DISARMED, UnlockLogic.gate(ready.copy(armed = false)) { true })
    assertEquals(Gate.NOT_LOCKED, UnlockLogic.gate(ready.copy(secureLocked = false)) { true })
    assertEquals(Gate.USED, UnlockLogic.gate(ready.copy(usedThisLock = true)) { true })
    assertEquals(Gate.NO_EARBUDS, UnlockLogic.gate(ready.copy(earbudsConnected = false)) { true })
    assertEquals(Gate.TOO_MANY_WRONG, UnlockLogic.gate(ready.copy(wrongThisLock = UnlockLogic.MAX_WRONG_PHRASES)) { true })
  }

  @Test fun phraseIsOnlyCheckedLast() {
    var checked = false
    UnlockLogic.gate(ready.copy(earbudsConnected = false)) { checked = true; true }
    assertFalse("no earbuds: the phrase isn't even checked (and no miss is counted)", checked)
    UnlockLogic.gate(ready.copy(usedThisLock = true)) { checked = true; true }
    assertFalse(checked)
  }
}
