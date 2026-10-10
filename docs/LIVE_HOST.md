# Live Host

Tilt is an AI character who hosts Fillbook's live streams. He reads chat and
answers out loud, runs short segments when chat is quiet, and mentions
Fillbook sparingly. He is openly an AI and openly a cartoon: a candlestick
who lives in a trading journal and has read every blown-account story.

Built 2026-10-09 at the owner's request. This is the one owner-approved
exception to the External Write Firewall; read the "Live Host exception"
section of `docs/EXTERNAL_WRITE_FIREWALL.md` before changing anything here.

## How it fits together

```
Growth OS app (phone)        Growth OS backend (Vercel)            Owner's PC
---------------------        --------------------------            ----------
Live Host tab                /api/approvals?resource=live-host     npm run live-host (worker)
  switch on/off  ---------->   switch + settings (app token only)    |  ticks every 3s
  watch the feed <----------   status + feed                         |
                               tick: chat in, ONE line out  <--------+
                                 - reads YouTube chat (official API)
                                 - drafts the line (Claude)          worker turns the line into
                                 - guardrails + brand rules          speech (edge-tts) and sends
                                 - firewall: authorizeLiveHostSpeech it to the stage page
                                 - records it                                |
                                                                     stage page (Tilt, captions)
                                                                             |
                                                                     OBS Browser Source -> stream
```

- **The server decides what is said.** The worker holds only the automation
  token, which can tick and confirm lines. It cannot flip the switch or
  change settings, and it never writes text itself.
- **The switch is the authority.** Speech is only authorized while
  `live_host_settings.desired_state = 'on'` and the system is not paused.
  Switching off ends the session and drops anything queued.
- **Everything is recorded.** Every chat message (with what became of it)
  and every line is in `live_host_messages` / `live_host_utterances` and in
  the app's Live Host tab. Every authorization is in `audit_logs`.

## Code map

| Piece | Where |
|---|---|
| Character, voice rules, segments | `backend/src/liveHost/liveHostPersona.ts` |
| Input and output safety checks | `backend/src/liveHost/liveHostGuardrails.ts` |
| Prompt and model call | `backend/src/liveHost/liveHostWriter.ts` |
| Switch, status, tick, confirm | `backend/src/liveHost/liveHostHandlers.ts` |
| HTTP routing and token rules | `backend/src/liveHost/liveHostApi.ts` (routed from `api/approvals.ts`) |
| Firewall exception | `backend/src/firewall/externalWriteFirewall.ts` |
| YouTube chat (read-only) | `backend/src/signals/adapters/youtubeLiveChatAdapter.ts` |
| Tables | `backend/src/db/migrations/0049_live_host.sql` |
| PC worker | `backend/scripts/live-host/worker.ts`, `obsClient.ts` |
| What viewers see | `backend/scripts/live-host/stage/index.html` |
| App tab | `android/.../ui/screens/LiveHostScreen.kt`, `data/LiveHostModels.kt` |

## What Tilt will and will not do

Enforced in code (guardrails, then the firewall), not only in the prompt:

- No trade calls, entries, stops, targets or market predictions.
- No guarantees or promises of passing, payouts or profit.
- No personal trading stories. The brand rule "Fillbook must never speak or
  be shown as if it personally trades" applies to him: his lore is that he
  has READ every blown account, never that he traded.
- Product claims only from verified knowledge, and never the blocked
  "real time / live tracking / any broker / before a breach" wording.
- No links except fillbookhq.com. Links in chat are stripped before the
  model sees them.
- Viewer names are cleaned before they are stored, shown or spoken; an
  unsafe name becomes "friend".
- Messages with slurs, attempts to instruct the host, or off-limits topics
  (politics, religion and similar) are marked blocked and never reach the
  model.
- Fillbook is mentioned in at most one of the last six lines unless a
  viewer asks about it. The explicit "what Fillbook is" segment runs at
  most every 12 minutes and never in a stream's first 4 minutes.
- He stops drafting once today's recorded spend reaches the daily budget
  (default $3, all Growth OS features combined).
- He never types in chat. Posting a chat message would be an
  `EXTERNAL_WRITE` and stays rejected.

The stage shows an "AI HOST" badge and a permanent line: "Tilt is an AI
character. Education and entertainment only, not financial advice."

## Setup (owner steps)

1. **Database.** Run `backend/src/db/migrations/0049_live_host.sql` in the
   Supabase SQL editor. Until then the app tab says "isn't set up yet".
