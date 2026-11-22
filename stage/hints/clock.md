# Clock (Samsung, com.sec.android.app.clockpackage)

Opening it: the icon label is "Clock". It's often in a "Samsung" folder, or in the app drawer.

- **Tabs** along the bottom: "Alarm", "World clock", "Stopwatch", "Timer". Tap a tab by name.
- **New alarm:** "Alarm" tab → tap "Add alarm" (a "+" at the top right) → the time picker shows hour and minute wheels, each an editable field. Tap the hour, `type` the number, then the minute and `type` again. Set "AM" or "PM" if shown. Then tap "Save" at the bottom.
- **Alarm name:** on the same screen, the "Alarm name" field takes text, such as "Gym".
- **Turn an alarm on or off:** each alarm row has a switch at its right edge. Its description includes the time, such as "7:00 AM". Tap the switch, not the row: tapping the row opens it for editing.
- **Timer:** "Timer" tab → hours, minutes and seconds fields → `type` into each → tap "Start".
- **Stopwatch:** "Stopwatch" tab → "Start", then "Lap" or "Stop".

## What goes wrong

- Typing into the time wheels can need a tap first to make them editable. If `type` fails with `not_editable`, tap the number and try again.
- 24-hour phones show no "AM"/"PM". Use 24-hour time.
- After "Save", a short message like "Alarm set for 8 hours from now" shows. That means it worked. Tell the user the time it says.
- Don't delete alarms unless asked. A long press selects rows for deleting. `key back` leaves that mode.
