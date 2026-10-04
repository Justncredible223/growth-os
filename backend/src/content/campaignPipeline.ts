import type { LlmClient } from "./llmClient.js";
import { CampaignFactory, type AssetStage } from "./campaignFactory.js";
import type { ContentScoreRepository } from "./contentScoreRepository.js";
import type { DeepReviewResult } from "./deepReviewGate.js";
import { draftContent } from "./contentWriter.js";
import { draftVideoScript, formatVideoScriptAsText, buildVideoScriptFromScenePlan, type VideoScript } from "./videoScriptWriter.js";
import type { RecentVideo } from "./videoHookVariety.js";
import { draftResearch, formatResearchAsText, type ResearchReport } from "./researchWriter.js";
import { extractMotionConceptRefFromRationale } from "../../scripts/video-factory/motionCatalog.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../opportunities/manualMotionConcept.js";
import { MOTION_SCENE_PLANS } from "../shortform/motionPlans.js";
import { spokenScriptOf } from "./contentQualityGate.js";
import { assertMeetsRenderBar } from "../shortform/storyScore.js";
import { loadManifest, validateScenePlan } from "../shortform/scenePlan.js";

/**
 * Platforms whose native format is short-form video, not a text post --
 * these get a real shootable production package (hook/script/shot
 * list/caption/hashtags) from videoScriptWriter instead of a single
 * platform-native post from contentWriter. See docs/VIDEO_FACTORY.md.
 */
const VIDEO_PLATFORMS = new Set(["tiktok"]);

export interface PipelineOpportunity {
  id: string;
  title: string;
  rationale: string;
  recommendedChannels: string[];
  /** See Opportunity.sourceUrl's kdoc -- presence means this is a reply-worthy X mention, not a content/campaign opportunity. */
  sourceUrl?: string;
  authorHandle?: string;
}

export interface CampaignRepository {
  createCampaign(opportunityId: string, thesis: string): Promise<string>;
  createCampaignAsset(campaignId: string, platform: string, assetType: string): Promise<string>;
  /**
   * metadata is optional and additive -- text posts never set it. Video
   * assets store the structured VideoScript here (not just re-parsed from
   * `body`) so downstream consumers -- the video-factory CLI in
   * particular -- get reliable structured fields instead of re-parsing
   * formatVideoScriptAsText's human-readable text block.
   */
  insertContentVersion(campaignAssetId: string, version: number, body: string, metadata?: Record<string, unknown>): Promise<string>;
  updateAssetStage(campaignAssetId: string, stage: AssetStage): Promise<void>;
}

export interface PipelineContext {
  brandRulesSummary: string;
  verifiedKnowledgeSummary: string;
  recentTextsForSameTopic: string[];
  /** Hooks and titles of recently made videos, so a new script does not repeat them. Optional: omitted means no history to avoid. */
  recentVideos?: RecentVideo[];
  /**
   * Overrides the asset_type this run creates -- defaults to the
   * existing "video_script" (video platforms) / "post" (everything
   * else) inference when omitted, so every existing caller (manual
   * /api/run-campaign, auto-draft) is unaffected. Used by the daily X
   * feed-post step to mark its output with a distinct, dedicated
   * asset_type (X_FEED_POST_ASSET_TYPE) instead of the generic "post"
   * value replies/opportunity-drafts already use -- see
   * dailyXFeedPost.ts's own doc comment for why that distinction is
   * what keeps Home's Today's X Post genuinely separate from replies.
   */
  assetTypeOverride?: string;
  /**
   * Tells the deep-review agents what shape of content this actually is,
   * beyond the existing post/reply distinction -- a partnership pitch is
   * a third shape (a private, one-recipient business proposition, not
   * public content), and judging it with the wrong bar (e.g.
   * hook_specialist expecting a scroll-stopping public hook) produces
   * wrong verdicts. Omitted defaults to the existing isReply-based
   * post/reply distinction, so every existing caller is unaffected.
   */
  contentFormat?: "post" | "reply" | "partnership_pitch";
  /** Only meaningful when contentFormat is "partnership_pitch" -- who this specific pitch is addressed to, so growth_strategist can judge recipient-specific relevance rather than a generic audience bar. */
  pitchRecipientOrganization?: string;
  /** Only meaningful when contentFormat is "partnership_pitch" -- which channel this will actually be sent through, so hook_specialist judges an email subject/opener vs an X DM opener appropriately. */
  pitchChannel?: "email" | "x";
  /** Only meaningful when contentFormat is "partnership_pitch" -- the recipient's OWN real words, given to both the writer (for personalization) and every reviewer (for specificity/fact-claim verification). See reviewAgents.ts's own doc comment for why this closed a real gap. */
  pitchEvidenceExcerpts?: string[];
  /** Only meaningful when contentFormat is "partnership_pitch" -- a prior failed attempt's own review-gate feedback, passed to the writer on a bounded revision retry so a rewrite targets the ACTUAL rejection reasons instead of guessing again from scratch. */
  pitchPriorFeedback?: string;
  /**
   * Explicit request for a verified motion-backed concept (a ScenePlan's
   * `planId`, see motionCatalog.ts's listMotionConcepts) -- when set, the
   * script is built directly from that ScenePlan (no LLM call) instead of
   * drafted by draftVideoScript. Normally arrives via the opportunity's own
   * `rationale` marker (see manualMotionConcept.ts) rather than this field
   * directly; this exists for a caller that already has a PipelineOpportunity
   * and wants to skip that indirection (e.g. a direct test).
   */
  motionConceptId?: string;
}

