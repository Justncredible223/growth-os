/**
 * Cost/volume guardrails for Prospecting's X search -- same pattern as
 * opportunities/autoDraftEligibility.ts (pure eligibility checks, real
 * documented reasoning per threshold, no I/O). X search reads bill at the
 * general $0.005/read rate (not the cheap $0.001 Owned Reads tier used for
 * mentions), drawing on the same shared $10 X API credit pool documented in
 * docs/PROGRESS_LEDGER.md Phase 4 -- a pool shared with mentions/inbound and
 * Partnerships discovery, and one that MONTHLY_PROSPECTING_BUDGET_USD no
 * longer sits under; see that constant's comment.
 */

import { currentScheduleSlot, getScheduleTimezone, getXProspectingSchedule } from "../config/scheduleConfig.js";

/**
 * How many of PROSPECTING_TOPICS get searched per growth-pulse run --
 * rotates through the full list over time rather than querying everything
 * at once. QUEUE_FULL_THRESHOLD below still stops search entirely once 2
 * days' worth of backlog is queued, so this can't overrun the owner's
 * strict 8-15 candidates/day reply cadence (shadowban-risk discipline) --
 * it only controls how much TOPIC DIVERSITY shows up per run while the
 * queue is empty/low.
 *
 * Raised from 1 to 2 (2026-09-07): at 1 topic/run * 3 runs/day, every
 * candidate found in one run came from the exact same search topic (real
 * example: a run that found 4 candidates, all under "too_many_trades"),
 * and the full ~35-topic list took ~14 days to cycle once. At 2/run * 3
 * runs/day = 6 topics/day, the full list cycles in under a week, and a
 * single run is no longer guaranteed to be single-topic. Cost impact: see
 * MONTHLY_PROSPECTING_BUDGET_USD's own comment. At 2 topics * 10 results *
 * 3 runs/day the search-only ceiling is $0.30/day / ~$9.00/month, which is
 * still under the shared $10 X API credit pool -- but note the pool is
 * shared with mentions/inbound and Partnerships, and since 2026-09-18 the
 * prospecting cap itself ($15) sits ABOVE the pool, so it is this run-rate,
 * not the cap, that keeps search spend inside the pool.
 */
export const TOPICS_PER_SEARCH_RUN = 2;

/** X's own minimum for max_results on this endpoint; going lower wastes a call for no benefit. Lowered from 15 -- 10 is still X's floor, and cuts read volume ~33% per query with no coverage loss that matters for a rotating discovery feed. */
export const RESULTS_PER_QUERY = 10;

/**
 * The three daily X-prospecting-and-inbound growth-pulse invocations -- approved final
 * schedule is 08:00/13:00/18:00 America/Phoenix (configurable via
 * X_PROSPECTING_TIMES/SCHEDULE_TIMEZONE, see
 * backend/src/config/scheduleConfig.ts, the single source of truth this
 * now reads from instead of a locally-hardcoded UTC array). Must be kept
 * in sync with .github/workflows/growth-pulse.yml's cron schedule, which
 * calls /api/growth-pulse at the equivalent fixed UTC times (safe to
 * fix in UTC because America/Phoenix never observes DST -- see
 * scheduleConfig.ts's doc comment). currentRunSlot() below maps whatever
 * time a run actually fires at back to the nearest configured slot, so a
 * few minutes of scheduler jitter never miscounts which slot this is.
 */
export function currentRunSlot(now: Date): number {
  return currentScheduleSlot(getXProspectingSchedule(), getScheduleTimezone(), now);
}

/** Number of X-prospecting run slots/day -- used to size the topic-rotation index. Derived from config, not a separate literal. */
export function runSlotsPerDay(): number {
  return getXProspectingSchedule().length;
}

/**
 * If this many non-terminal candidates (new/shown/drafting/ready -- the
 * same pool prospectingDailySelection.ts draws "today's set" from) are
 * already queued, skip searching for more today. Derived from the actual
 * daily target rather than picked blindly: DAILY_SET_MAX (15) * 2 = two
 * full days' worth of max-quality inventory already sitting available.
 * "Use existing quality inventory before spending to create more" --
 * discovery resumes on its own once the owner works the backlog down
 * below this.
 */
