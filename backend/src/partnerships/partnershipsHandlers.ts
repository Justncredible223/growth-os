import type { SupabaseClient } from "@supabase/supabase-js";
import { CampaignFactory } from "../content/campaignFactory.js";
import { ContentQualityGate } from "../content/contentQualityGate.js";
import { BrandConstitution } from "../knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../knowledge/supabaseRepositories.js";
import { SupabaseContentScoreRepository } from "../content/contentScoreRepository.js";
import { SupabaseCampaignRepository } from "../content/supabaseCampaignRepository.js";
import type { LlmUsage } from "../content/llmClient.js";
import { createRecordedLlmClient } from "../cost/recordedLlmClient.js";
import { runCampaignPipeline, type PipelineOpportunity } from "../content/campaignPipeline.js";
import { estimateCostUsd } from "../cost/costTracking.js";
import { reservePartnershipBudget, releasePartnershipBudgetReservation } from "./budgetReservation.js";
import { hasSufficientEvidenceForPitch, hasConcretePartnershipBasis } from "./discoveryScoring.js";
import { canMarkContacted, isValidTransition } from "./stageTransitions.js";
import { normalizeDomain, normalizeHandle, findExistingMatches, type ExistingMatch } from "./dedup.js";
import { SupabasePartnershipRepository } from "./supabasePartnershipRepository.js";
import { sendOutreachEmail } from "../email/emailClient.js";
import type { NewPartnershipProspect, PartnerCategory, PartnershipOutcomeMetric, PartnershipOutcomeSource, PartnershipProspect, PartnershipStage } from "./types.js";

export const PARTNERSHIP_ASSET_TYPE = "partnership_pitch";

export class PartnershipActionError extends Error {}

/** Every prospect creation goes through here so dedup is never skippable by a caller forgetting to check it. Returns the created row plus any cross-system matches found (informational -- creation is never blocked by a match, since a real duplicate might still be a legitimate second contact attempt months later; the owner decides). */
export async function createPartnership(
  client: SupabaseClient,
  input: NewPartnershipProspect,
): Promise<{ prospect: PartnershipProspect; existingMatches: ExistingMatch[] }> {
  const domain = normalizeDomain(input.websiteUrl);
  const handle = normalizeHandle(Object.values(input.socialLinks ?? {})[0]);
  const existingMatches = await findExistingMatches(client, { domain, handle });
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await repo.create(input, { domain, handle });
  return { prospect, existingMatches };
}

export async function listPartnerships(client: SupabaseClient): Promise<PartnershipProspect[]> {
  return new SupabasePartnershipRepository(client).list();
}

export async function updatePartnership(client: SupabaseClient, id: string, patch: Partial<NewPartnershipProspect>): Promise<PartnershipProspect> {
  return new SupabasePartnershipRepository(client).update(id, patch);
}

async function requireProspect(repo: SupabasePartnershipRepository, id: string): Promise<PartnershipProspect> {
  const prospect = await repo.get(id);
  if (!prospect) throw new PartnershipActionError(`No partnership prospect found for id ${id}`);
  return prospect;
}

function requireTransition(from: PartnershipStage, to: PartnershipStage): void {
  if (!isValidTransition(from, to)) {
    throw new PartnershipActionError(`Cannot move a partnership from '${from}' to '${to}'`);
  }
}

export async function qualifyPartnership(client: SupabaseClient, id: string, rationale: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "qualified");
  await repo.update(id, { qualificationRationale: rationale });
  return repo.transitionStage(id, "qualified", { interactionType: "note", summary: `Qualified: ${rationale}` });
}

export interface GenerateDraftResult {
  status: "ready" | "failed" | "skipped";
  campaignAssetId?: string;
  skipReason?: string;
  error?: string;
  costUsd: number;
  aiCalls: number;
  /** How many full draft+review attempts actually ran (1 or 2 -- see MAX_DRAFT_ATTEMPTS). */
  attempts: number;
}

