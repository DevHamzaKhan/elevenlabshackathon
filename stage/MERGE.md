# Stage: merging into the final app

Stage is not a package, so it adds no code, permissions, config plugins or native settings. The final app picks up files only:

- **Hints:** bundle every `stage/hints/*.md` and give them to the Mind as `hints`. Skip `TO-CHECK.md`: it's a checklist for Hands, not navigation notes.
- **Cursor:** read the folder name in `stage/cursor/CHOSEN` and use `stage/cursor/<name>/cursor.xml` as the cursor drawable (48 dp, 48 x 48 viewport, hotspot at the centre).
- **App icon:** `stage/icon/` once it exists (an Extras item). Until then, keep the default icon.
- **Dashboard:** runs on a laptop, not in the app. See `README.md`.
