import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordOwnerPublication } from "../attribution/contentPublications.js";
import { extractYoutubeVideoId } from "./youtubeUrl.js";
import { buildPinnedComment } from "./pinnedComment.js";
import { dayForTitle } from "./todaysVideo.js";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../opportunities/manualMotionConcept.js";
import { MAX_VIDEO_RENDERS_PER_MONTH, MAX_VIDEO_RENDERS_PER_DAY } from "./videoRenderEligibility.js";
import { RETENTION_MARKER, removeRenderSafely } from "./videoRenderRetention.js";

/**
 * The platform-specific publishing metadata generated alongside the video
 * script (see backend/src/content/videoScriptWriter.ts's VideoScript) --
 * surfaced here so Video Status can show copyable YouTube/TikTok sections
 * without a separate fetch. Null whenever the underlying content_versions
 * row has no structured videoScript metadata (e.g. a render created before
 * this field existed) -- never fabricated.
 */
export interface VideoRenderMetadataJson {
  youtubeTitle: string;
  youtubeDescription: string;
  tiktokCaption: string;
  /** Null only for a render predating this field (2026-09-18) -- never fabricated. */
  instagramCaption: string | null;
  hashtags: string[];
  disclosureCta: string | null;
  youtubeThumbnailConcept: string | null;
  /** The comment to post and pin under the video on TikTok and YouTube (pinnedComment.ts). Built from the video's hook, never stored. */
  pinnedComment: string;
}

export interface VideoRenderStatusJson {
  id: string;
  campaignAssetId: string;
  status: "queued" | "rendering" | "ready" | "failed" | "canceled";
  storagePath: string | null;
  /** A short-lived signed URL into the private rendered-videos bucket -- never a public/permanent link. Present only when status='ready' and the signing call itself succeeds; null otherwise (including a transient signing failure, which never blocks the rest of the status list). The app must treat a stale one as expired and re-fetch this endpoint for a fresh URL rather than caching it. */
  downloadUrl: string | null;
  /** Same signed-URL contract as downloadUrl, but for the real video-frame thumbnail render-single.ts extracts alongside the video (see thumbnail_path). Null whenever thumbnail generation failed for this render (best-effort, never blocks the render itself) or the render predates this field. */
  thumbnailDownloadUrl: string | null;
  durationSeconds: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  videoMetadata: VideoRenderMetadataJson | null;
  /** The motion concept's own title, when this video came from one of the daily concepts. */
  conceptTitle: string | null;
  /** Its day in the fixed daily order (1-30). */
  conceptDay: number | null;
  /** The real external URL the owner pasted back in after manually posting this video (see setPublishedUrl) -- null until they do. Never inferred/guessed. */
  publishedUrl: string | null;
}

/**
 * Pure parsing, independent of Supabase -- given whatever raw JSON sits in
 * content_versions.metadata, returns the typed publishing metadata or null.
 * Deliberately tolerant of a partially-shaped object (returns null rather
 * than throwing) since a render's metadata is best-effort display, never
 * something that should break the whole status list.
 */
export function parseVideoRenderMetadata(rawMetadata: unknown, campaignAssetId?: string): VideoRenderMetadataJson | null {
  if (typeof rawMetadata !== "object" || rawMetadata === null) return null;
  const videoScript = (rawMetadata as Record<string, unknown>).videoScript;
  if (typeof videoScript !== "object" || videoScript === null) return null;
  const v = videoScript as Record<string, unknown>;
  if (
    typeof v.youtubeTitle !== "string" ||
    typeof v.youtubeDescription !== "string" ||
    typeof v.tiktokCaption !== "string" ||
    !Array.isArray(v.hashtags) ||
    !v.hashtags.every((h) => typeof h === "string")
  ) {
    return null;
  }
  return {
    youtubeTitle: v.youtubeTitle,
    youtubeDescription: v.youtubeDescription,
    tiktokCaption: v.tiktokCaption,
    instagramCaption: typeof v.instagramCaption === "string" ? v.instagramCaption : null,
    hashtags: v.hashtags as string[],
    disclosureCta: typeof v.disclosureCta === "string" ? v.disclosureCta : null,
    youtubeThumbnailConcept: typeof v.youtubeThumbnailConcept === "string" ? v.youtubeThumbnailConcept : null,
    pinnedComment: buildPinnedComment(typeof v.hook === "string" ? v.hook : v.youtubeTitle, campaignAssetId, v.youtubeDescription),
  };
}

