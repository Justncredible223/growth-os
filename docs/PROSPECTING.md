# Prospecting

The problem this closes: Fillbook is a new product with no inbound
traffic yet — nobody searches for it by name, and Radar/Inbound only ever
surface people already talking *to* `@FillbookHQ`. Per
`fillbookhq/docs/social/MASTER_SOCIAL_STRATEGY.md` (the standing,
human-authored growth policy), the actual growth lever at this stage is
proactive, useful participation in OTHER people's conversations —
"~8-15 worthwhile X reply opportunities/day" is that doc's own directional
target, not invented here. Prospecting is the system that finds those
conversations, drafts something genuinely useful to say, and gets out of
the way.

## What this is NOT

- Not auto-reply, auto-post, or auto-anything. `XSignalAdapter` has no
  method that issues a write to X — `searchRecentPosts` is a GET, same as
  every other method on that class. `ExternalWriteFirewall` blocking
  `x.reply_to_tweet`/`x.post_tweet` unconditionally is a second,
  independent guarantee, not the only one.
- Not a quota to hit mechanically. The daily search surfaces a *pool* of
  ranked candidates; the owner chooses which 8-15 (or fewer, if fewer
  genuinely exist) are worth completing. "8-15" describes realistic daily
  workload, never an automation target.
- Not the Opportunity Engine or Inbound. `signals`/`opportunities` model
  "topics worth writing content about"; `inbound_engagements` models
  "someone spoke TO us." `prospecting_candidates` models a third thing:
  "we found someone else's post worth joining." All three stay separate
  tables with separate lifecycles.
- Not a Creators rebuild. A candidate can be flagged `creator_candidate`
  (a follower-count heuristic) for the owner to consider — nothing here
  ever inserts into the `creators` table automatically; that stays a
  human decision, same as it always has been.

## Data flow

1. `backend/api/daily-pipeline.ts`'s `prospecting_search` step (same
   `0 13 * * *` Vercel Hobby cron as everything else) calls
   `runProspectingSearch` (`backend/src/prospecting/prospectingSearch.ts`),
   which rotates through `PROSPECTING_TOPICS`
   (`prospectingTopics.ts` — ~27 queries covering prop-firm/journaling
   product terms plus problem-phrased terms from
   `fillbookhq/docs/social/COMMUNITY_INTELLIGENCE.md`), searching
   `TOPICS_PER_SEARCH_RUN` (6) of them per day via
   `XSignalAdapter.searchRecentPosts` (`GET /2/tweets/search/recent`,
   the same OAuth2UserToken/`tweet.read` scope already granted — no new
   X app or OAuth setup required, confirmed against docs.x.com directly).
2. Each result is scored (`prospectingScoring.ts`, pure/deterministic) on
   topic relevance, active discussion, author reach (capped, NOT
   dominant — `MASTER_SOCIAL_STRATEGY.md`: "Follower count alone does NOT
   determine priority"), recency, authenticity, whether it invites a real
   reply, and prior-outreach relationship. Obvious spam/signal-selling
   text is excluded outright, not just down-ranked.
3. New candidates (deduped on `(platform, external_id)`) are inserted into
   `prospecting_candidates` (migration `0015_prospecting.sql`).
4. Two eligibility gates run before any search happens at all
   (`prospectingEligibility.ts`): a real spend-based monthly budget cap
   (`$15` as of 2026-09-18, raised from `$9`, itself raised from the
   original `$8` — note this now EXCEEDS the shared $10 X API credit pool
   also used for mentions and Partnerships discovery, so the cap no longer
   protects that pool by itself), and a queue-capacity check (skip searching if 25+ unshown
   candidates are already queued — surface enough for the daily target,
   not maximum possible volume).
5. The Android Prospecting screen (`ui/screens/ProspectingScreen.kt`, a
   primary bottom-nav destination) reads/acts on the queue via
   `GET/POST /api/approvals?resource=prospecting` (folded into the
   existing `approvals.ts` — Vercel Hobby's 12-function cap was already
   at capacity, same reasoning as `inbound`/`ingest.ts`).

## Scoring factors (all in `prospectingScoring.ts`)

| Factor | Max points | Note |
|---|---|---|
| Topic/feature relevance | 20 | Which Fillbook capability the topic maps to |
| Active discussion | 20 | Log-scaled replies/quotes/likes -- "are people actually talking about this" |
| Author reach | 15 (capped) | Log-scaled follower count -- deliberately NOT dominant |
| Recency | 15 | Linear decay across the 7-day search window |
| Value-add opportunity | 15 | Asks a real question + has enough context for a real reply |
| Prior relationship | 10 | Already replied to this author before via Prospecting |
| Authenticity | 5 | Verified account, a mild positive nudge only |

Spam-pattern posts (signal-selling, "DM for guaranteed profit," etc.) are
excluded (`score: 0, excluded: true`), never merely down-ranked.

## Reply drafting

`prospectingReplyWriter.ts` — a distinct prompt from
`inboundResponseWriter.ts`, since this is cold outreach on a stranger's
post, not a reply to something addressed to us. The rule transcribed
directly from `MASTER_SOCIAL_STRATEGY.md`'s "No-pitch principle": **90%+
of replies mention Fillbook not at all.** The model returns
`mentionsFillbook`/`usesLink` flags describing what it actually wrote
(checked, not assumed) alongside the reply text, stored on the row and
shown in the app so the owner can see at a glance whether a given draft
breaks from the "mostly no mention" default. When a link genuinely
belongs, the model is told to use exactly one fixed trackable link
(`fillbookhq.com/go/prospecting`, added as a new static entry in
`fillbookhq/frontend/vercel.json` — see Attribution below).

## Deduplication / memory

Two tables, both new (migration `0015_prospecting.sql`):

- `prospecting_candidates` — one row per discovered post, unique on
  `(platform, external_id)`. Tracks discovery query, full scoring
  breakdown, status lifecycle (`new -> shown -> ready -> replied` or
  `skipped`/`not_relevant`/`already_handled`/`expired`), the draft, any
  owner edit, and whether the final reply mentioned Fillbook/used a link.
  A candidate already on file is never re-inserted or re-surfaced as new.
- `prospecting_outreach` — one row per `(platform, author_external_id)`
  ever replied to via Prospecting, incrementing `reply_count` and
  `last_replied_at` on each new reply. This is what lets scoring give a
  relationship bonus for a natural second touch, and what closes the
  Inbound bridge below.

## Inbound bridge

`inboundIngestion.ts`'s `hasExistingRelationship` check previously only
considered prior `inbound_engagements` rows and tracked Creators. It now
also checks `prospecting_outreach` (via a new optional
`hasProspectingOutreach` dependency, wired in `daily-pipeline.ts`) — so if
someone you cold-replied to via Prospecting later mentions or replies to
`@FillbookHQ`, they correctly classify as `p2_relationship` (an existing
relationship) instead of showing up as a first-time stranger. This closes
a real gap: without it, a successful Prospecting conversation would have
been invisible to Inbound.

## Creators bridge

A candidate whose author has ≥2,000 followers is flagged
`creator_candidate: true` on discovery (a simple threshold, not a vetting
judgment) and shown in the app as a badge. Nothing is auto-inserted into
`creators` — the table's existing manual-curation model (readiness score
only advances alongside a logged, confirmed interaction)
is left untouched. The flag is purely a "consider
this for the Creators tab" signal for the owner.

