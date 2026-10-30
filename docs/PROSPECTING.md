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

## Update 2026-10-14 -- cost cut

- The scheduled search counts how many candidates are already *selectable* (reply-worthy, under 12h old, past the quality
  bar, one per author). 15 or more waiting: no X read at all. 8 to 14: one topic instead of two. Fewer than 8: unchanged.
  The owner-triggered "search now" always searches the full slice.
- `since_id` per query was considered and rejected: topics come round about every 8 days while discovery already asks X for
  only the last 12 hours, so a per-topic cursor would never exclude anything.
- Drafting is owner-tap only (`approvals?resource=prospecting`, action `draft`); nothing pre-drafts. A second draft call on a
  card that already has a draft returns it without a relevance check or model call.
- Results' own-tweets read (`x_own_posts`) now runs once a day and asks X only for the tweets whose views can still change.
- Step summaries for `x_prospecting` and `x_own_posts` end with `X reads: n posts $x; LLM: n calls $y`.

## Futures only, vetted before it is shown, searched on demand (2026-10-24)

Owner direction: Prospecting should only look for futures posts and creators in a prop-firm or own-capital context. Forex, stock,
options and crypto posts were reaching the queue and the owner was tapping "Search now" four or five times to find one usable post.

- **Futures only.** `prospectingRelevance.ts` now needs at least one futures or futures-prop-firm signal (the word futures, a futures
  ticker, a futures prop firm or platform, a futures prop rule such as the trailing drawdown or consistency rule). Generic trading
  words alone no longer qualify. Options, forex and stock posts are excluded unless they also name futures explicitly; "prop firm" alone
  does not rescue them (forex prop firms exist). Every X query also requires a futures anchor and leaves crypto and options terms
  out (`FUTURES_QUERY_ANCHORS`, `OPTIONS_QUERY_EXCLUSIONS`), so those posts are never read or paid for.
- **Vetted before shown.** The cheap model relevance check (about $0.001 a post) now runs at discovery on the best new posts (at most 8 a
  run, `screenRelevance`), so a post that is not futures prop-firm or own-capital relevant is stored as `not_relevant` and never reaches
  the queue. A failed check never hides a post.
- **Search until found.** A scheduled or refill search only tops the queue up to 2 usable posts and stops as soon as that is met (one topic
  at a time, at most 2). An owner-tapped "Search now" keeps going, topic by topic, until it finds one more usable post, at most 3 topics.
- **Refill after a reply.** Marking a reply posted starts a background refill (`prospectingRefill.ts`, `waitUntil`), so a fresh post is
  waiting when the 20-minute cooldown ends. It never throws and cannot delay saving the reply.
- **Limits.** Searches are limited by money, not count: at most $0.25 (temporarily, see below; $0.50 before 2026-10-26) of X search spend a day (`DAILY_SEARCH_BUDGET_USD`, from cost
  events, Arizona day), with 30 requests as a safety net, and a monthly cap of $20 (was $15). The first version capped requests at 10;
  because the futures-anchored per-topic queries returned about 1.8 posts a search (down from 4 to 7), ten near-empty searches used the
  whole day. The Android app shows the skip reasons `daily_search_budget` and `daily_search_cap` as raw text until it is next rebuilt.
- **Denser searches (2026-10-25).** Each X request now ORs up to four topics (`groupedTopicQuery`, `TOPICS_PER_QUERY`), still behind the
  futures anchor and exclusions, so a request returns more relevant posts; each post is scored against the topic it matched
  (`topicForPost`).

