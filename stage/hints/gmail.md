# Gmail (com.google.android.gm)

- **Inbox**: top bar is a search field labelled "Search in mail"; left of it "Open navigation drawer" (hamburger); right of it the account avatar ("Signed in as … Account and settings"). Bottom right: big "Compose" button (extended FAB).
- **Email list rows**: each row's text/desc includes sender, subject and snippet, often as one long description ("Sarah Chen, Running late, …, Unread"). Tap the row (match on the sender name) to open it. Newest is at the top.
- **Open email**: sender name and subject near the top. At the bottom of the message: "Reply", "Reply all", "Forward" buttons (may need a swipe up on long emails). Top-right icons: "Archive", "Delete", "Mark unread", "More options".
- **Reply to an email**: open it → tap "Reply" → the body field (hint "Compose email") gets focus → `type` the text → tap "Send" (paper-plane, top right, desc "Send").
- **New email**: "Compose" → "To" field: type the address or name, then tap the suggested contact row → tap "Subject" → type → tap "Compose email" body → type → "Send".
- **Search**: tap "Search in mail" → type the query → key `enter` → results list.

What goes wrong:
- The keyboard covers "Reply"/"Forward" chips and the bottom of the body; "Send" is always at the top, so it stays reachable. Press `back` once to hide the keyboard if you need something below it.
- Opening an email from a conversation with several messages shows the thread; "Reply" applies to the last message.
- "Smart Reply" chips ("Sounds good!", etc.) sit above Reply. Don't tap them unless they match exactly what the user wants.
- A first-run "Meet"/"Chat" tab bar may show at the bottom ("Mail", "Meet"). Stay on "Mail".
- Multiple accounts: the avatar switches accounts. Check you are in the right inbox before searching.
- After Send, a snackbar "Sent" with "Undo" appears for a few seconds. Don't tap Undo.
- Discard prompts ("Discard draft?") on `back` from a compose screen: only discard if the user cancelled.
