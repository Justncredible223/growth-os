# Operations: running, controlling and checking the stream

## Start (solo YouTube, vertical)
1. `cd backend`, set `LIVE_HOST_PLATFORM=youtube` (optional: `LIVE_HOST_LAYOUT=wide` for 16:9, `LIVE_HOST_RECORD=on` to record in OBS, `LIVE_HOST_CONTROL_TOKEN=<random>` to require a token on the control panel).
2. `npm run live-host:setup-obs`, then `npm run live-host:preflight`, then `npm run live-host:supervised`.
3. Flip the Live Host switch ON in the app. The worker starts the OBS stream.

## Operator control panel: http://127.0.0.1:8790/control
Local only (bound to 127.0.0.1, host and origin checked, custom header required, optional shared token).

| Control | What it does |
|---|---|
| Pause / Resume | No new line is voiced or drafted while paused (no model spend). |
| Mute / Unmute | Mutes the stage audio; captions keep running. |
| Interrupt current | Cuts the line being spoken; reported as dropped. |
| Skip segment | Interrupts, or drops the line that is waiting. |
| Chat replies off / on | Chat is still stored but not answered. |
| Promos off / on | No unprompted Fillbook mention or spot; a viewer who asks still gets an answer. |
| Next topic | Runs a chosen segment now. |
| Emergency stop | Silences, stops the OBS stream, stays paused. Nothing restarts it until Resume. |

`GET /health` (same guard) returns status (`ok`, `off`, `degraded`, `no-stage`, `emergency-stopped`), seconds since the last good tick, failures in a row, OBS connection, spend today, the current line.

## Failure behavior
- Server not answering: tick retries with exponential backoff (1.5 s doubling, ceiling 30 s). After 3 failures the stage shows "Technical interruption, Tilt will be right back".
- Stage lost: the page shows the same overlay; the worker asks OBS to reload the source every 15 s.
- A line that fails to voice stays queued on the server and is retried; after 3 failures it is dropped.
- The stream is never reported live by the worker when the switch is off or after an emergency stop.
- Known gap: stopping the supervisor with TaskStop on Windows leaves child node processes. Stop the whole process tree, and switch the app OFF first.

## Pre-broadcast checklist
- [ ] Title, description, category (Education), language, audience set; link in description is the tracked link (see ATTRIBUTION.md)
- [ ] Live link pasted in the app (More, Live Host) so chat is read
- [ ] Preflight shows no FAIL; OBS "Tilt Stage" source loads; stage shows no "off air" overlay
- [ ] Control panel opens; Pause then Resume works; Mute works
- [ ] Open the stream on a phone (YouTube app) and a desktop: captions and footer clear of the chat overlay
- [ ] Recording on if you want clips (`LIVE_HOST_RECORD=on`)
- [ ] Daily budget and cost mode set (balanced by default)

## Post-broadcast checklist
- [ ] Switch OFF; confirm OBS stopped; end the broadcast in Studio if it did not auto-end
- [ ] `npm run live-host:report` and fill in the platform numbers
- [ ] `npm run live-host:clips -- --session <id> --recording <file>` and review `queue.json`
- [ ] Note what to change next time in the report

## Staging / unlisted smoke test
Run an Unlisted broadcast for 20 minutes with one other account in chat:
1. Desktop and phone playback; audio/video in sync; captions readable; nothing under the phone chat overlay.
2. Type a question: comment appears on stage within about 6 s, answer starts soon after, never cut mid-sentence.
3. Type "dance": instant move, no spoken reply.
4. Two accounts chat for a few minutes: the rundown segments start at a calm pace; one account alone gets answers only.
5. Control panel: pause, mute, interrupt, skip, chat off, promos off, emergency stop, resume.
6. Kill the network for 30 s: overlay appears, recovery without a restart.
7. Click the description link: lands on the site with UTMs; check the visit in site analytics.
8. Recording and clip queue produced.

## Clip workflow
Nothing is published automatically. `queue.json` entries are `pending_approval`. Caption timing is estimated from word count: check each SRT against the video. Lines that name a viewer or contain figures are flagged.
