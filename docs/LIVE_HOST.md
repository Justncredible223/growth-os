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

## Voice input (duo mode)

You can talk to Tilt instead of typing. The console has a **Hold to talk** button (or hold **Space** while the cursor
is not in a text box):

- Hold, speak, release: what you said is sent as a prompt, the same as a typed one (same screening, same firewall,
  the instant reaction plays, the line is drafted). **Esc** while holding throws it away.
- It uses the browser's own speech recognition, so it is free and there is nothing to install. It works in Chrome and
  Edge. The browser asks for the microphone once for `127.0.0.1:8790`. Note the browser's speech service processes the
  audio, so do not say anything you would not want leaving the machine.
- It is push to talk on purpose: it only listens while you hold, so it never picks up Tilt's own voice from the
  speakers or the room, and nothing is sent that you did not just say.
- Tilt is told the words may be a transcript, so a misheard word is taken in its most likely meaning.

Not built: always-on listening and a wake word (they would hear his own voice and the stream audio), and offline
recognition (Whisper) which would need a heavy install and is slow on the laptop this was built on.

## Length limits

Voicing time grows with length (a 65-word opening took 7.2 seconds to voice), and a long line loses the room, so the
length is enforced in code (`liveHostLength.ts`) and not just asked for in the prompt:

| Line | Limit |
|---|---|
| Join welcome | 40 words |
| Opening / sign-off | 60 words |
| Duo reply to the co-host | 55 words |
| Duo segment | 60 words |
| Solo segment | 60 words |
| Solo reply to chat | the 420-character limit only |

A draft over its limit is sent back once with the count. If it is still over, whole sentences are dropped, middle
first: the first sentence (the hook) and the last (the turn back to the co-host or chat) are kept, and a sentence with
the "entertainment, not advice" disclaimer is never dropped, so a trimmed line can stay a little over the limit
rather than lose it. A trimmed line goes through the same checks as any other before it is spoken.

## Tilt reacts to the co-host (duo mode)

While you talk, he looks like he is listening:

- **Listening** (you hold the talk button): his eyes widen and go to where you are, he leans toward you and tilts
  his head a little, and he nods about once a second while words are coming in.
- **Thinking** (the moment you release, or press a quick prompt, a segment or the show buttons): his eyes go up and
  away, one brow drops and his head tilts, until his line starts.
- It only shows while he is not talking himself, it eases in and out, and a missed "idle" times out (25 seconds for
  thinking, 70 for listening) so he can never be left staring at you.

Set where you are relative to him with `LIVE_HOST_COHOST_SIDE` = `left`, `right` or `down` (default `down`, the camera
feed at the bottom of the frame). Reactions are sent from the console to the worker's `/react` route (same local-only
trust check as `/ask`) and on to the stage.

## First solo YouTube stream: runbook

Solo means nobody is on camera and nobody types prompts: Tilt runs the show by himself, reading YouTube chat.

**What is different from TikTok / duo**

- `LIVE_HOST_PLATFORM=youtube` and `LIVE_HOST_MODE` left unset. An explicit `youtube` is authoritative: he may say
  "fillbookhq dot com" even if the TikTok chat setting is on in the app, and the TikTok chat reader is never started.
- The stage must be pointed at the YouTube layout (no TikTok safe zones, no hands bit): re-run setup with the platform
  set. `npm run live-host:preflight` fails if the OBS stage source is on the wrong layout.
- No "hands" jokes on screen (there are none on YouTube).
- Opens the room for the first 6 minutes even before anyone has chatted (YouTube cannot tell him who is watching);
  after that he follows the owner rule again and is quiet until someone says something. `LIVE_HOST_IDLE_SEGMENTS=on`
  makes him run segments regardless.
- He never mentions a giveaway, a prize or anything to enter, and neither confirms nor denies one if asked.

**Before the stream**

1. YouTube Studio: create the live (Go live, Stream), live chat on, not made for kids. Put the stream key in OBS under
   Settings, Stream (YouTube, RTMPS). Copy the live's link.
2. Growth OS app, More, Live Host: paste the link into the YouTube live link field. Without it he cannot read chat.
3. In a terminal in `backend`:

