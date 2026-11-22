# Google Maps (com.google.android.apps.maps)

- Main screen: search box at the top, text "Search here"; right of it "Voice search" and the account avatar. Category chips below ("Restaurants", "Coffee", "Gas", …). Bottom tabs: "Explore", "You", "Contribute". A "Directions"/"Go" button may float bottom right; "Re-centre"/"Your location" button above it.
- **Search a place**: tap "Search here" → `type` the query (e.g. "coffee near me") → key `enter` (or tap the first suggestion row) → results list slides up from the bottom.
- Results: each row has the place name, rating, distance, open/closed; buttons per row "Directions", "Call", "Website", "Save" (some only on the place page).
- **Open a place**: tap its name → place sheet with "Directions", "Start", "Call", "Save", "Share".
- **Directions**: place sheet → "Directions" → choose mode tab ("Driving", "Transit", "Walking") → "Start". Only tap "Start" if the user asked to navigate.

What goes wrong:
- The map itself is one big unlabelled view. Never tap the map; work with the search box, chips and the results list.
- The results sheet is half-height; swipe `up` on it to see more rows, `down` to show the map.
- Location permission/"Turn on location accuracy" dialogs: tap "Only this time"/"While using the app" or "No thanks"; never change system settings.
- Sponsored results ("Ad") appear first; prefer the first non-ad result unless the user named a place.
- After searching, `back` clears results; a second `back` leaves Maps.
