import type { VercelRequest, VercelResponse } from "@vercel/node";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { SupabaseOpportunityRepository } from "../src/opportunities/supabaseOpportunityRepository.js";
import type { OpportunityRepository } from "../src/opportunities/types.js";
import { requireAppAuth } from "../src/lib/requireAppAuth.js";
import { isPlausiblyTradingRelated } from "../src/prospecting/prospectingRelevance.js";
import { validateVideoTopicShape, manualVideoTopicTitle, manualVideoTopicOpportunityInput } from "../src/opportunities/manualVideoTopic.js";
import { validateResearchTopicShape, manualResearchTopicTitle, manualResearchTopicOpportunityInput } from "../src/opportunities/manualResearchTopic.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX, manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept.js";
import { enqueueMotionConceptRequest } from "../src/opportunities/requestMotionConcept.js";
import { listMotionConcepts } from "../scripts/video-factory/motionCatalog.js";
import { motionRequestedToday, nextDayStart, oneADayMessage } from "../src/video/dailyLimit.js";
import { MOTION_SCENE_PLANS, dailyPosition, isOfferedPlan } from "../src/shortform/motionPlans.js";
import { distinctConcepts } from "../src/shortform/conceptVariety.js";
import { renderBar, renderBarRefusal } from "../src/shortform/storyScore.js";

/**
 * Motion concepts that must not be offered again, keyed by their opportunity title (owner rule 2026-09-25: a concept
 * is used up the moment it's requested, so it's never run twice by accident):
 * - "waiting" from the moment it's requested -- a queued or running campaign-run request, or a script in Approvals;
 * - "made" once its script is approved (it has a video);
 * - "rejected" once the owner rejects its script. A concept's narration is fixed, so a new request would produce the
 *   identical script.
 * Only a run that failed or a draft the quality gate blocked leaves the concept available, so it can be retried.
 */
/** `campaigns.decided_by` on a draft retired by the plan-update cleanup SQL (scripts/printStaleMotionDraftsSql.ts). */
export const PLAN_UPDATE_CLEANUP = "plan update cleanup";
export type MotionConceptState = "made" | "waiting" | "rejected";
const STATE_PRIORITY: Record<MotionConceptState, number> = { made: 3, waiting: 2, rejected: 1 };

export async function motionConceptStates(client: ReturnType<typeof getServiceClient>): Promise<Map<string, MotionConceptState>> {
  const states = new Map<string, MotionConceptState>();
  const mark = (title: string, state: MotionConceptState) => {
    const current = states.get(title);
    if (!current || STATE_PRIORITY[state] > STATE_PRIORITY[current]) states.set(title, state);
  };

  const { data, error } = await client
    .from("campaigns")
    .select("thesis, status, decided_by")
    .like("thesis", `${MANUAL_MOTION_CONCEPT_TITLE_PREFIX}%`)
    .in("status", ["approved", "in_review", "retired"]);
  if (error) throw new Error(`Motion concept state lookup failed: ${error.message}`);
  for (const row of (data ?? []) as Array<{ thesis: string; status: string; decided_by?: string | null }>) {
    // A draft retired because its concept was redesigned (scripts/printStaleMotionDraftsSql.ts) was never rejected on its merits:
    // the concept is on offer again, and a new request drafts it fresh from the current plan.
    if (row.status === "retired" && row.decided_by === PLAN_UPDATE_CLEANUP) continue;
    if (row.status === "approved") mark(row.thesis, "made");
    else if (row.status === "in_review") mark(row.thesis, "waiting");
    else if (row.status === "retired") mark(row.thesis, "rejected");
  }

  // A request still queued or running has no campaign yet; without this, the concept stayed on offer until the run finished.
  const { data: pending, error: pendingError } = await client.from("campaign_run_requests").select("opportunity_id").in("status", ["queued", "running"]);
  if (pendingError) throw new Error(`Motion concept pending-run lookup failed: ${pendingError.message}`);
  const pendingIds = [...new Set(((pending ?? []) as Array<{ opportunity_id: string }>).map((r) => r.opportunity_id))];
  if (pendingIds.length > 0) {
    const { data: opps, error: oppError } = await client.from("opportunities").select("title").in("id", pendingIds);
    if (oppError) throw new Error(`Motion concept pending-run lookup failed: ${oppError.message}`);
    for (const o of (opps ?? []) as Array<{ title: string }>) {
      if (o.title.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX)) mark(o.title, "waiting");
    }
  }
  return states;
}