- **Maybe list (2026-10-26).** `GET /api/approvals?resource=prospecting` also returns an optional `maybe` array: posts the AI relevance screen turned away (status `not_relevant`, `skip_reason = screened_out_at_discovery`) in the last 7 days, newest first, at most 15 (`id, authorHandle, postText, postUrl, score, at`). Read-only, no migration. The app shows a collapsed "Maybe (n)" section at the end of the queue with "Open on X" only. There is no "This was fine" button: no existing flag or audit mechanism records that judgement safely, and the post is already stored as `not_relevant`.
- **Draft anyway (2026-10-26).** `POST /api/approvals?resource=prospecting {action:"draft-maybe", id}` (owner token only; the automation token gets 401). Accepts only a Maybe row (status `not_relevant`, `skip_reason = screened_out_at_discovery`, updated in the last 7 days); anything else is 409. It skips the regex pre-filter, the cheap relevance check and the drafter's `isRelevant` gate (the owner has judged the post) and adds a line to the drafter's user message saying the owner chose this post and to write a short harmless reply even if it is a poor fit. Every other drafting rule runs unchanged (voice rules, no link, no Fillbook in cold replies, recovery and mention-budget rules, claims, dashes, 280 characters, retries, `prospecting-draft` cost recording, daily LLM ceiling). Only after an accepted draft does the row change: status `not_relevant` -> `ready`, with `owner_override` and `owner_override_at` stored in `score_breakdown` (no migration). On any failure nothing changes and the row stays in `maybe`. For 24 hours after that the card stays in the queue regardless of the 12-hour freshness window, the score floor and the free spam gates; the reply cap and pacing apply when it is marked Replied, as for any card. The response is the same JSON as `draft`; the next queue GET lists the card and no longer lists it in `maybe`.

- **Search yield pass (2026-10-26).** Four "Search now" runs in a morning produced nothing (57 searches, $1.84 in three days, 5 kept, all 5
  rejected by the AI check): topic nouns such as "prop firm" and "trailing drawdown" pull in brand and content accounts. Three temporary,
  reversible changes: (1) `DAILY_SEARCH_BUDGET_USD` is $0.25 for one week (back to 0.5 in `prospectingEligibility.ts` after about
  2026-11-02; the 30-request safety net is unchanged); (2) every topic request ends in `-has:links` (`NO_LINKS_QUERY_EXCLUSION`), so
  stream teasers and promo posts are never read; creator `from:` requests are left without it because a vetted creator's useful posts
  may legitimately carry a link or media and the creator gate is already narrow; (3) topics have a `priority`: pain phrases (blown
  account, broke rules, why I lost, revenge trading, losing streak, sized up, tilt, ...; `PAIN_TOPIC_KEYS`) get every slot first and noun
  topics (prop firm, funded account, drawdown, journal, ...) only fill slots the pain topics cannot (`selectPrioritizedTopicsForRun`,
  `topicsInSearchOrder`). To undo (3), call `selectTopicsForRun(PROSPECTING_TOPICS, ...)` again in `prospectingSearch.ts`. Watch: pain
  phrases still sit behind the futures anchor, so they may return few posts; see the variant proposal in the PR.

