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
- He stops drafting once his own spend today reaches the daily budget
  (default $3). Only Live Host model calls count; the rest of Growth OS
  has its own limits.
- No financial advice of any kind: he explains how things work and never
  tells a viewer what to do with a trade, a plan or their money. He says
  out loud, when welcoming people and whenever asked for advice, that the
  stream is entertainment and education only.
- He only says the website when the worker states the stream is on
  YouTube (`LIVE_HOST_PLATFORM=youtube`) and TikTok chat is off. On
  TikTok, on both, or when it is not stated, he says the link is in the
  bio.
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

## Welcoming people who join

On TikTok the reader also sees who joins. When nobody is waiting on an
answer and Tilt is not mid-line, he welcomes up to three new arrivals by
name (and "the others" together), at most every 40 seconds. A name that is
hard to say gets his best attempt and a joke about butchering it. Names go
through the same cleaning as chat names; an unsafe one is counted among the
others and never said. Chat always comes first. YouTube does not say who
joins, so there he welcomes people on their first chat message instead.

## Hardening after the first run (2026-10-09)

An independent review before the first public stream found, and this
version fixes: a line could be spoken twice when its confirmation was slow;
a segment that kept failing checks was redrafted on every tick; switching
off did not stop a line already being written or playing; a failed OBS stop
was never retried; the blocked-word and trade-call filters had both false
positives and misses; a message the model ignored could be shown on screen;
and "link in bio" was itself on a shared banned-phrase list. Each has a
regression test in `backend/test/liveHost*.test.ts`.

## Not built yet

- The TikTok LIVE Studio hand-off from OBS.
- A premium voice. The voice is one function in the worker (`synthesize`);
  swapping providers means replacing it and returning word timings.
- Settings for quiet time and daily budget in the app (the API accepts
  them; the tab only edits the YouTube link).
- Viewer-triggered reactions (gifts, likes) and polls.

## Duo mode (TikTok co-host)

TikTok wants a real person present and interacting in a LIVE. Duo mode runs Tilt as a co-host next to you instead
of as a solo, automated host. YouTube stays fully automated; duo mode is for TikTok.

**How it works**

- You are on camera (OBS scene: your camera on one half, the Tilt stage Browser Source on the other, one output).
- You read TikTok chat yourself, in TikTok's app or LIVE Studio.
- You type prompts for Tilt at `http://127.0.0.1:8790/host` (the worker serves it, local only). Two ways to use it:
  - say something to Tilt directly ("Tilt, explain trailing drawdown to them"), and he answers you like a co-host;
  - paste a viewer's question into the box and put their name in "Viewer's name": Tilt answers it for that viewer.
- **Quick prompts**: one-click chips (Tease me, Ask me something, Hype the room, Say it simpler, Hot take, Roast my
  routine) send a ready-made prompt, so you don't have to type mid-stream.
- **Run a segment** button: pick a segment (or leave it on "Next in rotation") and press the button to have Tilt
  run one right now, skipping the quiet-time wait. A typed prompt waiting goes first. The Fillbook spot is not
  offered; the server rations it.
- Tilt speaks only when you send something or press the button. No idle segments, no unprompted welcomes, no spoken line without a
  prompt. The same screening, safety checks, owner switch and firewall rule apply to what you type as to chat.

**Run it**

```
LIVE_HOST_MODE=duo LIVE_HOST_PLATFORM=tiktok LIVE_HOST_COHOST_NAME=Justin npm run live-host
```

(`LIVE_HOST_COHOST_NAME` is what Tilt calls you on stream; default `Host`.) TikTok chat reading in the app can stay
off: duo mode does not need it. No server or database change is required beyond the Live Host migration.

**Limits**

- Duo replies use the fast model and are capped at about 35 words, so the back and forth stays quick.
- Typed prompts only for now (no speech-to-text). One prompt at a time is best; at most 10 wait in the queue.
- Keep the on-screen "AI HOST" label and use TikTok's AI-generated content disclosure if it applies.

## Voice speed

The worker keeps one Python voice helper (`tts_server.py`) running instead of starting Python for every line. Starting
Python and importing `edge_tts` cost 6 to 9 seconds per line on the laptop this was built on (`python -c pass` alone
took about 6). The helper warms up once when the worker starts (the log says "voice helper is warm"), then a line takes
about 2 seconds. If the helper dies, lines fall back to the old one-shot script until it restarts.

## The comedy pass (2026-10-10)

What changed after the first real duo runs, and why:

- **Who said what.** Memory labels your lines ("Justin (CO-HOST...)") and Tilt's own ("Tilt (you)"), and the duo prompt
  lists what the co-host has actually said, word for word. A model that mixed these up told you "you just told me"
  things Tilt himself had said.
- **Nothing invented.** With nothing to quote, a tease goes after the setup (a cartoon candle next to you on camera),
  never a made-up moment.
- **Shape of a line.** React, name one specific absurd detail, turn it; the first five words are the hook; the fact
  comes second and stays small.
- **No copying.** Example lines are exported (`LIVE_HOST_EXAMPLE_LINES`) and a draft that lifts six words in a row from
  one is rejected and rewritten. Keep examples few and varied: whatever topic an example covers becomes an attractor.
- **Not naming the company when asked if he is a bot.** He says he is an AI character built by the people who run the
  stream; naming Fillbook there tripped the promotion rationing check.

## Before you go live: preflight, instant reactions, failure sign

- **`npm run live-host:preflight`** checks the whole chain and prints PASS / WARN / FAIL: the token and secrets
  (never printed), Growth OS login and round trip, tables, pause flag and today's budget, the owner switch, OBS
  connection, the "Tilt Live" scene and "Tilt Stage" source, a camera or capture source, the 1080 x 1920 canvas, the
  stream key, and Python with edge-tts. It changes nothing and does not speak. Run it before every stream.
- **Instant reactions (duo mode).** When you send a prompt, press a quick prompt or run a segment, Tilt says a short
  fixed reaction right away ("Hold on. I have thoughts.") while the real line is being written, then answers. They are
  voiced once at worker start, at most one every 20 seconds, and are fixed text: nothing a model wrote.
- **Failure sign.** If the connection to Growth OS fails three times in a row, the stage shows "Hang on, Tilt lost his
  connection and is finding it again" instead of freezing in silence.

## Run of show (duo mode)

The console now has a show bar at the top:

- **Open the show** starts the stream properly: a joke about the situation first, then who he is and what this is
  (a comedy show about futures trading and prop firm rules, entertainment and not advice, link in the bio on TikTok),
  then he turns to you with a question or a dare.
- **Close the show** is the sign-off: a callback to the funniest thing of the stream, thanks, more next time, and you
  get the last word as a joke or a dare (never a tip).
- A **clock** shows how long you have been on air and how long since the last beat. It suggests "Segment soon" after
  2.5 minutes of nothing and "A segment is due" after 4. These are hints only; nothing runs by itself.

Both beats are normal segments on the server (`show: true` in `liveHostPersona.ts`), so they pass the same checks and
the same firewall rule. They are never part of the idle rotation and do not move it. A suggested shape for a 30 to 45
minute stream: Open the show, two or three quick prompts to settle in, a segment every 4 to 5 minutes (Roast My
Trade and Tilt-o-Meter are the easy ones), a Desk Lesson once, and Close the show.

Known limitation: openings and sign-offs tend to run 55 to 70 words against the 45 asked for, and the "market is
closed, no hands" joke comes up often. Shorten or vary the briefs in the persona file if that bothers you on air.
