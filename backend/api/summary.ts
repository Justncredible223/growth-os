import { loadTodaysVideo } from "../src/video/todaysVideo.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { MONTHLY_AUTO_DRAFT_BUDGET_USD, BACKLOG_CAP } from "../src/opportunities/autoDraftEligibility.js";
import { SupabaseAutoDraftRunRepository } from "../src/opportunities/autoDraftRunRepository.js";
import { requireAppAuth } from "../src/lib/requireAppAuth.js";
import { generateStrategy } from "../src/strategy/strategyEngine.js";
import { SupabaseStrategyRepository, collectStrategyEngineInputs } from "../src/strategy/supabaseStrategyRepository.js";
import { interpretExperiment } from "../src/experiments/experimentEngine.js";
import { SupabaseExperimentRepository, measureExperiment } from "../src/experiments/supabaseExperimentRepository.js";
import type { NewExperiment } from "../src/experiments/types.js";
import { SupabaseNotificationRepository } from "../src/notifications/supabaseNotificationRepository.js";
import { getTodaySpendUsd } from "../src/cost/costTracking.js";
import { deriveTodayXPostView, runDailyXFeedPostStep, feedPostTopicLabel, type TodayXPostView } from "../src/content/dailyXFeedPost.js";
import { buildXFeedPostStepDeps } from "../src/content/buildXFeedPostStepDeps.js";
import { SupabaseXFeedPostRunRepository } from "../src/content/xFeedPostRunRepository.js";
import { getOperatingDate, getScheduleTimezone } from "../src/config/scheduleConfig.js";
import { computeGrowthLoopSummary, type GrowthLoopPublicationRow, type GrowthLoopConversionRow } from "../src/attribution/growthLoopAnalytics.js";

/**
 * `?resource=strategy` handles Strategy Evolution -- a read of the latest
 * versioned report (GET) or forcing a fresh one (POST). Folded in here
 * for the same 12-function-cap reason as everything else in this file.
 * See docs/PROGRESS_LEDGER.md and backend/src/strategy/types.ts.
 */
