import type { SupabaseClient } from "@supabase/supabase-js";
import type { Job } from "../jobs/types.js";
import type { JobHandler } from "../jobs/jobQueue.js";
import { errorMessage } from "../lib/errorMessage.js";
import { createYoutubeUploadClient, type YoutubeUploadClient } from "../signals/adapters/youtubeUploadClient.js";
import { loadFromSupabase, assertApproved } from "../../scripts/video-factory/loadApprovedScript.js";
import { SupabaseVideoPerformanceRepository, type VideoPerformanceRepository } from "../shortform/performanceRepository.js";
import type { PublishedVideoMetadata } from "../shortform/metadata.js";
import { OFFICIAL_HANDLE } from "../shortform/types.js";
import { authorizeAndAudit, type AuditSink } from "../firewall/externalWriteFirewall.js";

const STORAGE_BUCKET = "rendered-videos";
export const PUBLISH_YOUTUBE_JOB_TYPE = "publish_youtube";

/**
 * YouTube gets a draft every other day, not every day (owner analytics 2026-10-17: 31 near-identical Shorts in four
 * weeks, the last ones at 0 to 2 views). 40 hours rather than 48 so a daily noon render lands on alternate days even
 * when a render runs a few hours late. TikTok is unaffected.
 */
export const YOUTUBE_MIN_HOURS_BETWEEN_DRAFTS = 40;

export interface PublishYoutubeJobPayload {
  videoRenderId: string;
}

interface VideoRenderRow {
  id: string;
  campaign_asset_id: string;
  status: string;
  storage_path: string | null;
  duration_seconds: number | null;
}

export interface PublishYoutubeJobDeps {
  client: SupabaseClient;
  uploadClient: YoutubeUploadClient;
  performanceRepo: VideoPerformanceRepository;
  auditSink: AuditSink;
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date;
}

/** Writes a real row to audit_logs -- see docs/EXTERNAL_WRITE_FIREWALL.md. */
function supabaseAuditSink(client: SupabaseClient): AuditSink {
  return async (record) => {
    await client.from("audit_logs").insert({
      action_name: record.actionName,
      action_class: record.actionClass,
      outcome: record.outcome,
      reason: record.reason,
      context: record.context,
      created_at: record.timestamp,
    });
  };
}

export function createPublishYoutubeJobDeps(client: SupabaseClient, env: NodeJS.ProcessEnv = process.env): PublishYoutubeJobDeps {
  return {
    client,
    uploadClient: createYoutubeUploadClient(client, env),
    performanceRepo: new SupabaseVideoPerformanceRepository(client),
    auditSink: supabaseAuditSink(client),
  };
}

function parsePayload(job: Job): PublishYoutubeJobPayload {
  const videoRenderId = job.payload.videoRenderId;
  if (typeof videoRenderId !== "string" || !videoRenderId) {
    throw new Error(`${PUBLISH_YOUTUBE_JOB_TYPE} job ${job.id} has no videoRenderId in its payload.`);
  }
  return { videoRenderId };
}

/**
 * Builds the metadata row an automated publish writes so the YouTube
 * Analytics pull-back (youtubeAnalyticsRefresh.ts) has somewhere to attach
 * its numbers via the existing video_platform_metrics FK. A handful of
 * fields (series/topic/voice/visualStyle) live only in the in-memory
 * ScenePlan the render pipeline builds and discards, not in anything
 * persisted per render -- those get honest placeholder values here rather
 * than fabricated specifics. title/caption/hashtags/hook are the REAL
 * values the video was actually rendered and uploaded with.
 */
function buildAutoPublishedMetadata(
  videoScript: { youtubeTitle: string; youtubeDescription: string; hashtags: string[]; hook: string; disclosureCta: string | null },
  campaignTitle: string,
  campaignAssetId: string,
  videoRenderId: string,
  durationSeconds: number,
  publishedUrl: string,
  publishedAt: string,
): PublishedVideoMetadata {
  return {
    platform: "youtube_shorts",
    title: videoScript.youtubeTitle,
    caption: videoScript.youtubeDescription,
    hashtags: videoScript.hashtags,
    handlePlacement: {
      inCaption: videoScript.youtubeDescription.toLowerCase().includes(OFFICIAL_HANDLE),
      // The render pipeline always burns the handle into the closing visual
      // (assignHookFallbackScreen / the brand card every render ends on) --
      // a structural property of every render this pipeline produces, not
      // re-verified frame-by-frame here.
      inClosingVisual: true,
    },
    series: campaignTitle,
    topic: campaignTitle,
    hook: videoScript.hook,
    cta: videoScript.disclosureCta ?? "",
    durationSeconds,
    voice: "default",
    visualStyle: "default",
    experimentId: campaignAssetId,
    variationId: videoRenderId,
    publishedAt,
    publishedUrl,
  };
}

