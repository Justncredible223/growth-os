import type { SupabaseClient } from "@supabase/supabase-js";
import type { Job } from "../jobs/types.js";
import type { JobHandler } from "../jobs/jobQueue.js";
import { errorMessage } from "../lib/errorMessage.js";
import { createTiktokUploadClient, type TiktokUploadClient } from "../signals/adapters/tiktokUploadClient.js";
import { loadFromSupabase, assertApproved } from "../../scripts/video-factory/loadApprovedScript.js";
import { videoClaimProblems } from "../content/videoScriptWriter.js";
import { SupabaseVideoPerformanceRepository, type VideoPerformanceRepository } from "../shortform/performanceRepository.js";
import type { PublishedVideoMetadata } from "../shortform/metadata.js";
import { OFFICIAL_HANDLE } from "../shortform/types.js";
import { authorizeAndAudit, type AuditSink } from "../firewall/externalWriteFirewall.js";

const STORAGE_BUCKET = "rendered-videos";
export const PUBLISH_TIKTOK_JOB_TYPE = "publish_tiktok";

export interface PublishTiktokJobPayload {
  videoRenderId: string;
}

interface VideoRenderRow {
  id: string;
  campaign_asset_id: string;
  status: string;
  storage_path: string | null;
  duration_seconds: number | null;
}

export interface PublishTiktokJobDeps {
  client: SupabaseClient;
  uploadClient: TiktokUploadClient;
  performanceRepo: VideoPerformanceRepository;
  auditSink: AuditSink;
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

export function createPublishTiktokJobDeps(client: SupabaseClient, env: NodeJS.ProcessEnv = process.env): PublishTiktokJobDeps {
  return {
    client,
    uploadClient: createTiktokUploadClient(client, env),
    performanceRepo: new SupabaseVideoPerformanceRepository(client),
    auditSink: supabaseAuditSink(client),
  };
}

function parsePayload(job: Job): PublishTiktokJobPayload {
  const videoRenderId = job.payload.videoRenderId;
  if (typeof videoRenderId !== "string" || !videoRenderId) {
    throw new Error(`${PUBLISH_TIKTOK_JOB_TYPE} job ${job.id} has no videoRenderId in its payload.`);
  }
  return { videoRenderId };
}

/**
 * Same reasoning as youtubePublishJob.ts's buildAutoPublishedMetadata --
 * TikTok's inbox flow has no publishedUrl (nothing is public/addressable
 * until the owner finishes posting in-app), so that field is left empty
 * rather than fabricated.
 */
function buildAutoDraftedMetadata(
  videoScript: { tiktokCaption: string; hashtags: string[]; hook: string; disclosureCta: string | null },
  campaignTitle: string,
  campaignAssetId: string,
  videoRenderId: string,
  durationSeconds: number,
  publishedAt: string,
): PublishedVideoMetadata {
  return {
    platform: "tiktok",
    title: videoScript.tiktokCaption,
    caption: videoScript.tiktokCaption,
    hashtags: videoScript.hashtags,
    handlePlacement: {
      inCaption: videoScript.tiktokCaption.toLowerCase().includes(OFFICIAL_HANDLE),
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
    publishedUrl: "",
  };
}

/**
 * Handles one `publish_tiktok` job: downloads the already-rendered MP4 from
 * Supabase Storage and uploads it to the creator's TikTok inbox as a draft
 * via the Content Posting API. This is an EXTERNAL_DRAFT under
 * docs/EXTERNAL_WRITE_FIREWALL.md, not a publish -- TikTok's inbox flow
 * requires the owner to open the app, add a caption, and post it
 * themselves; there is no automated path to TikTok Direct Post in this
 * codebase, matching externalWriteFirewall.ts's permanent rejection of
 * tiktok.publish_video. Idempotent against retries -- an already-drafted
 * row for this render is treated as success without re-uploading.
 */
export function createPublishTiktokJobHandler(deps: PublishTiktokJobDeps): JobHandler {
  return async (job: Job) => {
    const { videoRenderId } = parsePayload(job);

    const { data: existing, error: existingError } = await deps.client
      .from("platform_publications")
      .select("status")
      .eq("video_render_id", videoRenderId)
      .eq("platform", "tiktok")
      .maybeSingle();
    if (existingError) throw new Error(`load platform_publications failed: ${existingError.message}`);
    const existingStatus = (existing as { status: string } | null)?.status;
    if (existingStatus === "drafted" || existingStatus === "published") return;

    await authorizeAndAudit(
      {
        name: "tiktok.upload_draft_to_inbox",
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
      { video_render_id: videoRenderId, platform: "tiktok", status: "pending", updated_at: new Date().toISOString() },
      { onConflict: "video_render_id,platform" },
    );

    try {
      const pkg = await loadFromSupabase(renderRow.campaign_asset_id, deps.client);
      assertApproved(pkg);
      // Publish-time claims check (2026-11-18): re-check the stored text instead of trusting generation. A hit fails the job before any upload,
      // with the reason in the error so a human can correct the script.
      const claimProblems = videoClaimProblems(pkg.videoScript);
      if (claimProblems.length > 0) throw new Error(`Blocked: the script has claims Fillbook cannot support (${claimProblems.map((p) => `${p.field} ${p.reason}`).join("; ")}).`);

      const { data: fileData, error: downloadError } = await deps.client.storage
        .from(STORAGE_BUCKET)
        .download(renderRow.storage_path);
      if (downloadError || !fileData) throw new Error(`download rendered video failed: ${downloadError?.message ?? "no data"}`);
      const fileBytes = Buffer.from(await fileData.arrayBuffer());

      const publishId = await deps.uploadClient.uploadVideoToInbox({ fileBytes });

      const publishedAt = new Date().toISOString();

      const metadata = buildAutoDraftedMetadata(
        pkg.videoScript,
        pkg.campaignTitle,
        renderRow.campaign_asset_id,
        videoRenderId,
        renderRow.duration_seconds ?? 0,
        publishedAt,
      );
      await deps.performanceRepo.upsertMetadata(metadata);

      const { error: draftedError } = await deps.client
        .from("platform_publications")
        .update({
          external_video_id: publishId,
          status: "drafted",
          published_at: publishedAt,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("video_render_id", videoRenderId)
        .eq("platform", "tiktok");
      if (draftedError) throw new Error(`mark platform_publications drafted failed: ${draftedError.message}`);
    } catch (err) {
      const message = errorMessage(err);
      await deps.client
        .from("platform_publications")
        .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
        .eq("video_render_id", videoRenderId)
        .eq("platform", "tiktok");
      throw err;
    }
  };
}
