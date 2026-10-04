# Recorded voiceovers (ElevenLabs)

Drop a recording here and the concept it is named after uses it instead of the built-in voice. A concept with no file here keeps the built-in voice, so recordings can arrive one at a time.

The renderer reads five files per video, `daily-01-brief-room-1.mp3` to `-5.mp3`, one per beat, in beat order. The file name must match the concept id exactly (the number is the day in the daily order). `.wav` and `.m4a` work in place of `.mp3`.

To make them from plain recordings (one `daily-01-brief-room.mp3` per day, no timing markup), run `npx tsx scripts/splitVoiceRecordings.ts <folder>` from `backend/`; it cuts each file at the pauses between sentences, checks every cut against the words, and writes the five parts here. A single file with long pauses between the lines is also accepted if it is placed here as `<planId>.mp3`. The lines to record, and the settings used, are in `docs/VOICE_SCRIPTS.md`. See "Recorded voiceovers" in `docs/VIDEO_FACTORY.md`.
