# Google Maps (com.google.android.apps.maps)

- **Main screen:** the search box at the top reads "Search here". To its right are a microphone ("Voice search") and the account picture. Below it is a row of chips ("Restaurants", "Coffee", "Gas", "Groceries"). The bottom tabs are "Explore", "You" and "Contribute".
- **Find a place:** tap "Search here" → `type` the search, such as "coffee near me" → `key enter`. A list of results slides up from the bottom. Each row has the name, rating, distance and whether it's open.
- **Open a place:** tap its name. A sheet shows its details with buttons "Directions", "Start", "Call", "Save" and "Share". The address and opening hours are further down; `swipe up` on the sheet to read them.
- **Directions:** on a place's sheet, tap "Directions" → pick the travel mode from the row of tabs ("Driving", "Transit", "Walking") → the route and time show at the bottom. Only tap "Start" if the user asked to be navigated there.
- **Back to the map:** `key back` closes a place, then clears the search. One more `key back` leaves Maps.

## What goes wrong

- The map itself is one big view with no labels. Never tap the map. Work with the search box, the chips and the results list.
- The results list starts half open. `swipe up` on it to see more rows, `swipe down` to see the map.
- Results marked "Sponsored" or "Ad" come first. Skip them unless the user named that place.
- Location prompts ("Turn on location accuracy", "Allow Maps to access this device's location?"): tap "While using the app" or "No thanks". Never change other settings.
- If the user said a place name, check the result's name and area match it before giving directions or calling.
