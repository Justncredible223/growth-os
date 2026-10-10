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
| Draft | Claude writes 2-3 distinct, specific, non-promotional options per video from the title, description and top comments. Options that trip a guardrail or look like a recent comment are dropped and regenerated (up to 3 rounds). The model may decline a video. |
| Review | In the app: Open video, Copy a draft (editable first), Done (commented / liked) or Skip. |
| Record | Done writes an audit row (platform, video id, creator, draft chosen, the owner's final text, timestamp). An optional outcome note (got a reply, profile visits) can be logged against a done action through the API (`outcome`); the app does not expose it yet. |

Where the code lives: `backend/src/engagement/`, routed through `api/approvals.ts` as `?resource=engagement` (the
project is at Vercel Hobby's function cap, so no new function file). Migration:
`backend/src/db/migrations/0050_engagement_assistant.sql`. Android: `EngagementScreen.kt` (More > Engage).

## Guardrails (enforced in the backend)

| Guardrail | Default | Notes |
| --- | --- | --- |
| Daily cap | 25 done actions per platform per Arizona day | Counts Mark-done only. Refuses draft, open, copy and done once reached. |
| Minimum spacing | 90 s between actions (any platform) | Refuses copy and done inside the window and says how long to wait. |
| Per-creator cooldown | 3 days | Refuses draft, open, copy and done for that creator. Discovery does not queue cooled-down creators. |
| Quota budget | 3,000 units per Pacific day | Counted in `engagement_quota_ledger` before each call. Default project quota is 10,000. |
| Near-duplicate check | last 200 drafted or posted comments | Word-bigram and word-set similarity, plus a shared-opener rule. Also applied between sibling options. |
| Comment rules | see `commentGuardrails.ts` | No links, no brand name, no "check out" / "link in bio" / "my channel", no generic praise, no @mentions, no emoji or hashtags, no dashes, no claims or financial advice, TikTok 150 characters, YouTube 280. |
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
3. In the app: More > Engage. Add a channel (`@handle` or `UC...` id) or a search query to the watchlist, tap Find new
   videos, or paste a link.

## API

`GET /api/approvals?resource=engagement` returns status, queue, watchlist, today's counts and quota. `&stats=1&days=14`
returns counts per day and platform and the logged outcomes. `POST` actions: `add-watch`, `remove-watch`,
`discover`, `add-link`, `draft`, `open`, `copy`, `done`, `skip`, `outcome`. A guardrail refusal is HTTP 429 with
`{error, block: {code, message, retryAfterSeconds?}}`.
