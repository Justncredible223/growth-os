import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { requireAppAuth } from "../src/lib/requireAppAuth.js";
import { buildUtmParams, utmQueryString } from "../src/attribution/utmBuilder.js";
import { recordOwnerPublication, getOrCreateDestinationLink } from "../src/attribution/contentPublications.js";
import {
  InboundActionError,
  closeInbound,
  draftResponseForInbound,
  listInbound,
  markFollowUp,
  markResponded,
  runBacklogRecovery,
  summarizeInbound,
} from "../src/inbound/inboundHandlers.js";
import { CampaignFactory, applyOwnerDecisionIfPending, type AssetStage } from "../src/content/campaignFactory.js";
import { isReviewableBacklogAsset } from "../src/content/campaignBacklog.js";
import { ContentQualityGate } from "../src/content/contentQualityGate.js";
import { BrandConstitution } from "../src/knowledge/brandConstitution.js";
import { SupabaseBrandConstitutionRepository } from "../src/knowledge/supabaseRepositories.js";
import {
  ProspectingActionError,
  draftProspectingCandidateReply,
  listProspectingHistory,
  listProspectingQueue,
  markProspectingAlreadyHandled,
  markProspectingNotRelevant,
  markProspectingOpened,
  markProspectingReplied,
  markProspectingSkipped,
  toProspectingJson,
} from "../src/prospecting/prospectingHandlers.js";
import {
  PartnershipActionError,
  activatePartnership,
  archivePartnership,
  closePartnership,
  createPartnership,
  generateDraftForPartnership,
  listPartnerships,
  markPartnershipContacted,
  markPartnershipDoNotContact,
  qualifyPartnership,
  recordPartnershipOutcome,
  recordPartnershipReply,
  sendPartnershipEmail,
  startPartnershipPilot,
  toPartnershipJson,
  updatePartnership,
} from "../src/partnerships/partnershipsHandlers.js";
import type { NewPartnershipProspect, PartnershipOutcomeMetric, PartnershipOutcomeSource } from "../src/partnerships/types.js";
import { runPartnershipDiscoveryStep } from "../src/partnerships/discovery.js";
import { createXSignalAdapter } from "../src/signals/adapters/xAdapter.js";
import { listVideoRenderStatuses, registerDevicePushToken, dismissVideoRender, retryFailedRender, setPublishedUrl, VideoStatusActionError } from "../src/video/videoStatusHandlers.js";
import { MAX_VIDEO_RENDERS_PER_MONTH, MAX_VIDEO_RENDERS_PER_DAY } from "../src/video/videoRenderEligibility.js";
import { listResearchRecords } from "../src/research/researchHandlers.js";
import { PostingActionError, isMissingPostingTables, isPostingPlatform, loadPostingPlan, loadResults, recordManualStats, recordVideoPost } from "../src/posting/postingRepository.js";

/**
 * `?resource=inbound` handles the Inbound Engagement Queue -- a
 * completely different concept (replying to a specific person on X, not
 * approving a drafted post) folded into this file only because Vercel's
 * Hobby plan caps serverless functions at 12 and this project is already
 * at the cap (same reasoning as api/ingest.ts's multi-source
 * consolidation). See docs/INBOUND_ENGAGEMENT.md.
 */