```
$env:LIVE_HOST_PLATFORM = "youtube"
Remove-Item Env:LIVE_HOST_MODE -ErrorAction SilentlyContinue
npm run live-host:setup-obs
npm run live-host:preflight
```

   Fix every FAIL it prints. WARNs are for you to read.

**Going live**

1. `npm run live-host:supervised` (restarts the worker if it ever crashes). Leave the switch OFF; he stays idle.
2. Flip the switch ON in the app. The worker starts OBS streaming and he opens.
3. In YouTube Studio, press Go Live once the preview shows the picture (chat only exists after that).

**Ending**: flip the switch OFF in the app (stops OBS streaming), then end the stream in YouTube Studio.

**Things to know**: the canvas is vertical (1080 x 1920); YouTube shows that portrait on phones and pillarboxed on a
desktop. Daily budget is $3 across Growth OS; an hour of solo running is roughly $1 to $2. If something goes wrong:
switch OFF in the app first, always.

## The site card (YouTube)

When a line says the website ("fillbookhq dot com"), the stage shows a card with the address and "Free sample
dashboard. No signup. fillbookhq.com/sample" for the length of the line plus a few seconds, so viewers can read where
to go. Tilt is told the card appears, so he can say "it's up there".

- **YouTube layout only.** It never shows on the TikTok layout (`?safe=tiktok`): an address on screen there is the same
  off-platform problem as saying it, which is why the TikTok rule is "link in the bio".
- Fixed text and only the approved domain; a cut-off line takes the card with it.
- Not built: a scannable QR code. It needs a QR library on this machine and a way to check it scans.

## What it costs, and how to lower it

Measured 2026-10-10 against the real API with the production knowledge (system prompt about 8.8k tokens, cached):

| | cold cache (first line, or after 5 quiet minutes) | warm line |
|---|---|---|
| Sonnet (default for chat answers and segments) | $0.038 | $0.0077 |
| Haiku (join welcomes, duo replies, and the economy tiers below) | $0.0128 | $0.0025 |

Volume is what adds up. An engaged room is roughly one line every 40 seconds, so about 90 lines an hour, which is
about $0.90 an hour with retries on the stronger model. A quiet room costs almost nothing (he only speaks when someone
chats, after the opening minutes). Voice is free.

What is on regardless of mode:

- one line at most every 30 seconds while the room is engaged (was 18);
- a draft that is only slightly over the length limit is trimmed instead of paid for again (a re-draft happens only if it
  is more than 25 percent over);
- as today's spend passes 60 percent of the daily budget, everything but fact segments goes to the cheap model, and at
  85 percent so do those, so he keeps talking within the budget instead of going silent;
- the daily budget ($3 by default, set in the app) is a hard stop.

Choose a tier with `LIVE_HOST_COST` in the worker's environment:

- `quality` (default): the stronger model for every line. Tightest and funniest; about $0.90 an hour engaged.
- `balanced`: the routine joke-and-hook segments on the cheaper model; about 40 percent less. Measured side by side the
  cheaper model's lines run 55 to 70 words against 48 to 57, and are flatter.
- `low`: chat answers too, fact segments excepted; about 65 percent less.

The worker prints `spent today $X` with every line it speaks.

## Realism: voice, eyes and Red

- **His voice moves with his mood.** Each line's mood (smirk, shocked, tilted, proud, thinking, sad) shifts the pace
  and pitch a little (a shocked line is a touch faster and higher, a sad one slower and lower). Small steps, so it is
  still recognisably him; singing keeps its own pace. Table: `MOOD_PROSODY` in `worker.ts`.
- **He looks at what he is talking about.** A glance to the question bubble as he starts, to the card when it lands,
  and over to Red while Red talks, then back. Stops the "staring down the lens at everything" puppet look.
- **Red is scheduled.** The model volunteered him in 1 line of 8, against the brief's one in three. He is now asked for
  when none of the last three lines had him, and never on a fact segment, a show beat, a welcome, in duo mode, or
  when someone asked a direct question (a Red line that comes with a question is dropped). His bubble sits above
  Tilt's head, and Tilt looks over at him.
- **Numbers.** Any worked example is one exact, checked step, or no numbers at all (drawdown arithmetic came out
  garbled in several real drafts).

## Variety (so a stream does not sound like a loop)

