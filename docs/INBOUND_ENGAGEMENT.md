# Inbound Engagement Queue

The problem this closes: a full-repo audit confirmed that every X mention
of `@FillbookHQ` was previously ingested as a generic Opportunity Engine
"signal" — scored and displayed identically to a YouTube video idea or a
Search Console query. Nothing anywhere recorded whether a specific
person's reply had actually been answered. A manual review found real
people who had replied and apparently never got a response — this is the
system built to make that structurally harder to repeat.


## How it works now (2026-11-15) -- read this first

The sections below are history. Where they disagree with this one, this one is current.

- **Sources and schedule.**
  - X mentions and replies to @FillbookHQ, plus top-level comments on our YouTube Shorts.
  - Synced by `api/growth-pulse.ts` at 15:00, 20:00 and 01:00 UTC.
  - Health has its own rows for X (`x_inbound`) and YouTube (`youtube_comments`).
- **No silent loss.**
  - X follows pagination after the stored cursor, up to 5 pages (250 mentions, $0.25).
  - YouTube follows pages until it reaches the stored comment, up to 5 pages.
  - Stopping at either cap records a sync failure in Health.
- **Priority.**
  - p1: a direct reply.
  - p2: someone with a conversation we answered, a tracked creator, or a Prospecting reply we posted.
  - p3: a question.
  - p4: a mention.
  - Low-value items are closed at ingestion.
- **Queue order.**
  - Follow-ups flagged 48 hours or more ago come back on top as "FOLLOW-UP DUE".
  - Then p1, p2, p3 and p4, newest first within each.
- **One person, many replies.**
  - Items from the same person are grouped under a header ("@name · 8 replies") with the first one shown.
  - Each message keeps its own card and actions, so one Responded marks one item.
- **Possibly automated.**
  - An advisory label on a person: at least 4 messages in 24 hours that are under 200 characters and not questions, and no conversation we have answered with them.
  - It never closes, hides, reorders or restricts anything.
- **Context.**
  - The post an item answers is shown before drafting, from our stored posts (`x_own_posts`, no X read).
  - The drafter also gets the rebuilt thread.
  - An unsent follow-up draft is never treated as something we said.
- **States.**
  - Draft, Follow up and Responded work only on open items (new, needs_response, draft_ready, follow_up, review_needed).
  - Responded twice and Close twice change nothing.
  - A responded item is not closed.
  - Errors: 409 for a wrong state, 422 for a rejected draft, 404 for a missing item. The app shows the reason.
- **Counts.**
  - The Morning Brief, Home and the tab use the same summary: messages needing a response, plus how many people they come from.
  - Backlog review items are not counted as overdue.
- **Check for missed replies.** Runs at most once an hour and reports how many it found.

## What this is NOT

- Not auto-reply, auto-like, auto-follow, or auto-DM. Nothing here can
  post anything — `ExternalWriteFirewall` rejects `x.reply`/`x.post_tweet`
  unconditionally regardless, and more basically, no code in this module
  calls any X write endpoint at all.
- Not a CRM. Relationship context is limited to what already existed
  (creator tracking) plus a repeat-engagement flag — no new profile
  fields, no contact management.
- Not a replacement for the Opportunity Engine. `signals`/`opportunities`
  still model "topics worth writing content about." `inbound_engagements`
  is a separate table modeling "a specific person said something to us
  and may be waiting on a reply" — a different lifecycle (conversation
  threading, response drafting, human-confirmed completion).

## Data flow

1. `backend/src/signals/adapters/xAdapter.ts`'s `fetchOwnMentions` now
   requests `conversation_id`, `in_reply_to_user_id`, `referenced_tweets`,
   and a username expansion — previously only `created_at`, `public_metrics`,
   and a bare numeric `author_id` were requested, which made "is this a
   reply to us" and "who sent this" both undeterminable by construction,
   not just by omission downstream.
