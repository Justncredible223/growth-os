import type { SupabaseClient } from "@supabase/supabase-js";
import { BrandConstitution } from "../knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../knowledge/supabaseRepositories.js";
import { ContentQualityGate } from "./contentQualityGate.js";
import { CampaignFactory } from "./campaignFactory.js";
import { SupabaseContentScoreRepository } from "./contentScoreRepository.js";
import { SupabaseCampaignRepository } from "./supabaseCampaignRepository.js";
import type { LlmUsage } from "./llmClient.js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { estimateCostUsd } from "../cost/costTracking.js";
import { SupabaseXFeedPostRunRepository } from "./xFeedPostRunRepository.js";
import { X_FEED_POST_ASSET_TYPE, type FeedPostTopic, type XFeedPostStepDeps } from "./dailyXFeedPost.js";
import type { UsageTracker } from "./runCampaignForOpportunity.js";

/** How many days back to look for already-collected signals when scoring a topic's freshness -- see getTopicFreshnessSignals below. Deliberately short: "fresh" should mean recent, not "ever collected." */
const FRESHNESS_SIGNAL_LOOKBACK_DAYS = 7;

/**
 * How many recent X feed post bodies to check new drafts against for
 * originality -- scoped to this asset_type specifically (not the
 * generic run-campaign path's "last 10 content_versions of any kind"),
 * so a rotating daily post is compared against its own recent history,
 * not diluted by unrelated reply/video drafts.
 */
const RECENT_FEED_POST_LOOKBACK = 14;

/**
 * The asset stages that mean a draft actually reached the owner (ready for review, opened in X, or reviewed and
 * dismissed). Only these count as "recent content" for the originality check. Every attempt makes a draft asset,
 * including the ones the review gate rejected, so before this the lookback was mostly the day's own failed drafts: after a
 * few rejected attempts on similar angles, the next draft measured 60%+ against text nobody had seen ("too similar to
 * recent content (63% overlap)") and the day ended with no post.
 */
export const OWNER_REVIEWED_STAGES = ["ready_for_owner", "handed_off", "retired"];

/**
 * Builds the real Supabase-backed deps for runDailyXFeedPostStep, mirroring
 * buildSupabaseRunCampaignDeps's shape and reasoning (see that function's
 * kdoc) but scoped to this feature's own run-tracking table, budget line,
 * and recent-post lookback.
 */