Why: October's real spend was about $0.63 a day ($15.17 by the 24th), 113 of 114 discovered posts were too old to use, and the owner's
replies were reaching a median of 9 views. Revert switches: none needed; the old behavior is in git history (#227 and earlier).

## The Fillbook option, option C (2026-10-25)

Owner direction: the replies should market Fillbook when it fits, not only talk to people. Since the Oct 16 two-option test, neither
cold reply ever named Fillbook (the account's Results showed replies that did reached the fewest people, from a very small sample).

- **A third draft option, "fillbook".** Alongside "sharp" and "helpful", the draft may carry `fillbookReply`: one useful point about their
  situation, then ONE sentence naming Fillbook and what one vetted view would show them (Account Health buffer, the Reports splits, the
  rule simulator, Edge Score; `formatShowcaseViews()`). Two sentences at most, no link, no pitch phrases, no promise. Sharp and helpful
  still never name Fillbook unless the post asked about it.
- **Offered only when allowed.** Not while recovery mode is on, and not once more than 1 in 5 of the last 12 posted replies named
  Fillbook (`prospectingMentionBudget.ts`). The model is told ALLOWED or NOT ALLOWED in the user message and may leave it empty when no
  view fits.
- **Never costs the other two.** The handler keeps the option only if it names Fillbook, picks one real view, has no link and passes
  the same guardrails (`acceptedFillbookOption`); otherwise it is dropped without a retry.
- **Measured.** Posted text is matched back to the option (`posted_style = "fillbook"`), and the Monday review's "Reply style results"
  lists it with median views and likes next to sharp and helpful. The Android app labels any option style, so it shows as a
  "Fillbook" tab with no app rebuild.

## Futures evidence is required, not just "prop firm" (2026-10-25)

Two cards got through on the bare words "funded account" and "prop firm": a forex funded-account brag ("Alhamdulillah a $50K Funded account
secured") and a creator's teaser ("Video later today on how to pass prop firm challenges"). A mention of a prop firm or funded account no
longer counts as a futures signal (forex and CFD prop firms exist). A post needs the word futures, a futures ticker, a futures prop firm or
platform, or a rule only futures prop accounts have (trailing drawdown, consistency rule, trading combine). The X query anchors use the same
list. Video and stream teasers, "new video", "going live" and "funded account secured" posts are treated as broadcasts. The model relevance
prompts (screen at discovery, cheap check, draft schema and prompt) say the same: no futures evidence means not relevant. The queue applies
the free filter on every read, so cards already waiting that fail it disappear without a redeploy of data.

## The creator watchlist (2026-10-25)

Searching by phrase finds about 3 usable posts per X request, because fresh futures-trader conversations are thin. The watchlist reads
people instead (`prospectingWatchlist.ts`).

- **Who is on it.** It builds itself from `prospecting_candidates`, no table and no migration: an author with at least one vetted post
  (not turned away, opportunity score 50 or more, 1,000 to 300,000 followers, last 30 days) or one the owner has replied to. Authors whose
  posts were mostly turned away, and anyone outside the follower range, are left off. Up to 45 creators. Hand-picked creators can be added
  with the `PROSPECTING_WATCHLIST_HANDLES` environment variable (comma-separated, no @) or `PROSPECTING_SEED_CREATORS` in code; seeds come first.
- **How it is read.** One X request per group of about 15 creators: `(from:a OR from:b ...)`, top-level posts only (the adapter adds
  `-is:retweet -is:reply lang:en`), last 12 hours, same $0.005 a post read as any search and under the same daily budget. The search only uses
  the watchlist once four or more creators are known.
- **Order.** Scheduled and refill runs (2 requests) read the creators first, then topics. An owner-tapped "Search now" (up to 3) alternates
  creators, topics, creators. Each run starts from a different group of creators.
- **Same gates.** A creator's post is not trusted blindly: it needs futures evidence, must clear the promo and broadcast filters and the
  model screen, and scores like any other post plus 6 points for being a vetted creator. It is labelled with the topic its words match,
  else "Futures trader".
- **Why.** Replies under the same few creators build a relationship, and the follower range (1k to 300k) is the size of account that reads
  and answers replies.

## The funnel log (2026-10-25)

Two days in a row the daily search budget was spent and the queue still had nothing usable, with no record of where posts died. Each X
search request now writes what happened to its posts on the same `x_search_read` cost event (`context.funnel`): posts dropped by each free
gate (`options`, `forex_stock`, `crypto`, `no_futures_evidence`, `not_trading`, `promo`, `broadcast`, `ai_hype`, `small_author`, `spam`,
`sales_funnel`), posts inserted, duplicates, how many the model check looked at and turned away (`model_screen`), up to 10 short samples
of dropped posts with the reason, and up to 4 kept ones. Read it with `GET /api/summary?view=prospecting-runs` (latest 60 requests, newest
first). The cost event is written after the request is processed, in a `finally`, so spend is still recorded if processing fails.
`whyNotReplyWorthy` in `prospectingRelevance.ts` gives the first reason a post fails the free gate and agrees with `isReplyWorthyPost`.

## Suggested interaction and angle (2026-10-28)

Each scored candidate now carries `suggestedAction` (reply, quote or engage), `suggestedAngle` (one sentence) and `angleKind` (answer, loss, math, detail, like) in its score breakdown (`src/prospecting/prospectingInteraction.ts`, rules in the file). The Prospecting card shows "Suggested: Reply. <angle>" under the post. It is a suggestion only: the app still drafts replies, and a quote or a like is done by hand.

- engage: a thread with 40+ replies, or a post under 40 characters.
- quote: 1,000+ impressions and 10x the author's followers, a statement (no question) with numbers.
- reply otherwise; the angle follows the post: question, loss or breach, numbers, or a detail.

The weekly review's "Where replies reached people" section now also groups replies by `angleKind` and by a suggested quote, once a group has 3 replies. Candidates scored before this change have no suggestion and appear in no angle group. The app needs a new build to show the line; the server side works without it.

## Looser spam formatting check (2026-10-28)

The "listicle or ad formatting" check dropped any post with four or more short lines without a full stop. That caught real traders who write one sentence per line (a futures account posting "Be quick with the loss / Slow with the winner / ..." was dropped as spam every day). It now also needs three fragment lines: a bare dot, an emoji bullet, or three words or fewer. Ad copy and tag lists still match; one-sentence-per-line posts pass.

Left as is on purpose: the 12-hour age cutoff (cut from 72h on 2026-09-25 because replies to day-old posts got 1-4 views) and the futures-evidence requirement (the owner's futures-only rule).

## No repeated searches (2026-10-28)

A topic search whose exact query was already made in the last 3 hours is not made again (`RECENT_QUERY_WINDOW_MS`, `getRecentSearchQueries`). X's recent search returns the same newest posts for the same query, so a repeat read the same ~10 posts (all duplicates) for the same $0.05; three repeats in 14 seconds were seen on 2026-10-29. The run plans a few more topic groups than it needs (the next slices of the same rotation), drops the recent ones and searches the first fresh ones. When every group was searched recently the run makes no request, spends nothing, and reports `searched_recently`. A failed read of the recent searches never blocks a search. The 12-hour post age cutoff is unchanged.

- **More replies (2026-10-29).** Searches returned 1 to 10 posts each and almost all were dropped, so the queue sat empty. Owner: Fillbook is a futures trading journal and should reply wherever a futures trader talks about their trading. (1) The trading gate accepts everyday trader talk (trade, stopped out, win rate, risk-reward, P&L, red/green day, setup, journaling). (2) The futures gate accepts futures-only vocabulary without the word "futures": Apex, Topstep, sim funded, opening range, ORB, DOM, RTH, Globex, micro/mini contracts, "N ticks". (3) The X query anchor adds apex, ORB and ticks, and the topic part of a grouped query is capped at 180 characters so the wrapped query stays under X's 512. Unchanged: a bare "prop firm" or "funded account" still does not count, the 12-hour freshness cutoff, and the AI relevance screen. The Maybe list shows what the screen turns away.

- **Monthly cap $40 (2026-10-30).** `MONTHLY_PROSPECTING_BUDGET_USD` is $40 (was $20). The $20 cap was reached on Oct 30 ($20.06) and stopped Search now. The daily $0.50 limit and 30-request safety net are unchanged.

- **Index and session language (2026-10-30).** The futures gate also accepts Nasdaq, S&P 500, US30, Dow Jones, crude oil and NY/New York session/open, and the X query anchor adds nasdaq. Found in the first run after the cap rose: a "Nasdaq NY Session Trade" post and a plain prop-firm-rules post were dropped for no futures evidence. Stock and forex posts are still turned away by the other-market check; a bare prop firm or funded account still does not count.

- **More pain phrases (2026-10-30).** Only the 20 first-person pain topics were being searched (60 searches in 5 days touched 20 topics, in the same few groups, so most reads were repeats). Added 12 more single-phrase pain topics at priority 1: blew my eval, failed my eval, lost my funded, payout denied, revenge traded, stopped out again, moved my stop, cut my winners, ignored my plan, same mistake, tilted, red day. They rotate in with the rest and go through the same gates, the 3-hour repeat skip and the budget. Measure with `GET /api/summary?view=prospecting-runs`: stored posts per dollar by topic.

- **Eval, funded and payout phrases search without the futures anchor (2026-10-30).** The first run on the 12 new pain phrases read 0 posts for most groups: every topic request must also match a futures word (FUTURES_QUERY_ANCHORS), and "blew my eval again" rarely does. Topics flagged `unanchored` (blew my eval, failed my eval, lost my funded, payout denied) are grouped only with each other and sent without the anchor; they keep the crypto and options exclusions and no-links. The free gates and the model screen still require futures evidence after the read, so a forex or stock post costs its read (about $0.005) and is dropped. Measure: stored posts per dollar for these four in `GET /api/summary?view=prospecting-runs`; if they read mostly forex posts, flip the flag off in `prospectingTopics.ts`.