2. **Server env (Vercel).** `APP_API_TOKEN_AUTOMATION` (32+ characters) must
   be set; the worker uses it. `YOUTUBE_API_KEY` must be set for YouTube
   chat. `ANTHROPIC_API_KEY` is already used by the rest of Growth OS.
3. **App.** Rebuild and install the Android app (JDK 17 to 21). Live Host is
   in the More sheet.
4. **OBS on the PC.** Install OBS Studio 28 or newer.
   - Tools > WebSocket Server Settings: enable it and set a password.
   - With OBS open, run `npm run live-host:setup-obs` in `backend/`. It sets
     the canvas to 1080 x 1920, and creates the "Tilt Live" scene with a
     "Tilt Stage" Browser Source pointing at `http://127.0.0.1:8790/` with
     its audio routed through OBS. Safe to run again.
   - Settings > Stream: choose the service and paste the stream key
     yourself. Neither script ever sees a stream key.
5. **Worker env** in `backend/.env.local` (loaded automatically by both
   npm scripts): `GROWTH_OS_AUTOMATION_TOKEN`,
   `GROWTH_OS_PROTECTION_BYPASS_SECRET`, `OBS_WEBSOCKET_PASSWORD`. Set
   `LIVE_HOST_OBS_STREAM=off` to start and stop the stream in OBS by hand;
   the worker still reloads the stage page in OBS when it starts. See
   `backend/.env.example`.
6. **Go live.** In `backend/`: `npm run live-host`. Create the live stream
   on YouTube, paste its link into the app's Live Host tab, then flip the
   switch. Flip it off to stop.

To look at the stage without any of that: open
`backend/scripts/live-host/stage/index.html?demo=1` through any local web
server. It plays a scripted run with no audio and no network.

## Platforms

- **YouTube Live:** supported. Chat is read through the official Data API
  with the existing API key. `liveChatMessages.list` costs 5 quota units and
  is polled at most every 10 seconds, which is about five and a half hours
  of chat reading per day on the default 10,000-unit quota.
- **TikTok LIVE:** @fillbookhq can go live but has no stream key ("Stream
  keys are for certain verified accounts only"), so the picture has to go
  out through TikTok LIVE Studio on the PC, capturing the OBS scene. That
  hand-off is not set up or tested yet.
- **TikTok chat (owner decision, 2026-10-09):** TikTok has no official API
  for LIVE chat (`docs/TIKTOK_COMMENTS_BLOCKED.md`). The owner chose, with
  the risks explained, to read it through the unofficial
  `tiktok-live-connector` library. How that is contained:
  - It is off until the owner turns on **TikTok chat** in the app's Live
    Host tab and enters the username. The server ignores TikTok messages
    while it is off, and the worker only connects when the server says so.
  - `backend/scripts/live-host/tiktokChat.ts` only listens. It has no
    login, never posts, and a test asserts it contains no send call.
  - The library is AGPL-licensed and is not a dependency of this project.
    Install it on the streaming PC only:
    `npm run live-host:install-tiktok-reader` (run it again after any
    `npm ci`, which removes it).
  - While TikTok chat is on, Tilt says "link in bio" and a guardrail
    rejects any line that names the website, because TikTok's LIVE rules
    list directing viewers off-platform as a violation.
  - Known risks: it is outside TikTok's terms, it breaks when TikTok
    changes things, and it relies on a third-party signing service. When it
    cannot connect, Tilt keeps running segments without TikTok chat.
  - Not yet tried against a real TikTok LIVE.
- Streaming to both at once needs an OBS multi-output plugin or a restream
  service; OBS alone sends to one destination.

Platform rules worth knowing before the first stream (researched
2026-10-09, mostly from secondary sources, so re-check them): TikTok
discourages unattended or faceless LIVEs and may withhold them from
recommendation; both platforms require labelling of realistic synthetic
media (a cartoon is arguably outside that, the synthetic voice is a grey
area, hence the on-screen AI badge); trading content draws extra scrutiny.

## Cost

One Claude call per spoken line (Sonnet, cached system prompt), plus up to
two retries when a line fails a check. Voice is free (edge-tts). The daily
budget setting is the hard stop. Not yet measured on a real stream.

## Not built yet

- Greeting TikTok viewers as they join (the reader only passes chat on).
- The TikTok LIVE Studio hand-off from OBS.
- A premium voice. The voice is one function in the worker (`synthesize`);
  swapping providers means replacing it and returning word timings.
- Settings for quiet time and daily budget in the app (the API accepts
  them; the tab only edits the YouTube link).
- Viewer-triggered reactions (gifts, likes) and polls.
