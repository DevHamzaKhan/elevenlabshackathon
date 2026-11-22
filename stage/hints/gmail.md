# Gmail (com.google.android.gm)

Labels checked on the S21 (One UI, Android 15).

- **Inbox:** the top search field is an empty field whose hint is "Search in mail". `{"text":"Search in mail"}` still finds it. To its left is "Open navigation drawer". To its right is the account picture ("Signed in as …"). Bottom right is a "Compose" button. The tab bar at the bottom has "Mail" and "Meet". Stay on "Mail".
- **Email rows:** each row is one tappable node whose text is "Sender, Subject, preview…" (such as "Sarah Chen, Running late, can we push to 3?"). Inside it are separate, non-tappable text nodes for the sender, subject and preview. The newest email is at the top. Tap the row by the sender's name, such as `{"text":"Sarah Chen"}`.
- **Open email:** the sender is near the top, with a small "Reply" icon beside it. Before replying, check that the sender is the person the user named. At the bottom of the message are "Reply" and "Forward". "Reply all" is not there: it's under "More options". On a long email you may need to `swipe up`. Top right are "Archive", "Delete", "Mark unread" and "More options".
- **Reply:** open the email → tap "Reply" → the message body gets the focus by itself → `type` the text with **no `on`** → tap "Send" (top right, description "Send"). The subject shows "Re: <subject>". The body has no label, so never target it by text.
- **New email:** tap "Compose" → in the "To" field, type a name or address, then tap the suggested contact → tap "Subject" and type → tap below the subject to focus the body and type → tap "Send".
- **Search:** tap "Search in mail" → type the search → `key enter` → the results list.

## What goes wrong

- The keyboard can hide "Reply", "Forward" and the bottom of the body. "Send" is always at the top, so it stays reachable. If you need something under the keyboard, `key back` once to hide it.
- An email that's part of a conversation opens the whole thread. "Reply" answers the last message.
- Suggested-reply buttons ("Sounds good!", "Thanks!") sit near "Reply". Don't tap them unless one says exactly what the user wants.
- Several accounts: the account picture switches between them. Check you're in the right inbox before searching.
- After sending, a "Sent" message with "Undo" shows for a few seconds. Never tap "Undo".
- **Throwing away a reply:** "More options" → "Discard". `key back` can save a draft instead. Only discard if the user cancelled. Never leave drafts behind.