interface VideoRenderRow {
  id: string;
  campaign_asset_id: string;
  status: VideoRenderStatusJson["status"];
  storage_path: string | null;
  thumbnail_path: string | null;
  duration_seconds: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  published_url: string | null;
}

const STORAGE_BUCKET = "rendered-videos";
/** Generous for a phone-only flow (approve -> notification -> open app -> download, possibly minutes apart) while staying short-lived -- never a permanent/public link. */
const SIGNED_URL_TTL_SECONDS = 3600;

/** Polled by the Android Video Status screen -- the durable source of truth for render state, independent of whether any push notification was ever delivered (see the implementation plan's "Honest limit on exactly-once" note). Every call mints a fresh signed URL for each 'ready' row, so the app never needs to cache one past its own screen session -- an expired link is simply fixed by pulling to refresh. */
export async function listVideoRenderStatuses(client: SupabaseClient, limit = 50): Promise<VideoRenderStatusJson[]> {
  const { data, error } = await client
    .from("video_renders")
    .select("id, campaign_asset_id, status, storage_path, thumbnail_path, duration_seconds, error, created_at, updated_at, published_url")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listVideoRenderStatuses failed: ${error.message}`);

  // Rows retention or Dismiss is removing (tombstones) are not shown.
  const rows = ((data ?? []) as VideoRenderRow[]).filter((r) => !(r.status === "canceled" && (r.error ?? "").startsWith(RETENTION_MARKER)));

  // One batched query for every row's own latest content_versions.metadata,
  // instead of one query per row -- a render's own campaign_asset_id is the
  // join key. Best-effort: a failure here never fails the whole status
  // list (same tolerance already applied to signed-URL minting below), it
  // just leaves videoMetadata null for every row this call.
  const metadataByAssetId = new Map<string, VideoRenderMetadataJson | null>();
  const assetIds = [...new Set(rows.map((r) => r.campaign_asset_id))];
  if (assetIds.length > 0) {
    const { data: versions } = await client
      .from("content_versions")
      .select("campaign_asset_id, metadata, version")
      .in("campaign_asset_id", assetIds)
      .order("version", { ascending: false });
    for (const v of (versions ?? []) as Array<{ campaign_asset_id: string; metadata: unknown }>) {
      // Rows arrive ordered by version desc -- the first one seen per
      // asset id is its latest version, so a later (older) row for the
      // same asset is skipped rather than overwriting it.
      if (metadataByAssetId.has(v.campaign_asset_id)) continue;
      metadataByAssetId.set(v.campaign_asset_id, parseVideoRenderMetadata(v.metadata, v.campaign_asset_id));
    }
  }

  // The concept behind each video (best-effort, like the metadata above): the campaign's thesis is the request title.
  const thesisByAssetId = new Map<string, string>();
  if (assetIds.length > 0) {
    const { data: assetRows } = await client.from("campaign_assets").select("id, campaigns(thesis)").in("id", assetIds);
    for (const a of (assetRows ?? []) as unknown as Array<{ id: string; campaigns: { thesis?: string } | Array<{ thesis?: string }> | null }>) {
      const campaign = Array.isArray(a.campaigns) ? a.campaigns[0] : a.campaigns;
      if (campaign?.thesis) thesisByAssetId.set(a.id, campaign.thesis);
    }
  }

  return Promise.all(
    rows.map(async (row) => {
      const thesis = thesisByAssetId.get(row.campaign_asset_id);
      const isConcept = thesis !== undefined && thesis.startsWith(MANUAL_MOTION_CONCEPT_TITLE_PREFIX);
      let downloadUrl: string | null = null;
      let thumbnailDownloadUrl: string | null = null;
      let fileMissing = false;
      if (row.status === "ready" && !row.storage_path) fileMissing = true;
      if (row.status === "ready" && row.storage_path) {
        // A signing failure (bucket hiccup, transient error) never fails the
        // whole status list -- this row just surfaces with no download link,
        // and the next refresh tries again, same "never block on a
        // best-effort extra" pattern used throughout this feature.
        const { data: signed, error: signError } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
        downloadUrl = signed?.signedUrl ?? null;
        // P0 2026-11-15: never show "ready" for a file that is gone; a not-found answer (not a passing hiccup) marks it missing.
        if (!downloadUrl && /not.?found|does not exist/i.test(signError?.message ?? "")) fileMissing = true;
      }
      if (row.status === "ready" && row.thumbnail_path) {
        const { data: signedThumb } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(row.thumbnail_path, SIGNED_URL_TTL_SECONDS);
        thumbnailDownloadUrl = signedThumb?.signedUrl ?? null;
      }
      return {
        id: row.id,
        campaignAssetId: row.campaign_asset_id,
        status: row.status,
        storagePath: row.storage_path,
        downloadUrl,
        thumbnailDownloadUrl,
        durationSeconds: row.duration_seconds,
        // A 'ready' render's error field is always stale (left over from a
        // prior failed attempt before the render eventually succeeded) --
        // suppress it so the app never shows a red error banner on a
        // successfully rendered video.
        error: row.status === "ready" ? null : row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        videoMetadata: metadataByAssetId.get(row.campaign_asset_id) ?? null,
        conceptTitle: isConcept ? thesis!.slice(MANUAL_MOTION_CONCEPT_TITLE_PREFIX.length) : null,
        conceptDay: isConcept ? dayForTitle(thesis!) : null,
        publishedUrl: row.published_url,
        fileMissing,
        stuck: (row.status === "queued" || row.status === "rendering") && Date.now() - Date.parse(row.updated_at) > STUCK_RENDER_RETRY_MINUTES * 60 * 1000,
      };
    }),
  );
}

/**
 * Deletes a render row so the owner can clear items from the Video Status
 * screen or free a topic slot for re-rendering. Allows every status,
 * including queued/rendering -- render-single.ts's own status-update calls
 * (see its `.update({...}).eq("id", videoRenderId)` calls) simply match zero
 * rows and no-op if the render is dismissed out from under an in-flight
 * GitHub Actions job, so there is nothing to orphan by allowing this.
 *
 * For ready renders the stored video file is deleted from Supabase Storage
 * first so the freed bytes are reclaimed from the user's storage cap.
 *
 * Also stamps campaign_assets.video_render_dismissed_at (migration 0033) on
 * the way out -- a real production bug this closes: once this delete
 * removes the video_renders row, an approved video_script campaign_asset
 * with no video_renders row looks IDENTICAL to
 * videoRenderReconciliation.ts's own "crashed before it could be queued"
 * case, so its 3x/day sweep was silently re-enqueueing a fresh render for
 * every dismissed video (a stuck one the owner gave up on, or one they'd
 * already downloaded and cleared) forever, competing with the owner's real
 * daily cap for videos they'd already dealt with. This marker lets that
 * sweep tell "genuinely never rendered" apart from "the owner dismissed
 * this on purpose, never bring it back."
 */
export async function dismissVideoRender(client: SupabaseClient, videoRenderId: string): Promise<void> {
  const { data, error: fetchError } = await client
    .from("video_renders")
    .select("campaign_asset_id, status, storage_path, thumbnail_path")
    .eq("id", videoRenderId)
    .maybeSingle();
  if (fetchError) throw new Error(`dismissVideoRender fetch failed: ${fetchError.message}`);
  // P0 2026-11-15: a second tap (or a retry after a timeout) finds nothing to do, which is success, not an error.
  if (!data) return;
  const {
    campaign_asset_id: campaignAssetId,
    status,
    storage_path: storagePath,
    thumbnail_path: thumbnailPath,
  } = data as {
    campaign_asset_id: string;
    status: string;
    storage_path: string | null;
    thumbnail_path: string | null;
  };

  // A video published automatically keeps its audit row (platform_publications references the render), so it is not dismissed.
  const { count: publishedCount } = await client.from("platform_publications").select("id", { count: "exact", head: true }).eq("video_render_id", videoRenderId);
  if ((publishedCount ?? 0) > 0) throw new VideoStatusActionError("This video was published automatically, so its record is kept and it can't be dismissed.");

  // P0 2026-11-15: tombstone first, then the files, then the rows (removeRenderSafely). The old order removed the file before a row delete
  // that could fail, leaving a "ready" card with no file.
  void status;
  await removeRenderSafely(client, videoRenderId, [storagePath, thumbnailPath]);

  const { error: markError } = await client
    .from("campaign_assets")
    .update({ video_render_dismissed_at: new Date().toISOString() })
    .eq("id", campaignAssetId);
  if (markError) throw new Error(`dismissVideoRender dismissed-marker update failed: ${markError.message}`);
}

export class VideoStatusActionError extends Error {}

/** A queued or rendering video with no progress for this long is "stuck": flagged in the app and in Health, and can be retried. */
export const STUCK_RENDER_RETRY_MINUTES = 45;

/** True when the stored file is there (a signed link can be made for it). */
export async function renderFileExists(client: SupabaseClient, path: string): Promise<boolean> {
  const { data, error } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(path, 60);
  return !error && Boolean(data?.signedUrl);
}

export interface RetryRenderResult {
  queued: boolean;
  /** Why nothing was queued (a render cap), shown to the owner. Null when queued. */
  reason: string | null;
}

/**
 * Re-queues a render that failed (owner tapped Retry, 2026-10-04). Goes through the same atomic enqueue_video_render RPC as approval,
 * so the monthly/daily caps and the one-live-render-per-asset guard still apply. Only a failed render can be retried. The failed row
 * is removed once the new one exists, so the list shows one card for the video, not a failure beside its retry.
 */
export async function retryFailedRender(client: SupabaseClient, videoRenderId: string): Promise<RetryRenderResult> {
  const { data, error } = await client.from("video_renders").select("campaign_asset_id, status").eq("id", videoRenderId).maybeSingle();
  if (error) throw new Error(`retryFailedRender fetch failed: ${error.message}`);
  if (!data) throw new VideoStatusActionError(`video render not found: ${videoRenderId}`);
  const { campaign_asset_id: campaignAssetId, status } = data as { campaign_asset_id: string; status: string };
  // P0 2026-11-15: a render stuck in queued/rendering for STUCK_RENDER_RETRY_MINUTES, or a ready render whose file is gone, can be retried
  // too. A stuck row is first marked failed with a conditional update, so a runner that is in fact still working (it touches updated_at)
  // is never raced: the update matches nothing and the retry is refused.
  if (status === "queued" || status === "rendering") {
    const cutoff = new Date(Date.now() - STUCK_RENDER_RETRY_MINUTES * 60 * 1000).toISOString();
    const { data: marked } = await client
      .from("video_renders")
      .update({ status: "failed", error: `No progress for ${STUCK_RENDER_RETRY_MINUTES} minutes; retried by the owner.`, updated_at: new Date().toISOString() })
      .eq("id", videoRenderId)
      .in("status", ["queued", "rendering"])
      .lt("updated_at", cutoff)
      .select("id");
    if ((marked ?? []).length === 0) throw new VideoStatusActionError(`This render is still running. It can be retried after ${STUCK_RENDER_RETRY_MINUTES} minutes without progress.`);
  } else if (status === "ready") {
    const { data: row } = await client.from("video_renders").select("storage_path").eq("id", videoRenderId).maybeSingle();
    const path = (row as { storage_path?: string | null } | null)?.storage_path ?? null;
    const missing = !path || !(await renderFileExists(client, path));
    if (!missing) throw new VideoStatusActionError("This video is ready; there is nothing to retry.");
    await client.from("video_renders").update({ status: "failed", error: "The video file is missing; re-rendered by the owner.", updated_at: new Date().toISOString() }).eq("id", videoRenderId).eq("status", "ready");
  } else if (status !== "failed") {
    throw new VideoStatusActionError("Only a failed, stuck or missing render can be retried.");
  }

  const { data: enqueueData, error: enqueueError } = await client.rpc("enqueue_video_render", {
    p_campaign_asset_id: campaignAssetId,
    p_monthly_cap: MAX_VIDEO_RENDERS_PER_MONTH,
    p_daily_cap: MAX_VIDEO_RENDERS_PER_DAY,
  });
  if (enqueueError) throw new Error(`retryFailedRender enqueue failed: ${enqueueError.message}`);
  const row = (Array.isArray(enqueueData) ? enqueueData[0] : enqueueData) as { eligible?: boolean; reason?: string | null } | undefined;
  if (!row?.eligible) return { queued: false, reason: row?.reason ?? "The render could not be queued." };

  // The failed row's children first (they reference it without ON DELETE CASCADE), then the row itself.
  const { error: notifError } = await client.from("video_render_notifications").delete().eq("video_render_id", videoRenderId);
  if (notifError) throw new Error(`retryFailedRender notif delete failed: ${notifError.message}`);
  const { error: reserveError } = await client.from("video_storage_reservations").delete().eq("video_render_id", videoRenderId);
  if (reserveError) throw new Error(`retryFailedRender reservation delete failed: ${reserveError.message}`);
  const { error: deleteError } = await client.from("video_renders").delete().eq("id", videoRenderId);
  if (deleteError) throw new Error(`retryFailedRender delete failed: ${deleteError.message}`);
  return { queued: true, reason: null };
}


/**
 * Records the real external URL the owner pasted in after manually
 * posting a 'ready' video -- the only thing that lets a future polling
 * job (e.g. YouTube comment monitoring, see inboundYoutubeIngestion.ts)
 * know which real, live URL to watch, since storage_path only ever points
 * at the internal render file. Only allowed on a 'ready' render (nothing
 * to post yet for any other status) and requires a real http(s) URL --
 * never silently accepts an empty string or something unparseable.
 */
/** Best-effort guess at which platform a pasted URL is for, purely to pick a `channel` label for content_publications -- never used for anything security/access-relevant. Falls back to "other" for a URL this doesn't recognize, still recorded rather than rejected. */
function detectChannelFromUrl(url: string): string {
  if (extractYoutubeVideoId(url)) return "youtube";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  } catch {
    // Already validated as a real URL by the caller -- fall through to "other".
  }
  return "other";
}

export async function setPublishedUrl(client: SupabaseClient, videoRenderId: string, publishedUrl: string): Promise<void> {
  const trimmed = publishedUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new VideoStatusActionError("publishedUrl must be a real http(s) URL.");
  }

  const { data, error: fetchError } = await client.from("video_renders").select("status, campaign_asset_id").eq("id", videoRenderId).maybeSingle();
  if (fetchError) throw new Error(`setPublishedUrl fetch failed: ${fetchError.message}`);
  if (!data) throw new VideoStatusActionError(`video render not found: ${videoRenderId}`);
  if ((data as { status: string }).status !== "ready") {
    throw new VideoStatusActionError("Can only record a published URL for a render that finished successfully.");
  }

  const { error } = await client
    .from("video_renders")
    .update({ published_url: trimmed, updated_at: new Date().toISOString() })
    .eq("id", videoRenderId);
  if (error) throw new Error(`setPublishedUrl update failed: ${error.message}`);

  // Growth loop (2026-09-18): also record it in the generalized
  // content_publications table (migration 0035) alongside the
  // video_renders column above -- kept in sync, never a replacement, so
  // any code still reading video_renders.published_url (e.g. this same
  // file's YouTube-comment-monitoring callers) keeps working unchanged.
  // Best-effort: a failure here must never undo the write above, which is
  // the one video_renders callers actually depend on.
  const campaignAssetId = (data as { campaign_asset_id: string | null }).campaign_asset_id;
  if (campaignAssetId) {
    try {
      await recordOwnerPublication(client, {
        campaignAssetId,
        channel: detectChannelFromUrl(trimmed),
        actualUrl: trimmed,
      });
    } catch (err) {
      console.warn(`setPublishedUrl: content_publications sync failed for ${videoRenderId}, video_renders row still updated`, err);
    }
  }
}

/** One-way fingerprint of the app's own bearer credential -- never the credential itself -- stored alongside each device token purely for future credential-rotation cleanup (see migration 0027's doc comment on device_push_tokens). */
export function fingerprintAppToken(appApiToken: string): string {
  return createHash("sha256").update(appApiToken).digest("hex");
}

/**
 * Registers (or re-activates) an FCM device token for push delivery.
 * Upserts on the token's own uniqueness (a fresh install or token refresh
 * naturally produces a new value; the same physical token reappearing
 * just refreshes last_seen_at and clears any prior revocation).
 */
export async function registerDevicePushToken(client: SupabaseClient, fcmToken: string, appApiToken: string): Promise<void> {
  const { error } = await client.from("device_push_tokens").upsert(
    {
      fcm_token: fcmToken,
      app_token_fingerprint: fingerprintAppToken(appApiToken),
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "fcm_token" },
  );
  if (error) throw new Error(`registerDevicePushToken failed: ${error.message}`);
}
