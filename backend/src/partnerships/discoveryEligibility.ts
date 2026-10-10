import type { PartnershipProspect } from "./types.js";
import { hasSufficientEvidenceForPitch } from "./discoveryScoring.js";

/**
 * Matches discoveryScoring.ts's own "medium recency" cutoff for real
 * activity evidence -- a prospect whose research is older than this no
 * longer counts as part of the fresh, still-workable backlog that lets a
 * new paid discovery run be skipped. It can still be pursued by the owner;
 * it just doesn't excuse discovery from checking for more candidates.
 */
export const BACKLOG_FRESHNESS_DAYS = 90;

/**
 * Owner-approved (2026-09-05): Partnerships doesn't need daily paid
 * discovery. A new (weekly-cadence, see SCHEDULED_CADENCE_DAYS in
 * discovery.ts) paid run only happens when the owner has fewer than this
 * many qualified, uncontacted, unsuppressed, still-fresh recommendations
 * left to work through -- otherwise there's already enough of a backlog
 * and spending more of the discovery budget just produces candidates that
 * sit unreviewed even longer.
 */
export const MIN_BACKLOG_BEFORE_SKIPPING_DISCOVERY = 5;

function isFresh(prospect: PartnershipProspect, now: Date): boolean {
  if (!prospect.researchDate) return false;
  const researched = new Date(prospect.researchDate).getTime();
  if (Number.isNaN(researched)) return false;
  const ageDays = (now.getTime() - researched) / (1000 * 60 * 60 * 24);
  return ageDays <= BACKLOG_FRESHNESS_DAYS;
}

/**
 * "Qualified, uncontacted, unsuppressed" recommendations still worth
 * pursuing before spending on more discovery -- 'qualified' and
 * 'draft_ready' are both uncontacted and still actionable; every other
 * stage is either not yet qualified (plain 'prospect'), already past
 * discovery's job (contacted onward), or an owner-driven terminal state
 * (archived / do_not_contact), so none of those count toward this
 * backlog. A prospect with a non-null suppressedReason
 * is also excluded -- it isn't real,
 * workable backlog even while its stage still technically says
 * 'qualified'. Evidence must still meet BOTH freshness
 * (BACKLOG_FRESHNESS_DAYS) and the same personalization-sufficiency bar
 * generation itself enforces (hasSufficientEvidenceForPitch) -- a stale
 * or too-thin "qualified" row doesn't actually reduce the real need for
 * more/better discovery.
 */
export function countFreshQualifiedBacklog(prospects: PartnershipProspect[], now: Date = new Date()): number {
  return prospects.filter(
    (p) =>
      (p.stage === "qualified" || p.stage === "draft_ready") &&
      !p.suppressedReason &&
      isFresh(p, now) &&
      hasSufficientEvidenceForPitch({ rawExcerpts: p.evidenceExcerpts }),
  ).length;
}

export function shouldSkipPaidDiscoveryForBacklog(prospects: PartnershipProspect[], now: Date = new Date()): boolean {
  return countFreshQualifiedBacklog(prospects, now) >= MIN_BACKLOG_BEFORE_SKIPPING_DISCOVERY;
}