/** One initial attempt plus one bounded revision using the first attempt's own review-gate feedback -- never more, so a stubborn rejection can't loop indefinitely burning budget. Both attempts count against the same per-call cost/budget accounting. */
const MAX_DRAFT_ATTEMPTS = 2;

/**
 * A conservative CEILING (never the real cost) reserved before EACH
 * attempt, atomically against Partnerships' generation bucket AND its
 * shared monthly cap (see budgetReservation.ts) -- this is what actually
 * closes the cross-prospect budget race: two concurrent attempts for
 * different prospects now serialize through this reservation instead of
 * each independently reading a stale month-spend total.
 *
 * Derived from this pipeline's own hard structural limits, not from an
 * average: one attempt is 1 writer + up to 9 reviewer calls (10 total),
 * each capped at max_tokens=1024 output (llmClient.ts) -- worst-case
 * output cost alone is 10 * 1024 * $15/1e6 = $0.1536. Input tokens aren't
 * capped by the API, but this pipeline's real measured average input size
 * (~2,000 tokens/call, from cost_events) puts a realistic input ceiling at
 * roughly 10 * 2,000 * $3/1e6 = $0.06. $0.25 leaves real margin above
 * that combined ~$0.21 estimate without being so loose it defeats the
 * point of a ceiling.
 */
const GENERATION_ATTEMPT_RESERVATION_CEILING_USD = 0.25;

/**
 * Generates and reviews a pitch draft for a qualified prospect, reusing
 * the SAME pipeline every other content type goes through (mechanical
 * gate + all 9 deep-review agents) -- never a lighter or skipped review
 * just because this is a business pitch rather than a public post. Gated
 * by Partnerships' own independent monthly budget (see budget.ts), fully
 * separate from auto-draft/prospecting/x-feed-post's spend. On success,
 * the new campaign_asset becomes the prospect's `approvedCampaignAssetId`
 * -- calling this again for the same prospect (e.g. after a rejected
 * draft, or because the owner wants a different angle) REPLACES it with
 * the new one, which is exactly how "material edits invalidate any prior
 * approval" is enforced here: there is only ever one current approved
 * draft per prospect, and generating a new one is the only way its text
 * changes.
 *
 * If the first attempt fails the mechanical or review gate, ONE bounded
 * revision is attempted automatically, feeding the writer the exact
 * block reasons from the first attempt (see contentWriter.ts's
 * pitchContext.priorFeedback) -- never a second blind guess. Both
 * attempts share this one call's budget check; the loop stops early if
 * the budget runs out between attempts. Neither attempt ever lowers the
 * mechanical gate or skips a reviewer -- a revision must pass the exact
 * same bar as a first attempt.
 */
