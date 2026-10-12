# Engagement assistant (Engage tab)

Helps the owner interact with OTHER creators' YouTube Shorts and TikTok videos (a thoughtful comment, a like) to
build reach for @FillbookHQ. **v1 is open-and-paste only.** The app discovers candidates, drafts comment options and
keeps the record; the owner opens the video, pastes the text and taps post on the platform themselves. Nothing here
posts, likes or follows anything.

## What it is not

- No platform posting from the app, no Google OAuth write scope, no YouTube comment/like calls.
- No TikTok automation of any kind: TikTok has no public comment or like API and bans bots, scripts and scraping.
  The only request ever made to TikTok is the public oEmbed endpoint for a link the owner pasted.
- No batch approve, no auto-like, no scheduled posting. Every action is one human tap on one item.

## How it works

| Step | What happens |
| --- | --- |
| Discover (YouTube) | Official Data API v3 with `YOUTUBE_API_KEY` (read-only). Watchlist channels: `channels.list` + `playlistItems.list` + `videos.list`, 1 unit each. Watchlist queries use `search.list` (100 units), at most 3 per run. Only videos of 3 minutes or less are queued. |
| Discover (TikTok) | The owner pastes a video link. The backend reads title, author and thumbnail through `tiktok.com/oembed` and nothing else. |
| Draft | Claude writes 2-3 distinct, specific, non-promotional options per video from the title, description and top comments. Options that trip a guardrail or look like a recent comment are dropped and regenerated (up to 3 rounds). The model may decline a video that is off topic, a real tragedy, or a promotion; few or no comments, or a blown-account story, is not a reason to decline. |
| Review | In the app: Open video, Copy a draft (editable first), Done (commented / liked) or Skip. |
| Record | Done writes an audit row (platform, video id, creator, draft chosen, the owner's final text, timestamp). An optional outcome note (got a reply, profile visits) can be logged against a done action through the API (`outcome`); the app does not expose it yet. |

Where the code lives: `backend/src/engagement/`, routed through `api/approvals.ts` as `?resource=engagement` (the
project is at Vercel Hobby's function cap, so no new function file). Migration:
`backend/src/db/migrations/0050_engagement_assistant.sql`. Android: `EngagementScreen.kt` (More > Engage).

## Automatic fill (the queue is ready when you open the tab)

A scheduled step, `engagement_autofill`, keeps the queue stocked so the owner only works through cards (Open, Copy,
Done or Skip). It is a step inside `api/growth-pulse.ts` (the `youtubeComments` group), so it rides the existing
GitHub Actions pulse (08:00, 13:00 and 18:00 Arizona time) and adds no serverless function. Code:
`backend/src/engagement/engagementAutoFill.ts`.

Each run, in order:

1. Purges cached YouTube data older than 30 days (always, even when paused or when the key is missing).
2. Stops with a `skipped -- ...` line when the system is paused, `YOUTUBE_API_KEY` is missing, the migration is not
   applied, or today's quota budget is used up. It never throws into the pulse.
3. Seeds the default watchlist (see "Default queries" below) once per seed marker, never over an owner-curated list.
4. If fewer than 10 USABLE items are waiting (cards whose creator is on cooldown do not count), discovers more: 3
   `search.list` calls per run (100 units each, rotated across the watchlist, 25 results each), plus
   `channels.list`/`playlistItems.list` for watched channels and `videos.list` in 50-id chunks (1 unit each). Keeps
   videos of 3 minutes or less, published in the last 14 days, with at least 100 views, search hits whose title or
   description mentions trading, ordered by comment count then views. Creators on cooldown, creators who already
   have a waiting card, and videos already done or skipped are skipped.
5. Pre-drafts every undrafted waiting item with the existing drafter (2-3 options, same guardrails, dedupe and
   cost recording), at most 10 per run and inside a 35 s time budget. When the drafter declines or nothing passes the
   guardrails, that one video is skipped automatically with the reason (`auto: ...`) and never resurfaces. Only the
   video is closed: cooldown is driven by done actions only, so the creator's other videos stay eligible.
6. Reports one line, for example
   `discovered 4, drafted 4, queue 7, quota 312 units this run (312/3000 today) (funnel 31 seen, 4 added; low views 9, off topic 6, old 5, handled 4, same creator 3)`.
   The full breakdown is stored as JSON in the `engagement_autofill_detail` row of `integration_health` (see
   "Reading a run").

Quota: one fill is 3 searches (300) + at most 2 `videos.list` (2) + at most 10 top-comment reads (10), about 312 units
(a channel on the watchlist adds 2 more per run). Three fills a day (01:00, 15:00, 20:00 UTC) are about 940 units, a
third of the 3,000 budget; a fill with a full queue costs 0. The unit spender refuses any call that would cross the
budget. search.list costs 100 units per call regardless of how many results it returns, which is why each search asks
for 25.

### Tuning knobs

All in `backend/src/engagement/policy.ts` (with the quota math next to them):

| Constant | Value | Meaning |
| --- | --- | --- |
| `AUTOFILL_TARGET_WAITING` | 10 | Usable waiting cards the fill tops up to. |
| `AUTOFILL_MAX_SEARCHES_PER_RUN` | 3 | `search.list` calls (100 units) per fill. |
| `AUTOFILL_SEARCH_RESULTS_PER_QUERY` | 25 | Ids requested per search (same cost at 10 or 50). |
| `AUTOFILL_SEARCH_ORDERS` | viewCount, relevance, viewCount | `order` of the 1st, 2nd, 3rd search of a run. Newest-first mostly returns uploads with a handful of views that the floor then drops. |
| `AUTOFILL_MAX_AGE_DAYS` | 14 | Drop older videos; also the `publishedAfter` window of the search. |
| `AUTOFILL_MIN_VIEWS` | 100 | Views floor. Lower it only if the breakdown shows `tooFewViews` dominating with most of them in `under100`. |
| `AUTOFILL_MAX_DRAFTS_PER_RUN` | 10 | Pre-drafts per fill (a 35 s time budget also applies). |

Searches also send `type=video`, `videoDuration=short`, `relevanceLanguage=en` and `regionCode=US`.

### Default queries and the seed

Nine queries, three per fill, so the three daily fills cover the whole list once a day (rotation is by scheduled run,
so windows never overlap): `topstep payout`, `apex funded account`, `prop firm rules explained`,
`blew my funded account`, `futures day trading`, `trading journal`, `revenge trading`,
`trailing drawdown explained`, `prop firm challenge`.

Seeding is controlled by `integration_health` marker rows. `engagement_seed` is the first seed (six queries);
`engagement_seed_v2` is this list. With no v2 marker: an empty never-seeded list gets the nine queries; a list that is
exactly the untouched original six (all `default`-labelled, all active, nothing added or removed) is swapped for the
nine once; any other list (owner added, removed, relabelled or deactivated anything) is left completely alone and the
v2 marker is written so it is never revisited. Deleting every entry later is respected. No channel ids are seeded.

### Reading a run

The summary note carries a `funnel N seen, M added; ...` fragment (non-zero buckets only). The
`engagement_autofill_detail` row (`notes` is JSON) has the full version: the exact `queries` with their `order` and hit
count, `seen` (from search / from channels), then the drop buckets in filter order (`alreadyQueued`, `alreadyHandled`,
`notReturned`, `notShortLength`, `tooOld`, `tooFewViews` with `viewsBelowFloor` bands, `noTradingWords`,
`noCreatorOrOwn`, `creatorCooldown`, `creatorAlreadyQueued`, `roomExhausted`), `added`, plus drafting counts
(`declined` with the model's reasons, `guardrail` failures, `blocked`), the queue before/after and the quota. The
queries are also written to the function log as `engagement_autofill: searches [...]`.

The Engage tab opens on the ready queue: each card shows its first draft, and the empty state says when the next
automatic fill runs. "Find new videos", pasting a link and adding watchlist entries still work as before.

TikTok limitation: TikTok has no public discovery API and bans scraping and automation, so nothing discovers TikTok
videos for you. TikTok items appear only when the owner pastes a link (read through public oEmbed), and they are
drafted on the next scheduled fill. The fill itself only reads YouTube through the official Data API and writes
drafts; it never posts, likes or follows on any platform.

## Guardrails (enforced in the backend)

| Guardrail | Default | Notes |
| --- | --- | --- |
| Daily cap | 25 done actions per platform per Arizona day | Counts Mark-done only. Refuses draft, open, copy and done once reached. |
| Minimum spacing | 90 s between actions (any platform) | Refuses copy and done inside the window and says how long to wait. |
| Per-creator cooldown | 3 days | Refuses draft, open, copy and done for that creator. Discovery does not queue cooled-down creators. |
| Quota budget | 3,000 units per Pacific day | Counted in `engagement_quota_ledger` before each call. Default project quota is 10,000. |
| Near-duplicate check | last 200 drafted or posted comments | Word-bigram and word-set similarity, plus a shared-opener rule. Also applied between sibling options. |
| Comment rules | see `commentGuardrails.ts` | No links, no brand name, no "check out" / "link in bio" / "my channel", no generic praise, no @mentions, no emoji or hashtags, no dashes, no claims or financial advice, TikTok 150 characters, YouTube 280. |
| No invented experience | `findInventedExperience` in `commentGuardrails.ts` | The comment is posted under the owner's own account, so it may never speak as a trader with a history. Any first-person marker (I, I'm, I've, I'd, I'll, my, mine, me, myself, we, our, us, "been there", "same here", "can relate") rejects the option and the reason goes back into the regeneration loop (3 rounds). Allowed voices: an observation about what the video said, a specific question, a general point in the second or third person, agreement pointing to a specific moment. Owner-edited text is only warned about. Drafts stored before this rule are dropped on the next fill or when the queue loads; an item left with none goes back to "new" and is redrafted through the normal drafter within the per-run cap. |
| Cache retention | 30 days | YouTube metadata, statistics and comment snippets are deleted 30 days after fetch (YouTube API Developer Policies). |
| Auth | owner app token only | The automation token is refused on this resource. |

The owner keeps final control of published text. Edited text is checked and shown as warnings, not blocked.

## Policy notes

- YouTube API Developer Policies: no automated comments or likes without the user's specific consent and final
  control of text; API use only, no scraping; cached statistics refreshed or deleted within 30 days.
- YouTube spam policy bans high-volume, repetitive or templated comments and "check out my channel" promotion. The
  caps, cooldown and dedupe exist for that reason, but they only reduce risk: every comment still goes out under the
  owner's real account, so keep them honest, short and about the video.

## Setup

1. Apply `0050_engagement_assistant.sql` to the Growth OS Supabase project (owner action).
2. Set `YOUTUBE_API_KEY` in Vercel (a Data API v3 key, restricted to that API). Without it the tab still works for
   pasted TikTok links and shows YouTube discovery as not configured.
3. Nothing else: the scheduled fill seeds the watchlist and stocks the queue. Optionally, in the app (More >
   Engage) add channels (`@handle` or `UC...` id) or queries, or paste a link.

## API

`GET /api/approvals?resource=engagement` returns status, queue, watchlist, today's counts and quota. `&stats=1&days=14`
returns counts per day and platform and the logged outcomes. `POST` actions: `add-watch`, `remove-watch`,
`discover`, `add-link`, `draft`, `open`, `copy`, `done`, `skip`, `outcome`. A guardrail refusal is HTTP 429 with
`{error, block: {code, message, retryAfterSeconds?}}`.