/** The only asset-type overrides this endpoint will ever accept from a caller -- see the `assetType` handling below for why this is validated as an exact-match allowlist, never passed through freely. */
export const ALLOWED_ASSET_TYPE_OVERRIDES = ["video_script", "research"] as const;
export type AllowedAssetTypeOverride = (typeof ALLOWED_ASSET_TYPE_OVERRIDES)[number];

/** Pure, exported, and unit-testable independent of Supabase/Vercel -- same shape as ingest.ts's own isManualIngestSource, this codebase's established pattern for validating a caller-supplied enum-like field before it's ever trusted downstream. */
export function isAllowedAssetTypeOverride(value: unknown): value is AllowedAssetTypeOverride {
  return typeof value === "string" && (ALLOWED_ASSET_TYPE_OVERRIDES as readonly string[]).includes(value);
}

/**
 * Manual trigger: validates the request, then enqueues one opportunity to
 * run through the full Opportunity -> draft -> mechanical gate ->
 * nine-agent deep review -> ready_for_owner pipeline. Never publishes
 * anything -- the furthest an asset can reach is 'ready_for_owner'. Costs
 * real LLM tokens (one drafting call plus up to nine review calls), so
 * POST-only.
 *
 * The actual pipeline runs on GitHub Actions
 * (scripts/campaign-worker/run-single.ts), not inline in this request --
 * see enqueue_campaign_run's own doc comment (migration
 * 0041_campaign_run_requests.sql) for why: this endpoint used to call
 * runCampaignForOpportunity directly and occasionally exceeded Vercel's
 * 120s function cap. Poll GET /api/campaign-run-status?id=<the returned
 * campaignRunRequestId> for the eventual result. See
 * src/content/runCampaignForOpportunity.ts for the shared, testable
 * pipeline implementation, also used by the scheduled auto-draft step
 * (api/daily-pipeline.ts, which still calls it inline -- that path has no
 * HTTP client waiting on a response, so the timeout this endpoint hit
 * doesn't apply there) -- source: "manual" tags this path's cost events to
 * distinguish it from that automated one.
 *
 * Optional `assetType` field (2026-09-08): lets the owner explicitly
 * request a video_script for ANY open opportunity, not just one whose
 * recommended channel happens to be a video platform -- added because the
 * TikTok/YouTube signal adapters that used to produce video-first
 * opportunities were intentionally removed (see api/ingest.ts's own doc
 * comment), which otherwise left the video-script pipeline permanently
 * unreachable even though it's fully implemented and tested. Gated behind
 * requireAppAuth like every other field on this same authenticated
 * endpoint -- there is no separate, less-trusted path for it. The value
 * is checked against an exact allowlist (ALLOWED_ASSET_TYPE_OVERRIDES)
 * before it's ever passed downstream, so a caller can request the one
 * legitimate override this feature exists for and nothing else -- an
 * arbitrary string here is rejected with 400, never silently accepted or
 * coerced. Reuses every existing safeguard unchanged: the same paused
 * check below, the same nine-agent review/budget/grounding pipeline, and
 * the same listOpen()-based idempotency (a second request for an
 * opportunity that already reached ready_for_owner 404s here exactly like
 * a duplicate text campaign request already does, since
 * markOpportunityActioned moves it out of 'open' status).
 *
 * Optional `topic` field (2026-09-08, "Create Fillbook Video"): lets the
 * owner type a brand-new video topic directly, instead of picking from
 * whatever happens to already be an open opportunity. Only valid together
 * with `assetType: "video_script"` (never with `opportunityId` -- exactly
 * one of the two selects what gets drafted). Before anything paid ever
 * happens:
 * 1. Shape-validated (length bounds) via validateVideoTopicShape.
 * 2. Topic-relevance validated via the SAME zero-cost, $0, pre-LLM gate
 *    Prospecting already uses (isPlausiblyTradingRelated) -- an unrelated
 *    topic is rejected with 400 before any LLM call, exactly like an
 *    off-topic Prospecting candidate is filtered before it ever becomes
 *    actionable. Applied to an existing-opportunity request too (when
 *    assetType is "video_script"), not just the free-typed-topic path --
 *    requirement 4 is "reject unrelated topics", not "reject unrelated
 *    typed topics specifically."
 * 3. Checked for an existing opportunity with the identical (whitespace/
 *    case-insensitive) canonical title -- see manualVideoTopicTitle --
 *    and rejected with 409 if one already exists, regardless of that
 *    opportunity's current status. This is the duplicate-prevention gate
 *    for "the same topic requested twice" (a rapid double-tap is caught
 *    first, and more cheaply, by the Android app's own busy-state guard
 *    on the button itself).
 * Only once all three pass does this create a real (if minimal)
 * `opportunities` row for the topic and hand it to the exact same
 * runCampaignForOpportunity call every other request already goes
 * through -- no separate pipeline, no separate budget/idempotency logic.
 */
