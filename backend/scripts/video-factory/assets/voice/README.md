# Recorded voiceovers (ElevenLabs)

Drop a recording here and the concept it is named after uses it instead of the built-in voice. A concept with no file here keeps the built-in voice, so recordings can arrive one at a time.

Two forms, either one:

- `daily-01-brief-room.mp3` -- one file for the whole video: the five lines in order, with a pause of a second or more between them (`<break time="1.0s" />` in the script). The render cuts the file at those pauses and fails, naming what it found, unless it finds exactly five spoken parts.
- `daily-01-brief-room-1.mp3` ... `-5.mp3` -- one file per beat, in beat order.

`.wav` and `.m4a` work in place of `.mp3`. The file name must match the concept id exactly (the number is the day in the daily order). The lines to record are in `docs/VOICE_SCRIPTS.md`. See "Recorded voiceovers" in `docs/VIDEO_FACTORY.md`.
