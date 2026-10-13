import type { RecentVideo } from "./videoHookVariety.js";
import { MANUAL_VIDEO_TOPIC_TITLE_PREFIX } from "../opportunities/manualVideoTopic.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../opportunities/manualMotionConcept.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BrandConstitution } from "../knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../knowledge/supabaseRepositories.js";
import { ContentQualityGate } from "./contentQualityGate.js";
import { CampaignFactory } from "./campaignFactory.js";
import { SupabaseContentScoreRepository, type ContentScoreRepository } from "./contentScoreRepository.js";
import { SupabaseCampaignRepository } from "./supabaseCampaignRepository.js";
import { LlmClient, type LlmUsage } from "./llmClient.js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { runCampaignPipeline, type CampaignRepository, type PipelineOpportunity, type PipelineResult } from "./campaignPipeline.js";
import { estimateCostUsd } from "../cost/costTracking.js";

export type CampaignRunSource = "manual" | "auto-draft";

export interface RunCampaignDeps {
  llmClient: LlmClient;
  factory: CampaignFactory;
  scoreRepo: ContentScoreRepository;
  campaignRepo: CampaignRepository;
  brandRulesSummary: string;
  verifiedKnowledgeSummary: string;
  recentTextsForSameTopic: string[];
  /**
   * Draft bodies this same request already produced -- for a motion concept, every earlier attempt at that concept --
   * excluded from the duplicate check so a retry isn't blocked by its own earlier attempt.
   */
  listPriorDraftBodiesForOpportunity: (opportunity: { id: string; title: string }) => Promise<string[]>;
  /** Hooks and titles of recently made videos, passed to the video script writer so it avoids repeating them. */
  recentVideos?: RecentVideo[];
  /** Called only when the pipeline reaches ready_for_owner -- never otherwise. */
  markOpportunityActioned: (opportunityId: string) => Promise<void>;
  /** Called only when the pipeline reaches ready_for_owner. Sets 'in_review', NOT 'approved' -- AI review is not human approval. */
  markCampaignInReview: (campaignId: string) => Promise<void>;
}

/**
 * The core orchestration, fully testable with injected in-memory deps --
 * no Supabase required. Used by both the manual /api/run-campaign
 * endpoint and the scheduled auto-draft step (api/daily-pipeline.ts) via
 * buildSupabaseRunCampaignDeps below, so there is exactly one
 * implementation of "run one opportunity through the pipeline and update
 * its status on success," not two that could drift apart.
 */
export interface RunCampaignOptions {
  /**
   * Owner-requested video script or research (2026-09-08 / 2026-09-07):
   * the ONLY accepted values are "video_script" and "research" -- validated
   * by the one caller allowed to set this, api/run-campaign.ts, before it
   * ever reaches here (see that file's own comment for why an arbitrary
   * caller-supplied asset type is never trusted past that point). Omitted
   * (the default, used by every existing caller -- the plain manual run
   * and the scheduled auto-draft step) preserves the exact prior behavior:
   * asset type and the video-vs-text writer choice both come from the
   * opportunity's own recommended channel, nothing else.
   */
  assetTypeOverride?: "video_script" | "research";
}

/**
 * An opportunity the owner typed in as a video request keeps that meaning wherever it is run from. Without
 * this, running such an opportunity from Radar without the video option, or letting the daily auto-draft pick
 * it (it takes any open opportunity), drafted a plain text POST for a "Video request:" (9 times between
 * 2026-09-09 and 2026-09-21). Approving a post never queues a render, so the video "never went to render".
 * An explicit override from the caller still wins. Research requests are not covered: they have their own
 * handler logic keyed on the caller's option, and nothing shows the same problem there.
 */
export function assetTypeForManualRequest(title: string): "video_script" | undefined {
  // Motion-concept requests (2026-09-23) are video requests too -- same
  // failure mode otherwise: re-run from Radar or picked up by auto-draft
  // without an explicit override, they'd be labeled a plain "post" and
  // approving them would never queue a render.
  return title.startsWith(MANUAL_VIDEO_TOPIC_TITLE_PREFIX) || title.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) ? "video_script" : undefined;
}

export async function runCampaignForOpportunity(
  deps: RunCampaignDeps,
  opportunity: PipelineOpportunity,
  options: RunCampaignOptions = {},
): Promise<PipelineResult> {
  const ownPriorDrafts = new Set(await deps.listPriorDraftBodiesForOpportunity({ id: opportunity.id, title: opportunity.title }));
  const result = await runCampaignPipeline(deps.llmClient, deps.factory, deps.scoreRepo, deps.campaignRepo, opportunity, {
    brandRulesSummary: deps.brandRulesSummary,
    verifiedKnowledgeSummary: deps.verifiedKnowledgeSummary,
    recentTextsForSameTopic: deps.recentTextsForSameTopic.filter((text) => !ownPriorDrafts.has(text)),
    recentVideos: deps.recentVideos,
    assetTypeOverride: options.assetTypeOverride ?? assetTypeForManualRequest(opportunity.title),
  });

  if (result.finalStage === "ready_for_owner") {
    await deps.markOpportunityActioned(opportunity.id);
    await deps.markCampaignInReview(result.campaignId);
  }

  return result;
}

export interface UsageTracker {
  usages: LlmUsage[];
  aiCalls(): number;
  costUsd(): number;
}

