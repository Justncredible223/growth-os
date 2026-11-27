import type { getServiceClient } from "../lib/supabaseClient.js";
import type { MotionConceptSummary } from "../../scripts/video-factory/motionCatalog.js";
import { SupabaseOpportunityRepository } from "./supabaseOpportunityRepository.js";
import type { OpportunityRepository } from "./types.js";
import { manualMotionConceptOpportunityInput, manualMotionConceptTitle } from "./manualMotionConcept.js";

type Client = ReturnType<typeof getServiceClient>;

/**
 * Queues one motion-concept request: finds (or creates) the concept's opportunity and enqueues a video_script campaign
 * run through the same enqueue_campaign_run RPC every other request uses. Shared by the app's endpoint
 * (api/run-campaign.ts) and the daily chart-card refill (src/video/dailyChartCardRequests.ts), so both behave
 * identically. It does NOT check whether the concept is offered, passes the bar, or is already used up: callers do that
 * first, because they report those refusals in their own way (an HTTP status; a line in a step report).
 */
export async function enqueueMotionConceptRequest(
  client: Client,
  concept: MotionConceptSummary,
  /** Runs after the opportunity is known and before the run is queued (the automatic refill records it there). */
  beforeEnqueue?: (opportunityId: string) => Promise<void>,
): Promise<{ campaignRunRequestId: string; opportunityId: string }> {
  const opportunityRepo: OpportunityRepository = new SupabaseOpportunityRepository(client);
  const canonicalTitle = manualMotionConceptTitle(concept);
  const { data: existingDup, error: dupError } = await client
    .from("opportunities")
    .select("id, status")
    .ilike("title", canonicalTitle)
    .eq("status", "open")
    .limit(1);
  if (dupError) throw new Error(`Duplicate-concept check failed: ${dupError.message}`);

  let motionOpportunity: Awaited<ReturnType<typeof opportunityRepo.listOpen>>[number] | undefined;
  if (existingDup && existingDup.length > 0) {
    // Still open = stuck draft (failed a prior quality gate, e.g. the plan's own
    // evidence validation, or the review gate). Re-run the exact same request.
    const openList = await opportunityRepo.listOpen();
    motionOpportunity = openList.find((o) => o.id === existingDup[0]!.id);
  }
  if (!motionOpportunity) {
    motionOpportunity = await opportunityRepo.insert(manualMotionConceptOpportunityInput(concept));
  }

  if (beforeEnqueue) await beforeEnqueue(motionOpportunity.id);

  const { data: enqueueRows, error: enqueueError } = await client.rpc("enqueue_campaign_run", {
    p_opportunity_id: motionOpportunity.id,
    p_asset_type_override: "video_script",
  });
  if (enqueueError) throw new Error(`enqueue_campaign_run failed: ${enqueueError.message}`);
  const enqueued = (enqueueRows as Array<{ campaign_run_request_id: string; job_id: string | null; already_existed: boolean }>)[0]!;
  return { campaignRunRequestId: enqueued.campaign_run_request_id, opportunityId: motionOpportunity.id };
}