export async function buildXFeedPostStepDeps(client: SupabaseClient): Promise<{ deps: XFeedPostStepDeps; usage: UsageTracker }> {
  const brandConstitution = new BrandConstitution(new SupabaseBrandConstitutionRepository(client));
  const activeRules = await brandConstitution.getActiveRules();
  const brandRulesSummary = activeRules.map((r) => `[${r.ruleType}] ${r.content}`).join("\n");

  const { data: knowledgeRows } = await client.from("knowledge_documents").select("title, content").eq("trust_level", "verified");
  const verifiedKnowledgeSummary = (knowledgeRows ?? [])
    .map((row: { title: string; content: string }) => `${row.title}: ${row.content}`)
    .join("\n");

  const { data: recentAssetRows } = await client
    .from("campaign_assets")
    .select("id")
    .eq("asset_type", X_FEED_POST_ASSET_TYPE)
    .in("stage", OWNER_REVIEWED_STAGES)
    .order("created_at", { ascending: false })
    .limit(RECENT_FEED_POST_LOOKBACK);
  const recentAssetIds = ((recentAssetRows ?? []) as Array<{ id: string }>).map((r) => r.id);

  let recentFeedPostTexts: string[] = [];
  if (recentAssetIds.length > 0) {
    const { data: versionRows } = await client
      .from("content_versions")
      .select("campaign_asset_id, body")
      .in("campaign_asset_id", recentAssetIds)
      .order("created_at", { ascending: false });
    // For an asset the owner has actually posted, compare against what was
    // REALLY posted (posted_text on x_feed_post_runs), which may differ
    // from this pre-edit draft body after an in-app edit -- otherwise
    // future originality checks would keep comparing against stale,
    // never-shipped text forever. Falls back to the draft body for
    // anything not yet posted (or posted before this field existed).
    const { data: postedRows } = await client
      .from("x_feed_post_runs")
      .select("campaign_asset_id, posted_text")
      .not("posted_text", "is", null)
      .in("campaign_asset_id", recentAssetIds);
    const postedTextByAssetId = new Map(
      ((postedRows ?? []) as Array<{ campaign_asset_id: string; posted_text: string }>).map((r) => [r.campaign_asset_id, r.posted_text]),
    );
    recentFeedPostTexts = ((versionRows ?? []) as Array<{ campaign_asset_id: string; body: string }>).map(
      (r) => postedTextByAssetId.get(r.campaign_asset_id) ?? r.body,
    );
  }

  const usages: LlmUsage[] = [];
  const usage: UsageTracker = {
    usages,
    aiCalls: () => usages.length,
    costUsd: () => usages.reduce((sum, u) => sum + estimateCostUsd(u), 0),
  };
  // "owner" tier: the daily post is the product's one guaranteed daily output (and Regenerate is the owner's own tap),
  // so it is exempt from the background ceiling; only the absolute daily backstop (llmBudget.ts) can skip it.
  const llmClient = createRecordedLlmClient(client, {
    step: "x-feed-post",
    tier: "owner",
    onUsage: (u: LlmUsage) => {
      usages.push(u);
    },
  });

  const deps: XFeedPostStepDeps = {
    llmClient,
    factory: new CampaignFactory(new ContentQualityGate(brandConstitution)),
    scoreRepo: new SupabaseContentScoreRepository(client),
    campaignRepo: new SupabaseCampaignRepository(client),
    runRepo: new SupabaseXFeedPostRunRepository(client),
    brandRulesSummary,
    verifiedKnowledgeSummary,
    recentFeedPostTexts,
    usageLog: usages,
    isPaused: async () => {
      const { data } = await client.from("system_settings").select("paused").eq("id", true).single();
      return data?.paused ?? false;
    },
    isDismissed: async (campaignAssetId: string) => {
      const { data } = await client
        .from("campaign_assets")
        .select("campaign_id, campaigns(status)")
        .eq("id", campaignAssetId)
        .maybeSingle();
      const campaigns = (data as { campaigns: { status: string } | { status: string }[] | null } | null)?.campaigns;
      const status = Array.isArray(campaigns) ? campaigns[0]?.status : campaigns?.status;
      return status === "retired";
    },
    createOpportunityForTopic: async (topic) => {
      const { data, error } = await client
        .from("opportunities")
        .insert({
          title: `Daily X feed post: ${topic.label}`,
          score: 0,
          urgency: "normal",
          confidence: 1,
          rationale: topic.rationale,
          recommended_channels: ["x"],
          recommended_campaign_type: "x_feed_post",
          approval_class: "EXTERNAL_DRAFT",
          signal_ids: [],
        })
        .select("id")
        .single();
      if (error) throw new Error(`createOpportunityForTopic failed: ${error.message}`);
      const opportunityId = data.id as string;
      // Immediately actioned: this is an internal, curated topic, never a
      // real signal-derived opportunity for the owner to browse on Radar,
      // and score=0 means auto-draft's own eligibility scan would skip it
      // anyway (MIN_QUALIFYING_SCORE=50) -- marking it actioned closes
      // that door explicitly rather than relying on the score alone.
      await client.from("opportunities").update({ status: "actioned", updated_at: new Date().toISOString() }).eq("id", opportunityId);
      return opportunityId;
    },
    getTopicFreshnessSignals: async (topics) => getTopicFreshnessSignals(client, topics),
  };

  return { deps, usage };
}

/**
 * Counts already-collected signals (last FRESHNESS_SIGNAL_LOOKBACK_DAYS
 * days, matching a topic's editorialTags) for each given topic -- a
 * freshness BONUS in angle scoring, never a new paid lookup and never a
 * dependency. Any failure (missing table, transient error) resolves every
 * topic to 0 rather than throwing, since a freshness lookup must never
 * block selection.
 */
async function getTopicFreshnessSignals(client: SupabaseClient, topics: FeedPostTopic[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const topic of topics) result[topic.key] = 0;
  try {
    const since = new Date(Date.now() - FRESHNESS_SIGNAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await client.from("signals").select("topic").gte("observed_at", since);
    if (error || !data) return result;
    const signalTopics = (data as Array<{ topic: string | null }>).map((r) => (r.topic ?? "").toLowerCase());
    for (const topic of topics) {
      const tagWords = topic.editorialTags.map((t) => t.toLowerCase().replace(/-/g, " "));
      result[topic.key] = signalTopics.filter((st) => tagWords.some((tw) => st.includes(tw) || tw.includes(st))).length;
    }
    return result;
  } catch {
    return result; // advisory only -- never blocks selection
  }
}