export const QUEUE_FULL_THRESHOLD = 30; // 2 * DAILY_SET_MAX (kept as a literal -- see prospectingDailySelection.ts for the source constant)

/**
 * A non-terminal candidate this old has almost certainly scrolled off
 * relevance -- the conversation it belonged to has moved on. Matches
 * opportunities/scoring.ts's own TOPIC_FATIGUE_WINDOW_DAYS (14) for
 * consistency across the codebase's two "how long before this goes
 * stale" judgment calls, rather than inventing an unrelated number.
 */
export const STALE_EXPIRY_DAYS = 14;

/**
 * Monthly ceiling for ALL Prospecting spend -- X search reads AND the
 * reply-writer's LLM calls. Raised to $15.00 on 2026-09-18 at the owner's
 * explicit instruction ("Raise the cap to $15"), after the app reported
 * "Search skipped -- this month's Prospecting budget is used up." It was
 * $9.00 before that (and $8.00 when Phase 20 first landed it; see
 * docs/PROGRESS_LEDGER.md).
 *
 * What it measures: getProspectingMonthSpendUsd (backend/src/cost/
 * costTracking.ts) sums real recorded `cost_events` rows -- not estimates --
 * for event types "x_search_read" (prospecting's X searches) and
 * "prospecting_llm_call" (the reply writer), over the current UTC calendar
 * month. So the window resets on the 1st at 00:00 UTC, and the gate trips
 * once that sum reaches this number.
 *
 * Rate math: X search reads bill at the general $0.005/read tier (not the
 * cheap $0.001 Owned Reads tier mentions use). $15.00 / $0.005 = 3,000
 * search reads/month if nothing else drew on the budget. Today's config --
 * TOPICS_PER_SEARCH_RUN=2 * RESULTS_PER_QUERY=10 * 3 runs/day = 60 reads/day
 * = $0.30/day = ~$9.00/month -- is the search-only ceiling; the reply-writer
 * LLM calls counted under the same gate are what push real spend past it.
 *
 * IMPORTANT -- this cap no longer protects the X credit pool on its own.
 * $15 is HIGHER than the shared $10 X API credit pool documented in
 * docs/PROGRESS_LEDGER.md Phase 4 and docs/PROSPECTING.md, a pool also drawn
 * on by mentions/inbound ingestion and by Partnerships discovery. There is no
 * pool-level guard anywhere in the codebase: each feature caps only its own
 * bucket. What still keeps prospecting search inside the pool is the run rate
 * above (~$9.00/month search-only), not this ceiling.
 */
export const MONTHLY_PROSPECTING_BUDGET_USD = 40.0;
// 2026-10-30: raised from $20 to $40 on the owner's instruction; the $20 cap stopped Search now on the 30th with only 50 posts stored in five days.
// 2026-10-24: raised from $15 on the owner's instruction after October's real spend (about $0.63 a day, $15.17 by the 24th) tripped
// the cap a week early. The search changes below (vet before queueing, search until one qualifies, a daily search limit) are what
// bring the daily rate down; the cap is only the last line.

/**
 * Search breadth (2026-10-24 rewrite). The owner only works a reply every 20 minutes and replies to a fresh post, so a deep buffer
 * just ages out unread (113 of 114 discovered posts were too old by the time they were looked at). A scheduled or refill search now
 * only tops the queue up to BUFFER_TARGET fresh, vetted, selectable posts; at or above that it skips. It searches one topic at a time
 * and stops as soon as the buffer is met (at most MAX_TOPICS_BUFFER topics). An owner-tapped "Search now" keeps going until it has
 * found one MORE usable post than was waiting, up to MAX_TOPICS_MANUAL topics, so one tap gives a post or an honest "nothing right now"
 * instead of the owner re-tapping four or five times.
 */
export const BUFFER_TARGET = 2;
export const MAX_TOPICS_BUFFER = TOPICS_PER_SEARCH_RUN;
export const MAX_TOPICS_MANUAL = 3;
/** Safety net on X search requests a day, counted from recorded cost events. */
export const DAILY_SEARCH_CAP = 30;
/**
 * The real daily limit is money, not requests (2026-10-25): the first version capped requests at 10, and because the futures-anchored
 * queries returned almost nothing (about 1.8 posts a search, $0.009), ten near-empty searches used the whole day. Search spend is capped
 * at this many dollars a day (October ran about $0.31 a day on searches); the request count above is only a safety net.
 */
