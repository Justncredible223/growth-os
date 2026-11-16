/**
 * Freshness policy for Prospecting's daily selection (2026-09-07 growth
 * review): opportunity_score is computed ONCE, at discovery time
 * (prospectingScoring.ts, called from prospectingSearch.ts), and stored as
 * a static column -- it is never recomputed. Because a candidate can sit
 * in backlog for days before it's ever selected (see
 * prospectingDailySelection.ts's DAILY_SET_MAX cap and
 * prospectingEligibility.ts's QUEUE_FULL_THRESHOLD, which together mean a
 * strong-but-old candidate keeps re-winning a daily slot every day it goes
 * unactioned), the daily selection was re-ranking on a number that
 * reflected how fresh the post was AT DISCOVERY, not how fresh it actually
 * is today -- a real, confirmed production issue: candidates commonly
 * surfaced to the owner 2-4 days old.
 *
 * This module is the fix, applied only at SELECTION time (never at
 * discovery, and never by mutating the stored opportunity_score column --
 * see prospectingDailySelection.ts for how these compose with the
 * existing score). Two independent policies:
 *
 * 1. recencyDecayMultiplier -- a soft penalty on the stored score based on
 *    CURRENT post age, so a candidate found fresh but left unactioned for
 *    days no longer keeps its original full recency credit forever.
 * 2. isEligibleForDailySelection -- a hard cutoff: a post older than
 *    MAX_AGE_FOR_DAILY_SELECTION_MS is never chosen for today's active
 *    reply set, regardless of score. No exception to this exists anywhere
 *    in fillbookhq/docs/social/MASTER_SOCIAL_STRATEGY.md or elsewhere in
 *    this codebase as of this change -- if one is ever added, it must be
 *    threaded through here explicitly and documented at the call site.
 *
 * Both treat a missing/unknown postCreatedAt as "not penalized, not
 * excluded" (multiplier 1.0, always eligible) -- there is no evidence to
 * penalize on, and an age gate should never punish missing data by
 * silently discarding an otherwise-good candidate.
 *
 * Neither function mutates anything or performs I/O -- both are pure and
 * take `now` explicitly so they're fully deterministic under test.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Below this age, a post's original discovery-time recency credit is still basically accurate -- no decay applied. */
export const RECENCY_DECAY_START_MS = 4 * HOUR_MS;

/**
 * Hard cutoff for the active reply set. Was 72h (2026-09-07); cut to 12h on 2026-09-25 after @FillbookHQ's
 * replies dropped to 1-4 views: a reply to a post that's a day or two old gets almost no views even on a
 * healthy account, and a stream of late replies looks automated. Exactly 12h is still eligible; anything
 * past it is not -- see isEligibleForDailySelection's own boundary test coverage.
 */
/**
 * Age-window test (P2, ChatGPT 2026-11-15): PROSPECTING_AGE_WINDOW_HOURS=24 widens the window to 24 hours with a gentler decay, for a 7-day
 * comparison against the 12-hour baseline (kept posts per day, relevant posts per day, the owner's replies per day, off-topic rate). Unset or
 * any other value keeps the 12-hour window, so ending the test is removing the variable. Read once per cold start.
 */
export const AGE_WINDOW_TEST_ACTIVE = process.env.PROSPECTING_AGE_WINDOW_HOURS === "24";
export const MAX_AGE_FOR_DAILY_SELECTION_MS = (AGE_WINDOW_TEST_ACTIVE ? 24 : 12) * HOUR_MS;

/**
 * Floor the decay multiplier can reach at exactly
 * MAX_AGE_FOR_DAILY_SELECTION_MS -- deliberately not 0 or too low:
 * eligibility itself (not scoring alone) is what enforces the cutoff,
 * so a candidate right at the boundary isn't crushed to a score that's
 * mathematically unreachable against MIN_DAILY_SET_SCORE (40) before that
 * cutoff even applies. 0.45 is chosen so the maximum possible score (100)
 * decayed to the floor (45) still clears the 40-point bar -- i.e. "still
 * eligible at the cutoff" is a real, reachable outcome for an exceptionally
 * strong candidate, not merely a technicality that always loses to the
 * quality bar anyway.
 */
// In the 24-hour test the floor is 0.7, so a post scoring 50 stays above the 45 bar for about 11 hours instead of about 5.5.
const DECAY_FLOOR = AGE_WINDOW_TEST_ACTIVE ? 0.7 : 0.45;

/** Null when postCreatedAt is missing/unparseable -- callers must treat that as "no evidence," never as "infinitely old" or "infinitely fresh." */
export function currentPostAgeMs(postCreatedAt: string | null, now: Date): number | null {
  if (!postCreatedAt) return null;
  const postMs = new Date(postCreatedAt).getTime();
  if (Number.isNaN(postMs)) return null;
  return now.getTime() - postMs;
}

/**
 * 1.0 for a post at or under RECENCY_DECAY_START_MS old (no penalty). Linearly decays from
 * 1.0 there to DECAY_FLOOR at MAX_AGE_FOR_DAILY_SELECTION_MS for anything in between. Never called
 * for genuinely fresh (<=24h) candidates in a way that changes their
 * ranking -- this only ever reduces (never boosts) the stored score.
 */
export function recencyDecayMultiplier(postCreatedAt: string | null, now: Date): number {
  const ageMs = currentPostAgeMs(postCreatedAt, now);
  if (ageMs === null || ageMs <= RECENCY_DECAY_START_MS) return 1;
  const decayRangeMs = MAX_AGE_FOR_DAILY_SELECTION_MS - RECENCY_DECAY_START_MS;
  const overageMs = Math.min(ageMs - RECENCY_DECAY_START_MS, decayRangeMs);
  const fraction = overageMs / decayRangeMs; // 0 at the decay start -> 1 at the cutoff (and beyond, clamped)
  return 1 - fraction * (1 - DECAY_FLOOR);
}

/**
 * The number selection should actually rank by today: the stored
 * (discovery-time) score, adjusted for how fresh the post really is right
 * now. Never mutates or persists anything -- purely a ranking-time
 * computation recomputed fresh on every call to selectDailyWorkingSet.
 */
export function effectiveScoreForSelection(storedScore: number, postCreatedAt: string | null, now: Date): number {
  return storedScore * recencyDecayMultiplier(postCreatedAt, now);
}

/**
 * Hard MAX_AGE_FOR_DAILY_SELECTION_MS cutoff for the active reply set. A
 * candidate excluded here is NOT discarded or marked terminal -- it simply
 * isn't chosen for today, same as any other backlog/deferred candidate,
 * and remains subject to the existing, separate 14-day
 * discovered_at-based expireStale() lifecycle
 * (prospectingEligibility.ts's STALE_EXPIRY_DAYS), which already has a
 * clear, tested transition to status='expired'. This function only ever
 * decides "today," never "forever."
 */
export function isEligibleForDailySelection(postCreatedAt: string | null, now: Date): boolean {
  const ageMs = currentPostAgeMs(postCreatedAt, now);
  if (ageMs === null) return true;
  return ageMs <= MAX_AGE_FOR_DAILY_SELECTION_MS;
}
