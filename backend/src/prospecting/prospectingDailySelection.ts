import type { ProspectingCandidate } from "./types.js";
import { effectiveScoreForSelection, isEligibleForDailySelection } from "./prospectingFreshness.js";

/**
 * Turns the accumulated candidate pool into a real daily working set --
 * "8-15 strongest opportunities/day WHEN that much quality exists" is a
 * directional target (2026-09-03 growth review), not a quota to force-fill.
 * This is the SELECT DAILY WORKING SET step in DISCOVER -> FILTER -> RANK
 * -> SELECT DAILY WORKING SET -> DRAFT -> HUMAN REVIEW -> ... -- everything
 * before this point (search, spam exclusion, scoring) already happened in
 * prospectingSearch.ts/prospectingScoring.ts; this only re-ranks and caps
 * what's already a clean, scored pool.
 */
export const DAILY_SET_MIN = 8;
export const DAILY_SET_MAX = 15;

/**
 * Grounded in this project's own first real search run (2026-09-03): after
 * manual editorial review removed spam/promo/off-topic noise, the 43
 * genuine survivors scored min 38.4, median 45.9, p25 43.7, max 69.9. 40
 * sits just under that real p25 -- excludes roughly the weakest quarter of
 * already-vetted candidates from today's set (they stay in backlog for a
 * day they might rank better on, not discarded) without needing an
 * invented number.
 */
// 2026-10-15: 40 -> 45. "Fewer, better replies" is a voice rule the writer cannot enforce; a higher bar before a post is
// even offered is where it actually gets enforced. Tune it from the follower data.
export const MIN_DAILY_SET_SCORE = 45;

export interface DailySelectionResult {
  selected: ProspectingCandidate[];
  /** Eligible candidates that scored high enough but lost out to the one-per-author rule or the 15-cap -- still real backlog, not discarded. */
  deferred: ProspectingCandidate[];
  /** Eligible candidates that simply didn't clear MIN_DAILY_SET_SCORE (using today's freshness-adjusted effective score, not the frozen stored one -- see prospectingFreshness.ts). */
  belowQualityBar: ProspectingCandidate[];
  /**
   * Excluded from today's set purely for being older than
   * prospectingFreshness.ts's MAX_AGE_FOR_DAILY_SELECTION_MS (12h) --
   * never scored, never compared against MIN_DAILY_SET_SCORE. NOT
   * discarded: still real backlog, subject only to the existing, separate
   * 14-day discovered_at-based expireStale() lifecycle. Kept as its own
   * bucket (not folded into belowQualityBar) so "too old to consider
   * today" stays distinguishable from "considered today, didn't clear the
   * bar" for anyone inspecting selection results.
   */
  tooOldForToday: ProspectingCandidate[];
}

/**
 * Selects today's working set from an already-scored, already-clean
 * candidate pool (spam/promo already excluded upstream). Pure function --
 * no I/O, easy to test against real exported data.
 *
 * Rules, in order:
 * 1. Exclude anything older than the 12h freshness cutoff
 *    (prospectingFreshness.ts's isEligibleForDailySelection) -- never
 *    scored or compared, just set aside as tooOldForToday.
 * 2. Sort the rest by an EFFECTIVE score -- the stored (discovery-time)
 *    opportunity_score adjusted for how fresh the post actually is right
 *    now (prospectingFreshness.ts's effectiveScoreForSelection), not the
 *    frozen value alone. This is what closes a real, confirmed production
 *    issue: a candidate discovered fresh but left unactioned for days kept
 *    re-winning a daily slot on its original recency credit, so candidates
 *    commonly surfaced to the owner 2-4 days old. Ties broken by more
 *    recent discovery first, so a fresher post wins a tie over a stale one.
 * 3. Drop anything under MIN_DAILY_SET_SCORE (measured against the
 *    effective score) -- never force-fill weak or gone-stale posts just
 *    to hit a count.
 * 4. At most one candidate per author per day ("Avoid interacting
 *    repeatedly with the same account simply because search surfaced
 *    multiple posts. One strong interaction is better than looking
 *    automated.") -- keeps that author's highest-scored post, defers the
 *    rest.
 * 5. Cap at DAILY_SET_MAX. If fewer than DAILY_SET_MAX/DAILY_SET_MIN
 *    survive steps 1-4, that's a correct, expected result -- show fewer,
 *    not padding.
 */
export function selectDailyWorkingSet(candidates: ProspectingCandidate[], now: Date = new Date()): DailySelectionResult {
  const tooOldForToday: ProspectingCandidate[] = [];
  const withinFreshnessWindow: ProspectingCandidate[] = [];
  for (const candidate of candidates) {
    (isEligibleForDailySelection(candidate.postCreatedAt, now) ? withinFreshnessWindow : tooOldForToday).push(candidate);
  }

  const scored = withinFreshnessWindow.map((candidate) => ({
    candidate,
    effectiveScore: effectiveScoreForSelection(candidate.opportunityScore, candidate.postCreatedAt, now),
  }));

  const sorted = scored.sort((a, b) => {
    if (b.effectiveScore !== a.effectiveScore) return b.effectiveScore - a.effectiveScore;
    return new Date(b.candidate.discoveredAt).getTime() - new Date(a.candidate.discoveredAt).getTime();
  });

  const belowQualityBar = sorted.filter((s) => s.effectiveScore < MIN_DAILY_SET_SCORE).map((s) => s.candidate);
  const eligible = sorted.filter((s) => s.effectiveScore >= MIN_DAILY_SET_SCORE).map((s) => s.candidate);

  const seenAuthors = new Set<string>();
  const selected: ProspectingCandidate[] = [];
  const deferred: ProspectingCandidate[] = [];

  for (const candidate of eligible) {
    const authorKey = candidate.authorExternalId ?? candidate.authorHandle ?? candidate.id;
    const alreadyPicked = seenAuthors.has(authorKey);
    if (!alreadyPicked && selected.length < DAILY_SET_MAX) {
      seenAuthors.add(authorKey);
      selected.push(candidate);
    } else {
      deferred.push(candidate);
    }
  }

  return { selected, deferred, belowQualityBar, tooOldForToday };
}
