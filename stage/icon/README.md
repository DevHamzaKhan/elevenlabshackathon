# Bobby app icon

Matches the chosen `ring` cursor: the ring as Bobby's "eye on the screen", with voice arcs either side because he talks while the cursor works.

| File | Use |
|---|---|
| `bobby-icon.svg` / `bobby-icon-1024.png` | The app icon (`expo.icon` in `app.json`). |
| `bobby-adaptive-foreground.svg` / `bobby-adaptive-foreground-1024.png` | Android adaptive icon foreground, transparent. Pair with background colour `#5B3FE0`. |

Everything sits inside the central 66% circle, so Android's adaptive-icon masks never clip it.

In the final app's `app.json`:

```json
"icon": "../stage/icon/bobby-icon-1024.png",
"android": { "adaptiveIcon": { "foregroundImage": "../stage/icon/bobby-adaptive-foreground-1024.png", "backgroundColor": "#5B3FE0" } }
```

Regenerate the PNGs after editing an SVG: `cd stage && npm install && node tools/icon.mjs` (uses the installed Chrome).