/**
 * Handles one `publish_youtube` job: downloads the already-rendered MP4
 * from Supabase Storage, uploads it to YouTube via the Data API v3 as a
 * PRIVATE, not-publicly-reachable video, and records the result. This is
 * an EXTERNAL_DRAFT under docs/EXTERNAL_WRITE_FIREWALL.md, not a publish --
 * the owner still has to open YouTube Studio and make it public themselves.
 * Idempotent against retries -- an already-`drafted`/`published` row for
 * this render is treated as success without re-uploading (a real YouTube
 * video, unlike most external side effects, can't be "upserted" away if a
 * retry re-ran the upload, so this check matters more than most).
 */
export function createPublishYoutubeJobHandler(deps: PublishYoutubeJobDeps): JobHandler {
  return async (job: Job) => {
    const { videoRenderId } = parsePayload(job);

    const { data: existing, error: existingError } = await deps.client
      .from("platform_publications")
      .select("status, external_video_id")
      .eq("video_render_id", videoRenderId)
      .eq("platform", "youtube")
      .maybeSingle();
    if (existingError) throw new Error(`load platform_publications failed: ${existingError.message}`);
    const existingStatus = (existing as { status: string } | null)?.status;
    if (existingStatus === "drafted" || existingStatus === "published") return;

    // Every other day: skip this render on YouTube when another one went up recently. The job completes without an
    // upload and without a platform_publications row, so the video simply stays TikTok-only.
    const now = deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - YOUTUBE_MIN_HOURS_BETWEEN_DRAFTS * 3_600_000).toISOString();
    const { data: recent, error: recentError } = await deps.client
      .from("platform_publications")
      .select("video_render_id")
      .eq("platform", "youtube")
      .in("status", ["drafted", "published"])
      .gte("updated_at", since)
      .limit(1);
    if (recentError) throw new Error(`load recent YouTube drafts failed: ${recentError.message}`);
    if ((recent ?? []).length > 0) return;

    await authorizeAndAudit(
      {
        name: "youtube.upload_private_draft",
        actionClass: "EXTERNAL_DRAFT",
        context: { videoRenderId },
      },
      deps.auditSink,
    );

    const { data: render, error: renderError } = await deps.client
      .from("video_renders")
      .select("id, campaign_asset_id, status, storage_path, duration_seconds")
      .eq("id", videoRenderId)
      .maybeSingle();
    if (renderError) throw new Error(`load video_renders failed: ${renderError.message}`);
    const renderRow = render as VideoRenderRow | null;
    if (!renderRow) throw new Error(`No video_renders row found for id "${videoRenderId}".`);
    if (renderRow.status !== "ready" || !renderRow.storage_path) {
      throw new Error(`video_renders "${videoRenderId}" is not ready to publish (status=${renderRow.status}).`);
    }

    await deps.client.from("platform_publications").upsert(
      { video_render_id: videoRenderId, platform: "youtube", status: "pending", updated_at: new Date().toISOString() },
      { onConflict: "video_render_id,platform" },
    );

    try {
      const pkg = await loadFromSupabase(renderRow.campaign_asset_id, deps.client);
      // Belt-and-suspenders: a render only ever gets created for an
      // already-approved asset (see enqueue_video_render, migration 0027),
      // so this should never actually trip -- but publishing to a real,
      // public YouTube channel is exactly the kind of external side effect
      // worth re-checking rather than trusting a chain of earlier gates.
      assertApproved(pkg);

      const { data: fileData, error: downloadError } = await deps.client.storage
        .from(STORAGE_BUCKET)
        .download(renderRow.storage_path);
      if (downloadError || !fileData) throw new Error(`download rendered video failed: ${downloadError?.message ?? "no data"}`);
      const fileBytes = Buffer.from(await fileData.arrayBuffer());

      const externalVideoId = await deps.uploadClient.uploadVideo({
        title: pkg.videoScript.youtubeTitle,
        description: pkg.videoScript.youtubeDescription,
        fileBytes,
      });

      const publishedAt = new Date().toISOString();
      const publishedUrl = `https://www.youtube.com/watch?v=${externalVideoId}`;

      const metadata = buildAutoPublishedMetadata(
        pkg.videoScript,
        pkg.campaignTitle,
        renderRow.campaign_asset_id,
        videoRenderId,
        renderRow.duration_seconds ?? 0,
        publishedUrl,
        publishedAt,
      );
      await deps.performanceRepo.upsertMetadata(metadata);

      const { error: publishedError } = await deps.client
        .from("platform_publications")
        .update({
          external_video_id: externalVideoId,
          status: "drafted",
          published_at: publishedAt,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("video_render_id", videoRenderId)
        .eq("platform", "youtube");
      if (publishedError) throw new Error(`mark platform_publications drafted failed: ${publishedError.message}`);
    } catch (err) {
      const message = errorMessage(err);
      await deps.client
        .from("platform_publications")
        .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
        .eq("video_render_id", videoRenderId)
        .eq("platform", "youtube");
      throw err;
    }
  };
}
