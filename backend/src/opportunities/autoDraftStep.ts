import type { OpportunityRepository } from "./types.js";
import type { RunCampaignDeps } from "../content/runCampaignForOpportunity.js";
import { runCampaignForOpportunity } from "../content/runCampaignForOpportunity.js";
import type { AutoDraftRunRepository } from "./autoDraftRunRepository.js";
import { evaluateBacklog, evaluateMonthlyBudget, filterEligibleOpportunities, MAX_CALLS_PER_RUN } from "./autoDraftEligibility.js";
import { estimateCostUsd } from "../cost/costTracking.js";
import type { LlmUsage } from "../content/llmClient.js";

export type AutoDraftStatus = "already_ran" | "skipped" | "drafted" | "failed";

export interface AutoDraftStepResult {
  status: AutoDraftStatus;
  skipReason?: string;
  opportunityId?: string;
  campaignId?: string;
  opportunitiesConsidered: number;
  opportunitiesEligible: number;
  aiCalls: number;
  costUsd: number;
  error?: string;
}

export interface AutoDraftStepDeps {
  /** Ready-made drafting deps. Production passes `loadRunCampaignDeps` instead so none of its setup reads happen on a day the step skips. */
  runCampaignDeps?: RunCampaignDeps;
  usageLog?: LlmUsage[];
  /** Builds the drafting deps on demand, only once every guard has passed and an opportunity is actually about to be drafted. */
  loadRunCampaignDeps?: () => Promise<{ runCampaignDeps: RunCampaignDeps; usageLog: LlmUsage[] }>;
  opportunityRepo: OpportunityRepository;
  runRepo: AutoDraftRunRepository;
  countReadyForOwnerAssets: () => Promise<number>;
  listOpportunityIdsWithCampaigns: () => Promise<Set<string>>;
  /**
   * Backs the Settings/System screens' "Pause System" control (see
   * migration 0006_system_settings.sql) -- checked before the run is
   * even claimed, so flipping this off mid-day doesn't cost a real
   * auto_draft_runs row and the step can still run later that same day
   * once un-paused.
   */
  isPaused: () => Promise<boolean>;
  /**
   * Called with the selected opportunity's id right before drafting
   * starts -- lets the production Supabase wiring tag cost events with
   * the real id even though it wasn't known when runCampaignDeps was
   * built (selection happens in here, after that). No-op in tests.
   */
  onOpportunitySelected?: (opportunityId: string) => void;
}

/**
 * The whole safe daily auto-draft policy in one place: idempotency claim
 * -> backlog cap -> monthly budget cap -> eligibility -> select best ->
 * draft -> record outcome. "No draft" is always a valid, correctly-
 * recorded outcome, not a failure -- see docs/PROGRESS_LEDGER.md.
 * Deliberately takes injected deps (not a raw SupabaseClient) so this
 * whole policy is unit-testable with in-memory fakes; see
 * api/daily-pipeline.ts for the production Supabase wiring.
 */
export async function runAutoDraftStep(deps: AutoDraftStepDeps, runDate: string, now: Date): Promise<AutoDraftStepResult> {
  if (await deps.isPaused()) {
    return { status: "skipped", skipReason: "system_paused", opportunitiesConsidered: 0, opportunitiesEligible: 0, aiCalls: 0, costUsd: 0 };
  }

  const claimedId = await deps.runRepo.claimRun(runDate);
  if (claimedId === null) {
    return { status: "already_ran", opportunitiesConsidered: 0, opportunitiesEligible: 0, aiCalls: 0, costUsd: 0 };
  }

  const startedAt = Date.now();

  const skip = async (reason: string, considered: number): Promise<AutoDraftStepResult> => {
    await deps.runRepo.completeRun(claimedId, {
      status: "skipped",
      skipReason: reason,
      opportunitiesConsidered: considered,
      opportunitiesEligible: 0,
      aiCalls: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
    });
    return { status: "skipped", skipReason: reason, opportunitiesConsidered: considered, opportunitiesEligible: 0, aiCalls: 0, costUsd: 0 };
  };

  try {
    const backlogCount = await deps.countReadyForOwnerAssets();
    const backlogCheck = evaluateBacklog(backlogCount);
    if (!backlogCheck.eligible) return await skip(backlogCheck.reason!, 0);

    const yearMonth = runDate.slice(0, 7);
    const monthSpend = await deps.runRepo.getMonthSpendUsd(yearMonth);
    const budgetCheck = evaluateMonthlyBudget(monthSpend);
    if (!budgetCheck.eligible) return await skip(budgetCheck.reason!, 0);

    const openOpportunities = await deps.opportunityRepo.listOpen();
    const opportunityIdsWithCampaigns = await deps.listOpportunityIdsWithCampaigns();
    const eligible = filterEligibleOpportunities(openOpportunities, opportunityIdsWithCampaigns, now);

    if (eligible.length === 0) return await skip("no_qualifying_opportunity", openOpportunities.length);

    const selected = eligible[0]!;
    deps.onOpportunitySelected?.(selected.id);
    const loaded = deps.loadRunCampaignDeps
      ? await deps.loadRunCampaignDeps()
      : { runCampaignDeps: deps.runCampaignDeps as RunCampaignDeps, usageLog: deps.usageLog as LlmUsage[] };
    const usageBefore = loaded.usageLog.length;
    const result = await runCampaignForOpportunity(loaded.runCampaignDeps, selected);
    const newUsage = loaded.usageLog.slice(usageBefore);
    const aiCalls = newUsage.length;
    const costUsd = newUsage.reduce((sum, u) => sum + estimateCostUsd(u), 0);

    const overCallCap = aiCalls > MAX_CALLS_PER_RUN;

    await deps.runRepo.completeRun(claimedId, {
      status: "drafted",
      opportunityId: selected.id,
      campaignId: result.campaignId,
      opportunitiesConsidered: openOpportunities.length,
      opportunitiesEligible: eligible.length,
      aiCalls,
      costUsd,
      durationMs: Date.now() - startedAt,
      error: overCallCap ? `WARNING: exceeded MAX_CALLS_PER_RUN (${aiCalls} > ${MAX_CALLS_PER_RUN})` : null,
    });

    return {
      status: "drafted",
      opportunityId: selected.id,
      campaignId: result.campaignId,
      opportunitiesConsidered: openOpportunities.length,
      opportunitiesEligible: eligible.length,
      aiCalls,
      costUsd,
      error: overCallCap ? `exceeded MAX_CALLS_PER_RUN (${aiCalls} > ${MAX_CALLS_PER_RUN})` : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.runRepo.completeRun(claimedId, {
      status: "failed",
      opportunitiesConsidered: 0,
      opportunitiesEligible: 0,
      aiCalls: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return { status: "failed", opportunitiesConsidered: 0, opportunitiesEligible: 0, aiCalls: 0, costUsd: 0, error: message };
  }
}
