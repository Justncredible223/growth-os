import type { SupabaseClient } from "@supabase/supabase-js";
import type { XSignalAdapter } from "../signals/adapters/xAdapter.js";
import { recordXSearchCostEvent } from "../cost/costTracking.js";
import { PROSPECTING_TOPICS, type ProspectingTopic } from "./prospectingTopics.js";
import { isReplyWorthyBase, isReplyWorthyPost, isSalesFunnelOrEmptyPost, isTooSmallToBeWorthIt, withCryptoExclusions } from "./prospectingRelevance.js";
import { scoreProspectingCandidate } from "./prospectingScoring.js";
import {
  DAILY_SEARCH_BUDGET_USD,
  DAILY_SEARCH_CAP,
  RESULTS_PER_QUERY,
  VET_MAX_PER_RUN,
  currentRunSlot,
  evaluateMonthlyBudget,
  evaluateQueueCapacity,
  planSearchBreadth,
  runSlotsPerDay,
  selectTopicsForRun,
} from "./prospectingEligibility.js";
import { MAX_AGE_FOR_DAILY_SELECTION_MS, isEligibleForDailySelection } from "./prospectingFreshness.js";
import { MIN_DAILY_SET_SCORE, selectDailyWorkingSet } from "./prospectingDailySelection.js";
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
  /** Candidates already waiting in today's working set when this run started (null when the run stopped before counting). */
  selectableBefore?: number | null;
  /** Candidates in today's working set when the run ended. */
  selectableAfter?: number | null;
  /** X search requests this run made (one per topic searched). */
  searchRequests?: number;
  /** New posts the cheap model relevance check turned away before they could reach the queue. */
  screenedOut?: number;
}

/** Rows scanned to count what is waiting. Was QUEUE_FULL_THRESHOLD + 1; the selectable count needs the whole backlog (the queue endpoint reads up to 500). */
const BACKLOG_SCAN_LIMIT = 200;

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
   * The cheap model relevance check (about $0.001 a post), run on the best new posts BEFORE they can reach the queue, so everything
   * the owner is shown is already vetted (2026-10-24: the owner was tapping Search now four or five times to get one post that
   * was futures prop-firm or own-capital relevant). Returns false to turn a post away. Optional; omitted means no screening.
   * A thrown error counts as relevant: a failed check must never hide a post.
   */
  screenRelevance?: (post: { postText: string; discoveryQuery: string; authorHandle: string | null }) => Promise<boolean>;
  /** How many X search requests have been recorded today (Arizona day). Omitted means no daily limit is applied. */
  getTodaySearchCount?: () => Promise<number>;
  /** X search dollars recorded today (Arizona day): the real daily limit (DAILY_SEARCH_BUDGET_USD). Omitted means no daily spend limit is applied. */
  getTodaySearchSpendUsd?: () => Promise<number>;
  /**
   * Overrides which run-index's topic slice gets searched, bypassing the
   * normal day/schedule-slot rotation. Used by the owner-triggered manual
   * "search now" path (api/ingest.ts?source=x_prospecting) so a manual run
   * doesn't just re-search whatever the next scheduled slot would already
   * cover -- the scheduled caller (growth-pulse.ts) never passes this, so
   * its rotation is completely unaffected.
   */
  runIndexOverride?: number;
  /** Added to the run index so refills made between the scheduled slots start from a different topic than the last search (does not make the run a manual one). */
  runIndexOffset?: number;
}

/** Topics searched together in one X request (OR-ed): one near-empty request per narrow topic was burning the daily limit (2026-10-25). */
export const TOPICS_PER_QUERY = 4;
/** X allows 512 characters in a query; the wrapper (futures anchors, exclusions, -is:retweet -is:reply lang:en) takes about 270. */
const MAX_GROUPED_QUERY_CHARS = 200;

/** One X query that finds any of these topics: each topic's own query in parentheses, OR-ed, as many as fit. */
export function groupedTopicQuery(topics: ProspectingTopic[]): { query: string; used: ProspectingTopic[] } {
  const used: ProspectingTopic[] = [];
  let query = "";
  for (const topic of topics) {
    const next = query ? `${query} OR (${topic.query})` : `(${topic.query})`;
    if (next.length > MAX_GROUPED_QUERY_CHARS && used.length > 0) break;
    query = next;
    used.push(topic);
  }
  return { query, used };
}