const planFor = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id);
/** A concept's day in the fixed daily order (1-30), or 0 for a concept that is not in it. */
const dayOf = (id: string): number => dailyPosition(id) + 1;
/** Owner rule, 2026-10-01: a NEW video is only ever requested from a chart-card concept. Older concepts stay in the catalog (so an already drafted or approved script still renders) but are never offered or accepted again. */
const isOffered = (id: string): boolean => { const p = planFor(id); return p ? isOfferedPlan(p) : false; };
const meetsBar = (id: string): boolean => { const p = planFor(id); return p ? renderBar(p).ok : false; };
const barSummary = (id: string) => { const p = planFor(id); const r = p ? renderBar(p) : null; return { score: r?.score ?? 0, grade: r?.grade ?? "D", fixes: r?.fixes ?? [] }; };
const barRefusal = (id: string): string => { const p = planFor(id); return p ? renderBarRefusal(p) : `"${id}" is not a known concept.`; };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Requesting a video is something the automation token may do (approving it is not -- see requireAppAuth).
  if (!requireAppAuth(req, res, { allowAutomation: true })) return;
  // GET: the fixed, small catalog of concepts that have verified product
  // motion (see motionCatalog.ts's listMotionConcepts) -- read-only, no
  // paused/budget gate needed since it costs nothing and changes nothing.
  // The Android "Create Fillbook Video" picker calls this to show which
  // concepts get real recordings vs. the free-text custom-topic fallback.
  if (req.method === "GET") {
    try {
      const states = await motionConceptStates(getServiceClient());
      const unused = listMotionConcepts().filter((c) => isOffered(c.id) && !states.has(manualMotionConceptTitle(c)) && meetsBar(c.id));
      // Owner rule, 2026-10-02: never offer near-copies to choose between. A concept that says nearly what one already made or
      // waiting says, or what an earlier one in this list says, is left out (it stays in the catalog; see conceptVariety.ts).
      const used = listMotionConcepts().filter((c) => isOffered(c.id) && ["made", "waiting"].includes(states.get(manualMotionConceptTitle(c)) ?? "")).map((c) => c.id);
      const motionConcepts = distinctConcepts(unused, used, planFor);
      const requestedToday = await motionRequestedToday(getServiceClient());
      const offeredIds = new Set(motionConcepts.map((c) => c.id));
      res.status(200).json({
        // Only A and A+ concepts are offered (owner rule, 2026-09-30); the rest are listed with their grade and what to fix.
        // Each concept carries its day number (1-30, the fixed daily order); nextConceptId is the first one on offer, i.e. what the
        // daily refill will request next.
        motionConcepts: motionConcepts.map((c) => ({ ...c, day: dayOf(c.id) })),
        nextConceptId: motionConcepts[0]?.id ?? null,
        // One request a day (owner rule, 2026-10-03): the concept already requested today, if any, and when the next request opens.
        dailyLimit: { requestedToday, nextRequestAt: requestedToday ? nextDayStart(new Date()).toISOString() : null },
        // Unused concepts left out because they are near-copies of one that is made, waiting or offered above.
        hiddenNearCopyConceptIds: unused.filter((c) => !offeredIds.has(c.id)).map((c) => c.id),
        belowBarMotionConcepts: listMotionConcepts()
          .filter((c) => isOffered(c.id) && !meetsBar(c.id))
          .map((c) => ({ id: c.id, title: c.title, ...barSummary(c.id) })),
        unavailableMotionConcepts: listMotionConcepts()
          .filter((c) => isOffered(c.id) && states.has(manualMotionConceptTitle(c)))
          .map((c) => ({ id: c.id, title: c.title, day: dayOf(c.id), state: states.get(manualMotionConceptTitle(c)) })),
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const client = getServiceClient();

    const { data: settings } = await client.from("system_settings").select("paused").eq("id", true).single();
    if (settings?.paused) {
      res.status(409).json({ error: "System is paused -- unpause it in Settings before running a campaign manually." });
      return;
    }

    const body = req.body as { opportunityId?: string; topic?: unknown; assetType?: unknown; motionConceptId?: unknown } | undefined;
    const opportunityId = body?.opportunityId;
    const rawTopic = body?.topic;
    const rawMotionConceptId = body?.motionConceptId;

    if (rawMotionConceptId !== undefined) {
      if (typeof rawMotionConceptId !== "string" || !rawMotionConceptId) {
        res.status(400).json({ error: "motionConceptId, if provided, must be a non-empty string." });
        return;
      }
      if (opportunityId || rawTopic !== undefined) {
        res.status(400).json({ error: "Provide only one of motionConceptId, topic, or opportunityId." });
        return;
      }
      const concept = listMotionConcepts().find((c) => c.id === rawMotionConceptId);
      if (concept && !isOffered(concept.id)) {
        res.status(409).json({ error: `"${concept.title}" is retired: new videos are only made from the chart-card concepts now. Pick one from the list.` });
        return;
      }
      if (concept && !meetsBar(concept.id)) {
        res.status(409).json({ error: `Story bar not met: ${barRefusal(concept.id)}` });
        return;
      }
      if (!concept) {
        res.status(400).json({
          error: `Unknown motionConceptId "${rawMotionConceptId}". Known concepts: ${listMotionConcepts().map((c) => c.id).join(", ")}.`,
        });
        return;
      }

      const canonicalTitle = manualMotionConceptTitle(concept);
      const state = (await motionConceptStates(client)).get(canonicalTitle);
      if (state) {
        res.status(409).json({
          error: state === "made"
            ? `A video for "${concept.title}" has already been made. Pick another concept.`
            : state === "rejected"
              ? `You already rejected the script for "${concept.title}", and a new request would produce the same script. Pick another concept.`
              : `"${concept.title}" is already in progress or waiting in Approvals.`,
        });
        return;
      }
      // Owner rule, 2026-10-03: one new concept request per day (src/video/dailyLimit.ts).
      const requestedToday = await motionRequestedToday(client);
      if (requestedToday) {
        res.status(409).json({ error: oneADayMessage(requestedToday) });
        return;
      }
      const queued = await enqueueMotionConceptRequest(client, concept);
      res.status(200).json({ status: "queued", campaignRunRequestId: queued.campaignRunRequestId, opportunityId: queued.opportunityId });
      return;
    }

    let assetTypeOverride: AllowedAssetTypeOverride | undefined;
    if (body?.assetType !== undefined) {
      if (!isAllowedAssetTypeOverride(body.assetType)) {
        res.status(400).json({ error: `assetType, if provided, must be one of: ${ALLOWED_ASSET_TYPE_OVERRIDES.join(", ")}` });
        return;
      }
      assetTypeOverride = body.assetType;
    }
    if (assetTypeOverride === "video_script") {
      // The free-topic and Radar video paths made the older stock-footage / dashboard style. Videos now come from the chart-card concepts only.
      res.status(409).json({ error: "Videos are only made from the chart-card concepts now. Pick one from the list (a custom-topic video is no longer offered)." });
      return;
    }

    if (rawTopic !== undefined && opportunityId) {
      res.status(400).json({ error: "Provide either topic or opportunityId, not both." });
      return;
    }
    if (rawTopic !== undefined && assetTypeOverride !== "research") {
      res.status(400).json({ error: "topic is only valid together with assetType: 'research' (a custom-topic video is no longer offered)." });
      return;
    }

    // Typed as the interface, not the concrete class -- OpportunityRepository.insert
    // correctly omits createdAt (assigned by the DB default), matching how
    // OpportunityEngine.createFromEvidence already calls it elsewhere.
    const opportunityRepo: OpportunityRepository = new SupabaseOpportunityRepository(client);
    let opportunity: Awaited<ReturnType<typeof opportunityRepo.listOpen>>[number] | undefined;

    if (rawTopic !== undefined) {
      const isResearchRequest = assetTypeOverride === "research";
      const shapeError = isResearchRequest ? validateResearchTopicShape(rawTopic) : validateVideoTopicShape(rawTopic);
      if (shapeError) {
        res.status(400).json({ error: shapeError.reason });
        return;
      }
      const topic = rawTopic as string;
      if (!isPlausiblyTradingRelated(topic)) {
        res.status(400).json({
          error:
            "This topic doesn't read as futures trading, prop-firm trading, or trading discipline -- rephrase it to be " +
            "more specific, or pick an existing Radar opportunity instead.",
        });
        return;
      }

      const canonicalTitle = isResearchRequest ? manualResearchTopicTitle(topic) : manualVideoTopicTitle(topic);
      const { data: existingDup, error: dupError } = await client
        .from("opportunities")
        .select("id, status")
        .ilike("title", canonicalTitle)
        .limit(1);
      if (dupError) throw new Error(`Duplicate-topic check failed: ${dupError.message}`);
      if (existingDup && existingDup.length > 0) {
        const existing = existingDup[0]!;
        if (existing.status === "open") {
          // Still open = stuck draft (failed a prior quality gate). Re-run it.
          const openList = await opportunityRepo.listOpen();
          opportunity = openList.find((o) => o.id === existing.id);
          if (!opportunity) {
            res.status(409).json({ error: `Duplicate topic found but the opportunity is no longer accessible -- try again.` });
            return;
          }
        } else {
          // Actioned/retired = previous lifecycle is complete. Create a fresh
          // opportunity so the owner can request a new video for the same topic.
          opportunity = await opportunityRepo.insert(
            isResearchRequest ? manualResearchTopicOpportunityInput(topic) : manualVideoTopicOpportunityInput(topic),
          );
        }
      } else {
        opportunity = await opportunityRepo.insert(
          isResearchRequest ? manualResearchTopicOpportunityInput(topic) : manualVideoTopicOpportunityInput(topic),
        );
      }
    } else {
      const openOpportunities = await opportunityRepo.listOpen();
      opportunity = opportunityId
        ? openOpportunities.find((o) => o.id === opportunityId)
        : openOpportunities[0];

      if (
        opportunity &&
        assetTypeOverride === "research" &&
        !isPlausiblyTradingRelated(`${opportunity.title} ${opportunity.rationale}`)
      ) {
        res.status(400).json({
          error: "This opportunity doesn't read as futures/trading-related enough for research -- pick a different one, or use a custom topic instead.",
        });
        return;
      }

      // Duplicate-opportunity prevention for research (2026-09-07): unlike
      // a freshly-typed topic (caught above by the canonical-title check),
      // an EXISTING opportunity can already have a non-retired research
      // record from a prior request -- listOpen() alone doesn't catch this
      // because the opportunity itself is still 'open' (research doesn't
      // touch opportunities.status the way a completed pipeline run does
      // via markOpportunityActioned; it only does that once IT reaches
      // ready_for_owner, and a second concurrent request could otherwise
      // race in before that happens). Requesting a video for an
      // opportunity that already has research (or vice versa) is fine --
      // this only blocks a second research request for the SAME
      // opportunity.
      if (opportunity && assetTypeOverride === "research") {
        const { data: existingAssets, error: existingAssetsError } = await client
          .from("campaign_assets")
          .select("id, campaign_id, campaigns!inner(opportunity_id, status)")
          .eq("asset_type", "research")
          .eq("campaigns.opportunity_id", opportunity.id)
          .neq("campaigns.status", "retired")
          .limit(1);
        if (existingAssetsError) throw new Error(`Duplicate-opportunity research check failed: ${existingAssetsError.message}`);
        if (existingAssets && existingAssets.length > 0) {
          res.status(409).json({
            error: `Research already exists for this opportunity (campaign asset ${existingAssets[0]!.id}) -- check Approvals before requesting it again.`,
          });
          return;
        }
      }
    }

    if (!opportunity) {
      res.status(404).json({ error: opportunityId ? `No open opportunity with id ${opportunityId}` : "No open opportunities to run" });
      return;
    }

    // The actual pipeline (one drafting call plus up to nine review calls)
    // used to run right here, synchronously, inside this request -- moved
    // to GitHub Actions (2026-09-22) after production logs confirmed this
    // endpoint occasionally exceeded Vercel's 120s function cap ("Vercel
    // Runtime Timeout Error"), which the app surfaced as a generic failure
    // even on runs that eventually succeeded server-side. This now only
    // enqueues the work and returns immediately -- see
    // src/db/migrations/0041_campaign_run_requests.sql's enqueue_campaign_run
    // and scripts/campaign-worker/run-single.ts for where it actually runs,
    // same shape as enqueue_video_render/render-single.ts.
    const { data: enqueueRows, error: enqueueError } = await client.rpc("enqueue_campaign_run", {
      p_opportunity_id: opportunity.id,
      p_asset_type_override: assetTypeOverride ?? null,
    });
    if (enqueueError) throw new Error(`enqueue_campaign_run failed: ${enqueueError.message}`);
    const enqueued = (enqueueRows as Array<{ campaign_run_request_id: string; job_id: string | null; already_existed: boolean }>)[0]!;

    res.status(200).json({ status: "queued", campaignRunRequestId: enqueued.campaign_run_request_id, opportunityId: opportunity.id });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
