# Spotify (com.spotify.music)

- **Bottom tabs:** described "Home, Tab 1 of 5", "Search, Tab 2 of 5", "Your Library, Tab 3 of 5", "Premium, Tab 4 of 5". Target them by name, such as `{"text":"Search, Tab"}`. A plain `{"text":"Search"}` can hit something else first. The tab nodes aren't marked tappable (their containers are), but tapping them works. The mini-player bar ("Now Playing Bar") sits just above the tabs while something is playing.
- **Find music:** tap the "Search" tab → tap the field "What do you want to listen to?" → `type` the song, artist or playlist with no `on` → tap the matching row. Chips below the field ("Songs", "Artists", "Playlists", "Albums", "Podcasts") narrow the results.
- **Result rows:** each row holds the title and the kind, such as "Song • Taylor Swift" or "Artist". Tapping a song row plays it. Tapping an artist, album or playlist opens its page.
- **Artist, album or playlist page:** the big green round button near the top is "Play" (its description may be "Play" or "Play playlist"). "Shuffle" sits next to it. Tap "Play".
- **Pause, skip:** the mini-player has "Pause" (or "Play") at its right. Tap the track name on the mini-player to open the full player, with "Previous", "Pause", "Next", "Shuffle" and "Repeat".

## What goes wrong

- On a free account, ads and "Premium" cards pop up. Tap "Dismiss", "Not now" or "Close". Some songs may play shuffled instead of the one asked for; tell the user.
- Never tap "Connect to a device" or "Devices available". It moves the sound to another speaker.
- Home cards are long combined descriptions. Match on the artist or playlist name.
- If nothing plays after "Play", check for a pop-up covering the screen, then read the mini-player.
