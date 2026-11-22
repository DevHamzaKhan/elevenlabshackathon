# Chrome (com.android.chrome)

Samsung phones also ship "Internet" (com.sec.android.app.sbrowser). It works much the same; use whichever browser the user named.

- **Address bar** (checked on the S21): at the top. Empty, it's a field whose hint is "Search Google or type URL". `{"text":"Search Google or type URL"}` finds it, and so does `{"text":"Search Google"}`. With a page open, it shows the page's address. To its right are the tabs button, whose description is "See N tabs" (such as "See 16 tabs", so match `{"text":"tabs"}`), and "Customize and control Google Chrome" (the three dots menu). The new tab page also has "Start voice search", "Ask AI Mode", a Lens button and "Open the home page". Ignore those unless asked.
- **Search or open a site:** tap the address bar → `type` the search or the address with no `on` → `key enter`.
- **Results and pages:** a web page's links show up as nodes with their visible text. Tap the title of a result or the words of a link, such as `{"text":"Opening hours"}`. To read further down, `swipe up`.
- **Go back a page:** `key back`.
- **New tab, bookmarks, history:** tap "Customize and control Google Chrome" → "New tab", "Bookmarks" or "History".

## What goes wrong

- Many web buttons have no label. Tap the visible text next to them, or the link text. If nothing on screen fits, say so rather than tapping a pixel at random.
- Cookie banners ("Accept all", "Reject all") cover the page. Tap "Reject all" if it's there, otherwise "Accept all".
- "Sign in to Chrome", "Open in app?" and notification prompts: tap "No thanks", "Stay in Chrome" or "Use without an account".
- The address bar hides while you scroll down. `swipe down` a little to bring it back.
- The keyboard covers the bottom half of the page. `key back` once hides it. A second `key back` leaves the page.