2. `backend/src/inbound/inboundIngestion.ts` runs once daily (same Vercel
   Hobby cron as everything else — `0 13 * * *`, the platform's actual
   ceiling, not a choice made here) via `api/daily-pipeline.ts`'s
   `inbound_engagement` step, using its own cursor
   (`x_mention_inbound`, separate from `xIngestion.ts`'s `x_mention`
   cursor — the two pipelines classify and store differently and must not
   interfere with each other's progress).
3. Each mention is classified (`inboundClassifier.ts`, pure/deterministic,
   no LLM call) into a priority and inserted into `inbound_engagements`
   (migration `0014_inbound_engagement.sql`), deduped on
   `(platform, external_id)`.
4. The Android Inbound screen (`ui/screens/InboundScreen.kt`) and Home's
   Command Center both read the active queue via
   `GET /api/approvals?resource=inbound` (folded into the existing
   `approvals.ts` file — Vercel Hobby's 12-serverless-function cap was
   already fully used, same reasoning as `api/ingest.ts`'s multi-source
   consolidation).

## Priority classification

Deterministic, in `inboundClassifier.ts` — no LLM call, so classification
never depends on the AI provider key being configured:

| Priority | Meaning |
|---|---|
| `p1_direct_reply` | `in_reply_to_user_id` matches @FillbookHQ's own resolved user id — a direct reply to something we posted |
| `p2_relationship` | The author is a tracked creator OR has any prior `inbound_engagements` row — relationship outranks reply-type, since who it's from matters more than the exact tweet mechanics |
| `p3_comment` | A standalone mention containing a question |
| `p4_mention` | A standalone mention or quote-post with no question |
| `low_value` | Emoji-only, blank, or a single low-effort hype word (`isLowValue` in `inboundClassifier.ts`) |

`low_value` items are still inserted and visible (status `closed`
automatically) — never silently dropped. "No response needed" is a real,
auditable status, not an absence of a row.

## Status lifecycle

`new → needs_response → draft_ready → responded`, plus `follow_up`
(operator-set "revisit later," distinct from the automatic reopening
below), `review_needed` (backlog-recovery only, see below), and `closed`.

**`draft_ready` is never `responded`.** Generating a draft
(`POST /api/approvals?resource=inbound {action: "draft"}`) only ever sets
`draft_ready`. The *only* code path that ever sets `responded` is an
explicit `{action: "mark-responded"}` call — a human confirming they
actually replied on X themselves. X's API can't reliably confirm a reply
was sent from this account without a write-adjacent capability this app
deliberately doesn't have, so this is the safest available operator
workflow, not an inferred state.

**Follow-up reopening**: when someone replies again in a conversation
where an earlier message was already marked `responded`, the new message
becomes its *own* new row (same `conversation_id`, new `external_id`),
landing at `needs_response`. The earlier row keeps its `responded` status
— it's a true historical record, not something a later message overwrites.

## Response drafting

`inboundResponseWriter.ts` drafts one reply via the same brand-rules/
verified-knowledge grounding every other content-writer module uses,
passing along whether the author is a repeat engager and how many prior
interactions they have, so the draft can (naturally, not formulaically)
acknowledge an existing relationship. Never pitches Fillbook unless the
conversation is genuinely about journaling/tracking. Costs are recorded
to `cost_events` like every other LLM call.

## Backlog recovery

`POST /api/approvals?resource=inbound {action: "backlog-recover"}`
ignores the stored cursor and re-fetches the same recent window X's
mentions endpoint returns (up to 50). Genuinely new items land as
`review_needed`, not `needs_response` — forward sync has no ambiguity
(first time we've ever seen the message), but a backlog pass is
reconstructing *past* state with no way to know whether the owner already
handled it outside this system. Anything already tracked is left
completely untouched either way.

## Sync visibility

`integration_health` (present in the schema since migration `0001`, but
confirmed via full-repo grep to have never been read or written by any
code) now tracks the inbound sync's real state: `last_attempted_at`
(written before the sync even starts, so a crash mid-run still leaves
this current), `last_success_at`, and `last_error`. Surfaced in
`GET /api/health` as an "Inbound Engagement" row. A broken sync shows as
`DOWN` with the actual error — never as a merely-empty, falsely-reassuring
queue.

## Update 2026-09-04 -- 3x/day cadence added

Step 2 above described a 1x/day sync via `daily-pipeline.ts`'s
`inbound_engagement` step. That step has since moved to
`api/growth-pulse.ts` (called 3x/day by `.github/workflows/growth-pulse.yml`
-- see `docs/PROSPECTING.md`'s matching update and
`backend/src/config/scheduleConfig.ts` for the exact times/timezone).
People replying to `@FillbookHQ` are now noticed within one of three daily
windows instead of waiting up to 24h for the next cron tick.

Reddit inbound was added as a second inbound source on 2026-09-04 and
removed on 2026-09-06 -- Reddit closed self-service app registration and
no credentials were ever obtained. Inbound is X-only today.

## Known limitations

- **Once-daily sync.** Vercel Hobby cron jobs run at most once per day —
  a real platform ceiling, not a design choice. "Check for missed
  replies" (backlog recovery) is the manual override between cron runs.
- **`in_response_to_text` is not populated.** Knowing exactly what a
  reply is replying to would need a second API call per mention (fetch
  the parent tweet's text) — not implemented yet to keep Owned Reads
  costs and complexity down at current volume. The reply's own text and
  `in_reply_to_external_id` are still captured.
- **The X mentions endpoint is the ceiling on what's detectable.** If a
  reply genuinely doesn't trigger `/users/{id}/mentions` at all (rather
  than arriving with incomplete fields, which is the gap this phase
  fixed), no amount of downstream classification can recover it. This
  wasn't independently re-verified against X's current API behavior in
  this pass.
