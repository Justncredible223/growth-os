#!/usr/bin/env node
/**
 * One-shot campaign-run script for GitHub Actions.
 *
 * Runs the exact same draft -> mechanical gate -> nine-agent deep review
 * pipeline api/run-campaign.ts used to run inline inside the HTTP request --
 * moved here (2026-09-22) because that request occasionally exceeded
 * Vercel's 120s function cap (confirmed in production: "Vercel Runtime
 * Timeout Error: Task timed out after 120 seconds" on /api/run-campaign),
 * which the app surfaced as a generic failure even on runs that eventually
 * succeeded server-side. Same fix shape as video rendering's own
 * GitHub-Actions offload (see scripts/video-worker/render-single.ts) --
 * GitHub Actions has no comparable duration ceiling.
 *
 * Reads CAMPAIGN_RUN_REQUEST_ID, OPPORTUNITY_ID, and (optional)
 * ASSET_TYPE_OVERRIDE from env. Called by
 * .github/workflows/campaign-run.yml, dispatched by
 * supabase/functions/trigger-campaign-run in response to a `run_campaign`
 * system_jobs row -- not the polling loop.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "../../src/lib/supabaseClient.js";
import { SupabaseOpportunityRepository } from "../../src/opportunities/supabaseOpportunityRepository.js";
import { buildSupabaseRunCampaignDeps, runCampaignForOpportunity, type CampaignRunSource } from "../../src/content/runCampaignForOpportunity.js";
import { recordResearchCost } from "../../src/research/researchHandlers.js";
import { errorMessage } from "../../src/lib/errorMessage.js";
import { sendScriptReadyNotification } from "../video-worker/pushSender.js";
import { notifyScriptReady } from "./notifyScriptReady.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const campaignRunRequestId = requireEnv("CAMPAIGN_RUN_REQUEST_ID");
  const opportunityId = requireEnv("OPPORTUNITY_ID");
  const assetTypeOverrideRaw = process.env.ASSET_TYPE_OVERRIDE || undefined;
  const assetTypeOverride = assetTypeOverrideRaw === "video_script" || assetTypeOverrideRaw === "research" ? assetTypeOverrideRaw : undefined;

  const client = createClient(SUPABASE_URL, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  await client
    .from("campaign_run_requests")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", campaignRunRequestId);

  try {
    const opportunityRepo = new SupabaseOpportunityRepository(client);
    const openOpportunities = await opportunityRepo.listOpen();
    const opportunity = openOpportunities.find((o) => o.id === opportunityId);
    if (!opportunity) {
      throw new Error(`No open opportunity with id ${opportunityId} -- it may have already been actioned by a concurrent request.`);
    }

    const source: CampaignRunSource = "manual";
    const { deps, usage } = await buildSupabaseRunCampaignDeps(client, () => opportunity.id, source);
    const result = await runCampaignForOpportunity(deps, opportunity, { assetTypeOverride });

    if (assetTypeOverride === "research") {
      // Best-effort, same as api/run-campaign.ts's own call site -- see
      // recordResearchCost's doc comment for why this never blocks.
      void recordResearchCost(client, result.campaignAssetId, usage.costUsd());
    }

    const blockReasons = [...result.mechanicalBlockReasons, ...(result.deepReview?.blockReasons ?? [])];

    const { error: updateError } = await client
      .from("campaign_run_requests")
      .update({
        status: "ready",
        campaign_asset_id: result.campaignAssetId,
        final_stage: result.finalStage,
        block_reasons: blockReasons,
        cost_usd: usage.costUsd(),
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignRunRequestId);
    if (updateError) throw new Error(`mark campaign_run_requests ready failed: ${updateError.message}`);

    if (assetTypeOverride === "video_script" && result.finalStage === "ready_for_owner") {
      await notifyScriptReady(client, opportunity.title, sendScriptReadyNotification);
    }

    console.log(`[campaign-worker] done: ${campaignRunRequestId} -> ${result.finalStage}`);
  } catch (err) {
    const message = errorMessage(err);
    await client
      .from("campaign_run_requests")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", campaignRunRequestId);
    throw err;
  }
}

main().catch((err) => {
  console.error("[campaign-worker] failed:", err);
  process.exit(1);
});