export async function generateDraftForPartnership(client: SupabaseClient, id: string): Promise<GenerateDraftResult> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  if (prospect.stage !== "qualified" && prospect.stage !== "draft_ready") {
    throw new PartnershipActionError(`A partnership must be 'qualified' before a draft can be generated (currently '${prospect.stage}')`);
  }
  if (!prospect.proposedCollaboration) {
    throw new PartnershipActionError("proposedCollaboration must be set before generating a draft -- the pipeline needs a concrete offer to write about, not a blank ask.");
  }

  // Reuse a valid, already-passing draft instead of burning another full
  // attempt -- a duplicate/retried call (or a tap after the prospect
  // already reached draft_ready) must never re-spend on work that's
  // already done. Only meaningful once stage has actually advanced;
  // does nothing for the normal first-time 'qualified' case.
  if (prospect.stage === "draft_ready" && prospect.approvedCampaignAssetId) {
    return { status: "ready", campaignAssetId: prospect.approvedCampaignAssetId, costUsd: 0, aiCalls: 0, attempts: 0 };
  }

  // Block before spending anything if the recipient's own real evidence
  // is too thin to personalize against -- the exact gap that produced a
  // guaranteed-to-fail (and guaranteed-to-cost) attempt for a recipient
  // whose only "evidence" was a generic category summary. Applies to
  // EVERY path here, not just auto-discovery's own pre-qualification
  // gate -- a manually created-and-qualified prospect gets no free pass.
  if (!hasSufficientEvidenceForPitch({ rawExcerpts: prospect.evidenceExcerpts })) {
    throw new PartnershipActionError(
      "Not enough of this recipient's own words are on file to personalize a pitch confidently yet. Add real research (their actual posts, site copy, or notes in their own words) to evidenceExcerpts before generating -- a draft attempt here would very likely fail review and spend budget for nothing.",
    );
  }

  // Block before spending anything if there's no evidence this recipient
  // actually runs or offers a partnership-worthy audience/community/
  // business/educational-offering/complementary-product -- having enough
  // TEXT to personalize a pitch (the check above) is a separate concern
  // from being the RIGHT KIND of recipient at all. Real production finding
  // this closes: a retail trader's satisfied-customer review of a prop
  // firm easily cleared the evidence-length bar while being nothing a
  // partnership pitch could realistically be sent to. Applies to every
  // path here, including a prospect the owner manually qualified.
  if (!hasConcretePartnershipBasis({ rawExcerpts: prospect.evidenceExcerpts })) {
    throw new PartnershipActionError(
      "The evidence on file doesn't show this recipient runs or offers an audience, community, business, educational offering, or complementary product -- only that they mentioned a relevant topic (e.g. reviewing or discussing a prop firm/platform as a customer). A partnership pitch needs a real partner to send it to. Add evidence of what they actually run or offer before generating, or reconsider whether this is a genuine partnership candidate.",
    );
  }

  // Atomic per-prospect mutex -- a duplicate tap or a concurrent retry
  // for THIS SAME prospect must never both reach the paid pipeline. Only
  // one caller's conditional update (WHERE generation_claimed_at IS
  // NULL) can ever match a row; a second concurrent caller's update
  // matches zero rows and is turned away immediately, before any budget
  // check or LLM call. Always released in the finally below, success or
  // failure, so a genuine retry after this call finishes can proceed.
  const { data: claimedRows, error: claimError } = await client
    .from("partnership_prospects")
    .update({ generation_claimed_at: new Date().toISOString() })
    .eq("id", id)
    .is("generation_claimed_at", null)
    .select("id");
  if (claimError) throw new Error(`claiming generation slot failed: ${claimError.message}`);
  if (!claimedRows || claimedRows.length === 0) {
    throw new PartnershipActionError("A draft is already being generated for this prospect -- please wait for it to finish before trying again.");
  }

  try {
    return await runGenerationAttempts(client, repo, prospect);
  } finally {
    await client.from("partnership_prospects").update({ generation_claimed_at: null }).eq("id", id);
  }
}