A simulated ten-minute show showed the tells a viewer notices by minute three: every reply opened "Name, welcome.",
the market was always closed and he never had hands, every segment ended telling chat to type, and the disclaimer
kept coming back. `liveHostVariety.ts` works out from his own last lines what to steer away from, puts it in the
prompt, and checks the draft (one retry, then it is accepted):

- bits used twice in the last six lines are named and left out (closed market, no hands, the weekend or the hour,
  paid in nothing, no account, candle with a microphone, the suggestion box);
- a greeting of the "Name, welcome" kind is allowed once, and an opening that matches one of his last five is redone;
- a segment may end by asking chat to type only if someone chatted in the last 3 minutes and his last line did not;
- the not-financial-advice line goes in the opening, and again only if a viewer asks for advice;
- he is told never to claim chat said, guessed, laughed or went quiet when it is not in the lines he was given.

Rule Trivia and Trivia Answer were rewritten after a real draft got the arithmetic wrong: the question uses one simple
calculation with round numbers, and the answer states it once as X times Y percent is Z.

### Variety, second pass

- **Invented chat reactions** ("nobody guessed", "chat went so quiet") kept appearing in empty rooms in 3 of 3 test
  answers even with an explicit rule, so prompting is not enough. A draft that makes the claim when nobody has spoken is
  redone once, and if it still does, the sentence that makes the claim is dropped (`stripChatReactionClaims`).
- **Tilt-o-Meter** without a rating is redone once. The rating drives the needle on screen as well as the line.
- **Openings** are told to leave out the closed market (the opening angle list exists for that); the hour and the
  weekend are allowed there because several angles legitimately use them.

## Open mic (duo mode)

Hold-to-talk stays the default. **Open mic** is a toggle on the console for when your hands are busy:

- It listens between your words and sends a turn after a 1.3 second pause. It is **off every time the page loads**.
- **"Only when I say Tilt"** (on by default): a turn is sent only if "Tilt" is in its first few words ("Tilt, what do you
  think?"). Chatter, a phone call, something said to chat: shown on screen as "Heard, not sent", never sent. Untick it
  and any turn of three words or more goes, at most one every 6 seconds.
- **It is deaf while Tilt is talking** (and for 1.5 seconds after), so he cannot answer himself. Holding the talk button
  pauses it too; it resumes when you let go. **Esc** drops the turn you are in the middle of.
- He looks up and nods while a turn meant for him is coming in, same as hold-to-talk.
- **Wear headphones.** Without them his voice from the speakers can still leak into a turn right at the edges.
- Same service as hold-to-talk: Chrome or Edge, the browser's speech recognition processes the audio.

It is a convenience, not the recommended mode for a first TikTok run: rehearse it before relying on it live.

## Cut list (2026-10-10, after reading real runs)

- **Tilt Sings is retired** (`retired: true`): a text-to-speech voice cannot sing, so it is a poem read flat. Kept in the
  file; out of the rotation and the segment picker.
- **No empty-room bits.** The idle thoughts and animations that announce nobody is here (crickets, hello?, is this on,
  somebody type something, day 400, the sleeping, lonely and tumbleweed bits) are gone from the idle rotation. The
  "someone just left" lines still fire, but only on a real viewer drop on TikTok.
- **The origin line** ("more blown account stories than anyone alive") is allowed once per stream, not in every opening.
- **Shorter spoken disclaimer** in the opening (about five words); the footer carries the full statement on screen.
- **The Fillbook pitch** waits for 15 minutes into the show and for chat that is alive (someone typed in the last
  3 minutes), instead of firing at minute 4 into an empty room. The site card still shows whenever the address is said.

### Red, scheduled properly, and the trivia pair retired

- **Red appeared once in seven lines** in the 2026-10-10 rehearsal. The first scheduling (asked for only when none of the
  last three lines had him, never on fact segments) left almost no eligible lines, and a 3 second cameo once in seven
  lines is easy to miss. He is now due when none of the last **two** lines had him, starting from the line after the
  opening: about every third line. He is still skipped on fact segments, show beats, welcomes, duo mode and direct
  questions.
- **Rule Trivia and Trivia Answer are retired.** Three real runs produced a wrong or invented answer (an "80 percent"
  rule, garbled arithmetic, "most firms set it at twenty percent" plus an invented five-day minimum). A teaching stream
  cannot afford a confidently wrong fact. They can come back when the numbers are computed in code, not by the model.