/** Phrases a topic's query asks for: its quoted phrases, else its bare words. Lower-cased. */
function topicTerms(topic: ProspectingTopic): string[] {
  const quoted = [...topic.query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
  if (quoted.length > 0) return quoted;
  return topic.query.replace(/[()]/g, " ").split(/\s+/).filter((w) => w && !/^(OR|AND)$/i.test(w)).map((w) => w.toLowerCase());
}

/** Which topic of a grouped search a post matched: the first whose phrases appear in it, else the group's first (scoring and the "why it surfaced" label use it). */
export function topicForPost(group: ProspectingTopic[], postText: string): ProspectingTopic {
  const text = postText.toLowerCase();
  return group.find((t) => topicTerms(t).some((term) => text.includes(term))) ?? group[0]!;
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
  const backlog = await deps.repo.listByStatus(["new", "shown", "drafting", "ready"], BACKLOG_SCAN_LIMIT);
  const freshBacklogCount = backlog.filter((c) => isEligibleForDailySelection(c.postCreatedAt, now)).length;
  const queueCheck = evaluateQueueCapacity(freshBacklogCount);
  if (!queueCheck.eligible) {
    return { skipped: true, skipReason: queueCheck.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
  }

  // How many of the waiting candidates the owner would actually be shown right now (same gate + selection the queue
  // endpoint applies). Scheduled and refill runs skip when the buffer is already met; an owner-tapped "search now"
  // (runIndexOverride) always searches, and keeps going until it finds one more usable post.
  const countSelectable = async (): Promise<number> => {
    const rows = await deps.repo.listByStatus(["new", "shown", "drafting", "ready"], BACKLOG_SCAN_LIMIT);
    return selectDailyWorkingSet(
      rows.filter((c) => isReplyWorthyPost(c.postText) && !isTooSmallToBeWorthIt(c.authorFollowerCount)),
      now,
    ).selected.length;
  };
  const selectable = await countSelectable();
  const isManual = deps.runIndexOverride !== undefined;
  const breadth = planSearchBreadth(selectable, isManual);
  if (breadth.skip) {
    return { skipped: true, skipReason: breadth.reason, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  // Combines the calendar day with which of the daily run slots (see
  // backend/src/config/scheduleConfig.ts's X prospecting schedule -- 08:00/
  // 13:00/18:00 America/Phoenix by default) this invocation is so the
  // rotation advances once per run instead of once per day -- same
  // topic-list cycling behavior as before the 3x/day split, just
  // finer-grained.
  const dayIndex = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const runIndex = (deps.runIndexOverride ?? dayIndex * runSlotsPerDay() + currentRunSlot(now)) + (deps.runIndexOffset ?? 0);
  // breadth.maxTopics is how many X requests this run may make; each request covers up to TOPICS_PER_QUERY topics.
  const wanted = selectTopicsForRun(PROSPECTING_TOPICS, runIndex, breadth.maxTopics * TOPICS_PER_QUERY);
  const groups: ProspectingTopic[][] = [];
  for (let i = 0; i < wanted.length; i += TOPICS_PER_QUERY) groups.push(wanted.slice(i, i + TOPICS_PER_QUERY));

  let searchedToday = deps.getTodaySearchCount ? await deps.getTodaySearchCount() : 0;
  if (deps.getTodaySearchCount && searchedToday >= DAILY_SEARCH_CAP) {
    return { skipped: true, skipReason: `daily_search_cap (${searchedToday} searches today, the limit is ${DAILY_SEARCH_CAP})`, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  let spentToday = deps.getTodaySearchSpendUsd ? await deps.getTodaySearchSpendUsd() : 0;
  if (deps.getTodaySearchSpendUsd && spentToday >= DAILY_SEARCH_BUDGET_USD) {
    return { skipped: true, skipReason: `daily_search_budget ($${spentToday.toFixed(2)} spent on searches today, the limit is $${DAILY_SEARCH_BUDGET_USD.toFixed(2)})`, topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0, selectableBefore: selectable };
  }

  let postsRead = 0;
  let newCandidates = 0;
  let excludedAsSpam = 0;
  let excludedAsIrrelevant = 0;
  let screenedOut = 0;
  let screenedChecked = 0;
  let costUsd = 0;
  let searchRequests = 0;
  let selectableNow = selectable;
  const searched: string[] = [];
  const priorOutreachCache = new Map<string, boolean>();

  // One grouped request at a time, stopping as soon as enough usable posts are waiting.
  for (const group of groups) {
    if (deps.getTodaySearchCount && searchedToday >= DAILY_SEARCH_CAP) break;
    if (deps.getTodaySearchSpendUsd && spentToday >= DAILY_SEARCH_BUDGET_USD) break;
    // Bounded discovery-time freshness (2026-09-07 review): X's recent-search
    // endpoint supports a real start_time filter (see xAdapter.ts's own doc
    // comment), so this asks X itself to never return anything older than
    // the same window prospectingFreshness.ts enforces at selection
    // time -- catching staleness at the source instead of only filtering it
    // out after paying to read it. A sparse topic returning fewer (or zero)
    // results under this bound is the correct, intended outcome.
    const { query: groupQuery, used: groupTopics } = groupedTopicQuery(group);
    const results = await deps.adapter.searchRecentPosts(withCryptoExclusions(groupQuery), RESULTS_PER_QUERY, now, MAX_AGE_FOR_DAILY_SELECTION_MS);
    searchRequests++;
    searchedToday++;
    searched.push(...groupTopics.map((t) => t.key));
    postsRead += results.length;
    const requestCost = await recordXSearchCostEvent(deps.client, results.length, { topics: groupTopics.map((t) => t.key), query: groupQuery });
    costUsd += requestCost;
    spentToday += requestCost;

    const created: Array<{ id: string; postText: string; discoveryQuery: string; authorHandle: string | null; score: number }> = [];
    for (const post of results) {
      const topic = topicForPost(groupTopics, post.text);
      // Same $0 mechanical gate applied at queue-read time
      // (prospectingHandlers.ts's listProspectingQueue) -- checked here too
      // so an obviously off-topic post (crypto, options, forex, stocks, prop-firm referral spam,
      // newsletters, AI-trading-agent hype) is never written to prospecting_candidates in the first place.
      if (!isReplyWorthyBase(post.text) || isTooSmallToBeWorthIt(post.authorFollowerCount)) {
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
      // Sales funnels (academy / course / signal seller / "DM me" / CFD-broker promo / hashtag- or link-only posts) are counted
      // with spam: they are the same kind of post, and they never reach the queue.
      if (isSalesFunnelOrEmptyPost(post.text)) {
        excludedAsSpam++;
        continue;
      }

      const { id, created: isNew } = await deps.repo.upsertIfNew({
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
      if (isNew) {
        newCandidates++;
        created.push({ id, postText: post.text, discoveryQuery: topic.key, authorHandle: post.authorHandle, score: scoreResult.score });
      }
    }

    // Screen the best new posts with the cheap model check before they can be shown. Only posts that could clear the daily quality
    // bar are worth the call; a turned-away post is stored as not_relevant (so it is never found and screened twice).
    if (deps.screenRelevance) {
      const candidates = created.filter((c) => c.score >= MIN_DAILY_SET_SCORE).sort((a, b) => b.score - a.score);
      for (const c of candidates) {
        if (screenedChecked >= VET_MAX_PER_RUN) break;
        screenedChecked++;
        let relevant = true;
        try {
          relevant = await deps.screenRelevance({ postText: c.postText, discoveryQuery: c.discoveryQuery, authorHandle: c.authorHandle });
        } catch {
          relevant = true; // a failed check never hides a post
        }
        if (!relevant) {
          await deps.repo.updateStatus(c.id, "not_relevant", { skipReason: "screened_out_at_discovery" });
          screenedOut++;
        }
      }
    }

    selectableNow = await countSelectable();
    if (selectableNow >= breadth.target) break;
  }

  return {
    skipped: false,
    topicsSearched: searched,
    postsRead,
    newCandidates,
    excludedAsSpam,
    excludedAsIrrelevant,
    costUsd,
    selectableBefore: selectable,
    selectableAfter: selectableNow,
    searchRequests,
    screenedOut,
  };
}
