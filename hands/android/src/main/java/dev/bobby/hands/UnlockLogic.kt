package dev.bobby.hands

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Pure logic for the locked-phone unlock (no Android calls, so it runs in JVM unit tests).
 * [UnlockVault] stores the secrets; [LockedUnlock] drives the lock screen.
 *
 * The rules, in order:
 *  1. Set up and armed (a failed PIN entry disarms until the owner sets it up again).
 *  2. A secure lock screen (PIN) is showing.
 *  3. This lock session's one attempt hasn't been used (it resets when the owner unlocks).
 *  4. The trusted earbuds are connected.
 *  5. What Bobby heard contains the phrase (at most [MAX_WRONG_PHRASES] misses per lock session).
 * Only then is the PIN typed, once.
 */
object UnlockLogic {
  const val MAX_WRONG_PHRASES = 3
  const val PBKDF2_ITERATIONS = 20_000
  const val MIN_PIN = 4
  const val MAX_PIN = 16
  const val MIN_PHRASE_WORDS = 2
  const val MIN_PHRASE_CHARS = 8

  // --- phrase ---

  /** Lower case, apostrophes dropped ("it's" -> "its"), other punctuation as spaces. */
  fun normalize(text: String): String {
    val sb = StringBuilder(text.length)
    for (ch in text.lowercase()) {
      when {
        ch == '\'' || ch == '’' || ch == '‘' -> {}
        ch.isLetterOrDigit() -> sb.append(ch)
        else -> sb.append(' ')
      }
    }
    return sb.toString().trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
  }

  fun words(text: String): List<String> = normalize(text).split(' ').filter { it.isNotEmpty() }

  /** Why a phrase can't be used, or null when it's fine. */
  fun phraseProblem(phrase: String): String? {
    val w = words(phrase)
    if (w.size < MIN_PHRASE_WORDS) return "Use at least $MIN_PHRASE_WORDS words."
    if (w.joinToString(" ").length < MIN_PHRASE_CHARS) return "Use at least $MIN_PHRASE_CHARS letters."
    return null
  }

  fun newSalt(): ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }

  fun hashPhrase(normalized: String, salt: ByteArray, iterations: Int = PBKDF2_ITERATIONS): ByteArray {
    val chars = normalized.toCharArray()
    val spec = PBEKeySpec(chars, salt, iterations, 256)
    try {
      return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    } finally {
      spec.clearPassword()
      chars.fill('\u0000')
    }
  }

  /**
   * True when some run of [wordCount] consecutive words in [heard] hashes to [hash]. The phrase
   * itself is never stored, so each window is hashed and compared in constant time.
   */
  fun heardPhrase(heard: String, wordCount: Int, salt: ByteArray, hash: ByteArray, iterations: Int = PBKDF2_ITERATIONS): Boolean {
    if (wordCount <= 0) return false
    val w = words(heard)
    if (w.size < wordCount) return false
    val seen = HashSet<String>()
    var match = false
    for (i in 0..(w.size - wordCount)) {
      val window = w.subList(i, i + wordCount).joinToString(" ")
      if (!seen.add(window)) continue
      if (MessageDigest.isEqual(hashPhrase(window, salt, iterations), hash)) match = true
    }
    return match
  }

  // --- PIN ---

  /** Why a PIN can't be used, or null when it's fine. */
  fun pinProblem(pin: CharArray): String? {
    if (pin.size < MIN_PIN || pin.size > MAX_PIN) return "The PIN must be $MIN_PIN to $MAX_PIN digits."
    if (pin.any { it !in '0'..'9' }) return "The PIN can only have digits."
    return null
  }

  // --- earbuds ---

  /**
   * Android hides most of a Bluetooth address from apps without BLUETOOTH_CONNECT
   * ("XX:XX:XX:XX:AB:CD"), so only the last two bytes are compared, along with the name.
   */
  fun addressTail(address: String?): String {
    val a = (address ?: "").trim().uppercase()
    return if (a.length >= 5) a.takeLast(5) else ""
  }

  fun sameEarbuds(storedName: String, storedTail: String, name: String, address: String?): Boolean {
    if (storedName.isEmpty() || name.trim() != storedName) return false
    val tail = addressTail(address)
    // Both sides have an address: it must match too. Otherwise the name alone decides.
    return storedTail.isEmpty() || tail.isEmpty() || tail == storedTail
  }

  // --- the lock screen's keypad ---

  private val KEY_ID = Regex(".*:id/key([0-9])$")
  private val KEY_LABEL = Regex("^([0-9])(\\s+[A-Za-z+]*)?$")
  private val ENTER_IDS = listOf(":id/key_enter", ":id/okButton", ":id/key_ok")
  private val ENTER_WORDS = setOf("enter", "ok", "done", "confirm", "next", "unlock")
  private val NEVER = setOf("delete", "backspace", "erase", "clear", "emergency call", "emergency", "cancel", "back")

  fun isKeyId(viewId: String) = KEY_ID.matches(viewId)

  /** The digit a lock-screen key types, from its view id ("...:id/key7"), text ("7 PQRS") or description. */
  fun digitOf(viewId: String, text: String, desc: String): Int? {
    KEY_ID.matchEntire(viewId)?.let { return it.groupValues[1].toInt() }
    val label = text.replace('\n', ' ').trim()
    KEY_LABEL.matchEntire(label)?.let { return it.groupValues[1].toInt() }
    KEY_LABEL.matchEntire(desc.replace('\n', ' ').trim())?.let { return it.groupValues[1].toInt() }
    return null
  }

  fun isEnterKey(viewId: String, text: String, desc: String): Boolean {
    if (ENTER_IDS.any { viewId.endsWith(it) }) return true
    val t = text.trim().lowercase()
    val d = desc.trim().lowercase()
    if (t in NEVER || d in NEVER) return false
    return t in ENTER_WORDS || d in ENTER_WORDS
  }

  /**
   * A full keypad: each digit 0-9 found exactly once. Anything else (a pattern or password
   * lock, two keys for one digit) returns null, and nothing is typed.
   */
  fun <K> keypad(keys: List<Pair<Int, K>>): Map<Int, K>? {
    val byDigit = keys.groupBy({ it.first }, { it.second })
    if ((0..9).any { byDigit[it]?.size != 1 }) return null
    return (0..9).associateWith { byDigit[it]!!.single() }
  }

  // --- the rules ---

  enum class Gate { GO, NOT_SET_UP, DISARMED, NOT_LOCKED, USED, NO_EARBUDS, TOO_MANY_WRONG, WRONG_PHRASE }

  /** Everything the rules look at, minus the secrets. */
  data class Facts(
    val setUp: Boolean,
    val armed: Boolean,
    val secureLocked: Boolean,
    val usedThisLock: Boolean,
    val wrongThisLock: Int,
    val earbudsConnected: Boolean,
  )

  /**
   * Decides whether to try. [phraseMatches] is only called once every other rule passes (it
   * costs a PBKDF2 per word window, and a miss counts against the lock session).
   */
  fun gate(f: Facts, phraseMatches: () -> Boolean): Gate = when {
    !f.setUp -> Gate.NOT_SET_UP
    !f.armed -> Gate.DISARMED
    !f.secureLocked -> Gate.NOT_LOCKED
    f.usedThisLock -> Gate.USED
    f.wrongThisLock >= MAX_WRONG_PHRASES -> Gate.TOO_MANY_WRONG
    !f.earbudsConnected -> Gate.NO_EARBUDS
    !phraseMatches() -> Gate.WRONG_PHRASE
    else -> Gate.GO
  }
}
