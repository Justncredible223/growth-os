import type { SupabaseClient } from "@supabase/supabase-js";
import type { XSignalAdapter } from "../signals/adapters/xAdapter.js";
import { recordXSearchCostEvent } from "../cost/costTracking.js";
import { PROSPECTING_TOPICS, type ProspectingTopic } from "./prospectingTopics.js";
import { isPlausiblyTradingRelated, withCryptoExclusions } from "./prospectingRelevance.js";
import { scoreProspectingCandidate } from "./prospectingScoring.js";
import {
  QUEUE_FULL_THRESHOLD,
  RESULTS_PER_QUERY,
  TOPICS_PER_SEARCH_RUN,
  currentRunSlot,
  evaluateMonthlyBudget,
  evaluateQueueCapacity,
  runSlotsPerDay,
  selectTopicsForRun,
} from "./prospectingEligibility.js";
import { MAX_AGE_FOR_DAILY_SELECTION_MS, isEligibleForDailySelection } from "./prospectingFreshness.js";
import type { ProspectingRepository } from "./types.js";

export interface ProspectingRunResult {
  skipped: boolean;
  skipReason?: string;
  topicsSearched: string[];
  postsRead: number;
  newCandidates: number;
  excludedAsSpam: number;
  /**
   * Rejected by prospectingRelevance.ts's isPlausiblyTradingRelated before
   * ever being stored -- real, confirmed problem (2026-09-28 owner report:
   * 70-80% of stored candidates were getting swept to 'not_relevant'):
   * this same $0 regex gate already ran at queue-read time
   * (prospectingHandlers.ts's listProspectingQueue), but never at
   * discovery/insert time here, so every crypto/prop-firm-ad/stock-
   * newsletter post a broad topic query like "drawdown" or "risk
   * management" pulled in got written to prospecting_candidates first and
   * only reclassified as not_relevant the next time the queue was
   * fetched. Checking it here instead means that noise is never written
   * at all.
   */
  excludedAsIrrelevant: number;
  costUsd: number;
}

export interface ProspectingRunDeps {
  adapter: XSignalAdapter;
  repo: ProspectingRepository;
  client: SupabaseClient;
  /** Sum of cost_events.cost_usd for event_type IN ('llm_call','x_search_read') this calendar month -- same "real recorded spend, not estimate" contract as autoDraftEligibility. */
  getMonthSpendUsd: () => Promise<number>;
  /**
   * Same system_settings.paused gate already used by autoDraftStep.ts and
   * buildXFeedPostStepDeps.ts, applied here too -- runProspectingSearch has
   * exactly one caller anywhere in this codebase (growth-pulse.ts's
   * scheduled x_prospecting step; there is no owner-triggered "search now"
   * endpoint), so checking this unconditionally, first, before even the
   * monthly-budget/queue-capacity checks, closes the gap where a paused
   * system still spent real X-search cost 3x/day. Optional and defaults to
   * "not paused" so existing tests that never cared about pause behavior
   * don't need to start passing a dep they have no opinion about.
   */
  isPaused?: () => Promise<boolean>;
  now?: Date;
  /**
   * Overrides which run-index's topic slice gets searched, bypassing the
   * normal day/schedule-slot rotation. Used by the owner-triggered manual
   * "search now" path (api/ingest.ts?source=x_prospecting) so a manual run
   * doesn't just re-search whatever the next scheduled slot would already
   * cover -- the scheduled caller (growth-pulse.ts) never passes this, so
   * its rotation is completely unaffected.
   */
  runIndexOverride?: number;
}

/**
 * The Prospecting discovery step: searches a rotating slice of
 * PROSPECTING_TOPICS, scores and dedupes results, and inserts genuinely
 * new candidates. Read-only against X (search only, no write path exists
 * anywhere in XSignalAdapter) and purely additive against Supabase --
 * never modifies or re-surfaces a candidate that's already been shown,
 * replied to, skipped, or marked not-relevant (upsertIfNew is a no-op for
 * any (platform, externalId) already on file).
 */
