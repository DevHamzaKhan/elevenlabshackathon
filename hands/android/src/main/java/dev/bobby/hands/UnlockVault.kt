package dev.bobby.hands

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where the locked-phone unlock keeps its secrets and its attempt counters.
 *
 * - The PIN is encrypted with an AES-256-GCM key that lives in the Android Keystore
 *   (StrongBox when the phone has it). The key can't be exported, so the stored ciphertext is
 *   useless anywhere else. It can't require a fresh unlock, since its whole job is to be read
 *   while the phone is locked.
 * - The phrase is never stored: only a salted PBKDF2 hash and its word count.
 * - The file lives in `noBackupFilesDir`, so no cloud or adb backup copies it.
 * - The PIN only leaves this file as a ByteArray that the caller wipes after typing it. It is
 *   never logged, never sent over the hub and never shown again.
 * - "Attempt started" is written to disk before the first digit, so even a crash mid-entry
 *   counts as the one attempt and disarms (see [recover]).
 */
object UnlockVault {
  private const val ALIAS = "bobby_unlock_pin_v1"
  private const val FILE = "bobby_unlock.json"

  data class Status(
    val setUp: Boolean,
    val armed: Boolean,
    val earbuds: String,
    val disarmedReason: String,
    val lastResult: String,
    val lastAt: Long,
  )

  class Phrase(val salt: ByteArray, val hash: ByteArray, val words: Int, val iterations: Int)

  private fun file(ctx: Context) = AtomicFile(File(ctx.noBackupFilesDir, FILE))

  @Synchronized private fun load(ctx: Context): JSONObject = try {
    JSONObject(String(file(ctx).readFully(), Charsets.UTF_8))
  } catch (e: Exception) { JSONObject() }

  @Synchronized private fun save(ctx: Context, o: JSONObject) {
    val f = file(ctx)
    val out = f.startWrite()
    try {
      out.write(o.toString().toByteArray(Charsets.UTF_8))
      f.finishWrite(out) // fsyncs before the rename
    } catch (e: Exception) {
      f.failWrite(out)
      throw e
    }
  }

  @Synchronized private fun edit(ctx: Context, fn: (JSONObject) -> Unit) {
    val o = load(ctx)
    fn(o)
    save(ctx, o)
  }

