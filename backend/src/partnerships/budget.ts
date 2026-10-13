import type { SupabaseClient } from "@supabase/supabase-js";
import { selectCostEvents, sumCostUsd } from "../cost/costTracking.js";

/**
 * Independent monthly budget line, same reasoning as
 * X_FEED_POST_MONTHLY_BUDGET_USD (dailyXFeedPost.ts): a separate feature's
 * spend must never compete with or be silently starved by auto-draft's,
 * prospecting's, or x-feed-post's own budgets.
 *
 * $12.00 default explicitly approved by the owner (2026-09-05, raised
 * from the original $3.00 the same day after that cap was hit on day one
 * with only 8 real prospects loaded). At the measured ~$0.06-0.21 cost
 * per draft attempt (1 writer + up to 9 reviewers, see
 * GENERATION_ATTEMPT_RESERVATION_CEILING_USD in partnershipsHandlers.ts),
 * this comfortably covers dozens of draft attempts a month even at the
 * worst-case per-attempt cost. Overridable via PARTNERSHIP_MONTHLY_BUDGET_USD
 * without a code change if the owner wants a different number later.
 */
export const PARTNERSHIP_MONTHLY_BUDGET_USD = Number(process.env.PARTNERSHIP_MONTHLY_BUDGET_USD) || 12.0;

/**
 * Sub-allocations of the shared $12 cap, owner-approved (2026-09-05): daily
 * paid discovery isn't needed (see discoveryEligibility.ts's backlog gate),
 * so discovery/enrichment gets a deliberately small $2 slice, leaving $10
 * reserved for pitch generation/review -- the actual product-value work.
 * Both are enforced ATOMICALLY alongside the shared cap by
 * reserve_partnership_budget (see budgetReservation.ts and migration 0024):
 * a request must clear its own bucket's remaining allowance AND the shared
 * cap, computed from real month-to-date spend plus any other in-flight
 * reservation, before it's allowed to proceed. These two deliberately don't
 * need to sum to exactly PARTNERSHIP_MONTHLY_BUDGET_USD to stay correct --
 * they're each an independent, narrower ceiling layered under the one
 * shared cap, not a partition of it -- but they do sum to it under today's
 * defaults, and a test asserts that stays true.
 */
export const PARTNERSHIP_DISCOVERY_BUDGET_USD = Number(process.env.PARTNERSHIP_DISCOVERY_BUDGET_USD) || 2.0;
export const PARTNERSHIP_GENERATION_BUDGET_USD = Number(process.env.PARTNERSHIP_GENERATION_BUDGET_USD) || 10.0;

export interface EligibilityCheckResult {
  eligible: boolean;
  reason?: string;
}

export function evaluatePartnershipBudget(monthSpendUsd: number, budgetUsd: number = PARTNERSHIP_MONTHLY_BUDGET_USD): EligibilityCheckResult {
  if (budgetUsd <= 0) {
    return { eligible: false, reason: "partnership_budget_disabled (PARTNERSHIP_MONTHLY_BUDGET_USD explicitly set to 0)" };
  }
  if (monthSpendUsd >= budgetUsd) {
    return { eligible: false, reason: `monthly_budget_reached ($${monthSpendUsd.toFixed(4)} spent, cap is $${budgetUsd.toFixed(2)})` };
  }
  return { eligible: true };
}

/**
 * Real recorded spend this calendar month across BOTH of Partnerships'
 * own cost sources -- pitch-generation LLM calls ("partnership_llm_call")
 * and discovery's X search reads ("partnership_x_search_read", see
 * costTracking.ts's recordPartnershipXSearchCostEvent) -- summed under
 * ONE gate, per the mission's Phase 7 requirement that discovery and
 * generation share a single budget rather than each getting its own.
 * Fully independent of every other feature's budget line (Prospecting's
 * own X-search spend is tracked under the separate "x_search_read" type).
 */
export async function getPartnershipMonthSpendUsd(client: SupabaseClient, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const rows = await selectCostEvents(client, "cost_usd", { since: monthStart, until: nextMonthStart, eventTypes: ["partnership_llm_call", "partnership_x_search_read"], label: "getPartnershipMonthSpendUsd" });
  return sumCostUsd(rows);
}