export async function runProspectingSearch(deps: ProspectingRunDeps): Promise<ProspectingRunResult> {
  const now = deps.now ?? new Date();

  if (await (deps.isPaused?.() ?? Promise.resolve(false))) {
    return { skipped: true, skipReason: "system_paused", topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  const monthSpend = await deps.getMonthSpendUsd();
  const budgetCheck = evaluateMonthlyBudget(monthSpend);
  if (!budgetCheck.eligible) {
    return { skipped: true, skipReason: budgetCheck.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  // Same non-terminal pool prospectingDailySelection.ts draws "today's set"
  // from -- QUEUE_FULL_THRESHOLD is derived from that pool's real target.
  // Only candidates still within the reply window (MAX_AGE_FOR_DAILY_SELECTION_MS) count toward capacity:
  // stale candidates that daily selection will reject anyway must not block
  // new fresh searches (deadlock: queue counted as full, but nothing shown).
  const backlog = await deps.repo.listByStatus(["new", "shown", "drafting", "ready"], QUEUE_FULL_THRESHOLD + 1);
  const freshBacklogCount = backlog.filter((c) => isEligibleForDailySelection(c.postCreatedAt, now)).length;
  const queueCheck = evaluateQueueCapacity(freshBacklogCount);
  if (!queueCheck.eligible) {
    return { skipped: true, skipReason: queueCheck.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  // Combines the calendar day with which of the daily run slots (see
  // backend/src/config/scheduleConfig.ts's X prospecting schedule -- 08:00/
  // 13:00/18:00 America/Phoenix by default) this invocation is so the
  // rotation advances once per run instead of once per day -- same
  // topic-list cycling behavior as before the 3x/day split, just
  // finer-grained.
  const dayIndex = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const runIndex = deps.runIndexOverride ?? dayIndex * runSlotsPerDay() + currentRunSlot(now);
  const topics: ProspectingTopic[] = selectTopicsForRun(PROSPECTING_TOPICS, runIndex, TOPICS_PER_SEARCH_RUN);

  let postsRead = 0;
  let newCandidates = 0;
  let excludedAsSpam = 0;
  let excludedAsIrrelevant = 0;
  let costUsd = 0;
  const priorOutreachCache = new Map<string, boolean>();

  for (const topic of topics) {
    // Bounded discovery-time freshness (2026-09-07 review): X's recent-search
    // endpoint supports a real start_time filter (see xAdapter.ts's own doc
    // comment), so this asks X itself to never return anything older than
    // the same window prospectingFreshness.ts enforces at selection
    // time -- catching staleness at the source instead of only filtering it
    // out after paying to read it. Sharing the one MAX_AGE_FOR_DAILY_SELECTION_MS
    // constant keeps discovery and selection aligned; a sparse topic
    // returning fewer (or zero) results under this bound is the correct,
    // intended outcome, not a bug -- a genuinely quiet topic this run just
    // means fewer new candidates today, never stale ones let through.
    const results = await deps.adapter.searchRecentPosts(withCryptoExclusions(topic.query), RESULTS_PER_QUERY, now, MAX_AGE_FOR_DAILY_SELECTION_MS);
    postsRead += results.length;
    costUsd += await recordXSearchCostEvent(deps.client, results.length, { topic: topic.key, query: topic.query });

    for (const post of results) {
      // Same $0 mechanical gate applied at queue-read time
      // (prospectingHandlers.ts's listProspectingQueue) -- checked here too
      // so an obviously off-topic post (crypto, prop-firm referral spam,
      // stock-market newsletters, AI-trading-agent hype -- all confirmed
      // real noise sources for broad topic queries like "drawdown" or
      // "risk management") is never written to prospecting_candidates in
      // the first place, instead of being stored and only reclassified
      // 'not_relevant' the next time the queue happens to be fetched.
      if (!isPlausiblyTradingRelated(post.text)) {
        excludedAsIrrelevant++;
        continue;
      }

      let previouslyEngaged = false;
      if (post.authorId) {
        if (priorOutreachCache.has(post.authorId)) {
          previouslyEngaged = priorOutreachCache.get(post.authorId)!;
        } else {
          previouslyEngaged = await deps.repo.hasPriorOutreach("x", post.authorId);
          priorOutreachCache.set(post.authorId, previouslyEngaged);
        }
      }

      const scoreResult = scoreProspectingCandidate({
        topic,
        postText: post.text,
        postCreatedAt: post.createdAt,
        publicMetrics: post.publicMetrics,
        authorFollowerCount: post.authorFollowerCount,
        authorVerified: post.authorVerified,
        previouslyEngaged,
        now,
      });

      if (scoreResult.excluded) {
        excludedAsSpam++;
        continue;
      }

      const { created } = await deps.repo.upsertIfNew({
        platform: "x",
        externalId: post.id,
        discoveryQuery: topic.key,
        authorHandle: post.authorHandle,
        authorExternalId: post.authorId,
        authorName: post.authorName,
        authorFollowerCount: post.authorFollowerCount,
        authorVerified: post.authorVerified,
        postText: post.text,
        postUrl: `https://x.com/i/web/status/${post.id}`,
        postCreatedAt: post.createdAt ? post.createdAt.toISOString() : null,
        publicMetrics: post.publicMetrics ?? {},
        opportunityScore: scoreResult.score,
        scoreBreakdown: scoreResult.breakdown,
        creatorCandidate: (post.authorFollowerCount ?? 0) >= 2000,
        discoveredAt: now.toISOString(),
      });
      if (created) newCandidates++;
    }
  }

  return {
    skipped: false,
    topicsSearched: topics.map((t) => t.key),
    postsRead,
    newCandidates,
    excludedAsSpam,
    excludedAsIrrelevant,
    costUsd,
  };
}