function createUsageTracker(): UsageTracker {
  const usages: LlmUsage[] = [];
  return {
    usages,
    aiCalls: () => usages.length,
    costUsd: () => usages.reduce((sum, u) => sum + estimateCostUsd(u), 0),
  };
}

/**
 * Builds the real Supabase-backed deps for production use. Fetches brand
 * rules / verified knowledge / recent drafts fresh on every call (same
 * as the original run-campaign.ts always did) rather than caching --
 * volume here is low enough that staleness risk isn't worth the
 * complexity.
 */
export async function buildSupabaseRunCampaignDeps(
  client: SupabaseClient,
  /**
   * Returns the opportunity id to tag cost events with. A function, not a
   * fixed string, because the auto-draft path builds these deps before
   * it has selected which opportunity it will actually run -- selection
   * happens inside runAutoDraftStep, after these deps (including the
   * LlmClient's cost-recording callback) already exist.
   */
  getOpportunityId: () => string,
  source: CampaignRunSource,
): Promise<{ deps: RunCampaignDeps; usage: UsageTracker }> {
  const brandConstitution = new BrandConstitution(new SupabaseBrandConstitutionRepository(client));
  const activeRules = await brandConstitution.getActiveRules();
  const brandRulesSummary = activeRules.map((r) => `[${r.ruleType}] ${r.content}`).join("\n");

  const { data: knowledgeRows } = await client.from("knowledge_documents").select("title, content").eq("trust_level", "verified");
  const verifiedKnowledgeSummary = (knowledgeRows ?? [])
    .map((row: { title: string; content: string }) => `${row.title}: ${row.content}`)
    .join("\n");

  const { data: recentVersions } = await client
    .from("content_versions")
    .select("body")
    .order("created_at", { ascending: false })
    .limit(10);
  const recentTextsForSameTopic = (recentVersions ?? []).map((row: { body: string }) => row.body);

  // Recent video hooks and titles (from the stored script package), so a new video script does not
  // reuse an opening the channel already ran.
  const { data: recentVideoRows } = await client
    .from("content_versions")
    .select("metadata")
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(60);
  const recentVideos: RecentVideo[] = [];
  for (const row of (recentVideoRows ?? []) as Array<{ metadata: { videoScript?: { hook?: string; youtubeTitle?: string } } | null }>) {
    const script = row.metadata?.videoScript;
    if (script?.hook) recentVideos.push({ hook: script.hook, title: script.youtubeTitle ?? "" });
  }

  const usage = createUsageTracker();
  // An explicit owner request ("manual") is exempt from the background ceiling; the scheduled auto-draft is not.
  const llmClient = createRecordedLlmClient(client, {
    step: "run-campaign",
    tier: source === "manual" ? "owner" : "background",
    context: { source },
    onUsage: (u: LlmUsage) => {
      usage.usages.push(u);
    },
  });

  const deps: RunCampaignDeps = {
    llmClient,
    factory: new CampaignFactory(new ContentQualityGate(brandConstitution)),
    scoreRepo: new SupabaseContentScoreRepository(client),
    campaignRepo: new SupabaseCampaignRepository(client),
    brandRulesSummary,
    verifiedKnowledgeSummary,
    recentTextsForSameTopic,
    listPriorDraftBodiesForOpportunity: async (opportunity) => {
      // A motion concept's script is fixed, so every earlier request for the same concept counts as its own attempt.
      let opportunityIds = [opportunity.id];
      if (opportunity.title.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX)) {
        const { data: sameConcept, error: sameConceptError } = await client.from("opportunities").select("id").eq("title", opportunity.title);
        if (sameConceptError) throw new Error(`listPriorDraftBodiesForOpportunity (opportunities) failed: ${sameConceptError.message}`);
        opportunityIds = [...new Set([opportunity.id, ...(sameConcept ?? []).map((row: { id: string }) => row.id)])];
      }
      const { data: campaigns, error: campaignsError } = await client.from("campaigns").select("id").in("opportunity_id", opportunityIds);
      if (campaignsError) throw new Error(`listPriorDraftBodiesForOpportunity (campaigns) failed: ${campaignsError.message}`);
      const campaignIds = (campaigns ?? []).map((row: { id: string }) => row.id);
      if (campaignIds.length === 0) return [];
      const { data: assets, error: assetsError } = await client.from("campaign_assets").select("id").in("campaign_id", campaignIds);
      if (assetsError) throw new Error(`listPriorDraftBodiesForOpportunity (campaign_assets) failed: ${assetsError.message}`);
      const assetIds = (assets ?? []).map((row: { id: string }) => row.id);
      if (assetIds.length === 0) return [];
      const { data: versions, error: versionsError } = await client.from("content_versions").select("body").in("campaign_asset_id", assetIds);
      if (versionsError) throw new Error(`listPriorDraftBodiesForOpportunity (content_versions) failed: ${versionsError.message}`);
      return (versions ?? []).map((row: { body: string }) => row.body);
    },
    recentVideos,
    markOpportunityActioned: async (id) => {
      await client.from("opportunities").update({ status: "actioned", updated_at: new Date().toISOString() }).eq("id", id);
    },
    markCampaignInReview: async (id) => {
      await client.from("campaigns").update({ status: "in_review", updated_at: new Date().toISOString() }).eq("id", id);
    },
  };

  return { deps, usage };
}