/** The actual paid pipeline, factored out so the claim/release above always wraps it regardless of which return path fires. */
async function runGenerationAttempts(client: SupabaseClient, repo: SupabasePartnershipRepository, prospect: PartnershipProspect): Promise<GenerateDraftResult> {
  const id = prospect.id;
  if (!prospect.proposedCollaboration) throw new Error("unreachable: proposedCollaboration was already validated by the caller");

  const brandConstitution = new BrandConstitution(new SupabaseBrandConstitutionRepository(client));
  const activeRules = await brandConstitution.getActiveRules();
  const brandRulesSummary = activeRules.map((r) => `[${r.ruleType}] ${r.content}`).join("\n");
  const { data: knowledgeRows } = await client.from("knowledge_documents").select("title, content").eq("trust_level", "verified");
  const verifiedKnowledgeSummary = ((knowledgeRows ?? []) as Array<{ title: string; content: string }>)
    .map((row) => `${row.title}: ${row.content}`)
    .join("\n");

  // Per-recipient dedup: never compare a new pitch against OTHER
  // recipients' pitches (irrelevant), only this same prospect's own prior
  // draft, if one already exists.
  const recentTextsForSameTopic: string[] = [];
  if (prospect.approvedCampaignAssetId) {
    const { data: versions } = await client.from("content_versions").select("body").eq("campaign_asset_id", prospect.approvedCampaignAssetId);
    for (const v of (versions ?? []) as Array<{ body: string }>) recentTextsForSameTopic.push(v.body);
  }

  const usages: LlmUsage[] = [];
  // Tracked (not fire-and-forget) so the reservation release below can
  // positively confirm a cost_events WRITE actually succeeded for THIS
  // attempt -- not just that an LLM call returned a usage block, which
  // says nothing about whether the DB insert itself succeeded (see
  // recordCostEvent's own docstring on why that distinction matters here).
  const costWritePromises: Promise<boolean>[] = [];
  const llmClient = createRecordedLlmClient(client, {
    step: "partnerships",
    tier: "owner",
    context: { partnershipId: id },
    eventType: "partnership_llm_call",
    onUsage: (usage) => {
      usages.push(usage);
    },
    onCostRecorded: (recorded) => {
      costWritePromises.push(Promise.resolve(recorded));
    },
  });

  const { data: opportunityRow, error: opportunityError } = await client
    .from("opportunities")
    .insert({
      title: `Partnership pitch: ${prospect.organizationName}`,
      score: 0,
      urgency: "normal",
      confidence: 1,
      rationale: prospect.proposedCollaboration,
      recommended_channels: [prospect.contactRoute?.toLowerCase().includes("x") ? "x" : "email"],
      recommended_campaign_type: "partnership_pitch",
      approval_class: "EXTERNAL_DRAFT",
      signal_ids: [],
    })
    .select("id")
    .single();
  if (opportunityError) throw new Error(`createOpportunityForPartnership failed: ${opportunityError.message}`);
  await client.from("opportunities").update({ status: "actioned", updated_at: new Date().toISOString() }).eq("id", opportunityRow.id);

  const pitchChannel: "email" | "x" = prospect.contactRoute?.toLowerCase().includes("x") ? "x" : "email";

  const opportunity: PipelineOpportunity = {
    id: opportunityRow.id,
    title: `Partnership pitch to ${prospect.organizationName}`,
    rationale: prospect.proposedCollaboration,
    recommendedChannels: [pitchChannel],
  };

  const factory = new CampaignFactory(new ContentQualityGate(brandConstitution));

  let attempts = 0;
  let priorFeedback: string | undefined;
  let evidenceGapStopped = false;
  let budgetStopReason: string | undefined;
  let lastResult: Awaited<ReturnType<typeof runCampaignPipeline>> | null = null;

  while (attempts < MAX_DRAFT_ATTEMPTS) {
    // Reserved BEFORE dispatching this attempt's paid calls, atomically
    // against both the generation bucket and the shared cap -- a
    // concurrent attempt for a DIFFERENT prospect (or a discovery run
    // happening at the same time) is serialized through the same check,
    // not just this one prospect's own mutex. Released in the finally
    // below regardless of how the attempt turns out, so a real cost that
    // was already recorded is never lost track of, and a failed/
    // interrupted attempt never leaves budget silently held forever (see
    // migration 0024's expiry).
    const reservation = await reservePartnershipBudget(client, "generation", GENERATION_ATTEMPT_RESERVATION_CEILING_USD, id);
    if (!reservation.eligible) {
      budgetStopReason = reservation.reason;
      break;
    }
    const writesBeforeAttempt = costWritePromises.length;
    try {
      attempts += 1;
      lastResult = await runCampaignPipeline(
        llmClient,
        factory,
        new SupabaseContentScoreRepository(client),
        new SupabaseCampaignRepository(client),
        opportunity,
        {
          brandRulesSummary,
          verifiedKnowledgeSummary,
          recentTextsForSameTopic,
          assetTypeOverride: PARTNERSHIP_ASSET_TYPE,
          contentFormat: "partnership_pitch",
          pitchRecipientOrganization: prospect.organizationName,
          pitchChannel,
          pitchEvidenceExcerpts: prospect.evidenceExcerpts,
          pitchPriorFeedback: priorFeedback,
        },
      );
    } finally {
      // If this reservation had already expired and been conservatively
      // settled into a charge (this attempt ran long, or hit a genuine
      // failure right before this finally), tell release whether we can
      // positively confirm a real cost_events WRITE succeeded for THIS
      // attempt -- awaited here (not just "did usages grow") so a write
      // that's still in flight, or one that failed silently, is never
      // mistaken for a confirmed real cost. Only a genuinely confirmed
      // write reverses the conservative charge.
      const attemptWriteResults = await Promise.all(costWritePromises.slice(writesBeforeAttempt));
      const hasConfirmedRealCost = attemptWriteResults.some((wrote) => wrote);
      await releasePartnershipBudgetReservation(client, reservation.reservationId, hasConfirmedRealCost);
    }
    if (lastResult.finalStage === "ready_for_owner") break;
    priorFeedback =
      lastResult.mechanicalBlockReasons.length > 0
        ? `quality gate: ${lastResult.mechanicalBlockReasons.join("; ")}`
        : `review gate: ${lastResult.deepReview?.blockReasons.join("; ") ?? "unknown"}`;
    // A rewrite can only fix what the SAME evidence lets it fix. If the
    // rejection itself says there's no real knowledge of the recipient to
    // draw on, a second attempt with the identical evidence is spending
    // another full attempt (up to 10 more AI calls) on a gap a rewrite
    // cannot close -- confirmed in production (Dan Cheung failed
    // attempt 2 for the same underlying reason as attempt 1). Stop here
    // and tell the owner what's actually needed instead.
    if (isUnresolvedEvidenceGap(priorFeedback)) {
      evidenceGapStopped = true;
      break;
    }
  }

  if (attempts === 0) {
    // Budget was exhausted before even the first attempt could be
    // reserved -- no pipeline call was ever dispatched, no cost incurred.
    return { status: "skipped", skipReason: budgetStopReason ?? "monthly_budget_reached", costUsd: 0, aiCalls: 0, attempts: 0 };
  }

  const result = lastResult!;
  const costUsd = usages.reduce((sum, u) => sum + estimateCostUsd(u), 0);

  if (result.finalStage === "ready_for_owner") {
    await repo.setApprovedDraft(id, result.campaignAssetId);
    await repo.insertInteraction(id, "draft_generated", `Draft generated and passed review after ${attempts} attempt${attempts === 1 ? "" : "s"} (campaign_asset ${result.campaignAssetId}).`);
    if (prospect.stage === "qualified") {
      await repo.transitionStage(id, "draft_ready", { interactionType: "note", summary: "Moved to draft_ready after a passing draft." });
    }
    return { status: "ready", campaignAssetId: result.campaignAssetId, costUsd, aiCalls: usages.length, attempts };
  }

  const error = evidenceGapStopped
    ? `(after ${attempts} attempt${attempts === 1 ? "" : "s"} -- stopped early, a rewrite can't fix this) The available evidence isn't specific enough to personalize a pitch, and the reviewers said so directly: ${priorFeedback}. Add more real research on this recipient before trying again -- another attempt with the same evidence would very likely fail the same way.`
    : budgetStopReason
      ? `(after ${attempts} attempt${attempts === 1 ? "" : "s"} -- a revision was needed but the budget ran out first: ${budgetStopReason}) ${priorFeedback ?? "unknown"}`
      : `(after ${attempts} attempt${attempts === 1 ? "" : "s"}) ${priorFeedback ?? "unknown"}`;
  await repo.insertInteraction(id, "draft_generated", `Draft attempt failed: ${error}`);
  return { status: "failed", error, costUsd, aiCalls: usages.length, attempts };
}

