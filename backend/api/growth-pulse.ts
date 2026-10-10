import type { VercelRequest, VercelResponse } from "@vercel/node";
import { errorMessage } from "../src/lib/errorMessage.js";
import { getServiceClient } from "../src/lib/supabaseClient.js";
import { constantTimeEquals } from "../src/lib/requireAppAuth.js";
import { SignalGraph } from "../src/signals/signalGraph.js";
import { SupabaseSignalRepository } from "../src/signals/supabaseSignalRepository.js";
import { createXSignalAdapter } from "../src/signals/adapters/xAdapter.js";
import { SupabaseIngestionCursorStore } from "../src/signals/adapters/ingestionCursorStore.js";
import { ingestXMentions } from "../src/signals/adapters/xIngestion.js";
import { ingestInboundMentions } from "../src/inbound/inboundIngestion.js";
import { ingestInboundYoutubeComments } from "../src/inbound/inboundYoutubeIngestion.js";
import { SupabaseInboundRepository } from "../src/inbound/supabaseInboundRepository.js";
import { findCreatorIdByHandle } from "../src/creators/supabaseCreatorRepository.js";
import { recordSyncAttempt, recordSyncSuccess, recordSyncFailure } from "../src/lib/integrationHealth.js";
import { runProspectingSearch } from "../src/prospecting/prospectingSearch.js";
import { SupabaseProspectingRepository } from "../src/prospecting/supabaseProspectingRepository.js";
import { getProspectingMonthSpendUsd } from "../src/cost/costTracking.js";
import { runPartnershipDiscoveryStep } from "../src/partnerships/discovery.js";
import { reconcileVideoRenders, sweepStuckVideoRenderDispatches } from "../src/video/videoRenderReconciliation.js";
import { runDailyChartCardRequests } from "../src/video/dailyChartCardRequests.js";
import { expireStuckCampaignRuns } from "../src/video/campaignRunSweep.js";
import { motionRequestedToday } from "../src/video/dailyLimit.js";
import { enqueueMotionConceptRequest } from "../src/opportunities/requestMotionConcept.js";
import { listMotionConcepts } from "../scripts/video-factory/motionCatalog.js";
import { motionConceptStates } from "./run-campaign.js";
import { createYoutubeCommentAdapter } from "../src/signals/adapters/youtubeAdapter.js";
import { extractYoutubeVideoId } from "../src/video/youtubeUrl.js";
import { isMissingPostingTables, saveOwnTweets, syncYoutubeStats } from "../src/posting/postingRepository.js";
import { recordXOwnedReadCostEvent } from "../src/cost/costTracking.js";
import { runEngagementAutoFill } from "../src/engagement/engagementAutoFill.js";
import { AUTOFILL_HEALTH_KEY } from "../src/engagement/engagementHandlers.js";

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

async function runStep(step: string, fn: () => Promise<string>): Promise<StepResult> {
  try {
    return { step, ok: true, detail: await fn() };
  } catch (err) {
    return { step, ok: false, detail: errorMessage(err) };
  }
}

export interface StepGroups {
  x: boolean;
  partnerships: boolean;
  videoReconciliation: boolean;
  youtubeComments: boolean;
  /** Results tracking (2026-09-25): YouTube stats for posted videos, and the account's own X replies with their views. */
  results: boolean;
}

/**
 * Pure query-string -> step-group decision, pulled out of the handler so
 * it's directly unit-testable (see test/growthPulseStepGroups.test.ts)
 * without needing a real VercelRequest/VercelResponse. See this file's
 * main doc comment for why this is flag-driven rather than wall-clock
 * inference: the caller (.github/workflows/growth-pulse.yml) already knows
 * exactly which scheduled slot it is, so it passes that directly instead
 * of this endpoint re-deriving the same fact from `now`. No flags present
 * at all -- e.g. a bare manual POST while debugging -- runs every group.
 */
export function resolveStepGroups(query: Record<string, unknown>): StepGroups {
  const isTrue = (v: unknown) => v === "1" || v === "true";
  const anyFlagPresent = ["x", "partnerships", "videoReconciliation", "youtubeComments", "results"].some((k) => k in query);
  return {
    x: !anyFlagPresent || isTrue(query.x),
    // discovery.ts's own SCHEDULED_CADENCE_DAYS=7 gate means most of these
    // daily calls are a cheap no-op anyway (see discovery.ts's doc
    // comment), so it's fine to fire on the same 3x/day slots as X rather
    // than needing a schedule slot of its own.
    partnerships: !anyFlagPresent || isTrue(query.partnerships),
    // Own flag, own step, own try/catch -- shares this endpoint's 3x/day
    // schedule with X purely for cron-slot economy (see the implementation
    // plan's isolation section); a bug here can never throw into
    // x_mentions/x_inbound/x_prospecting or vice versa.
    videoReconciliation: !anyFlagPresent || isTrue(query.videoReconciliation),
    // Same own-flag/own-try-catch isolation as videoReconciliation above.
    // Riding the same 3x/day slots as X is fine here too -- each video's
    // own per-video cursor (see inboundYoutubeIngestion.ts) means a run
    // only ever fetches genuinely new comments, so there's no reason to
    // poll more or less often than the rest of this endpoint already does.
    youtubeComments: !anyFlagPresent || isTrue(query.youtubeComments),
    // Own flag and own try/catch like the rest; cheap (one X read of ~60 own tweets, one YouTube videos.list call).
    results: !anyFlagPresent || isTrue(query.results),
  };
}

