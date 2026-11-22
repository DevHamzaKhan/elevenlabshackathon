# Stage: merging into the final app

Stage is not a package, so it adds no code, permissions, config plugins or native settings. The final app picks up files only:

- **Hints:** bundle every `stage/hints/*.md` and give them to the Mind as `hints`. Skip `TO-CHECK.md`: it's a checklist for Hands, not navigation notes.
- **Cursor:** read the folder name in `stage/cursor/CHOSEN` and use `stage/cursor/<name>/cursor.xml` as the cursor drawable (48 dp, 48 x 48 viewport, hotspot at the centre).
- **App icon:** `stage/icon/bobby-icon-1024.png` as `expo.icon`, and `stage/icon/bobby-adaptive-foreground-1024.png` with background `#5B3FE0` as `android.adaptiveIcon`. See `icon/README.md`.
- **Dashboard:** runs on a laptop, not in the app. See `README.md`.
- **Sounds (optional):** `stage/sounds/wake.wav` (session starts), `done.wav` (task done), `failed.wav` (task failed or cancelled). Short, quiet, 22 kHz mono. Play them only if the team wants audio cues besides Bobby's voice.
