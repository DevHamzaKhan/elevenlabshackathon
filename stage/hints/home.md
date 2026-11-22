# Samsung home screen (One UI launcher)

The screen's app is `com.sec.android.app.launcher`. You see it after `key home`.

- **App icons** show up as nodes whose `text` is the app's name under the icon, such as "Gmail", "Messages" or "Chrome". They are tappable. Tap the label to open the app.
- **The dock** is the row at the very bottom (high `top` values, around 2000 to 2300 on a 2400-pixel-tall screen). It holds the same 4 or 5 apps on every page, usually Phone, Messages, Internet or Chrome, and Camera. Check it first.
- **Pages:** the home screen has several pages side by side. To see the next page, `swipe left`. To go back a page, `swipe right`. After each swipe, read the screen again. If the labels didn't change, you're on the last page.
- **Page dots:** a small row of dots above the dock shows which page you're on. It may have a description such as "Page 2 of 3". Use it to know how many pages are left.
- **Folders** look like an app icon with a name such as "Google" or "Social". Gmail is often inside a folder named "Google". Tap the folder name to open it. Its apps then show up as nodes over the home screen. Tap the app inside. If the app isn't there, `key back` closes the folder.
- **App drawer** (every installed app, A to Z): from the home screen, `swipe up` from the middle of the screen. It has a search field at the top ("Search" or "Search phone"). Use it as a fallback when the app isn't on any home page.
- **Widgets** (clock, weather, Google search bar) also show up as nodes. Ignore them. Tapping the Google search bar opens a search, not an app.

## What goes wrong

- A swipe that starts on a widget can scroll the widget instead of changing the page. If the screen didn't change, swipe again from another spot, such as `{"x":540,"y":1500}`.
- `swipe down` on the home screen opens the notification shade. `key back` closes it.
- A long press opens an edit menu ("Remove", "Select", "Edit"). If you see those words, `key back`.
- Labels can be cut short ("Messa…"). Match on the start of the name.
- If the screen shows a lock screen, or anything that isn't the launcher after `key home`, say so. Don't try to unlock it.