/**
 * The higher-than-1x/day companion to daily-pipeline.ts, covering X's
 * more-frequent workflows. Deliberately ONE file/serverless function (not
 * split further) -- this project was found to already be sitting exactly
 * AT Vercel Hobby's 12-function cap with the existing 12 files (one slot
 * freed by folding the former api/cost-summary.ts into
 * api/summary.ts?view=cost -- see that file's doc comment). Adding a
 * separate function per workflow would have silently re-broken the cap
 * the same way docs/PROGRESS_LEDGER.md's Phase 15 already documents once
 * (a build that succeeds but then fails at "Deploying outputs..." with no
 * further log line).
 *
 * Which step-groups run is controlled by explicit query-string flags
 * (`?x=1`, `?partnerships=1`) set by the CALLER
 * (.github/workflows/growth-pulse.yml), not inferred from wall-clock time
 * inside this handler. That's a deliberate choice over "guess which
 * schedule window `now` is nearest to": GitHub Actions cron triggers are
 * already explicit UTC times -- the workflow file is the one place that
 * already has to know exactly which invocation is which, so passing that
 * as an explicit flag avoids a second, fuzzier inference of the same fact
 * (and the DST/off-by-an-hour edge cases that inference would otherwise
 * need re-solving here). If NO flag is present at all, every step group
 * runs -- this is the manual "run now" behavior (e.g. calling this
 * endpoint by hand while debugging), matching how daily-pipeline.ts's own
 * steps always all run.
 *
 * Every step is independently try/caught, same pattern as
 * daily-pipeline.ts: one source failing (an expired token, a rate limit)
 * never blocks the others.
 *
 * Reddit inbound/prospecting used to run from this same endpoint but were
 * removed (2026-09-06): Reddit closed self-service app registration and
 * no credentials were ever obtained -- see docs/CODE_REVIEW_HANDOFF.md's
 * history for the prior "code-complete, credentials pending" state this
 * replaced.
 *
 * Called 3x/day by .github/workflows/growth-pulse.yml. Same auth contract
 * as daily-pipeline.ts: GET or POST with `Authorization: Bearer
 * <CRON_SECRET>`.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: "CRON_SECRET is not configured on the server" });
    return;
  }
  if (!req.headers.authorization || !constantTimeEquals(req.headers.authorization, `Bearer ${cronSecret}`)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    x: runX,
    partnerships: runPartnerships,
    videoReconciliation: runVideoReconciliation,
    youtubeComments: runYoutubeComments,
    results: runResults,
  } = resolveStepGroups(req.query as Record<string, unknown>);

  const client = getServiceClient();
  const now = new Date();
  const signalGraph = new SignalGraph(new SupabaseSignalRepository(client));
  const cursorStore = new SupabaseIngestionCursorStore(client);
  const results: StepResult[] = [];

  // Connection warm-up (2026-09-13): three separate scheduled runs in a row
  // (2026-09-12T22:00, plus the 2026-09-13T01:00 slot GitHub's own
  // scheduler silently skipped, then the manual catch-up run at 05:50) all
  // saw x_mentions/x_inbound -- always the FIRST real DB queries this
  // handler makes -- fail with a Supabase "Gateway Timeout", while every
  // later step in the exact same request (prospecting, partnerships, video
  // reconciliation) succeeded on the same client. That's the signature of
  // a cold connection/pooler warm-up cost landing on whichever query
  // happens to go first, not a real data problem -- a throwaway query here
  // absorbs that cost before the steps that actually matter run. Swallowed
  // on failure: if even this one times out, x_mentions/x_inbound below
  // will surface their own real errors exactly as before, unblocked.
  try {
    await client.from("system_settings").select("paused").eq("id", true).maybeSingle();
  } catch {
    // Best-effort only -- see comment above.
  }

  if (runX) {
    results.push(
      await runStep("x_mentions", async () => {
        const adapter = createXSignalAdapter(client);
        const userId = await adapter.resolveOwnUserId();
        const signals = await ingestXMentions(adapter, signalGraph, cursorStore, userId);
        return `${signals.length} ingested`;
      }),
    );
    results.push(
      await runStep("x_inbound", async () => {
        await recordSyncAttempt(client, "x_inbound");
        try {
          const adapter = createXSignalAdapter(client);
          const userId = await adapter.resolveOwnUserId();
          const repo = new SupabaseInboundRepository(client);
          const prospectingRepo = new SupabaseProspectingRepository(client);
          const result = await ingestInboundMentions(
            {
              adapter,
              repo,
              findCreatorIdByHandle: (handle) => findCreatorIdByHandle(client, handle),
              hasProspectingOutreach: (authorExternalId) => prospectingRepo.hasPriorOutreach("x", authorExternalId),
            },
            cursorStore,
            userId,
          );
          await recordSyncSuccess(client, "x_inbound", `${result.inserted} new, ${result.skippedExisting} already tracked`);
          return `${result.inserted} new inbound (${result.fetched} fetched, ${result.skippedExisting} already tracked)`;
        } catch (err) {
          await recordSyncFailure(client, "x_inbound", errorMessage(err));
          throw err;
        }
      }),
    );
    results.push(
      await runStep("x_prospecting", async () => {
        await recordSyncAttempt(client, "prospecting");
        try {
          const adapter = createXSignalAdapter(client);
          const repo = new SupabaseProspectingRepository(client);
          const result = await runProspectingSearch({
            adapter,
            repo,
            client,
            getMonthSpendUsd: () => getProspectingMonthSpendUsd(client),
            isPaused: async () => {
              const { data } = await client.from("system_settings").select("paused").eq("id", true).single();
              return data?.paused ?? false;
            },
            now,
          });
          if (result.skipped) {
            // A deliberate skip (budget/queue-capacity gate) is not a
            // failure -- still counts as a successful sync attempt so
            // Health doesn't flag it as broken.
            await recordSyncSuccess(client, "prospecting", `skipped -- ${result.skipReason}`);
            return `skipped -- ${result.skipReason}`;
          }
          await recordSyncSuccess(client, "prospecting", `${result.newCandidates} new, ${result.postsRead} read`);
          return `${result.newCandidates} new (${result.postsRead} read, ${result.excludedAsSpam} excluded as spam, $${result.costUsd.toFixed(4)}) across topics: ${result.topicsSearched.join(", ")}`;
        } catch (err) {
          await recordSyncFailure(client, "prospecting", errorMessage(err));
          throw err;
        }
      }),
    );
  }

  if (runPartnerships) {
    results.push(
      await runStep("partnerships_discovery", async () => {
        let adapter = null;
        try {
          adapter = createXSignalAdapter(client);
        } catch {
          // X credentials not configured -- discovery still runs against
          // existing-records sources (creators/prospecting/inbound) only.
        }
        const result = await runPartnershipDiscoveryStep({
          client,
          adapter,
          triggeredBy: "scheduled",
          now,
          isPaused: async () => {
            const { data } = await client.from("system_settings").select("paused").eq("id", true).single();
            return data?.paused ?? false;
          },
        });
        return `${result.status}: ${result.newCandidates} new (sources: ${result.sourcesSearched.join(", ") || "none"}, $${result.costUsd.toFixed(4)})${result.skipReason ? ` -- ${result.skipReason}` : ""}`;
      }),
    );
  }

  if (runVideoReconciliation) {
    results.push(await runStep("video_render_reconciliation", () => reconcileVideoRenders(client)));
    // Own step, own try/catch -- see sweepStuckVideoRenderDispatches's own
    // doc comment for what this recovers from. process.env access here
    // (rather than threading a key through) mirrors getServiceClient()'s
    // own pattern just above; that call already having succeeded means
    // this env var is set.
    results.push(
      await runStep("video_render_dispatch_sweep", () => sweepStuckVideoRenderDispatches(process.env.SUPABASE_SERVICE_ROLE_KEY as string)),
    );
    // A draft run that never finished (a dead dispatch, a killed job) would hold its concept and the day's one request forever;
    // after 25 minutes with no update it is marked failed so the refill below can try again. See campaignRunSweep.ts.
    results.push(await runStep("campaign_run_sweep", () => expireStuckCampaignRuns(client)));
    // Keeps a few chart cards waiting in Approvals (owner request 2026-10-01). It only queues drafts; approving, and so
    // rendering, stays the owner's action. Bounded: one request a day, at most 1 waiting at once, each concept requested once.
    results.push(
      await runStep("chart_card_requests", () =>
        runDailyChartCardRequests({
          isPaused: async () => {
            const { data } = await client.from("system_settings").select("paused").eq("id", true).maybeSingle();
            return Boolean((data as { paused?: boolean } | null)?.paused);
          },
          states: () => motionConceptStates(client),
          requestedToday: () => motionRequestedToday(client),
          request: async (conceptId) => {
            const concept = listMotionConcepts().find((c) => c.id === conceptId);
            if (!concept) throw new Error(`unknown concept ${conceptId}`);
            return enqueueMotionConceptRequest(client, concept);
          },
        }),
      ),
    );
  }

  if (runYoutubeComments) {
    // Engage tab "ready to go" fill (docs/ENGAGEMENT_ASSISTANT.md): discovers YouTube videos, pre-drafts comment
    // options for the owner's review queue, and purges the 30-day YouTube cache. Discover and draft ONLY: it never
    // posts, likes or follows anything. Never throws (runEngagementAutoFill turns every failure into a summary line),
    // so it cannot fail the pulse or the comment-monitoring step below.
    results.push(
      await runStep("engagement_autofill", async () => {
        const fill = await runEngagementAutoFill(client, {
          now: () => now,
          isPaused: async () => {
            const { data } = await client.from("system_settings").select("paused").eq("id", true).maybeSingle();
            return Boolean((data as { paused?: boolean } | null)?.paused);
          },
        });
        try {
          await recordSyncAttempt(client, AUTOFILL_HEALTH_KEY);
          if (fill.summary.startsWith("failed")) await recordSyncFailure(client, AUTOFILL_HEALTH_KEY, fill.summary);
          else await recordSyncSuccess(client, AUTOFILL_HEALTH_KEY, fill.summary);
        } catch {
          // Health bookkeeping is best-effort.
        }
        return fill.summary;
      }),
    );
    results.push(
      await runStep("youtube_comments", async () => {
        // Not configured is a real, expected state (the owner hasn't
        // created a Google Cloud API key yet) -- reported as a clear
        // skip, not a step failure that'd show up as red in Health.
        let adapter;
        try {
          adapter = createYoutubeCommentAdapter();
        } catch {
          return "skipped -- YOUTUBE_API_KEY not configured";
        }

        const { data: rows, error } = await client
          .from("video_renders")
          .select("published_url")
          .eq("status", "ready")
          .not("published_url", "is", null);
        if (error) throw error;

        // Links saved through the posting plan (video_posts) outlive the render row, so poll those too.
        const { data: postRows, error: postError } = await client.from("video_posts").select("external_id").eq("platform", "youtube_shorts").not("external_id", "is", null);
        if (postError) throw postError;
        const videoIds = [
          ...new Set([
            ...((rows ?? []) as Array<{ published_url: string | null }>)
              .map((r) => (r.published_url ? extractYoutubeVideoId(r.published_url) : null))
              .filter((id): id is string => id !== null),
            ...((postRows ?? []) as Array<{ external_id: string }>).map((r) => r.external_id),
          ]),
        ];
        if (videoIds.length === 0) return "0 videos with a recorded YouTube URL to poll";

        const repo = new SupabaseInboundRepository(client);
        let totalFetched = 0;
        let totalInserted = 0;
        for (const videoId of videoIds) {
          const result = await ingestInboundYoutubeComments({ adapter, repo }, cursorStore, videoId, now);
          totalFetched += result.fetched;
          totalInserted += result.inserted;
        }
        return `${totalInserted} new inbound across ${videoIds.length} video(s) (${totalFetched} fetched)`;
      }),
    );
  }

  if (runResults) {
    results.push(
      await runStep("youtube_stats", async () => {
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey) return "skipped -- YOUTUBE_API_KEY not configured";
        try {
          return await syncYoutubeStats(client, apiKey, fetch, now);
        } catch (err) {
          if (isMissingPostingTables(err)) return "skipped -- migration 0043 not applied yet";
          throw err;
        }
      }),
    );
    results.push(
      await runStep("x_own_posts", async () => {
        // Checked first so a missing table never spends an X read.
        const { error: tableError } = await client.from("x_own_posts").select("tweet_id").limit(1);
        if (tableError && isMissingPostingTables(new Error(`x_own_posts: ${tableError.message} ${tableError.code ?? ""}`))) return "skipped -- migration 0043 not applied yet";
        const adapter = createXSignalAdapter(client);
        const userId = await adapter.resolveOwnUserId(now);
        const tweets = await adapter.fetchOwnTweets(userId, 60, now);
        const cost = await recordXOwnedReadCostEvent(client, tweets.length, { endpoint: "users/tweets", purpose: "results_tracking" });
        const saved = await saveOwnTweets(client, tweets, now);
        return `${saved.saved} own tweets (${saved.replies} replies, ${saved.matched} matched to Prospecting), $${cost.toFixed(3)}`;
      }),
    );
  }

  const allOk = results.every((r) => r.ok);
  res.status(allOk ? 200 : 207).json({
    results,
    ranGroups: { x: runX, partnerships: runPartnerships, videoReconciliation: runVideoReconciliation, youtubeComments: runYoutubeComments, results: runResults },
  });
}
