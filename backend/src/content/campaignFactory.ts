import { authorizeAndAudit, type AuditSink } from "../firewall/externalWriteFirewall.js";
import { ContentQualityGate } from "./contentQualityGate.js";
import type { LlmClient } from "./llmClient.js";
import { runDeepReview, ALL_REVIEW_AGENTS, type DeepReviewResult } from "./deepReviewGate.js";
import type { ReviewAgentName, ReviewContext } from "./reviewAgents.js";
import type { ContentScoreRepository } from "./contentScoreRepository.js";

export type AssetStage =
  | "idea"
  | "evidence_packet"
  | "thesis"
  | "angle"
  | "hook_competition"
  | "outline"
  | "draft"
  | "platform_adaptation"
  | "factual_verification"
  | "brand_verification"
  | "originality_review"
  | "anti_slop_review"
  | "policy_review"
  | "conversion_review"
  | "final_draft"
  | "ready_for_owner"
  | "handed_off"
  | "retired";

export const STAGE_ORDER: AssetStage[] = [
  "idea",
  "evidence_packet",
  "thesis",
  "angle",
  "hook_competition",
  "outline",
  "draft",
  "platform_adaptation",
  "factual_verification",
  "brand_verification",
  "originality_review",
  "anti_slop_review",
  "policy_review",
  "conversion_review",
  "final_draft",
  "ready_for_owner",
  "handed_off",
  "retired",
];

export interface SubmitDraftResult {
  advanced: boolean;
  newStage: AssetStage;
  blockReasons: string[];
}

/**
 * Orchestrates a campaign asset through the content pipeline. Nothing in
 * this class can reach a published state — 'handed_off' means "opened the
 * platform's own composer / staged the file for the owner", enforced by
 * always calling the firewall with EXTERNAL_DRAFT, never EXTERNAL_WRITE.
 * There is no method on this class that accepts an action class parameter
 * from the caller — that is intentional, not an oversight, matching
 * ExternalWriteFirewall's "no override" invariant.
 */
export class CampaignFactory {
  constructor(
    private qualityGate: ContentQualityGate,
    private auditSink: AuditSink = () => {},
  ) {}

  /**
   * Runs the mechanical quality gate against a draft. Only advances to
   * 'final_draft' if it passes; otherwise stays at 'draft' (or whatever
   * stage was passed in) with the reasons so the caller can regenerate.
   */
  async submitDraft(
    currentStage: AssetStage,
    candidateText: string,
    recentTextsForSameTopic: string[],
    options: { isVideo?: boolean; requireParagraphs?: boolean } = {},
  ): Promise<SubmitDraftResult> {
    const result = await this.qualityGate.check(candidateText, recentTextsForSameTopic, options);
    if (!result.passed) {
      return { advanced: false, newStage: currentStage, blockReasons: result.blockReasons };
    }
    return { advanced: true, newStage: "final_draft", blockReasons: [] };
  }

  /**
   * Marks a final_draft as ready for the owner to review. Requires the
   * asset to actually be at 'final_draft' — cannot skip stages.
   */
  markReadyForOwner(currentStage: AssetStage): AssetStage {
    if (currentStage !== "final_draft") {
      throw new Error(
        `Cannot mark ready_for_owner from stage "${currentStage}" — must pass through final_draft first.`,
      );
    }
    return "ready_for_owner";
  }

  /**
   * Additive: runs the nine LLM deep-review agents (Phase 6, requires
   * ANTHROPIC_API_KEY) and persists every verdict to content_scores,
   * regardless of pass/fail -- the audit trail matters as much as the
   * gate. Does not change submitDraft's mechanical-only behavior; a
   * caller with no AI provider key configured never has to touch this
   * method at all.
   */
  async runAndRecordDeepReview(
    client: LlmClient,
    scoreRepo: ContentScoreRepository,
    contentVersionId: string,
    candidateText: string,
    context: ReviewContext,
    agents: ReviewAgentName[] = ALL_REVIEW_AGENTS,
  ): Promise<DeepReviewResult> {
    const result = await runDeepReview(client, agents, candidateText, context);
    for (const verdict of result.verdicts) {
      await scoreRepo.save(contentVersionId, verdict);
    }
    return result;
  }

  /**
   * The only way an asset reaches 'handed_off'. This is EXTERNAL_DRAFT by
   * construction (opening a composer / staging a file) — never a publish.
   * If a caller somehow needs to model an actual publish, that is out of
   * scope for this class entirely; see docs/EXTERNAL_WRITE_FIREWALL.md.
   */
  async handOffToOwner(currentStage: AssetStage, platform: string, assetId: string): Promise<AssetStage> {
    if (currentStage !== "ready_for_owner") {
      throw new Error(
        `Cannot hand off from stage "${currentStage}" — must be ready_for_owner first.`,
      );
    }
    await authorizeAndAudit(
      {
        name: `${platform}.open_composer_with_draft`,
        actionClass: "EXTERNAL_DRAFT",
        context: { assetId, platform },
      },
      this.auditSink,
    );
    return "handed_off";
  }
}

/**
 * The transition an Approve/Reject decision applies to a 'ready_for_owner'
 * asset -- a real, confirmed bug this closes: the Approvals screen's
 * decide() previously only ever updated campaigns.status (approved/
 * retired), never this asset's own stage, so the asset stayed at
 * 'ready_for_owner' forever afterward -- invisible in the Approvals list
 * (which correctly requires campaigns.status='in_review' to show up) but
 * still permanently counted by any backlog check keyed on stage alone.
 *
 * Deliberately NOT a CampaignFactory method and deliberately NOT routed
 * through handOffToOwner: that method specifically models "opened the
 * platform's own composer" and is audited as an EXTERNAL_DRAFT action --
 * tapping Approve is a decision, not yet an open-composer action (the
 * owner's actual copy/share tap is a separate, unaudited client-side
 * action). This reuses 'handed_off' as Approve's terminal value anyway
 * (the owner has decided to use this content -- there is no other
 * "resolved positively" stage in this state machine to reuse), and adds
 * 'retired' as Reject's terminal value, mirroring campaigns.status's own
 * 'retired' outcome. Neither branch performs or audits an external
 * action -- deciding is not publishing.
 */
export function resolveOwnerDecisionStage(currentStage: AssetStage, decision: "approved" | "rejected"): AssetStage {
  if (currentStage !== "ready_for_owner") {
    throw new Error(`Cannot resolve an owner decision from stage "${currentStage}" -- must be ready_for_owner first.`);
  }
  return decision === "approved" ? "handed_off" : "retired";
}

/**
 * The safe, idempotent form of resolveOwnerDecisionStage for the live
 * Approve/Reject call site -- returns null (no stage change needed,
 * never throws) when the asset isn't currently 'ready_for_owner', rather
 * than erroring. This is what makes a repeated Approve/Reject call (a
 * double-tap, a retry, or one that races an already-processed decision)
 * a safe no-op instead of a 500 -- and, combined with the fact that every
 * real Approve/Reject call now runs this, means a reviewable asset can no
 * longer be left permanently stuck at 'ready_for_owner' the way the
 * original bug allowed.
 */
export function applyOwnerDecisionIfPending(currentStage: AssetStage, decision: "approved" | "rejected"): AssetStage | null {
  if (currentStage !== "ready_for_owner") return null;
  return resolveOwnerDecisionStage(currentStage, decision);
}