## Attribution

`fillbookhq/frontend/vercel.json`'s `/go/` redirects are static,
hand-edited entries requiring a code deploy per link — confirmed by
auditing the actual implementation (there is no dynamic short-link
service, database table, or API backing it). Building one was out of
scope for this pass. The pragmatic version shipped instead: one new
shared link, `/go/prospecting` (`utm_source=x&utm_medium=reply&
utm_campaign=prospecting`), used whenever a draft's `usesLink` is true.
This gives real, if aggregate rather than per-reply, attribution — you
can see total clicks/signups attributed to the `prospecting` campaign in
whatever analytics already reads Fillbook's UTM parameters. Per-reply
attribution (which specific candidate's link converted) would need a real
dynamic short-link service as a follow-up; `reply_used_link` is still
recorded per-candidate so that data is ready to join against aggregate
campaign numbers once/if that's built.

## Cost controls

X search reads bill at the general `$0.005/read` rate (not the cheaper
`$0.001` Owned Reads tier used for mentions, since a search result isn't
the authenticated user's own resource — confirmed in
`docs/PROGRESS_LEDGER.md` Phase 4). `cost_events` gained a new
`event_type: 'x_search_read'` row per search call
(`recordXSearchCostEvent`), and `prospecting_search_runs` logs one row per
call (query, results, new-candidate count, estimated cost) for direct
visibility beyond the aggregate. `MONTHLY_PROSPECTING_BUDGET_USD` (`$15` as
of 2026-09-18 — originally `$8`, then `$9`) hard-stops searching for the rest
of the month once real recorded spend (not just the theoretical daily
estimate) reaches it. The gate sums real `cost_events` rows of type
`x_search_read` **and** `prospecting_llm_call` (the reply writer) over the
current UTC calendar month, so it resets on the 1st at 00:00 UTC. At
`$15 / $0.005` that is up to 3,000 search reads/month if nothing else drew on
the budget; today's 2 topics × 10 results × 3 runs/day = 60 reads/day =
`$0.30/day` (~`$9.00/month`) search-only. Because `$15` is above the shared
`$10` X API credit pool, it is that run rate — not the cap — that keeps
prospecting search inside the pool.

## Update 2026-09-04 -- 3x/day cadence added

The data flow above (step 1) described a 1x/day search via
`daily-pipeline.ts`. That step has since moved to `api/growth-pulse.ts`
(called 3x/day -- 08:00/13:00/18:00 America/Phoenix by default, see
`backend/src/config/scheduleConfig.ts` -- by
`.github/workflows/growth-pulse.yml`, a free external scheduler, since
Vercel Hobby's Cron feature is capped at 2 jobs/once-per-day each and
can't run anything 3x/day itself). `TOPICS_PER_SEARCH_RUN` dropped from 6
to 1 and `runIndex` now combines the calendar day with which of the 3
daily slots this run is (`currentRunSlot()`), so total daily topic
coverage/read volume is unchanged from the prior once/day design -- see
`prospectingEligibility.ts`'s own doc comments for the exact numbers.

Reddit prospecting was added as a second discovery source on 2026-09-04
and removed on 2026-09-06 -- Reddit closed self-service app registration
and no credentials were ever obtained. Prospecting is X-only today.

## Known limitations

- Per-reply link attribution isn't real yet (see Attribution above) --
  only aggregate campaign-level attribution exists today.
- No manual "search now" trigger in the Android app -- new candidates
  only appear once/day via the cron. Revisit if the daily queue proves
  too thin on a slow day; not built now to keep the cost model simple and
  fully server-controlled.
- `creator_candidate` is a follower-count heuristic only, not the six-axis
  vetting `MASTER_SOCIAL_STRATEGY.md` describes for real creator
  evaluation -- it's a "consider this" flag, not a verdict.