  private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
  private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)

  // --- Keystore ---

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun newKey(): SecretKey {
    keyStore().deleteEntry(ALIAS)
    fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setRandomizedEncryptionRequired(true)
      .setIsStrongBoxBacked(strongBox)
      .build()
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    return try {
      gen.init(spec(true)); gen.generateKey()
    } catch (e: StrongBoxUnavailableException) {
      gen.init(spec(false)); gen.generateKey()
    }
  }

  private fun key(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

  // --- set up / turn off ---

  /**
   * Stores a new PIN, phrase and earbuds, and arms. Uses a fresh Keystore key each time.
   * [pin] is ASCII digits; the caller wipes it afterwards.
   */
  @Synchronized fun setUp(ctx: Context, pin: ByteArray, phrase: String, earbudsName: String, earbudsAddress: String?) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, newKey())
    val sealed = cipher.doFinal(pin)
    val normalized = UnlockLogic.normalize(phrase)
    val salt = UnlockLogic.newSalt()
    val hash = UnlockLogic.hashPhrase(normalized, salt)
    val o = JSONObject()
      .put("v", 1)
      .put("pin", b64(sealed))
      .put("iv", b64(cipher.iv))
      .put("salt", b64(salt))
      .put("hash", b64(hash))
      .put("words", UnlockLogic.words(normalized).size)
      .put("iters", UnlockLogic.PBKDF2_ITERATIONS)
      .put("earName", earbudsName.trim())
      .put("earTail", UnlockLogic.addressTail(earbudsAddress))
      .put("armed", true)
      .put("used", false)
      .put("wrong", 0)
      .put("inProgress", false)
      .put("last", "set up")
      .put("lastAt", System.currentTimeMillis())
    sealed.fill(0)
    save(ctx, o)
  }

  /** Forgets everything: the Keystore key and the file. */
  @Synchronized fun turnOff(ctx: Context) {
    try { keyStore().deleteEntry(ALIAS) } catch (_: Exception) {}
    try { file(ctx).delete() } catch (_: Exception) {}
  }

  // --- reading ---

  @Synchronized fun status(ctx: Context): Status {
    val o = load(ctx)
    val setUp = o.optString("pin").isNotEmpty() && try { key() != null } catch (e: Exception) { false }
    return Status(
      setUp = setUp,
      armed = setUp && o.optBoolean("armed"),
      earbuds = o.optString("earName"),
      disarmedReason = o.optString("disarmed"),
      lastResult = o.optString("last"),
      lastAt = o.optLong("lastAt"),
    )
  }

  @Synchronized fun facts(ctx: Context, secureLocked: Boolean, earbudsConnected: Boolean): UnlockLogic.Facts {
    val o = load(ctx)
    val st = status(ctx)
    return UnlockLogic.Facts(
      setUp = st.setUp,
      armed = st.armed,
      secureLocked = secureLocked,
      usedThisLock = o.optBoolean("used"),
      wrongThisLock = o.optInt("wrong"),
      earbudsConnected = earbudsConnected,
    )
  }

  @Synchronized fun earbuds(ctx: Context): Pair<String, String> {
    val o = load(ctx)
    return o.optString("earName") to o.optString("earTail")
  }

  @Synchronized fun phrase(ctx: Context): Phrase? {
    val o = load(ctx)
    if (o.optString("hash").isEmpty()) return null
    return Phrase(unb64(o.optString("salt")), unb64(o.optString("hash")), o.optInt("words"), o.optInt("iters", UnlockLogic.PBKDF2_ITERATIONS))
  }

  // --- counters ---

  @Synchronized fun wrongPhrase(ctx: Context) = edit(ctx) { it.put("wrong", it.optInt("wrong") + 1) }

  /** The owner unlocked the phone (or Bobby did): a new lock session gets one attempt again. */
  @Synchronized fun onUserPresent(ctx: Context) {
    val o = load(ctx)
    if (o.length() == 0) return
    if (!o.optBoolean("used") && o.optInt("wrong") == 0) return
    o.put("used", false).put("wrong", 0)
    save(ctx, o)
  }

  /**
   * Marks this lock session's one attempt as used, writes it to disk, and only then returns the
   * PIN. Returns null (and types nothing) if the attempt is already used or the PIN can't be
   * read. The caller must wipe the returned bytes.
   */
  @Synchronized fun beginAttempt(ctx: Context): ByteArray? {
    val o = load(ctx)
    if (!o.optBoolean("armed") || o.optBoolean("used") || o.optBoolean("inProgress")) return null
    o.put("used", true).put("inProgress", true).put("lastAt", System.currentTimeMillis())
    save(ctx, o)
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key() ?: throw IllegalStateException("no key"), GCMParameterSpec(128, unb64(o.optString("iv"))))
      cipher.doFinal(unb64(o.optString("pin")))
    } catch (e: Exception) {
      finishAttempt(ctx, false, "couldn't read the stored PIN")
      null
    }
  }

  /** Uses up this lock session's attempt without typing anything (and without disarming). */
  @Synchronized fun useSession(ctx: Context) = edit(ctx) { if (it.length() > 0) it.put("used", true) }

  /** Ends the attempt. A failure disarms until the owner sets it up again in the app. */
  @Synchronized fun finishAttempt(ctx: Context, ok: Boolean, result: String) = edit(ctx) {
    it.put("inProgress", false).put("last", result).put("lastAt", System.currentTimeMillis())
    if (!ok) it.put("armed", false).put("disarmed", result)
  }

  /** A gate stopped the attempt before any digit was typed: just record why (nothing secret). */
  @Synchronized fun note(ctx: Context, result: String) = edit(ctx) {
    if (it.length() > 0) it.put("last", result).put("lastAt", System.currentTimeMillis())
  }

  /** At service start: an attempt that was in progress when the process died counts as failed. */
  @Synchronized fun recover(ctx: Context) {
    val o = load(ctx)
    if (o.optBoolean("inProgress")) {
      o.put("inProgress", false).put("armed", false).put("disarmed", "interrupted during PIN entry")
        .put("last", "interrupted during PIN entry").put("lastAt", System.currentTimeMillis())
      save(ctx, o)
    }
  }
}
