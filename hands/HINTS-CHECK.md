# Hints check on the S21 (One UI, Android 15)

Checked 2026-11-22 against `stage/hints/TO-CHECK.md`, with `drive.mjs` `screen` (read only) on each app's start screen.
"hint" means the label is an empty field's hint text: Hands reports it as an extra `hint` field (text is ""), and `{text}` targets match it after text/desc.

## Gmail (com.google.android.gm)
- Search field "Search in mail": **confirmed**, but it's an EditText with that as its **hint** (text is empty), not a text label.
- Compose FAB: **confirmed**, Button with text "Compose".
- "Open navigation drawer" desc: **confirmed**. Account avatar desc "Signed in as <name> <email> Account…": **confirmed**.
- Email row: **one combined node** per row, a tappable FrameLayout whose text is "Sender, Subject, snippet…" (e.g. "Hamza Khan, yo, 12:00 p.m."), with separate non-tappable TextViews for sender, subject and snippet inside it. Matching on the sender name finds the row.
- Open email: bottom "Reply" and "Forward" are text labels on tappable rows. There is **no "Reply all" button** at the bottom (it's in "More options"). Header row has a "Reply" icon (desc) next to the sender. Top icons "Archive", "Delete", "Mark unread", "More options": **confirmed**.
- Reply body: **wrong**. There is no "Compose email" label. The body is a WebView, which becomes an unlabeled EditText once it has focus; it gets focus by itself after tapping Reply, so `type` with no target works. The subject field shows "Re: <subject>".
- Send: **confirmed**, Button desc "Send" at top right.
- After send: **confirmed**, snackbar "Sent" with "Undo".
- Discard a reply: "More options" → "Discard" (a menu row; "Save draft" is disabled until there's text).
- Bottom tab bar shows "Mail, More than 99 new notifications" and "Meet".

## Messages
- Default SMS app: **Google Messages** (`com.google.android.apps.messaging`). Samsung Messages is also installed.
- Start chat FAB: **confirmed**, Button text "Start chat". There's also a "Gemini" FAB above it.
- Top: "Search messages" (button desc), account avatar "Signed in as …".
- Conversation rows: "Conversation Icon" avatars with name/snippet/date TextViews; the list is a RecyclerView desc "Conversation list".
- Field hint and send button inside a chat: **not checked** (needs opening a conversation).

## WhatsApp (com.whatsapp)
- Bottom tabs "Chats" (desc "Chats, N new notifications"), "Updates", "Communities", "Calls": **confirmed**.
- FAB desc "New chat": **confirmed**.
- Search: **confirmed** as the bar "Ask Meta AI or Search" (no separate "Search" icon).
- Chat rows: avatar ImageView desc "<name> picture", name TextView, date, snippet, "N unread message(s)".
- Chat field / send / mic: **not checked** (needs opening a chat).

## Chrome (com.android.chrome)
- Address bar: **at the top** on the New Tab page; EditText with hint **"Search Google or type URL"** (**wrong**: not "Search or type web address").
- Tab switcher: **wrong**, desc is "See N tabs" (e.g. "See 16 tabs"), not "Switch or close tabs".
- Menu desc "Customize and control Google Chrome": **confirmed**.
- Also: "Open the home page", "New Incognito tab", "Start voice search", "Ask AI Mode", Lens button.

## Maps (com.google.android.apps.maps)
- Search box "Search here": **confirmed** (EditText desc "Search here").
- Bottom tabs "Explore", "You" (desc may add "New updates in You"), "Contribute": **confirmed**.
- Category chips: "Restaurants", "Coffee", "Groceries", "Home".
- Place sheet "Directions"/"Call"/"Start": **not checked** (needs a search).

## Spotify (com.spotify.music)
- Installed: **yes**.
- Tabs: **confirmed with different labels**, desc "Home, Tab 1 of 5", "Search, Tab 2 of 5", "Your Library, Tab 3 of 5", "Premium, Tab 4 of 5". The tab nodes themselves aren't marked tappable (their parents are), but tapping the matched node's centre works.
- Mini-player: "Now Playing Bar", play button desc "Play" (**confirmed**), "Connect to a device".
- Search field "What do you want to listen to?": **not checked** (needs the Search tab).

## Settings (com.android.settings)
- Search icon: **wrong**, desc is "Search settings" (a "contains" match on "Search" still finds it).
- Section names on this One UI: "Connections" (subtitle "Wi-Fi • Bluetooth • SIM manager"), "Modes and Routines" (subtitle "Modes • Routines"), "Sounds and vibration", "Notifications": **confirmed**. "Display" is further down the list (not on the first screen).
- Toggle rows' own switch nodes: **not checked**.
