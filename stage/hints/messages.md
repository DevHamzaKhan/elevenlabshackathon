# Messages (com.google.android.apps.messaging or com.samsung.android.messaging)

On the S21 the default is **Google Messages** (`com.google.android.apps.messaging`). Samsung Messages is also installed. The `app` field of the screen tells you which one is open. Labels are close in both.

- **Conversation list:** one row per person, holding the name and the last message. The newest is at the top. Tap a row by the name, such as `{"text":"Sarah Chen"}`. At the top are "Search messages" and the account picture. The new-message button is bottom right: "Start chat" in Google Messages, "Compose new message" (a pencil) in Samsung Messages. Google Messages also has a "Gemini" button just above "Start chat". It's a chatbot, so never tap it.
- **Open conversation:** messages fill the screen, newest at the bottom. The text field is at the bottom. In Google Messages it's a field whose hint is "Text message" for SMS (checked on the S21), or "RCS message" / "Chat message" for chat. In Samsung Messages it's "Enter message". The send button is to its right and only appears once there's text. Its description is "Send SMS" for SMS (checked), so target `{"text":"Send"}`. Around the field are "Show attach content screen", "Show attach emoji and stickers screen" and "Show attach media screen". Don't tap those.
- **Text someone you've texted before:** tap their row → tap the text field → `type` the text → tap the button whose description starts with "Send".
- **Text someone new:** tap "Start chat" (or "Compose new message") → `type` the name into the "To" field → tap the matching contact → tap the text field → `type` → tap "Send".

## What goes wrong

- Before you type, the send spot holds a microphone ("Show record a voice message screen"). Tapping it records audio. Only tap "Send" after the text is in.
- A contact with several numbers shows a list ("Mobile", "Home", "Work"). Pick "Mobile".
- "Set as default SMS app?", "Turn on chat features" and similar cards: tap "Not now" or "Cancel". Never change defaults.
- `key back` with text in the field leaves it as a draft. Send it, or clear it if the user cancelled.
- Check the name at the top of the conversation before sending. Groups and contacts can share first names.