export interface PipelineResult {
  campaignId: string;
  campaignAssetId: string;
  platform: string;
  draftText: string;
  mechanicalGatePassed: boolean;
  mechanicalBlockReasons: string[];
  deepReview: DeepReviewResult | null;
  finalStage: AssetStage;
}

/**
 * The end-to-end Opportunity -> draft -> mechanical gate -> deep review ->
 * ready_for_owner pipeline. Every ingredient here already existed
 * separately (ContentWriter, ContentQualityGate via CampaignFactory,
 * the nine review agents) -- this is just the orchestration that was
 * missing to turn them into one real run. It never calls
 * handOffToOwner/EXTERNAL_DRAFT -- the furthest stage this can reach is
 * 'ready_for_owner', same as every other path into CampaignFactory.
 */
let catalogSpokenScripts: Set<string> | null = null;

/** True when `text` is a stored draft of one of the verified motion catalog's own scripts (compared on the spoken script, as the originality gate does). */
export function isCatalogMotionScript(text: string): boolean {
  catalogSpokenScripts ??= new Set(MOTION_SCENE_PLANS.map((p) => buildVideoScriptFromScenePlan(p).script.trim()));
  return catalogSpokenScripts.has(spokenScriptOf(text).trim());
}

export async function runCampaignPipeline(
  llmClient: LlmClient,
  factory: CampaignFactory,
  scoreRepo: ContentScoreRepository,
  campaignRepo: CampaignRepository,
  opportunity: PipelineOpportunity,
  context: PipelineContext,
): Promise<PipelineResult> {
  const platform = opportunity.recommendedChannels[0] ?? "x";
  // Owner-requested video script (2026-09-08): normally isVideo is purely a
  // function of the opportunity's own recommended channel, but the owner
  // can now explicitly request a video script for ANY open opportunity
  // (see api/run-campaign.ts's validated `assetType` field) regardless of
  // its channel -- e.g. because the TikTok/YouTube signal adapters that
  // used to produce tiktok-first opportunities were intentionally removed
  // (see api/ingest.ts's own doc comment), so relying on platform alone
  // would make the video-script path permanently unreachable. Explicitly
  // requesting assetTypeOverride: "video_script" both labels the resulting
  // campaign_asset correctly AND switches the writer step below to the
  // real video-script writer instead of the plain text writer -- the two
  // were previously the same boolean by construction, so this is the one
  // place they need to be reconciled.
  const isVideo = VIDEO_PLATFORMS.has(platform) || context.assetTypeOverride === "video_script";
  // Motion-backed concept request (2026-09-23, "Create Fillbook Video"
  // motion picker): the concept id rides inside the opportunity's own
  // `rationale` field behind a fixed marker (see manualMotionConcept.ts's
  // own doc comment for why -- reuses this exact opportunity-based
  // pipeline with no schema change). `context.motionConceptId` is the
  // same signal for a caller that already has a PipelineOpportunity in
  // hand and wants to skip the rationale-marker indirection (e.g. a
  // direct unit test, or a future first-class request field). Checked
  // ahead of isVideo's own drafting branch below: when present, this
  // REPLACES the LLM drafting step entirely (buildVideoScriptFromScenePlan
  // is instant and free) but still flows through the exact same mechanical
  // gate + nine-agent deep review as any other video script.
  //
  // The rationale-marker path ALSO requires the title to carry
  // MANUAL_MOTION_CONCEPT_TITLE_PREFIX (2026-09-23, closed a real gap):
  // `rationale` is a plain-text field a custom-topic request also writes
  // to (see manualVideoTopicOpportunityInput), and that flow embeds the
  // OWNER'S OWN TYPED TEXT verbatim inside it -- a topic that happened to
  // contain the literal string "MOTION_CONCEPT_REF:pilot-2-..." would
  // otherwise activate motion mode by pure textual coincidence. The title
  // prefix is never derived from user-typed text (manualVideoTopicTitle
  // always PREPENDS "Video request: " ahead of whatever the owner typed,
  // so it can never equal MANUAL_MOTION_CONCEPT_TITLE_PREFIX by accident)
  // -- requiring BOTH signals makes an ordinary custom-topic request
  // structurally unable to trigger this path, regardless of its text.
  const rationaleMotionConceptId =
    opportunity.title.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX) ? extractMotionConceptRefFromRationale(opportunity.rationale) : null;
  const motionConceptId = context.motionConceptId ?? rationaleMotionConceptId;
  // A motion-concept script IS a video script regardless of how this run
  // was triggered (explicit override, Radar re-run, or auto-draft) -- it
  // must be labeled asset_type "video_script" (only that queues a render
  // on approval) and gated with the video mechanical rules.
  const isVideoAsset = isVideo || Boolean(motionConceptId);
  // Owner-requested research (2026-09-07): a private, internal research
  // document for the owner to review, not public-facing content -- see
  // researchWriter.ts's own doc comment. Checked ahead of isVideo/isReply
  // since research is neither a video script nor a text post/reply; it
  // takes over the writer step entirely below.
  const isResearch = context.assetTypeOverride === "research";
  // Same signal the Android app uses to tell an "engagement" opportunity
  // from a "campaign/content" one -- never inferred from title text.
  const isReply = Boolean(opportunity.sourceUrl);
  let draftText: string;
  let videoScript: VideoScript | null = null;
  let researchReport: ResearchReport | null = null;
  if (isResearch) {
    researchReport = await draftResearch(llmClient, opportunity, context.brandRulesSummary, context.verifiedKnowledgeSummary);
    draftText = formatResearchAsText(researchReport);
  } else if (motionConceptId) {
    const plan = MOTION_SCENE_PLANS.find((p) => p.planId === motionConceptId);
    if (!plan) {
      throw new Error(`Motion concept "${motionConceptId}" is not a known verified ScenePlan (known: ${MOTION_SCENE_PLANS.map((p) => p.planId).join(", ")}).`);
    }
    // Refuses to draft against a broken/incomplete verified plan rather
    // than generating a script whose motionScenePlan reference would only
    // fail later at render time -- the owner finds out immediately, before
    // spending any review-agent budget on a request that could never
    // actually render with motion.
    assertMeetsRenderBar(plan);
    const planValidation = validateScenePlan(plan, loadManifest(), { checkFiles: true });
    if (!planValidation.ok) {
      const errors = planValidation.issues.filter((i) => i.severity === "error").map((i) => `${i.sceneId}: ${i.code} -- ${i.message}`);
      throw new Error(`Motion concept "${motionConceptId}" currently fails its own claim/evidence/timing validation, so no script was drafted:\n${errors.join("\n")}`);
    }
    videoScript = buildVideoScriptFromScenePlan(plan);
    draftText = formatVideoScriptAsText(videoScript);
  } else if (isVideo) {
    videoScript = await draftVideoScript(llmClient, opportunity, context.brandRulesSummary, context.verifiedKnowledgeSummary, context.recentVideos);
    draftText = formatVideoScriptAsText(videoScript);
  } else {
    draftText = await draftContent(
      llmClient,
      platform,
      opportunity,
      context.brandRulesSummary,
      context.verifiedKnowledgeSummary,
      isReply ? { authorHandle: opportunity.authorHandle ?? null } : undefined,
      context.contentFormat === "partnership_pitch" && context.pitchRecipientOrganization && context.pitchChannel
        ? {
            recipientOrganization: context.pitchRecipientOrganization,
            channel: context.pitchChannel,
            evidenceExcerpts: context.pitchEvidenceExcerpts ?? [],
            proposedCollaboration: opportunity.rationale,
            priorFeedback: context.pitchPriorFeedback,
          }
        : undefined,
    );
  }

  const campaignId = await campaignRepo.createCampaign(opportunity.id, opportunity.title);
  const campaignAssetId = await campaignRepo.createCampaignAsset(
    campaignId,
    platform,
    motionConceptId ? "video_script" : (context.assetTypeOverride ?? (isVideo ? "video_script" : "post")),
  );
  const contentVersionId = await campaignRepo.insertContentVersion(
    campaignAssetId,
    1,
    draftText,
    videoScript ? { videoScript } : researchReport ? { research: researchReport } : undefined,
  );

  // A motion concept's script is fixed, fact-checked catalog copy, and the catalog's chart cards share wording on
  // purpose ("Check your target against...", "Same signal. Same loss."), so measuring it against OTHER catalog scripts
  // blocked every motion video after the first as "too similar". It is still checked against everything else.
  const recentForGate = motionConceptId ? context.recentTextsForSameTopic.filter((text) => !isCatalogMotionScript(text)) : context.recentTextsForSameTopic;
  // An X post is laid out in short paragraphs (owner request 2026-10-04), so a long single block is sent back for a rewrite.
  const requireParagraphs = platform === "x" && !isVideoAsset && context.assetTypeOverride !== "research";
  const mechanical = await factory.submitDraft("draft", draftText, recentForGate, { isVideo: isVideoAsset, requireParagraphs });
  await campaignRepo.updateAssetStage(campaignAssetId, mechanical.newStage);

  if (!mechanical.advanced) {
    return {
      campaignId,
      campaignAssetId,
      platform,
      draftText,
      mechanicalGatePassed: false,
      mechanicalBlockReasons: mechanical.blockReasons,
      deepReview: null,
      finalStage: mechanical.newStage,
    };
  }

  // Research (2026-09-07): deliberately SKIPS the nine-agent deep review
  // entirely and goes straight from the mechanical gate to
  // ready_for_owner -- same lighter-review treatment
  // draftOpportunityReply already gives a lighter content type. A research
  // report is a private internal document the owner already has to read
  // in full before it informs anything public; hook_specialist,
  // conversion_reviewer, and growth_strategist all judge public-facing
  // content mechanics (scroll-stopping hooks, CTAs, audience growth) that
  // simply don't apply to a document nobody but the owner will ever see.
  // The mechanical gate (banned-phrase/duplicate check) still runs above,
  // unchanged, for every content type including this one.
  if (isResearch) {
    const readyStage = factory.markReadyForOwner(mechanical.newStage);
    await campaignRepo.updateAssetStage(campaignAssetId, readyStage);
    return {
      campaignId,
      campaignAssetId,
      platform,
      draftText,
      mechanicalGatePassed: true,
      mechanicalBlockReasons: [],
      deepReview: null,
      finalStage: readyStage,
    };
  }

  const deepReview = await factory.runAndRecordDeepReview(llmClient, scoreRepo, contentVersionId, draftText, {
    platform,
    brandRulesSummary: context.brandRulesSummary,
    verifiedKnowledgeSummary: context.verifiedKnowledgeSummary,
    isReply,
    contentFormat: context.contentFormat,
    pitchRecipientOrganization: context.pitchRecipientOrganization,
    pitchChannel: context.pitchChannel,
    pitchEvidenceExcerpts: context.pitchEvidenceExcerpts,
  });

  if (!deepReview.passed) {
    return {
      campaignId,
      campaignAssetId,
      platform,
      draftText,
      mechanicalGatePassed: true,
      mechanicalBlockReasons: [],
      deepReview,
      finalStage: mechanical.newStage,
    };
  }

  const readyStage = factory.markReadyForOwner(mechanical.newStage);
  await campaignRepo.updateAssetStage(campaignAssetId, readyStage);

  return {
    campaignId,
    campaignAssetId,
    platform,
    draftText,
    mechanicalGatePassed: true,
    mechanicalBlockReasons: [],
    deepReview,
    finalStage: readyStage,
  };
}
