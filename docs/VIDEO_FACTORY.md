# Video Factory — script generation (Growth OS) + local render (you)

Growth OS generates a real, shootable **production package** for video
opportunities (currently: any opportunity whose recommended platform is
`tiktok`) — hook, full voiceover script, shot list, caption, and hashtags —
and runs it through the same review pipeline as every other draft
(mechanical quality gate + the nine LLM review agents). It shows up in the
Android app's Approvals screen exactly like a text post does, just with a
`video_script` asset type instead of `post`.

**What Growth OS does NOT do, on purpose:** call a TTS API, run ffmpeg, or
produce a video file inside the Vercel deployment. Vercel's serverless
functions have execution-time and disk limits unsuited to video rendering
(10s on Hobby, up to 300s on Pro — real rendering can need more of both,
plus scratch disk ffmpeg doesn't get in a serverless invocation). Instead,
a **local-only CLI** (`backend/scripts/video-factory/`) automates the
mechanical production work on your own machine, after you've approved a
draft — see "Render command" below. It never runs in Vercel, never exposes
a network endpoint, and never publishes anything.

## End-to-end flow

1. **Growth OS drafts it.** A `tiktok` opportunity runs through
   `draftVideoScript` (`backend/src/content/videoScriptWriter.ts`), passes
   the mechanical gate + deep review, and lands in Approvals as a
   `video_script` asset — same as any other draft, same human-approval-only
   rule (`ExternalWriteFirewall` never lets this auto-publish).
2. **You approve it** in the Android app, same button as any other draft.
   This sets `campaigns.status = 'approved'` — the one thing the CLI's
   approval gate checks (see below).
3. **You render it** with one command (see "Render command"). The CLI
   fetches the approved package from Supabase, generates a real voiceover,
   times captions against it, composites branded scene backgrounds, and
   produces a validated 9:16 MP4 — fully automated, no manual ffmpeg
   commands needed day to day.
4. **You preview and upload it to TikTok yourself.** No code path here —
   in Growth OS or in the CLI — ever touches TikTok's upload API. Same
   human-only-publish invariant as every other platform.

## Prerequisites

Install once, system-wide (this is exactly the pipeline validated while
building the CLI — same tools, same versions used in testing):

| Tool | Purpose | Install (Windows) |
|---|---|---|
| ffmpeg (full build, with libx264/libass/libfreetype) | render, composite, caption burn-in | `winget install Gyan.FFmpeg` |
| Python 3 + `pip install edge-tts` | word-level narration timing (see edge_tts_words.py) | Python from python.org, then `pip install edge-tts` |
| Node.js 18+ | runs the CLI itself | already required for the rest of this repo |

No API keys, no paid tools. `edge-tts` (Microsoft neural TTS) is free and
needs no account. The CLI calls the `edge_tts` Python library directly
(via `edge_tts_words.py`), not the `edge-tts` command-line tool, because
only the library's `WordBoundary` stream gives real per-word timing —
the CLI's `--write-subtitles` only ever produced sentence-level SRT,
not enough to drive the word-by-word highlighted captions.

**Check everything is installed:**

```bash
ffmpeg -version
ffprobe -version
python3 --version
python3 -c "import edge_tts"
```

The CLI itself also checks all three automatically before doing anything
else, and fails with a clear message (pointing back to this section) if
one is missing — you don't have to remember to check by hand.

## Render command

From `backend/`:

```bash
npm run video:render -- <draft-id>
```

`<draft-id>` is the `campaign_assets.id` shown in the Approvals API /
Android app for the approved video draft. This fetches the approved
package directly from Supabase (needs `SUPABASE_SERVICE_ROLE_KEY` in
`backend/.env.local` — the same value already in Vercel's project env
vars) and refuses to proceed unless that draft is genuinely approved.

**Offline / no-Supabase-access variant**, if you'd rather hand it a file
(e.g. testing, or a package assembled outside the normal flow):

```bash
npm run video:render -- --input path/to/approved-video-package.json
```

The JSON file must include `approvedAt` (and ideally `approvedBy`) —
there is no way to render an offline package without asserting approval
explicitly; see "How the human-approval gate works."

Optional flags: `--voice <edge-tts voice name>` (default
`en-US-AndrewMultilingualNeural`, edge-tts's higher-quality "Multilingual"
HD neural tier), `--out-dir <path>` to override where output lands.

## Where outputs go

```
backend/output/video-factory/<draft-id>/
  package.json       -- the loaded, validated production package (for the record)
  script.txt          -- exact text sent to edge-tts
  voiceover.mp3        -- generated narration
  voiceover.words.json  -- edge-tts's real per-word timing (drives word-by-word captions)
  captions.ass           -- final burned-in caption/scene-label file
  final.mp4                -- the finished, validated video
  render-report.json        -- machine-readable summary (see below)
```

This directory is gitignored (`output/`) — nothing here is ever committed.
Rerunning the same draft ID overwrites its directory cleanly.

## How to preview the result

Open `final.mp4` in any video player, or from the command line:

```bash
start backend/output/video-factory/<draft-id>/final.mp4
```

To spot-check a specific moment without opening a player (useful for
checking caption clipping or a specific scene transition):

```bash
ffmpeg -y -ss <seconds> -i final.mp4 -frames:v 1 frame.png
```

## How validation works

After rendering, the CLI runs `ffprobe` on the output and checks, in
order: video stream present (codec), audio stream present (codec),
resolution is exactly 1080x1920, duration is a sane positive number,
duration is within 5 seconds of the expected narration+pad length, and
the output file is non-empty. Every check (pass or fail) prints in the
final summary. If any check fails, the command exits non-zero and prints
`Validation: FAIL` — the render is not silently treated as usable.

## How the human-approval gate works

The CLI has exactly one approval check
(`scripts/video-factory/loadApprovedScript.ts`'s `assertApproved`), called
once, immediately after loading, before anything else happens:

- **Draft-ID mode:** the loader only ever populates `approvedAt` when
  `campaigns.status === 'approved'` — the single status value that
  `POST /api/approvals`'s "approve" action sets, the same approval you
  already do in the Android app. Any other status (`draft`, `in_review`,
  `retired`) means `approvedAt` stays empty and the gate throws.
- **`--input` mode:** the JSON file must set `approvedAt` itself. There
  is no bypass, no flag, no env var that skips this check in either mode.

If you see `Draft has not been approved`, go approve it in the Approvals
screen first — that's the intended behavior, not a bug.

## Common errors

| Error | Meaning | Fix |
|---|---|---|
| `"ffmpeg" was not found on PATH` | ffmpeg isn't installed / not on PATH | `winget install Gyan.FFmpeg`, restart your terminal |
| `"python3" was not found on PATH` | Python isn't installed / not on PATH | Install Python from python.org, restart your terminal |
| `edge-tts word-timing script failed` mentioning `ModuleNotFoundError: No module named 'edge_tts'` | the `edge-tts` package isn't installed for this Python | `pip install edge-tts` |
| `SUPABASE_SERVICE_ROLE_KEY is not set` | no `backend/.env.local` | Copy the key from Vercel's project env vars into `backend/.env.local` |
| `Draft "<id>" has not been approved` | campaign isn't `approved` yet | Approve it in the Approvals screen, then rerun |
| `No campaign_assets row found with id "<id>"` | wrong/mistyped draft id | Double-check the id from the Approvals API/app |
| `has asset_type "post", not "video_script"` | you gave it a text post's id | Only `video_script` assets (video opportunities) can render |
| `no structured videoScript in content_versions.metadata` | draft predates this feature | Re-run the campaign for its opportunity to regenerate |
| `edge-tts failed` / `ffmpeg render failed` | the underlying tool errored | The full stderr is included in the message — usually a bad voice name or a corrupted intermediate file; delete the draft's output directory and rerun |
| `Validation FAILED` | rendered file didn't pass the ffprobe checks | Check which specific checks failed in the printed list; usually indicates a genuinely broken render, not a false alarm |

## How to rerender

Just run the same command again — `npm run video:render -- <draft-id>`
overwrites that draft's entire output directory from scratch. There's no
separate "clean" step needed.

## Windows quickstart

```bash
# one-time setup
winget install Gyan.FFmpeg
winget install astral-sh.uv
cd backend
npm install

# put SUPABASE_SERVICE_ROLE_KEY in backend/.env.local (same value as in Vercel)

# render an approved draft
npm run video:render -- <draft-id>

# preview
start output\video-factory\<draft-id>\final.mp4
```

Uploading the finished MP4 to TikTok is, and remains, a manual step you
do yourself in the TikTok app — nothing in this repository ever touches
TikTok's upload/publish API.

## Why this split, not more automation

- The **creative step** (deciding what to say, whether a claim is
  grounded, whether the hook actually works) is exactly what Growth OS's
  existing pipeline is built for — reusing it here means TikTok video
  scripts get the same brand/factual/anti-slop scrutiny a text post does,
  for free.
- The **mechanical render step** (TTS + ffmpeg) has no judgment calls left
  in it once the script is approved — it's a real infra/tooling problem
  (where does ffmpeg run with enough time and disk), not a content-quality
  one, and doesn't need an LLM or a review pipeline. It's also already
  solved and working on your machine.
- Automating the render step later (a small always-on worker, e.g. a $5-7/mo
  VPS or Railway/Fly.io service with ffmpeg installed) is a real option if
  render volume grows enough to justify it — see the "Video Factory" entry
  in `docs/PROGRESS_LEDGER.md` for the tradeoffs. Not worth building for a
  few videos a week with one owner doing final review anyway.

## Extending to other video platforms

`VIDEO_PLATFORMS` in `backend/src/content/campaignPipeline.ts` currently
only treats `tiktok` opportunities as video. Adding `youtube_shorts` (or
any other short-form video platform) later is a one-line addition to that
set — the writer and render pipeline are already platform-agnostic.

## CLI architecture

`backend/scripts/video-factory/`:

| File | Responsibility |
|---|---|
| `index.ts` | CLI entry point -- arg parsing, orchestration, the operator-facing summary |
| `loadApprovedScript.ts` | Fetches/validates the production package (Supabase or `--input` JSON) and enforces the approval gate |
| `voiceover.ts` | Runs `edge-tts`, measures real narration duration via `ffprobe` |
| `captions.ts` | Parses `edge-tts`'s real per-sentence `.srt` timing, splits oversized sentences deterministically, builds the final `.ass` file |
| `scenes.ts` | Classifies each approved shot-list entry (hook/product/metric/cta/explanation) and builds a deterministic branded background + on-screen-label plan |
| `render.ts` | Builds the exact `ffmpeg` argv and runs it |
| `validate.ts` | Runs and interprets `ffprobe` on the finished output |
| `processRunner.ts` | Thin, mockable `child_process` wrapper every other module uses instead of shelling out directly |
| `types.ts` | Shared types |

Preserved verbatim from the known-good local pipeline
(`~/fillbookhq/docs/social/VIDEO_PRODUCTION_WORKFLOW.md`): the `en-US-
AndrewNeural` voice, 1080x1920 output, the `.ass`-not-`drawtext`/raw-`.srt`
caption approach (both hit real bugs previously -- a segfault and a
libass clipping bug), `PlayResX`/`PlayResY` matching the render
resolution, `Alignment=5`, and the libx264/aac/`-shortest` composite
settings. Extended, not replaced: scene backgrounds are new (Day 1's
video used one flat background for the whole clip), and captions now
use `edge-tts`'s own real per-sentence timing rather than being
hand-timed against the `.srt` by a human.

## Known limitations

- **Scene cuts are paced and phrase-aligned, but shots map to the
  narration proportionally, not semantically.** The approved shot list
  isn't time-coded against the script, so matching a specific shot to a
  specific spoken sentence would be a guess dressed up as precision.
  Instead `buildScenePlan` paces scenes to 1-3s (repeating a shot's scene
  kind across extra cuts when the shot list is short) and snaps every cut
  to a phrase boundary from the real word timing. `render.ts`'s
  `computeSyncedSceneTimeline` keeps those cuts on their timestamps
  despite crossfades. Without word timing it falls back to an even split.
- **Videos end on the loop, not a brand card.** The 2.5s silent
  "FILLBOOK / fillbookhq.com" end card was removed (dead time hurts
  completion rate); the render ends 0.3s after the voice. The script
  prompt requires 45-75 words and a last line that flows back into the
  hook, with the Fillbook mention placed mid-to-late in the body.
- **Product scenes use real app screenshots, but a fixed set.** Scenes the
  shot list marks as Fillbook UI show one of 11 bundled screenshots
  (`assets/ui/`, from the seeded demo account) as a slow vertical pan,
  picked by keywords in the shot description (`uiScreens.ts`) and never
  repeated until all 8 are used. They sit in a window between dark bands so
  the "FILLBOOK · EXAMPLE DATA" label (required: the data is seeded demo
  data) and the captions never draw over the screenshot's own text. Not
  screen *recordings* -- no taps or live interaction -- and the set only
  changes when someone adds files there. Screenshots showing an account
  email or a phone status bar are deliberately not bundled.
- **Hook and audio treatment.** The first spoken sentence (ends at
  sentence punctuation, else a ~2.4s window) renders as a big 92pt
  centered title card; stock-clip hook scenes get a slow push-in and a
  35% dark scrim. Music is ducked under the voice with sidechain
  compression (base 0.2, ~-10dB while speaking) and the final mix is
  loudness-normalised to about -14 LUFS (single pass, so it lands within
  ~1.5 LU; earlier renders measured about -26 LUFS). The voice itself is
  still the single edge-tts `en-US-AndrewNeural`.
- **Music varies per render.** `music.ts` picks a track (seed mod the
  number of `.mp3` files in `assets/music/`) and a seeded start offset
  inside it, so the one bundled 2:20 track already yields ~5 distinct
  stretches for a ~25s video. To add variety, drop more royalty-free `.mp3`
  files into `assets/music/` (no code change) and record each one's source
  and license in `assets/music/LICENSE.txt` -- only tracks whose license
  allows commercial use without attribution. Eight beds ship today: the
  Pixabay track plus seven synthesised in-house (`generated-bed-01..07.mp3`,
  made with `makeMusicTrack.mjs`; no third-party audio).
- **One voice, one visual style.** No per-draft customization beyond
  `--voice` yet -- not needed at current volume, easy to extend if it
  becomes worth it.

## Chart-card concepts: keeping the queue varied

The app offers only chart-card concepts, and the daily refill requests them one
theme at a time (`src/video/dailyChartCardRequests.ts` round-robins across each
concept's first `expectedTopic`). Three families exist:

- `chartPilots.ts` -- hand-made cards (payout gap, two accounts).
- `chartBarsConcepts.ts` -- one labelled bar chart per concept, each drawn from a
  verified recording of a *different* product feature (day of week, time of day,
  tagged habits, conviction, plan vs reality, flagged sizing, Edge Score, win-rate
  drift, consistency cap).
- `chartConcepts.ts` -- the illustrative "win rate isn't profit" arithmetic
  cards. One theme, many parameter sets. They say nearly the same thing
  (64-80% overlap), so only one is ever offered at a time (see below).

**No near-copies to choose between** (owner rule, 2026-10-02).
`src/shortform/conceptVariety.ts` hides any concept whose narration overlaps 50%
or more with, or whose hook repeats, a concept that is already made, waiting, or
earlier in the offered list. It is applied both to the app's picker
(`GET /api/run-campaign`, which also returns `hiddenNearCopyConceptIds`) and to the
daily refill. Hidden concepts are not deleted -- an already drafted or approved
script from one still renders. Today that leaves 13 distinct concepts; the supply
warning ("LOW SUPPLY") counts distinct concepts, so it fires when new ones are
needed. To get more than one win-rate card, rewrite their narration so they genuinely differ
(changing it changes the plan hash of any draft already made from the old wording).

To add a concept on a new feature: take a recording in `verified-manifest.json`,
write a `buildBarsPlan` config in `chartBarsConcepts.ts` (every number in a row
label, figure, headline, caption or narration must be in a fact the beat cites),
add it to `BARS_PILOTS`, and run the tests -- the plan validator, the story bar
(grade A or better) and the variety checks in `test/chartBars.test.ts` must pass.
The stored facts were read from the recordings by the system, not confirmed by
the owner (`asset_not_owner_verified` review notice): spot-check a concept's
numbers against its recording before approving it.

## Product-mock slides (chart kind `mock`)

A `mock` slide is laid out in HTML/CSS with the site's own typefaces (Space Grotesk,
Manrope, JetBrains Mono -- `backend/scripts/video-factory/assets/brand`, copied from
the fillbook repo with their OFL licences) and colour tokens, then screenshotted by
headless Chromium at the final 1080x1920 (`mockCard.ts`). It shows large figures over a
product window, so the viewer sees where in the product a number comes from. Frame one
is the payoff: one or two figures at up to 250px, drawn from the first frame (no count up
from zero), over the first window. Beats 2 and 3 each show one figure over a window with
one row ringed and a cursor on it (the cursor travels there, and on beat 3 moves on from
where beat 2 left it). Beat 4 is the caption as a headline over "what else this screen
shows"; beat 5 is the caption as a headline over the invitation.
All twelve offered concepts use it (the older drawn "bars" kind is still supported and
tested). To add a concept, give a `buildBarsPlan` config a `mock` spec: `opening` (1-2
`MockHero` figures), `windows` (1-2 windows of 2-5 rows; with two opening figures the
first window holds 2), `focus` (the figure, window and row for beats 2 and 3, "but" item
last) and optional `details` (3-5 rows). Every text is length-limited and every number in
it is checked against the facts the beat cites (`mockLayout.ts`, `chart.ts`).

**Platform overlays.** Every box has a fixed position in `mockLayout.ts`, all inside
x 100-880, y 170-1600 -- the strictest of TikTok's and YouTube Shorts' insets, the
owner's measured button column (x 930) and caption block (y 1600). Text limits are
character budgets, so a too-long line is a validation error, not a reflow. The
renderer also measures every box in the real browser and throws if one leaves the
clear area or its text overflows, so a slide a platform button could cover never
reaches a video. `test/mockLayout.test.ts` proves both.

**Chromium.** `video-render.yml` runs `npx playwright install --with-deps chromium`.
Locally, set `MOCK_CHROMIUM_PATH` or run the same command. Preview a concept with
`npx tsx scripts/video-factory/renderScenePlanLocally.ts chart-bars-sized-up`.

**Length and detail.** Each concept runs five beats; the spoken length sets the video length
(about 9-12 s). The detail beat's claim is a `product_capability` claim, so wording must
stay within the guardrails (synced, closed trades; no "live"; behaviour labels framed as
flags). Because a mock draws windows that carry every figure, each beat cites all of the
concept's facts.

**Motion.** Every mock beat opens with a one-second entrance, drawn as 30 PNG frames
(`MOCK_ENTRANCE` in `mockCard.ts`) and played by `render.ts` as an image sequence
that then holds on the finished slide. The page script `seek(ms)` draws each frame as
a pure function of time, so a render is deterministic. Beat 1: the figures settle into
place (visible from frame one) and the window rises with its rows sliding in. Beats 2-3:
the figure settles, the window rises (only when it is a different window from the last
beat), the cursor travels to the focused row, the row is ringed and the others fade.
Beat 4: the headline settles and the detail card rises with its rows. Beat 5: the headline
settles and the invitation pops. Every figure is its own finished text from the first
frame, so the last frame is exactly the verified number. Motion only slides content from inside the safe
area; the finished slide is the one measured against the platform overlays. A video
takes about a minute to render locally because each beat is 30 screenshots.

## Narration on product mocks

Offered product-mock concepts are narrated (`voiceover: "narrated"`): `en-US-AndrewNeural` at
`MOCK_SPEECH_RATE` (+8%, not the faster +18% payoff pace), one edge-tts call per beat. Each beat's
`narration` is both the spoken line and the text the claim checks read, so a spoken sentence carries
at most two figures (`test/narratedMocks.test.ts`). A beat's audio is padded with silence to
`MOCK_MIN_BEAT_SECONDS` (1.5 s) so a one-line beat still holds after its 1 s entrance. The slide
already carries its own text, so no word-by-word subtitles are burned over a mock. The older drawn
bar charts stay silent. Spoken lines are 7 words or fewer, whole dollars only (a voice reads cents slowly), with the silence the voice leaves around each line trimmed (`trimSilence`), so most beats run 1.5-2.5 s and a concept about 9-12 s. A figure in the thousands ("$3,822") alone takes about 2 s to say. The name is sent to the voice as "Fill-book" (the plain spelling reads as "fill bewk").

## The 30 daily concepts, one a day

From 2026-10-03 the app offers 30 concepts (`backend/src/shortform/dailyConcepts.ts`), in a fixed order: day 1 first, the day number is part of the concept id (`daily-05-size-over-plan`). They replace the first twelve product mocks and every older concept, which stay in the catalog (so a script already drafted or approved still renders) but are no longer offered. Each is built only from figures in a verified recording (`assets/verified-manifest.json`), never invented, and passes the same claim, fit and story checks as before (`test/dailyConcepts.test.ts`). Two concepts about the same recording never run back to back.

**One a day.** Only one new concept request is allowed per calendar day in Arizona time (`src/video/dailyLimit.ts`; Eastern until 2026-10-04, now the same day as the render cap and posting plan). It applies to the app's Motion render button (a second request gets a 409 naming today's concept and when the next opens) and to the daily refill, which also now keeps at most one waiting in Approvals. A request counts while its draft is waiting or approved, or while it is queued or running. A rejected or retired draft, or a failed run, does not count, so you can pick a different concept the same day. `GET` on the endpoint reports `dailyLimit.requestedToday` and `nextRequestAt`.

**Voice sheet.** `docs/VOICE_SCRIPTS.md` lists the 30 in order with the exact lines to record; regenerate it with `npx tsx scripts/printVoiceScripts.ts > ../docs/VOICE_SCRIPTS.md` from `backend/` if a line changes. Do not reorder the days once recordings exist: the file name carries the day number.

## Recorded voiceovers (ElevenLabs)

A recording in `backend/scripts/video-factory/assets/voice/` is used for the concept it is named after, in place of the built-in voice (`suppliedVoice.ts`); a concept with none keeps the built-in voice. The render reports `narration: supplied`, and it never calls ElevenLabs.

**The form the renderer uses is five files per video**, `<planId>-1.mp3` to `-5.mp3`, one per beat. They get the same silence trimming, 1.5 s floor and joining as the built-in voice, so the two sound and time alike.

**Making them from plain recordings.** The 30 daily recordings were made from plain text with no timing markup (Eleven v4 takes audio tags, not pause tags): one file per day, `<planId>.mp3`, in a folder. `npx tsx scripts/splitVoiceRecordings.ts <folder>` (from `backend/`) cuts each into its five parts and writes them to `assets/voice/`. Every line is a full sentence, so the pause after each is longer than the pauses inside a line. Per day it tries, in order: the N-1 longest pauses, if they are clearly longer than the rest (ratio 1.3 or more) and every part is about the length its words predict (within 12 points of its share); then, when a colon pauses as long as a full stop, matching the pauses in order to the punctuation (when the count of pauses is exactly what the colons and full stops predict); then the set of pauses that makes every part the length its words predict, accepted only if it fits within 7 points and beats the next choice by 4. A day that none of these can settle is reported and nothing is written for it; re-record it. `--dry` checks without writing. `OK*` in the report marks a day cut by a fallback method.

**A single file with long pauses** (`<planId>.mp3`, lines separated by a pause of a second or more) is also accepted by the renderer, which cuts it at the pauses and fails naming what it found unless there are exactly as many parts as beats.

## Music rotation

Each render takes the next bundled track in order: `runRender` counts the render rows
created before this one and passes that as the rotation index, so consecutive renders
never share a track and every track plays before any repeats (twenty-four tracks today across eight styles -- lo-fi, driving, piano, corporate, synthwave, deep house, cinematic,
ambient -- all synthesised in-house and numbered so consecutive renders always change style; add an .mp3 to
`assets/music/` and it joins the rotation; keep it to synthesised beds, since TikTok flags third-party audio;
`makeMusicTrack.mjs --style` makes more). The start point inside the
track still varies by render. If the count cannot be read, the track falls back to
one chosen from the render's id, so music never blocks a render.

## Redesigned concepts and old drafts

A draft stores the id and content hash of the plan it was written from, and the worker
refuses a draft whose plan has changed (it never renders different content than was
approved). After a redesign, run `npx tsx scripts/printStaleMotionDraftsSql.ts` and paste
its two statements into the Supabase SQL editor: the first previews the stale drafts, the
second retires them (as Reject does) and cancels their queued or failed renders. The
concepts can then be requested again and are drafted fresh from the current plan. Videos
that already rendered are untouched. Only product-mock concepts are offered
(`isOfferedPlan`); the older illustrative win-rate cards still resolve for drafts already
made but are no longer offered.

## Pinned comment

Video Status shows a "Pinned comment" block with a Copy button on every video that has
publishing metadata: a short plain-text line pointing to `fillbookhq.com/sample` and
saying the data is sample data (`backend/src/video/pinnedComment.ts`; one of four
wordings, chosen from the video's hook so neighbouring videos differ). It is built on the
fly, not stored. Posting and pinning stay manual: neither TikTok's nor YouTube's API can
pin a comment, and nothing here posts to a platform without the owner.

**Owner-view overlays (2026-10-03).** On the owner's own view of a posted video TikTok draws extra
UI over the bottom of the frame: a comment-preview bubble, a "Promotional content" label and a
promote/analytics bar (YouTube: "Promote this Short", "Analytics", "Share your video"). A guest view
(TikTok web, signed out of the owner account) shows none of them, only the right-hand buttons and the
account name and caption from about y 1540. TikTok's "Suggested promotion" ad preview (and a promoted post)
is different: it stacks a promotion tag, a longer caption and a Learn More button from about y 1250 (measured 2026-10-05
on a screenshot), which hid the caption and the lower half of the slide. Everything on a mock therefore ends above
y 1220 (`MOCK_BOTTOM_LIMIT`), clear of both. An earlier change (#97) moved everything above y 1250 for the owner-view
bubble and was reverted because normal viewers never see it; this one is for promoted posts, which viewers do see.

**Per-video look (2026-10-05).** Mock videos no longer all share one palette and layout. `backend/src/shortform/mockStyle.ts` picks a look from the render's position in the music rotation (`musicRotation`, falling back to a number from the render id) and the worker logs it (`[render-single] mock look: <id> (rotation index <n>)`): 6 palettes (classic cyan, violet, mono white-accent, emerald, sky, and a bright "light" one that uses a dark-wordmark logo, `fillbook-horizontal-dark.svg`), left or centred text, and 3 window chromes (classic, sharp, soft). Consecutive videos always differ in all three; there are 24 distinct looks and none repeats within 16 videos. Every beat of one video uses the same look. A look only recolours and re-aligns inside the fixed boxes of `mockLayout.ts`; it never moves one (the logo stays left because the "Demo data" badge the video adds sits just right of it), so the overlay-safe limit (y 1220) holds for all of them, and `test/mockStyle.test.ts` renders and measures each. No index, or index 0, is the original look, so tests that pass nothing are unchanged. Preview one: `npx tsx scripts/video-factory/renderScenePlanLocally.ts chart-bars-conviction 5` (the last number is the rotation index). Amber was dropped: it sat too close to the red loss colour and read as "caution" on the good row. Not varied yet: the vertical order of figure and window, and the entrance motion.

**Daily loop, as of 2026-10-04.** One request a day -> draft in Approvals (push: "Script ready to approve"; optional reject reason, migration 0048) -> approve starts the render (push on ready or failed; Retry on a failed card) -> download, post by hand with the per-video tagged pinned comment, add each link in Video Status -> numbers in Results (leaderboard, day-7 prompt). Home shows where today's video is; Health checks stuck or failed renders, forgotten posts, YouTube stats and that the auto-publish flags stay off. The posting reminder is one a day at 12:00 Arizona.