/**
 * A pattern-based, best-effort signal that a rejection is fundamentally
 * about the RECIPIENT EVIDENCE being too thin/generic -- not a style,
 * tone, or claim-wording issue a rewrite could fix with the same
 * material. Deliberately conservative (only stops early on a clear,
 * repeated signal) -- a false negative here just costs one extra
 * attempt (the previous behavior for every case); a false positive
 * would wrongly deny a fixable rewrite, which is the worse mistake.
 */
function isUnresolvedEvidenceGap(feedback: string): boolean {
  const lower = feedback.toLowerCase();
  const evidenceGapPhrases = [
    "zero evidence",
    "no evidence",
    "no specific knowledge",
    "no real knowledge",
    "generic cold outreach",
    "could be sent to any",
    "could be sent to literally any",
    "with only the name",
    "name swapped",
    "demonstrates zero",
    "cannot be traced to any",
  ];
  const matches = evidenceGapPhrases.filter((phrase) => lower.includes(phrase)).length;
  return matches >= 2; // more than one reviewer independently pointing at the same root cause, not just one agent's phrasing choice
}

/**
 * The owner's own explicit confirmation that they actually contacted this
 * prospect -- never inferred from a draft merely existing or being
 * copied. Requires a currently-approved, passing draft (canMarkContacted)
 * so a prospect can never be marked contacted with no real reviewed
 * message behind it. `finalText` is the ACTUAL text sent (may differ from
 * the draft after an owner edit) -- stored in the interaction log so
 * there's a real record of what was actually said, same reasoning as
 * Today's X Post's posted_text.
 */