async function handleInbound(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();

  if (req.method === "GET") {
    try {
      if (req.query.summary === "1") {
        res.status(200).json(await summarizeInbound(client));
        return;
      }
      const includeResolved = req.query.includeResolved === "1";
      res.status(200).json({ items: await listInbound(client, includeResolved) });
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
    const body = req.body as { action?: string; id?: string; note?: string; finalResponse?: string } | undefined;
    const action = body?.action;

    if (action === "backlog-recover") {
      res.status(200).json(await runBacklogRecovery(client));
      return;
    }

    if (!body?.id) {
      res.status(400).json({ error: "Body must include { id: string }" });
      return;
    }

    switch (action) {
      case "draft":
        res.status(200).json(await draftResponseForInbound(client, body.id));
        return;
      case "mark-responded":
        await markResponded(client, body.id, body.note, typeof body.finalResponse === "string" ? body.finalResponse : undefined);
        res.status(200).json({ id: body.id, status: "responded" });
        return;
      case "follow-up":
        await markFollowUp(client, body.id);
        res.status(200).json({ id: body.id, status: "follow_up" });
        return;
      case "close":
        await closeInbound(client, body.id, body.note);
        res.status(200).json({ id: body.id, status: "closed" });
        return;
      default:
        res.status(400).json({ error: "action must be one of: draft, mark-responded, follow-up, close, backlog-recover" });
    }
  } catch (err) {
    if (err instanceof InboundActionError) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * `?resource=prospecting` handles the Prospecting queue -- proactive
 * discovery of OTHER people's public X posts, distinct from both
 * `inbound` (people who spoke TO us) and the default approvals resource
 * (drafted campaign posts awaiting a stage decision). Folded in here for
 * the same reason `inbound` is: Vercel Hobby's 12-function cap, already
 * at capacity (confirmed via `ls backend/api/*.ts` before adding this).
 * See docs/PROSPECTING.md.
 */
async function handleProspecting(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();

  if (req.method === "GET") {
    try {
      if (req.query.history === "1") {
        const items = await listProspectingHistory(client);
        res.status(200).json({ items: items.map(toProspectingJson) });
      } else {
        // diagnostics makes an empty/small `items` array unambiguous --
        // "Queue is clear" (nothing to consider at all) is now
        // distinguishable from "everything's just too old right now" or
        // "plenty of backlog, none of it clears today's quality bar" (see
        // prospectingHandlers.ts's ProspectingSelectionDiagnostics).
        const { candidates, diagnostics, pacing, recovery } = await listProspectingQueue(client);
        res.status(200).json({ items: candidates.map(toProspectingJson), diagnostics, pacing, recovery });
      }
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
    const body = req.body as
      | { action?: string; id?: string; finalReply?: string; mentionsFillbook?: boolean; usedLink?: boolean; reason?: string }
      | undefined;
    const action = body?.action;
    const id = body?.id;
    if (!id) {
      res.status(400).json({ error: "Body must include { id: string }" });
      return;
    }

    switch (action) {
      case "draft":
        res.status(200).json(toProspectingJson(await draftProspectingCandidateReply(client, id)));
        return;
      case "open":
        await markProspectingOpened(client, id);
        res.status(200).json({ id, opened: true });
        return;
      case "mark-replied": {
        const updated = await markProspectingReplied(client, id, body?.finalReply, body?.mentionsFillbook, body?.usedLink);
        res.status(200).json(toProspectingJson(updated));
        return;
      }
      case "skip":
        await markProspectingSkipped(client, id, body?.reason);
        res.status(200).json({ id, status: "skipped" });
        return;
      case "not-relevant":
        await markProspectingNotRelevant(client, id);
        res.status(200).json({ id, status: "not_relevant" });
        return;
      case "already-handled":
        await markProspectingAlreadyHandled(client, id);
        res.status(200).json({ id, status: "already_handled" });
        return;
      default:
        res.status(400).json({ error: "action must be one of: draft, open, mark-replied, skip, not-relevant, already-handled" });
    }
  } catch (err) {
    if (err instanceof ProspectingActionError) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * `?resource=partnerships` handles the Partnerships prospect/pitch/pilot
 * pipeline -- a manual-first workflow distinct from prospecting (public
 * posts) and inbound (people who engaged with @FillbookHQ). Folded in
 * here for the same Vercel Hobby 12-function-cap reason as inbound and
 * prospecting above. See docs/PARTNERSHIPS_MISSION.md.
 */
async function handlePartnerships(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();

  if (req.method === "GET") {
    try {
      const prospects = await listPartnerships(client);
      const withApprovedDraft = prospects.filter((p) => p.approvedCampaignAssetId);
      let previewByAssetId = new Map<string, string>();
      if (withApprovedDraft.length > 0) {
        const { data: versions } = await client
          .from("content_versions")
          .select("campaign_asset_id, body, version")
          .in("campaign_asset_id", withApprovedDraft.map((p) => p.approvedCampaignAssetId));
        const latestByAsset = new Map<string, { body: string; version: number }>();
        for (const row of (versions ?? []) as Array<{ campaign_asset_id: string; body: string; version: number }>) {
          const current = latestByAsset.get(row.campaign_asset_id);
          if (!current || row.version > current.version) latestByAsset.set(row.campaign_asset_id, row);
        }
        previewByAssetId = new Map([...latestByAsset.entries()].map(([assetId, v]) => [assetId, v.body]));
      }
      const items = prospects.map((p) => ({
        ...toPartnershipJson(p),
        previewText: p.approvedCampaignAssetId ? (previewByAssetId.get(p.approvedCampaignAssetId) ?? null) : null,
      }));
      const { data: lastRunRow } = await client
        .from("partnership_discovery_runs")
        .select("status, new_candidates, sources_searched, cost_usd, error, created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastDiscoveryRun = lastRunRow
        ? {
            status: (lastRunRow as { status: string }).status,
            newCandidates: (lastRunRow as { new_candidates: number }).new_candidates,
            sourcesSearched: (lastRunRow as { sources_searched: string[] }).sources_searched,
            costUsd: (lastRunRow as { cost_usd: number }).cost_usd,
            error: (lastRunRow as { error: string | null }).error,
            createdAt: (lastRunRow as { created_at: string }).created_at,
          }
        : null;
      res.status(200).json({ items, lastDiscoveryRun });
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
    const body = req.body as
      | ({
          action?: string;
          id?: string;
          channel?: string;
          finalText?: string;
          subject?: string;
          reason?: string;
          summary?: string;
          rationale?: string;
          termsAgreed?: string;
          startDate?: string;
          metric?: PartnershipOutcomeMetric;
          value?: number | null;
          source?: PartnershipOutcomeSource;
          note?: string | null;
        } & Partial<NewPartnershipProspect>)
      | undefined;
    const action = body?.action;

    if (action === "create") {
      if (!body?.organizationName || !body?.partnerCategory) {
        res.status(400).json({ error: "Body must include { organizationName, partnerCategory } to create a prospect" });
        return;
      }
      const { prospect, existingMatches } = await createPartnership(client, body as NewPartnershipProspect);
      res.status(200).json({ ...toPartnershipJson(prospect), previewText: null, existingMatches });
      return;
    }

    if (action === "refresh-discovery") {
      // Owner-triggered, bounded (see discovery.ts's MAX_NEW_CANDIDATES_PER_RUN
      // and MIN_INTERVAL_MINUTES) -- force:true only bypasses the 7-day
      // SCHEDULED cadence gate, never the budget gate or the minimum-interval
      // gate, so repeated taps can't silently keep spending.
      let adapter = null;
      try {
        adapter = createXSignalAdapter(client);
      } catch {
        // X credentials not configured -- discovery still runs against
        // existing-records sources only, never treated as a hard failure.
      }
      const result = await runPartnershipDiscoveryStep({ client, adapter, triggeredBy: "owner", force: true });
      res.status(200).json(result);
      return;
    }

    const id = body?.id;
    if (!id) {
      res.status(400).json({ error: "Body must include { id: string }" });
      return;
    }

    switch (action) {
      case "update":
        res.status(200).json(toPartnershipJson(await updatePartnership(client, id, body as Partial<NewPartnershipProspect>)));
        return;
      case "qualify":
        if (!body?.rationale) {
          res.status(400).json({ error: "qualify requires { rationale: string }" });
          return;
        }
        res.status(200).json(toPartnershipJson(await qualifyPartnership(client, id, body.rationale)));
        return;
      case "generate-draft":
        res.status(200).json(await generateDraftForPartnership(client, id));
        return;
      case "mark-contacted":
        if (!body?.channel || !body?.finalText) {
          res.status(400).json({ error: "mark-contacted requires { channel: string, finalText: string }" });
          return;
        }
        res.status(200).json(toPartnershipJson(await markPartnershipContacted(client, id, body.channel, body.finalText)));
        return;
      case "send-email":
        if (!body?.finalText) {
          res.status(400).json({ error: "send-email requires { subject?: string, finalText: string }" });
          return;
        }
        res.status(200).json(toPartnershipJson(await sendPartnershipEmail(client, id, body.subject ?? "A partnership idea from Fillbook", body.finalText)));
        return;
      case "record-reply":
        res.status(200).json(toPartnershipJson(await recordPartnershipReply(client, id, body?.summary ?? "Reply received.")));
        return;
      case "start-pilot":
        if (!body?.termsAgreed || !body?.startDate) {
          res.status(400).json({ error: "start-pilot requires { termsAgreed: string, startDate: string }" });
          return;
        }
        res.status(200).json(toPartnershipJson(await startPartnershipPilot(client, id, body.termsAgreed, body.startDate)));
        return;
      case "activate":
        res.status(200).json(toPartnershipJson(await activatePartnership(client, id)));
        return;
      case "close":
        res.status(200).json(toPartnershipJson(await closePartnership(client, id, body?.reason ?? "")));
        return;
      case "archive":
        res.status(200).json(toPartnershipJson(await archivePartnership(client, id, body?.reason ?? "")));
        return;
      case "do-not-contact":
        res.status(200).json(toPartnershipJson(await markPartnershipDoNotContact(client, id, body?.reason ?? "")));
        return;
      case "record-outcome":
        if (!body?.metric || !body?.source) {
          res.status(400).json({ error: "record-outcome requires { metric: string, source: 'measured'|'manual_entry' }" });
          return;
        }
        await recordPartnershipOutcome(client, id, body.metric, body.value ?? null, body.source, body.note);
        res.status(200).json({ id, recorded: true });
        return;
      default:
        res.status(400).json({
          error:
            "action must be one of: create, refresh-discovery, update, qualify, generate-draft, mark-contacted, record-reply, start-pilot, activate, close, archive, do-not-contact, record-outcome",
        });
    }
  } catch (err) {
    if (err instanceof PartnershipActionError) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * Wires CampaignFactory.handOffToOwner() -- built, tested, and never
 * called from any route until now -- to a real action. EXTERNAL_DRAFT
 * only ("opened the platform's own composer / staged the file for the
 * owner"); there is no code path here or in CampaignFactory that can
 * reach EXTERNAL_WRITE. Requires the asset to actually be at
 * 'ready_for_owner' (handOffToOwner throws otherwise) and persists the
 * resulting 'handed_off' stage -- CampaignFactory itself does no I/O.
 */
async function handOffAsset(client: SupabaseClient, campaignAssetId: string): Promise<{ campaignAssetId: string; stage: string }> {
  const { data: asset, error: assetError } = await client
    .from("campaign_assets")
    .select("stage, platform")
    .eq("id", campaignAssetId)
    .single();
  if (assetError) throw assetError;

  const brandConstitution = new BrandConstitution(new SupabaseBrandConstitutionRepository(client));
  const factory = new CampaignFactory(new ContentQualityGate(brandConstitution));
  const newStage = await factory.handOffToOwner(asset.stage as AssetStage, asset.platform as string, campaignAssetId);

  const { error: updateError } = await client
    .from("campaign_assets")
    .update({ stage: newStage })
    .eq("id", campaignAssetId);
  if (updateError) throw updateError;

  return { campaignAssetId, stage: newStage };
}

/**
 * `?resource=video-status` -- the Android Video Status screen's polling
 * endpoint (GET) and device push-token registration (POST). Folded into
 * this file for the same Vercel Hobby 12-function-cap reason as
 * inbound/prospecting/partnerships above. GET is the durable source of
 * truth for render state (see the implementation plan's "Honest limit on
 * exactly-once" note: this never depends on a push notification actually
 * arriving). POST registers the FCM token asserted by the phone's own
 * app -- since every request here already passed requireAppAuth, the
 * caller is trusted to be the one owner's device.
 */
async function handleVideoStatus(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();

  if (req.method === "GET") {
    try {
      const items = await listVideoRenderStatuses(client);
      res.status(200).json({ items });
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
    const body = req.body as { action?: string; fcmToken?: string; videoRenderId?: string; publishedUrl?: string } | undefined;
    if (body?.action === "dismiss") {
      if (!body.videoRenderId) {
        res.status(400).json({ error: "Body must include { action: 'dismiss', videoRenderId: string }" });
        return;
      }
      await dismissVideoRender(client, body.videoRenderId);
      res.status(200).json({ dismissed: true });
      return;
    }
    if (body?.action === "retry-render") {
      if (!body.videoRenderId) {
        res.status(400).json({ error: "Body must include { action: 'retry-render', videoRenderId: string }" });
        return;
      }
      try {
        res.status(200).json(await retryFailedRender(client, body.videoRenderId));
      } catch (err) {
        if (err instanceof VideoStatusActionError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      return;
    }
    if (body?.action === "set-published-url") {
      if (!body.videoRenderId || !body.publishedUrl) {
        res.status(400).json({ error: "Body must include { action: 'set-published-url', videoRenderId: string, publishedUrl: string }" });
        return;
      }
      try {
        await setPublishedUrl(client, body.videoRenderId, body.publishedUrl);
      } catch (err) {
        if (err instanceof VideoStatusActionError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      res.status(200).json({ saved: true });
      return;
    }
    if (body?.action !== "register-device" || !body.fcmToken) {
      res.status(400).json({
        error:
          "Body must be { action: 'register-device', fcmToken: string }, { action: 'dismiss', videoRenderId: string }, " +
          "{ action: 'retry-render', videoRenderId: string }, or { action: 'set-published-url', videoRenderId: string, publishedUrl: string }",
      });
      return;
    }
    // requireAppAuth already validated this header against APP_API_TOKEN.
    const appApiToken = process.env.APP_API_TOKEN as string;
    await registerDevicePushToken(client, body.fcmToken, appApiToken);
    res.status(200).json({ registered: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * `?resource=research` -- the Android Research Lab screen's list endpoint
 * (GET only; creation happens through api/run-campaign.ts's own
 * `assetType: "research"` branch, exactly like video creation goes
 * through that same endpoint rather than through approvals.ts). Folded
 * into this file for the same Vercel Hobby 12-function-cap reason as
 * inbound/prospecting/partnerships/video-status above.
 */
/**
 * `?resource=posting` -- the daily posting plan and results (2026-09-25). Folded into this file for the same Vercel
 * Hobby 12-function-cap reason as the other resources. GET returns today's plan (3 Arizona-time slots) and the last
 * 30 days of results with the X reply-visibility check. POST: `record-post` saves where a video went on one platform;
 * `record-stats` saves numbers the owner typed in for TikTok or Instagram.
 */
async function handlePosting(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();
  try {
    if (req.method === "GET") {
      const [plan, results] = await Promise.all([loadPostingPlan(client), loadResults(client)]);
      res.status(200).json({ plan, results });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.action === "record-post") {
      if (typeof body.campaignAssetId !== "string" || !isPostingPlatform(body.platform) || typeof body.url !== "string") {
        res.status(400).json({ error: "Body must be { action: 'record-post', campaignAssetId, platform: 'tiktok'|'youtube_shorts'|'instagram', url, videoRenderId? }" });
        return;
      }
      await recordVideoPost(client, {
        campaignAssetId: body.campaignAssetId,
        videoRenderId: typeof body.videoRenderId === "string" ? body.videoRenderId : null,
        platform: body.platform,
        url: body.url,
      });
      res.status(200).json({ saved: true });
      return;
    }
    if (body.action === "record-stats") {
      const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
      if (typeof body.videoPostId !== "string") {
        res.status(400).json({ error: "Body must be { action: 'record-stats', videoPostId, views?, likes?, comments?, shares? }" });
        return;
      }
      await recordManualStats(client, { videoPostId: body.videoPostId, views: num(body.views), likes: num(body.likes), comments: num(body.comments), shares: num(body.shares) });
      res.status(200).json({ saved: true });
      return;
    }
    res.status(400).json({ error: "Unknown action. Use 'record-post' or 'record-stats'." });
  } catch (err) {
    if (err instanceof PostingActionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (isMissingPostingTables(err)) {
      res.status(503).json({ error: "Posting plan isn't set up yet: apply migration 0043 in Supabase." });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
}

async function handleResearch(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const items = await listResearchRecords(client);
    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * GET: assembles ApprovalAsset-shaped rows (matching the Android app's
 * data model) from campaign_assets at 'ready_for_owner' whose campaign is
 * still 'in_review' -- i.e. AI-reviewed and genuinely still awaiting a
 * human decision, not already approved or rejected. Flags which ones
 * were produced by the unattended daily auto-draft step
 * (api/daily-pipeline.ts) by checking auto_draft_runs.campaign_id, the
 * same row that already records that run's real cost and timestamp.
 *
 * POST: records the one human decision this whole pipeline exists to
 * wait for. Body: { campaignAssetId, action: "approve" | "reject" }.
 * 'approve' sets campaigns.status = 'approved' -- the only code path
 * anywhere that ever sets this value; auto-draft/run-campaign only ever
 * reach 'in_review'. 'reject' sets campaigns.status = 'retired'. Also
 * transitions the asset's OWN stage off 'ready_for_owner' (to
 * 'handed_off'/'retired' via resolveOwnerDecisionStage) whenever it's
 * still there -- closes a real, confirmed bug where an already-decided
 * asset stayed at 'ready_for_owner' forever, invisible here (this GET
 * requires 'in_review') but still permanently counted by the backlog cap
 * (see campaignBacklog.ts, and migration 0030's one-time repair for rows
 * that got stuck before this fix). Neither action publishes, posts, or
 * contacts any external platform -- approving here only changes what
 * this app displays; the owner still does the actual posting themselves,
 * same as every other path into CampaignFactory (see
 * docs/EXTERNAL_WRITE_FIREWALL.md).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only the read-only video-status list is open to the automation token; every approve/reject/edit stays app-token only.
  if (!requireAppAuth(req, res, { allowAutomation: req.method === "GET" && req.query.resource === "video-status" })) return;
  if (req.query.resource === "inbound") {
    await handleInbound(req, res);
    return;
  }
  if (req.query.resource === "prospecting") {
    await handleProspecting(req, res);
    return;
  }
  if (req.query.resource === "partnerships") {
    await handlePartnerships(req, res);
    return;
  }
  if (req.query.resource === "video-status") {
    await handleVideoStatus(req, res);
    return;
  }
  if (req.query.resource === "research") {
    await handleResearch(req, res);
    return;
  }
  if (req.query.resource === "posting") {
    await handlePosting(req, res);
    return;
  }
  const client = getServiceClient();

  if (req.method === "POST") {
    try {
      const body = req.body as
        | { campaignAssetId?: string; action?: string; decidedBy?: string; reason?: string; channel?: string; actualUrl?: string; ownerReportedPublishedAt?: string }
        | undefined;
      const campaignAssetId = body?.campaignAssetId;
      const action = body?.action;

      if (action === "hand-off") {
        if (!campaignAssetId) {
          res.status(400).json({ error: "Body must include { campaignAssetId: string }" });
          return;
        }
        const result = await handOffAsset(client, campaignAssetId);
        res.status(200).json(result);
        return;
      }

      // Growth loop (2026-09-18): the generalized "I posted this" action --
      // extends Video Status's setPublishedUrl (see videoStatusHandlers.ts)
      // to X posts/replies and Partnerships outreach, the two other
      // content types the growth loop needs published-outcome data for.
      // Body: { campaignAssetId, action: "mark-published", channel,
      // actualUrl?, ownerReportedPublishedAt? }. actualUrl is optional --
      // a plain X reply has no separately copyable "post page" the way a
      // YouTube upload does, so omitting it still records a real
      // owner-confirmed publication (evidence_type:
      // 'owner_confirmed_no_url'), just without a URL. Never itself posts
      // anything -- purely a database write of what the owner reports,
      // same EXTERNAL_DRAFT-only guarantee as every other action here.
      if (action === "mark-published") {
        const channel = typeof body?.channel === "string" ? body.channel : null;
        if (!campaignAssetId || !channel) {
          res.status(400).json({ error: "Body must include { campaignAssetId: string, action: 'mark-published', channel: string }" });
          return;
        }
        try {
          const row = await recordOwnerPublication(client, {
            campaignAssetId,
            channel,
            actualUrl: typeof body?.actualUrl === "string" ? body.actualUrl : null,
            ownerReportedPublishedAt: typeof body?.ownerReportedPublishedAt === "string" ? body.ownerReportedPublishedAt : null,
          });
          res.status(200).json({ recorded: true, publication: row });
        } catch (err) {
          res.status(400).json({ error: errorMessage(err) });
        }
        return;
      }

      // Get-or-create the trackable destination link independent of
      // publish state -- "Copy tracking link" must work on an approved
      // draft that hasn't been posted yet. Body: { campaignAssetId,
      // action: "get-destination-link", channel }.
      if (action === "get-destination-link") {
        const channel = typeof body?.channel === "string" ? body.channel : null;
        if (!campaignAssetId || !channel) {
          res.status(400).json({ error: "Body must include { campaignAssetId: string, action: 'get-destination-link', channel: string }" });
          return;
        }
        try {
          const { data: asset, error: assetErr } = await client
            .from("campaign_assets")
            .select("campaigns(thesis)")
            .eq("id", campaignAssetId)
            .single();
          if (assetErr) throw assetErr;
          const destinationLink = await getOrCreateDestinationLink(client, {
            campaignAssetId,
            channel,
            campaignThesis: (asset as any)?.campaigns?.thesis ?? "campaign",
          });
          res.status(200).json({ destinationLink });
        } catch (err) {
          res.status(400).json({ error: errorMessage(err) });
        }
        return;
      }

      if (!campaignAssetId || (action !== "approve" && action !== "reject")) {
        res.status(400).json({ error: "Body must be { campaignAssetId: string, action: 'approve' | 'reject' | 'hand-off' }" });
        return;
      }

      const { data: asset, error: assetError } = await client
        .from("campaign_assets")
        .select("campaign_id, asset_type, stage")
        .eq("id", campaignAssetId)
        .single();
      if (assetError) throw assetError;

      const newStatus = action === "approve" ? "approved" : "retired";
      const now = new Date().toISOString();
      const { error: updateError } = await client
        .from("campaigns")
        .update({
          status: newStatus,
          updated_at: now,
          decided_by: body?.decidedBy?.trim() || null,
          decided_at: now,
        })
        .eq("id", asset.campaign_id);
      if (updateError) throw updateError;

      // Why it was rejected (optional). Separate, best-effort update: before migration 0048 the column does not exist, and a
      // missing reason must never block the decision itself.
      const rejectionReason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) : "";
      if (action === "reject" && rejectionReason) {
        const { error: reasonError } = await client.from("campaigns").update({ rejection_reason: rejectionReason }).eq("id", asset.campaign_id);
        if (reasonError) console.warn("[approvals] rejection reason not saved:", reasonError.message);
      }

      // Closes a real, confirmed bug: approving/rejecting previously only
      // ever updated campaigns.status above -- this asset's own stage
      // stayed at 'ready_for_owner' forever afterward, invisible in the
      // Approvals list (which requires campaigns.status='in_review') but
      // still permanently counted by the backlog cap. Returns null (a
      // safe no-op) for a repeated call or one that races an
      // already-processed decision, instead of throwing. See
      // campaignFactory.ts's own kdoc for why this reuses 'handed_off'/
      // 'retired' rather than a new stage, and why it's not routed through
      // handOffToOwner (deciding is not the same action as opening the
      // platform's own composer).
      const newAssetStage = applyOwnerDecisionIfPending(asset.stage as AssetStage, action === "approve" ? "approved" : "rejected");
      if (newAssetStage) {
        const { error: stageError } = await client.from("campaign_assets").update({ stage: newAssetStage }).eq("id", campaignAssetId);
        if (stageError) throw stageError;
      }

      // Video rendering isolation: approving a video_script draft queues
      // exactly one render via the single atomic enqueue_video_render RPC
      // (migration 0027) -- see the implementation plan's "Approval/
      // enqueue reliability" section. This never blocks approving the
      // content itself; a monthly-cap denial still returns 200 with the
      // reason surfaced to the app, not an error.
      let videoRender: { queued: boolean; alreadyExisted: boolean; reason: string | null } | undefined;
      if (action === "approve" && asset.asset_type === "video_script") {
        const { data: enqueueData, error: enqueueError } = await client.rpc("enqueue_video_render", {
          p_campaign_asset_id: campaignAssetId,
          p_monthly_cap: MAX_VIDEO_RENDERS_PER_MONTH,
          p_daily_cap: MAX_VIDEO_RENDERS_PER_DAY,
        });
        if (enqueueError) throw enqueueError;
        const row = (Array.isArray(enqueueData) ? enqueueData[0] : enqueueData) as
          | { already_existed: boolean; eligible: boolean; reason: string | null }
          | undefined;
        videoRender = {
          queued: Boolean(row?.eligible),
          alreadyExisted: Boolean(row?.already_existed),
          reason: row?.reason ?? null,
        };
      }

      res.status(200).json({ campaignId: asset.campaign_id, status: newStatus, videoRender });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { data: assets, error: assetsError } = await client
      .from("campaign_assets")
      .select("id, platform, asset_type, campaign_id, campaigns(thesis, status)")
      .eq("stage", "ready_for_owner");
    if (assetsError) throw assetsError;

    const awaitingDecision = (assets ?? []).filter((asset: any) => isReviewableBacklogAsset({ stage: "ready_for_owner", campaignStatus: asset.campaigns?.status }));

    const { data: autoDraftRuns, error: autoDraftError } = await client
      .from("auto_draft_runs")
      .select("campaign_id, cost_usd, created_at")
      .eq("status", "drafted");
    if (autoDraftError) throw autoDraftError;
    const autoDraftByCampaignId = new Map(
      ((autoDraftRuns ?? []) as Array<{ campaign_id: string | null; cost_usd: number | null; created_at: string }>)
        .filter((r) => r.campaign_id)
        .map((r) => [r.campaign_id as string, r]),
    );

    const approvals = await Promise.all(
      awaitingDecision.map(async (asset: any) => {
        const { data: latestVersion } = await client
          .from("content_versions")
          .select("id, body")
          .eq("campaign_asset_id", asset.id)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();

        const autoDraft = autoDraftByCampaignId.get(asset.campaign_id);

        let reviewPassCount = 0;
        let reviewFailCount = 0;
        if (latestVersion) {
          const { data: scores } = await client
            .from("content_scores")
            .select("verdict")
            .eq("content_version_id", latestVersion.id);
          for (const row of (scores ?? []) as Array<{ verdict: string }>) {
            if (row.verdict === "pass") reviewPassCount++;
            else reviewFailCount++;
          }
        }

        const campaignTitle = asset.campaigns?.thesis ?? "(untitled campaign)";
        const utmParams = buildUtmParams(asset.id, asset.platform, campaignTitle);
        // Best-effort: a failure generating/reading the destination link
        // must never block the approvals list itself from loading.
        const destinationLink = await getOrCreateDestinationLink(client, {
          campaignAssetId: asset.id,
          channel: asset.platform,
          campaignThesis: campaignTitle,
        }).catch(() => null);

        return {
          id: asset.id,
          campaignTitle,
          platform: asset.platform,
          assetType: asset.asset_type,
          previewText: latestVersion?.body ?? "",
          stage: "READY_FOR_OWNER",
          isAutoDraft: Boolean(autoDraft),
          costUsd: autoDraft ? Number(autoDraft.cost_usd ?? 0) : null,
          generatedAt: autoDraft ? autoDraft.created_at : null,
          reviewPassCount,
          reviewFailCount,
          // See backend/src/attribution/utmBuilder.ts's kdoc: this is the
          // honest, buildable slice of Attribution -- a consistent tag to
          // append to any fillbookhq.com link in the post, not real
          // click/signup tracking (which needs access this project
          // doesn't have).
          trackingQuery: utmQueryString(utmParams),
          destinationLink,
        };
      }),
    );

    res.status(200).json({ approvals });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