async function handleStrategy(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();
  const repo = new SupabaseStrategyRepository(client);

  if (req.method === "GET") {
    try {
      if (req.query.history === "1") {
        res.status(200).json({ versions: await repo.listHistory(20) });
        return;
      }
      res.status(200).json({ strategy: await repo.getLatest() });
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
    const now = new Date();
    const inputs = await collectStrategyEngineInputs(client, now);
    const recommendation = generateStrategy(inputs);
    const saved = await repo.save(recommendation);
    res.status(200).json({ strategy: saved });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * `?resource=experiments` -- before/after content-performance tests (see
 * backend/src/experiments/types.ts for why "control vs treatment" means
 * time periods here, not a randomized split). GET lists all; POST with
 * no `id` creates+starts one; POST with `{ id, action: "measure" }`
 * computes and PERSISTS an interim result without ending it; POST with
 * `{ id, action: "complete" }` computes a final result and closes it;
 * POST with `{ id, action: "abort" }` cancels one early. Folded in here
 * for the same 12-function-cap reason as strategy above.
 */
async function handleExperiments(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();
  const repo = new SupabaseExperimentRepository(client);

  if (req.method === "GET") {
    try {
      res.status(200).json({ experiments: await repo.list() });
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
      | { id?: string; action?: string; hypothesis?: string; scope?: { platform?: string; assetType?: string }; guardrailNote?: string; startDate?: string; controlWindowDays?: number }
      | undefined;

    if (!body?.id) {
      if (!body?.hypothesis || !body?.startDate) {
        res.status(400).json({ error: "Body must include { hypothesis, startDate } to create an experiment" });
        return;
      }
      const input: NewExperiment = {
        hypothesis: body.hypothesis,
        scope: body.scope ?? {},
        guardrailNote: body.guardrailNote ?? null,
        startDate: body.startDate,
        controlWindowDays: body.controlWindowDays ?? 14,
      };
      const created = await repo.create(input);
      res.status(200).json({ experiment: created });
      return;
    }

    const experiment = await repo.get(body.id);
    if (!experiment) {
      res.status(404).json({ error: "Experiment not found" });
      return;
    }

    if (body.action === "abort") {
      await repo.abort(body.id);
      res.status(200).json({ id: body.id, status: "aborted" });
      return;
    }

    if (body.action === "measure" || body.action === "complete") {
      const now = new Date();
      const { control, treatment } = await measureExperiment(client, experiment, now);
      const result = interpretExperiment(control, treatment, now);

      if (body.action === "complete") {
        const completed = await repo.complete(body.id, result, now.toISOString().slice(0, 10));
        res.status(200).json({ experiment: completed });
        return;
      }
      // "measure" persists the interim result (status untouched, still
      // running) so it survives the app's next refresh instead of living
      // only in this response -- and the response is the persisted row.
      const measured = await repo.recordProvisionalResult(body.id, result);
      res.status(200).json({ experiment: measured });
      return;
    }

    res.status(400).json({ error: "action must be one of: measure, complete, abort" });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * `?resource=notifications` -- the real in-app Notification System (see
 * backend/src/notifications/notificationEngine.ts). GET lists recent
 * notifications + unread count; POST { id, action: "mark-read" } or
 * { action: "mark-all-read" }. In-app only, not OS-level push -- that
 * needs a Firebase Cloud Messaging project (a new external service the
 * owner would have to set up), not attempted without that owner action.
 */
async function handleNotifications(req: VercelRequest, res: VercelResponse): Promise<void> {
  const client = getServiceClient();
  const repo = new SupabaseNotificationRepository(client);

  if (req.method === "GET") {
    try {
      const [notifications, unreadCount] = await Promise.all([repo.list(50), repo.countUnread()]);
      res.status(200).json({ notifications, unreadCount });
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
    const body = req.body as { id?: string; action?: string } | undefined;
    if (body?.action === "mark-all-read") {
      await repo.markAllRead();
      res.status(200).json({ ok: true });
      return;
    }
    if (body?.action === "mark-read" && body.id) {
      await repo.markRead(body.id);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: "action must be 'mark-read' (with id) or 'mark-all-read'" });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * `?resource=brief` (Morning Brief) and `?resource=evening-report`
 * (Evening Report) -- both computed on read from real data, not stored
 * separately, since there's nothing to store that isn't already a
 * snapshot of other tables. "Overnight"/"today" both mean the trailing
 * 24h from the request time, not a calendar-day boundary -- simpler and
 * correct regardless of which timezone the owner is actually in.
 */
async function handleBrief(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const client = getServiceClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [signalsSince, newOpportunities, pendingApprovals, inboundSummaryRow, strategy, unreadNotifications] = await Promise.all([
      client.from("signals").select("id", { count: "exact", head: true }).gte("observed_at", since),
      client.from("opportunities").select("id, title, score").eq("status", "open").gte("created_at", since).order("score", { ascending: false }).limit(5),
      client.from("campaign_assets").select("id, campaigns!inner(status)", { count: "exact", head: true }).eq("stage", "ready_for_owner").eq("campaigns.status", "in_review"),
      client.from("inbound_engagements").select("status"),
      new SupabaseStrategyRepository(client).getLatest(),
      client.from("notifications").select("id, title, severity").is("read_at", null).order("created_at", { ascending: false }).limit(5),
    ]);

    const needsResponse = ((inboundSummaryRow.data ?? []) as Array<{ status: string }>).filter(
      (r) => r.status === "needs_response" || r.status === "review_needed" || r.status === "draft_ready",
    ).length;

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      signalsOvernight: signalsSince.count ?? 0,
      topNewOpportunities: (newOpportunities.data ?? []).map((o: any) => ({ id: o.id, title: o.title, score: Number(o.score) })),
      pendingApprovals: pendingApprovals.count ?? 0,
      inboundNeedsResponse: needsResponse,
      strategySummary: strategy?.summary ?? null,
      unreadNotifications: unreadNotifications.data ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

async function handleEveningReport(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const client = getServiceClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [assetsDrafted, decidedToday, scoresToday, costToday, inboundResolvedToday, topCampaign] = await Promise.all([
      client.from("campaign_assets").select("id", { count: "exact", head: true }).gte("created_at", since),
      client.from("campaigns").select("status").gte("decided_at", since),
      client.from("content_scores").select("verdict").gte("created_at", since),
      client.from("cost_events").select("cost_usd").gte("created_at", since),
      client.from("inbound_engagements").select("id", { count: "exact", head: true }).gte("responded_at", since),
      client.from("opportunities").select("title, score").gte("created_at", since).order("score", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const decided = (decidedToday.data ?? []) as Array<{ status: string }>;
    const approvedCount = decided.filter((c) => c.status === "approved").length;
    const rejectedCount = decided.filter((c) => c.status === "retired").length;

    const scores = (scoresToday.data ?? []) as Array<{ verdict: string }>;
    const passCount = scores.filter((s) => s.verdict === "pass").length;
    const reviewPassRate = scores.length > 0 ? passCount / scores.length : null;

    const totalCostToday = (costToday.data ?? []).reduce((sum: number, r: { cost_usd: number }) => sum + Number(r.cost_usd), 0);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      assetsDrafted: assetsDrafted.count ?? 0,
      approvedToday: approvedCount,
      rejectedToday: rejectedCount,
      reviewPassRate,
      costTodayUsd: Number(totalCostToday.toFixed(6)),
      inboundResolvedToday: inboundResolvedToday.count ?? 0,
      topOpportunity: topCampaign.data ? { title: (topCampaign.data as any).title, score: Number((topCampaign.data as any).score) } : null,
    });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

/**
 * POST here (default resource) is the Pause System control (Settings/
 * System screens): { paused: boolean }. Folded into this GET endpoint
 * rather than a new file -- this project is already at Vercel Hobby's
 * 12-serverless-function cap (see ingest.ts/daily-pipeline.ts), same
 * reasoning as approvals.ts combining its own GET/POST. Actually
 * enforced, not just a display value: see autoDraftStep.ts's isPaused
 * dep and run-campaign.ts's own check -- both real money-spending paths
 * stop when this is true.
 */
/**
 * Folded in from the former api/cost-summary.ts (`GET /api/summary?view=cost`)
 * to free a serverless-function slot for api/reddit-pulse.ts -- this
 * project was discovered to be already AT Vercel Hobby's 12-function cap
 * (see this file's own doc comment below), and the in-progress
 * prospecting-pulse.ts split had silently pushed it to 13 (a real,
 * previously-uncaught deploy-breaking bug, same failure mode documented in
 * docs/PROGRESS_LEDGER.md Phase 15 -- a successful build that then fails
 * silently at the "Deploying outputs..." step). Response shape is
 * byte-for-byte identical to the old endpoint; only the URL changed
 * (Android's NetworkGrowthOsRepository.getCostSummary() updated to match).
 */
/**
 * Real, timezone-correct lookup for Home's Today's X Post -- keyed by
 * x_feed_post_runs.operating_date (America/Phoenix by default), never
 * by campaign_assets.created_at falling in a UTC calendar-day window.
 * See dailyXFeedPost.ts's own doc comment for why that distinction is
 * exactly what made this field sit empty for days at a time.
 */
export async function computeTodayXPostView(client: SupabaseClient, now: Date): Promise<TodayXPostView> {
  try {
    return await computeTodayXPostViewOrThrow(client, now);
  } catch (err) {
    // A missing x_feed_post_runs table (this backend deployed before its
    // migration was applied -- see docs/PROGRESS_LEDGER.md) or any other
    // query failure here must NEVER take down the rest of Home: this
    // function is one entry in GET /api/summary's Promise.all, and an
    // unguarded throw here would reject the whole thing, turning "Today's
    // X Post" trouble into a 500 for signals/opportunities/analytics too.
    // Surfaced as "failed" (not "empty") so it stays visibly distinct
    // from a genuine no-post day -- see this file's own doc comment on
    // deriveTodayXPostView for that distinction.
    return { state: "failed", reason: `Couldn't load today's post status: ${errorMessage(err)}`, canRegenerate: false };
  }
}

async function computeTodayXPostViewOrThrow(client: SupabaseClient, now: Date): Promise<TodayXPostView> {
  const operatingDate = getOperatingDate(now, getScheduleTimezone());
  const runRepo = new SupabaseXFeedPostRunRepository(client);
  const run = await runRepo.getRun(operatingDate);

  if (!run || run.status !== "ready" || !run.campaignAssetId) {
    return deriveTodayXPostView(run, null, false, null, now);
  }

  // Posted is a hard terminal state -- never re-derive a "dismissed"
  // read on an already-posted asset (its campaign could theoretically be
  // retired for unrelated bookkeeping reasons after the fact; that must
  // never make an already-posted post disappear or look regenerable).
  if (run.postedAt) {
    return deriveTodayXPostView(run, "handed_off", false, null);
  }

  const { data: asset } = await client
    .from("campaign_assets")
    .select("stage, campaigns(status)")
    .eq("id", run.campaignAssetId)
    .maybeSingle();
  const campaigns = (asset as { campaigns: { status: string } | { status: string }[] | null } | null)?.campaigns;
  const campaignStatus = Array.isArray(campaigns) ? campaigns[0]?.status : campaigns?.status;
  const dismissed = campaignStatus === "retired";

  let previewText: string | null = null;
  if (!dismissed) {
    const { data: latestVersion } = await client
      .from("content_versions")
      .select("body")
      .eq("campaign_asset_id", run.campaignAssetId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    previewText = latestVersion?.body ?? null;
  }

  return deriveTodayXPostView(run, asset?.stage ?? null, dismissed, previewText);
}

/**
 * `?resource=x-feed-post` -- owner-triggered actions for Today's X Post
 * that don't fit GET /api/summary's read-only response: POST
 * { action: "regenerate" } forces a fresh attempt (bounded, see
 * dailyXFeedPost.ts's MAX_ATTEMPTS_PER_DAY); POST { action: "mark-posted",
 * campaignAssetId } records the owner's own explicit confirmation that
 * the post actually went out on X -- a separate, later step than handoff
 * (which only means "opened X with the draft copied"), same reasoning as
 * Inbound's "Mark responded": this backend has no way to verify a post
 * via the X API, so it's a human confirmation, never an inference.
 */
async function handleXFeedPost(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const client = getServiceClient();
    const body = req.body as { action?: string; campaignAssetId?: string; postedText?: string } | undefined;
    const now = new Date();
    const operatingDate = getOperatingDate(now, getScheduleTimezone());

    if (body?.action === "regenerate") {
      const { deps } = await buildXFeedPostStepDeps(client);
      const start = Date.now();
      await runDailyXFeedPostStep(deps, operatingDate, true, now, start + 55_000);
      res.status(200).json({ todayXPost: await computeTodayXPostView(client, now) });
      return;
    }

    if (body?.action === "mark-posted" && body.campaignAssetId) {
      // The owner's final confirmed text is required, not optional: it's
      // what future originality/editorial-tag comparisons must compare
      // against (see markPosted's kdoc) -- a mark-posted with no text
      // would silently fall back to comparing against the pre-edit draft
      // forever, which is exactly the gap this closes.
      if (!body.postedText || !body.postedText.trim()) {
        res.status(400).json({ error: "postedText is required when marking posted" });
        return;
      }
      const runRepo = new SupabaseXFeedPostRunRepository(client);
      const run = await runRepo.getRun(operatingDate);
      if (!run || run.campaignAssetId !== body.campaignAssetId) {
        res.status(404).json({ error: "No matching Today's X Post run for this asset" });
        return;
      }
      await runRepo.markPosted(operatingDate, now.toISOString(), body.postedText);
      res.status(200).json({ todayXPost: await computeTodayXPostView(client, now) });
      return;
    }

    res.status(400).json({ error: "action must be 'regenerate' or 'mark-posted' (with campaignAssetId and postedText)" });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

export interface XFeedPostHistoryEntry {
  operatingDate: string;
  state: "unposted_draft" | "posted" | "failed";
  topicLabel?: string;
  previewText?: string;
  reason?: string;
  campaignAssetId?: string;
}

/** How many days back Previous drafts/history looks -- deliberately independent of RECENT_EDITORIAL_HISTORY_DAYS (that one drives repetition scoring; this one is just how far back the owner can browse). */
const HISTORY_WINDOW_DAYS = 14;

/**
 * A ready-but-unposted prior day's run is a recoverable draft (item 3's
 * "Previous drafts" surface), not just an editorial-repetition input.
 * Skips 'running' rows (an abandoned prior-day claim -- nothing readable
 * to show) and excludes today's own operating date, which the main
 * Today's X Post card already covers.
 */
async function computeXFeedPostHistory(client: SupabaseClient, now: Date): Promise<XFeedPostHistoryEntry[]> {
  const operatingDate = getOperatingDate(now, getScheduleTimezone());
  const runRepo = new SupabaseXFeedPostRunRepository(client);
  const since = new Date(new Date(operatingDate + "T00:00:00Z").getTime() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const runs = (await runRepo.listRecentRuns(since)).filter((r) => r.operatingDate < operatingDate);

  const entries: XFeedPostHistoryEntry[] = [];
  for (const run of runs) {
    if (run.status === "failed") {
      entries.push({ operatingDate: run.operatingDate, state: "failed", topicLabel: feedPostTopicLabel(run.topicKey) ?? undefined, reason: run.error ?? undefined });
      continue;
    }
    if (run.status === "ready" && run.campaignAssetId) {
      if (run.postedAt) {
        entries.push({
          operatingDate: run.operatingDate,
          state: "posted",
          topicLabel: feedPostTopicLabel(run.topicKey) ?? undefined,
          previewText: run.postedText ?? undefined,
          campaignAssetId: run.campaignAssetId,
        });
      } else {
        const { data: latestVersion } = await client
          .from("content_versions")
          .select("body")
          .eq("campaign_asset_id", run.campaignAssetId)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();
        entries.push({
          operatingDate: run.operatingDate,
          state: "unposted_draft",
          topicLabel: feedPostTopicLabel(run.topicKey) ?? undefined,
          previewText: latestVersion?.body ?? undefined,
          campaignAssetId: run.campaignAssetId,
        });
      }
    }
    // status "running" for a PRIOR day is an abandoned claim (the
    // operating date rolled over before it could even self-heal) -- there
    // is nothing generated to show, so it's silently skipped rather than
    // rendered as a confusing empty history row.
  }
  return entries;
}

/** `?resource=x-feed-post-history` -- read-only GET for the Previous drafts / history surface (item 3). Never accepts writes; Regenerate/Mark-posted stay on `?resource=x-feed-post`. */
async function handleXFeedPostHistory(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const client = getServiceClient();
    const entries = await computeXFeedPostHistory(client, new Date());
    res.status(200).json({ entries });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

async function handleCostSummary(res: VercelResponse): Promise<void> {
  try {
    const client = getServiceClient();
    const { data, error } = await client
      .from("cost_events")
      .select("cost_usd, input_tokens, output_tokens, model, created_at");
    if (error) throw error;

    const rows = (data ?? []) as Array<{
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      model: string;
      created_at: string;
    }>;

    const totalCostUsd = rows.reduce((sum, r) => sum + Number(r.cost_usd), 0);
    const totalInputTokens = rows.reduce((sum, r) => sum + r.input_tokens, 0);
    const totalOutputTokens = rows.reduce((sum, r) => sum + r.output_tokens, 0);

    const last24hCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const last24hCostUsd = rows
      .filter((r) => r.created_at >= last24hCutoff)
      .reduce((sum, r) => sum + Number(r.cost_usd), 0);

    res.status(200).json({
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      last24hCostUsd: Number(last24hCostUsd.toFixed(6)),
      totalCalls: rows.length,
      totalInputTokens,
      totalOutputTokens,
    });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAppAuth(req, res)) return;

  if (req.query.resource === "strategy") {
    await handleStrategy(req, res);
    return;
  }
  if (req.query.resource === "experiments") {
    await handleExperiments(req, res);
    return;
  }
  if (req.query.resource === "notifications") {
    await handleNotifications(req, res);
    return;
  }
  if (req.query.resource === "x-feed-post") {
    await handleXFeedPost(req, res);
    return;
  }
  if (req.query.resource === "x-feed-post-history") {
    await handleXFeedPostHistory(req, res);
    return;
  }
  if (req.query.resource === "brief") {
    await handleBrief(req, res);
    return;
  }
  if (req.query.resource === "evening-report") {
    await handleEveningReport(req, res);
    return;
  }
  if (req.method === "GET" && req.query.view === "cost") {
    await handleCostSummary(res);
    return;
  }

  if (req.method === "POST") {
    try {
      const paused = (req.body as { paused?: boolean } | undefined)?.paused;
      if (typeof paused !== "boolean") {
        res.status(400).json({ error: "Body must be { paused: boolean }" });
        return;
      }
      const client = getServiceClient();
      const { error } = await client
        .from("system_settings")
        .update({ paused, updated_at: new Date().toISOString() })
        .eq("id", true);
      if (error) throw error;
      res.status(200).json({ paused });
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
    const client = getServiceClient();
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const yearMonth = new Date().toISOString().slice(0, 7);

    const autoDraftRunRepo = new SupabaseAutoDraftRunRepository(client);

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [
      signalsToday,
      openOpportunities,
      readyAssetsAwaitingDecision,
      settings,
      signalsBySource,
      opportunitiesByStatus,
      assetsByStage,
      costRows,
      lastAutoDraftRun,
      monthAutoDraftSpendUsd,
      todayXPost,
      todaySpendUsd,
      todaysVideo,
      recentConversions,
      recentPublications,
      recentLinkClicks,
      recentAllConversions,
      recentCostEvents,
      anyConversionEventEver,
    ] = await Promise.all([
        client.from("signals").select("id", { count: "exact", head: true }).gte("observed_at", startOfToday.toISOString()),
        client.from("opportunities").select("id", { count: "exact", head: true }).eq("status", "open"),
        // Same filter as GET /api/approvals: ready_for_owner AND the
        // campaign is still in_review. Counting ready_for_owner alone
        // (the old behavior) overcounted -- an asset can sit at
        // ready_for_owner after its campaign has already been approved
        // or retired, which /api/approvals correctly excludes but this
        // count previously didn't, so Home showed "N waiting on you"
        // while Approvals showed fewer (or zero) real decisions pending.
        client
          .from("campaign_assets")
          .select("id, campaigns!inner(status)", { count: "exact", head: true })
          .eq("stage", "ready_for_owner")
          .eq("campaigns.status", "in_review"),
        client.from("system_settings").select("paused").eq("id", true).single(),
        client.from("signals").select("source"),
        client.from("opportunities").select("status"),
        client.from("campaign_assets").select("stage"),
        client.from("cost_events").select("cost_usd"),
        autoDraftRunRepo.getLastRun(),
        autoDraftRunRepo.getMonthSpendUsd(yearMonth),
        computeTodayXPostView(client, now),
        getTodaySpendUsd(client),
        // The daily video's state for the Home card. A failure here must not break Home, so it resolves to null.
        loadTodaysVideo(client, now).catch(() => null),
        // Attribution loop this session closed (see backend/src/attribution/):
        // FillbookHQ's signup webhook writes here. Surfaced on Home so the
        // loop is actually visible instead of a table nobody queries.
        // event_type filter added 2026-09-18 when conversion_events grew
        // activation/first_trade/first_paid rows alongside signup (see
        // migration 0035) -- without it, this count would silently inflate
        // with every non-signup funnel event once FillbookHQ starts
        // sending them, since the original query counted every row in the
        // table as a signup.
        client
          .from("conversion_events")
          .select("utm_source, utm_medium, utm_content")
          .eq("event_type", "signup")
          .gte("occurred_at", sevenDaysAgo.toISOString()),
        // Growth loop (2026-09-18), Analytics item 4 -- see
        // growthLoopAnalytics.ts's own header comment for exactly what
        // each of these can and cannot honestly claim.
        client.from("content_publications").select("channel, owner_reported_published_at").gte("recorded_at", sevenDaysAgo.toISOString()),
        client.from("link_clicks").select("id", { count: "exact", head: true }).gte("clicked_at", sevenDaysAgo.toISOString()),
        client.from("conversion_events").select("event_type, utm_source, occurred_at").gte("occurred_at", sevenDaysAgo.toISOString()),
        client.from("cost_events").select("cost_usd").gte("created_at", sevenDaysAgo.toISOString()),
        // Existence check only (head:true, limit irrelevant) -- has
        // FillbookHQ's sync EVER delivered anything, any event_type, any
        // time -- distinguishes "genuinely zero this window" from "never
        // connected at all." Deliberately NOT scoped to this window.
        client.from("conversion_events").select("id", { count: "exact", head: true }),
      ]);

    const countBy = (rows: Array<Record<string, string>> | null, key: string): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const row of rows ?? []) {
        const value = row[key] ?? "unknown";
        counts[value] = (counts[value] ?? 0) + 1;
      }
      return counts;
    };
    const totalCostUsd = (costRows.data ?? []).reduce((sum: number, r: { cost_usd: number }) => sum + Number(r.cost_usd), 0);

    // Ranks by whichever of utm_source/utm_medium is present, per row (a
    // signup can legitimately have neither -- a direct visit with no UTM
    // tag -- which is real information, not a data gap, so it's excluded
    // from the ranking rather than counted as an "unknown" source).
    const conversionRows = (recentConversions.data ?? []) as Array<{ utm_source: string | null; utm_medium: string | null; utm_content: string | null }>;
    const sourceCounts = countBy(
      conversionRows.filter((r) => r.utm_source || r.utm_medium).map((r) => ({ source: (r.utm_source || r.utm_medium)! })),
      "source",
    );
    const topSource = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const publicationRows: GrowthLoopPublicationRow[] = ((recentPublications.data ?? []) as Array<{ channel: string; owner_reported_published_at: string | null }>).map((r) => ({
      channel: r.channel,
      ownerReportedPublishedAt: r.owner_reported_published_at,
    }));
    const conversionRowsAllTypes: GrowthLoopConversionRow[] = ((recentAllConversions.data ?? []) as Array<{ event_type: string; utm_source: string | null; occurred_at: string }>).map((r) => ({
      eventType: r.event_type,
      utmSource: r.utm_source,
      occurredAt: r.occurred_at,
    }));
    const recentCostUsd = ((recentCostEvents.data ?? []) as Array<{ cost_usd: number }>).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    const growthLoop = computeGrowthLoopSummary({
      windowDays: 7,
      publications: publicationRows,
      linkClickCount: recentLinkClicks.count ?? 0,
      conversions: conversionRowsAllTypes,
      contentProductionCostUsd: recentCostUsd,
      fillbookSyncHasEverDelivered: (anyConversionEventEver.count ?? 0) > 0,
    });

    res.status(200).json({
      todayXPost,
      video: todaysVideo,
      signalsAnalyzedToday: signalsToday.count ?? 0,
      opportunitiesFound: openOpportunities.count ?? 0,
      assetsReady: readyAssetsAwaitingDecision.count ?? 0,
      // Same real, in_review-filtered count GET /api/approvals returns --
      // guarantees Home and Approvals always agree on "how many."
      pendingReview: readyAssetsAwaitingDecision.count ?? 0,
      systemPaused: settings.data?.paused ?? false,
      attribution: {
        signupsLast7Days: conversionRows.length,
        topSource,
      },
      analytics: {
        totalSignals: (signalsBySource.data ?? []).length,
        signalsBySource: countBy(signalsBySource.data as Array<Record<string, string>>, "source"),
        opportunitiesByStatus: countBy(opportunitiesByStatus.data as Array<Record<string, string>>, "status"),
        campaignAssetsByStage: countBy(assetsByStage.data as Array<Record<string, string>>, "stage"),
        totalCostUsd: Number(totalCostUsd.toFixed(6)),
        // Properly date-scoped (today, UTC calendar day, all providers) --
        // see getTodaySpendUsd's doc comment. totalCostUsd above is
        // lifetime and deliberately left as-is for the screens that
        // already correctly label it "Total"/"LLM spend" (AnalyticsScreen,
        // SystemScreen) -- only Home's "Today's spend" tile was wired to
        // the wrong field, and now reads todaySpendUsd instead.
        todaySpendUsd: Number(todaySpendUsd.toFixed(6)),
        autoDraft: {
          lastRunDate: lastAutoDraftRun?.runDate ?? null,
          lastRunStatus: lastAutoDraftRun?.status ?? null,
          lastRunSkipReason: lastAutoDraftRun?.skipReason ?? null,
          backlogCount: readyAssetsAwaitingDecision.count ?? 0,
          backlogCap: BACKLOG_CAP,
          monthSpendUsd: Number(monthAutoDraftSpendUsd.toFixed(6)),
          monthBudgetUsd: MONTHLY_AUTO_DRAFT_BUDGET_USD,
        },
        growthLoop,
      },
    });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
}