export async function markPartnershipContacted(
  client: SupabaseClient,
  id: string,
  channel: string,
  finalText: string,
): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  if (!canMarkContacted(prospect.stage, prospect.approvedCampaignAssetId)) {
    throw new PartnershipActionError(
      `Cannot mark contacted: prospect must be 'draft_ready' with an approved draft (currently '${prospect.stage}', approvedCampaignAssetId=${prospect.approvedCampaignAssetId ?? "null"})`,
    );
  }
  const now = new Date().toISOString();
  await repo.recordContact(id, channel, now);
  return repo.transitionStage(id, "contacted", { interactionType: "contacted", summary: `Contacted via ${channel}: ${finalText}` });
}

/**
 * Extracts a plain email address from a contactRoute of the shape
 * "email:someone@example.com" (see PartnershipCard's own channelForRoute/
 * copyAndOpen logic on the Android side, which parses the same shape for
 * the existing mailto: flow). Returns null for any other shape (an X
 * handle, an unset route) -- sendPartnershipEmail treats that as "this
 * prospect isn't an email contact," not an error to guess around.
 */
function extractEmailAddress(contactRoute: string | null): string | null {
  if (!contactRoute?.toLowerCase().startsWith("email")) return null;
  const address = contactRoute.split(":").slice(1).join(":").trim();
  return address.length > 0 ? address : null;
}

/**
 * Sends a partnership pitch directly via Resend, as an alternative to the
 * existing "copy pitch, open mailto:" flow (still available and unchanged
 * -- this is an addition, not a replacement). Requires the SAME
 * approved-draft precondition as markPartnershipContacted (canMarkContacted)
 * so a real send can't happen without a reviewed draft behind it, and
 * marks the prospect contacted exactly the same way on success -- from the
 * pipeline's perspective, a Resend send and a manual mailto: send are the
 * same real-world action, just a different delivery mechanism.
 *
 * Deliberately NOT wired to any automatic trigger -- this function only
 * ever runs when the owner explicitly taps "Send email" on a specific,
 * already-reviewed draft (see docs discussion 2026-09-10: every other
 * outreach channel in this app requires the same explicit human send
 * action, and email -- unlike X, which has no programmatic DM/reply API --
 * is the one channel actually capable of sending itself, so keeping this
 * gate is a deliberate consistency choice, not a technical necessity).
 */