export const DAILY_SEARCH_BUDGET_USD = 0.5;
// 2026-10-26 it was lowered from 0.50 to 0.25 for a week while the search yield was fixed (about $0.60 a day bought almost no usable
// prospect). Back to 0.50 on 2026-10-28 at the owner's call, now that the search requirements are looser.
/** The top-scoring new posts per run that get the cheap model relevance check before they can reach the queue (about $0.001 each). */
export const VET_MAX_PER_RUN = 8;

export type SearchBreadth = { skip: true; reason: string } | { skip: false; maxTopics: number; target: number };

export function planSearchBreadth(selectableCount: number, manual = false): SearchBreadth {
  if (manual) return { skip: false, maxTopics: MAX_TOPICS_MANUAL, target: selectableCount + 1 };
  if (selectableCount >= BUFFER_TARGET) {
    return { skip: true, reason: `enough_waiting (${selectableCount} selectable candidates already queued, the buffer target is ${BUFFER_TARGET})` };
  }
  return { skip: false, maxTopics: MAX_TOPICS_BUFFER, target: BUFFER_TARGET };
}

export interface EligibilityCheckResult {
  eligible: boolean;
  reason?: string;
}

export function evaluateQueueCapacity(unshownCandidateCount: number): EligibilityCheckResult {
  if (unshownCandidateCount >= QUEUE_FULL_THRESHOLD) {
    return {
      eligible: false,
      reason: `queue_full (${unshownCandidateCount} unshown candidates already queued, threshold is ${QUEUE_FULL_THRESHOLD})`,
    };
  }
  return { eligible: true };
}

/** Pure predicate -- true if a non-terminal candidate's discoveredAt is older than STALE_EXPIRY_DAYS. Used by the repository's expireStale() before each daily-set selection so a months-old unactioned post never resurfaces as if freshly found. */
export function isStaleCandidate(discoveredAt: string, now: Date): boolean {
  const ageMs = now.getTime() - new Date(discoveredAt).getTime();
  return ageMs > STALE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

export function evaluateMonthlyBudget(monthSpendUsd: number): EligibilityCheckResult {
  if (monthSpendUsd >= MONTHLY_PROSPECTING_BUDGET_USD) {
    return {
      eligible: false,
      reason: `monthly_budget_reached ($${monthSpendUsd.toFixed(4)} spent, cap is $${MONTHLY_PROSPECTING_BUDGET_USD.toFixed(2)})`,
    };
  }
  return { eligible: true };
}

/**
 * Deterministic day-based rotation through the full topic list so
 * TOPICS_PER_SEARCH_RUN queries per day still cover every configured
 * topic over time, instead of always hitting the same first N. `dayIndex`
 * is meant to be something like days-since-epoch so it advances daily and
 * wraps around the topic list.
 */
export function selectTopicsForRun<T>(topics: readonly T[], dayIndex: number, count: number): T[] {
  if (topics.length === 0) return [];
  const start = dayIndex * count % topics.length;
  const selected: T[] = [];
  for (let i = 0; i < Math.min(count, topics.length); i++) {
    selected.push(topics[(start + i) % topics.length]!);
  }
  return selected;
}

/**
 * Like selectTopicsForRun, but tier by tier: topics must already be in priority order (lowest priority number first). The run's slots
 * go to the first tier (rotating through it by runIndex); only slots the first tier cannot fill go to the next tier, and so on.
 */
export function selectPrioritizedTopicsForRun<T extends { priority?: number }>(topics: readonly T[], runIndex: number, count: number): T[] {
  const tiers = [...new Set(topics.map((t) => t.priority ?? 2))].sort((a, b) => a - b);
  const selected: T[] = [];
  for (const tier of tiers) {
    const room = count - selected.length;
    if (room <= 0) break;
    selected.push(...selectTopicsForRun(topics.filter((t) => (t.priority ?? 2) === tier), runIndex, room));
  }
  return selected;
}
