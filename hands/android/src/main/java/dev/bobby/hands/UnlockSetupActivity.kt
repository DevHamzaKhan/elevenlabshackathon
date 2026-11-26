package dev.bobby.hands

import android.app.Activity
import android.app.KeyguardManager
import android.graphics.Color
import android.graphics.Typeface
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Bundle
import android.os.CancellationSignal
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView

/**
 * Where the owner sets up the locked-phone unlock: their PIN, their phrase and which earbuds
 * count. Native on purpose, so the PIN never passes through JavaScript, the hub or `.env`.
 *
 * - Opens only after the owner proves it's them (fingerprint, face or the phone's own PIN).
 * - FLAG_SECURE: no screenshots, no screen recording, blank in the recents list.
 * - The PIN fields are cleared as soon as Save is pressed and are never filled back in.
 */
class UnlockSetupActivity : Activity() {
  private lateinit var root: LinearLayout
  private var authCancel: CancellationSignal? = null
  private var earbuds: List<Pair<String, String>> = emptyList()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(48), dp(20), dp(32))
    }
    setContentView(ScrollView(this).apply { setBackgroundColor(Color.WHITE); addView(root) })
    val km = getSystemService(KeyguardManager::class.java)
    if (!km.isDeviceSecure) {
      message("Set a PIN lock first", "This only makes sense when the phone has a PIN lock. Set one in Settings > Lock screen, then come back.")
      return
    }
    message("Checking it's you", "Confirm with your fingerprint, face or PIN.")
    authenticate()
  }

  override fun onDestroy() {
    authCancel?.cancel()
    super.onDestroy()
  }

  private fun authenticate() {
    val cancel = CancellationSignal().also { authCancel = it }
    val prompt = BiometricPrompt.Builder(this)
      .setTitle("Set up Bobby's unlock")
      .setSubtitle("Prove it's you before changing how Bobby unlocks your phone")
      .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
      .build()
    prompt.authenticate(cancel, mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = form()
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
        message("Not confirmed", "Nothing was changed. (${errString ?: "cancelled"})")
      }
    })
  }

  // --- UI ---

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

  private fun title(text: String) = TextView(this).apply {
    this.text = text; textSize = 24f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.rgb(27, 22, 64))
  }

  private fun body(text: String, color: Int = Color.rgb(68, 68, 68)) = TextView(this).apply {
    this.text = text; textSize = 15f; setTextColor(color); setPadding(0, dp(8), 0, dp(4))
  }

  private fun heading(text: String) = TextView(this).apply {
    this.text = text; textSize = 17f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.rgb(27, 22, 64))
    setPadding(0, dp(20), 0, dp(4))
  }

  private fun button(text: String, onClick: () -> Unit) = Button(this).apply {
    this.text = text; isAllCaps = false; setOnClickListener { onClick() }
  }

  private fun field(hint: String, type: Int) = EditText(this).apply {
    this.hint = hint
    inputType = type
    // Keep keyboards from learning or suggesting what's typed here.
    importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    imeOptions = imeOptions or android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
  }

  private fun message(head: String, text: String) {
    root.removeAllViews()
    root.addView(title(head))
    root.addView(body(text))
    root.addView(button("Close") { finish() })
  }

  private fun form() {
    root.removeAllViews()
    val st = UnlockVault.status(this)
    root.addView(title("Bobby's unlock"))
    root.addView(body(
      "When your phone is locked and your earbuds are connected, hold the side button and say your phrase. " +
        "Bobby then types your PIN on the lock screen, once. If that ever fails, he stops trying until you set it up here again.",
    ))
    if (st.setUp) {
      val state = if (st.armed) "On, with ${st.earbuds}." else "Off: ${st.disarmedReason.ifEmpty { "disarmed" }}. Save again to turn it back on."
      root.addView(body(state, if (st.armed) Color.rgb(34, 165, 89) else Color.rgb(194, 65, 12)))
    }

    root.addView(heading("Your phone's PIN"))
    root.addView(body("The same PIN you use on the lock screen. It's encrypted with a key that never leaves this phone, and it's never shown again."))
    val pin = field("PIN", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
    val pin2 = field("PIN again", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
    root.addView(pin); root.addView(pin2)

    root.addView(heading("Your phrase"))
    root.addView(body("What you'll say, like \"hey, it's James\". Avoid words speech recognition might spell two ways (\"it's\" / \"it is\")."))
    val phrase = field("Phrase", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
    root.addView(phrase)

    root.addView(heading("Your earbuds"))
    val group = RadioGroup(this)
    root.addView(group)
    fun listEarbuds() {
      group.removeAllViews()
      earbuds = LockedUnlock.connectedEarbuds(this)
      if (earbuds.isEmpty()) group.addView(body("No Bluetooth earbuds connected. Connect them, then tap Refresh."))
      earbuds.forEachIndexed { i, (name, _) ->
        group.addView(RadioButton(this).apply { id = 1000 + i; text = name; textSize = 15f })
      }
      if (earbuds.size == 1) group.check(1000)
    }
    listEarbuds()
    root.addView(button("Refresh earbuds") { listEarbuds() })

    val error = body("", Color.rgb(194, 65, 12))
    root.addView(error)
    root.addView(button(if (st.setUp) "Save and turn on" else "Turn on") {
      val a = CharArray(pin.length()).also { android.text.TextUtils.getChars(pin.text, 0, pin.length(), it, 0) }
      val b = CharArray(pin2.length()).also { android.text.TextUtils.getChars(pin2.text, 0, pin2.length(), it, 0) }
      pin.text.clear(); pin2.text.clear()
      try {
        val problem = UnlockLogic.pinProblem(a)
          ?: (if (!a.contentEquals(b)) "The two PINs don't match." else null)
          ?: UnlockLogic.phraseProblem(phrase.text.toString())
          ?: (if (group.checkedRadioButtonId < 1000) "Pick your earbuds (connect them first)." else null)
        if (problem != null) { error.text = problem; return@button }
        val (name, address) = earbuds[group.checkedRadioButtonId - 1000]
        val bytes = ByteArray(a.size) { a[it].code.toByte() }
        try {
          UnlockVault.setUp(this, bytes, phrase.text.toString(), name, address)
        } finally {
          bytes.fill(0)
        }
        phrase.text.clear()
        Hub.log("unlock: set up and armed")
        message("Done", "Bobby's unlock is on, with $name. Lock your phone, hold the side button and say your phrase to try it.")
      } catch (e: Exception) {
        error.text = "Couldn't save: ${e.javaClass.simpleName}"
      } finally {
        a.fill('\u0000'); b.fill('\u0000')
      }
    })

    if (st.setUp) {
      root.addView(heading("Turn off"))
      root.addView(body("Deletes the stored PIN, the phrase and the key that encrypted them."))
      root.addView(button("Turn off and forget") {
        UnlockVault.turnOff(this)
        Hub.log("unlock: turned off")
        message("Turned off", "Bobby's unlock is off and the stored PIN is gone.")
      })
    }
    root.addView(button("Cancel") { finish() }.apply { gravity = Gravity.CENTER })
  }
}