export async function sendPartnershipEmail(client: SupabaseClient, id: string, subject: string, finalText: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  if (!canMarkContacted(prospect.stage, prospect.approvedCampaignAssetId)) {
    throw new PartnershipActionError(
      `Cannot send email: prospect must be 'draft_ready' with an approved draft (currently '${prospect.stage}', approvedCampaignAssetId=${prospect.approvedCampaignAssetId ?? "null"})`,
    );
  }
  const to = extractEmailAddress(prospect.contactRoute);
  if (!to) {
    throw new PartnershipActionError(`Cannot send email: contactRoute "${prospect.contactRoute ?? "(none)"}" isn't an email address -- use Copy & Open instead.`);
  }

  const result = await sendOutreachEmail({ to, subject, body: finalText });
  if (!result.sent) {
    throw new PartnershipActionError(`Cannot send email: ${result.skippedReason ?? "email sending isn't configured yet"}.`);
  }

  const now = new Date().toISOString();
  await repo.recordContact(id, "email", now);
  return repo.transitionStage(id, "contacted", { interactionType: "contacted", summary: `Emailed directly via Resend (${result.providerId ?? "sent"}): ${finalText}` });
}

export async function recordPartnershipReply(client: SupabaseClient, id: string, summary: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "replied");
  return repo.transitionStage(id, "replied", { interactionType: "reply_received", summary });
}

export async function startPartnershipPilot(client: SupabaseClient, id: string, termsAgreed: string, startDate: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "pilot");
  const { error } = await client.from("partnership_prospects").update({ pilot_terms_agreed: termsAgreed, pilot_start_date: startDate, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`startPartnershipPilot failed: ${error.message}`);
  return repo.transitionStage(id, "pilot", { interactionType: "pilot_started", summary: `Pilot started ${startDate}: ${termsAgreed}` });
}

export async function activatePartnership(client: SupabaseClient, id: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "active_partner");
  return repo.transitionStage(id, "active_partner", { interactionType: "note", summary: "Became an active partner." });
}

export async function closePartnership(client: SupabaseClient, id: string, reason: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "closed");
  return repo.transitionStage(id, "closed", { interactionType: "note", summary: `Closed: ${reason}` });
}

export async function archivePartnership(client: SupabaseClient, id: string, reason: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "archived");
  return repo.transitionStage(id, "archived", { interactionType: "note", summary: `Archived: ${reason}` });
}

export async function markPartnershipDoNotContact(client: SupabaseClient, id: string, reason: string): Promise<PartnershipProspect> {
  const repo = new SupabasePartnershipRepository(client);
  const prospect = await requireProspect(repo, id);
  requireTransition(prospect.stage, "do_not_contact");
  return repo.transitionStage(id, "do_not_contact", { interactionType: "note", summary: `Do not contact: ${reason}` });
}

export async function recordPartnershipOutcome(
  client: SupabaseClient,
  id: string,
  metric: PartnershipOutcomeMetric,
  value: number | null,
  source: PartnershipOutcomeSource,
  note?: string | null,
): Promise<void> {
  const repo = new SupabasePartnershipRepository(client);
  await requireProspect(repo, id); // 404s cleanly rather than inserting an outcome for a nonexistent prospect
  await repo.recordOutcome(id, metric, value, source, note);
  await repo.insertInteraction(id, "outcome_recorded", `${metric}: ${source === "measured" ? value : `${value} (manually entered)`}${note ? ` -- ${note}` : ""}`);
}

export function toPartnershipJson(prospect: PartnershipProspect) {
  return prospect;
}

export type { PartnerCategory };
