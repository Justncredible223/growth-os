import type { SupabaseClient } from "@supabase/supabase-js";
import { VIDEO_RETENTION_DAYS } from "./videoRenderEligibility.js";

const STORAGE_BUCKET = "rendered-videos";

interface VideoRenderRow {
  id: string;
  storage_path: string | null;
  thumbnail_path: string | null;
  status: "queued" | "rendering" | "ready" | "failed" | "canceled";
}

/**
 * Deletes Storage objects for ready/failed renders older than
 * VIDEO_RETENTION_DAYS, following the exact pruneOldCostEvents idiom
 * (costTracking.ts) -- stateless, re-evaluated fresh every run, never
 * throws uncaught (runStep wraps it). Critically: a video_renders row and
 * its storage_reservations row are only ever deleted/marked-deleted AFTER
 * the Storage delete call itself confirms success -- see the
 * implementation plan's "Storage safeguards" section. A failed Storage
 * delete leaves both untouched so committed usage is never
 * under-counted, and the next day's run retries it.
 */
export async function pruneOldVideoRenders(client: SupabaseClient, now: Date = new Date()): Promise<string> {
  const cutoff = new Date(now.getTime() - VIDEO_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // P0 2026-11-15 (ChatGPT): the old version removed the file first and then failed to delete the row (child rows reference it without a
  // cascade), leaving a "ready" card with no file and stopping the loop. Now:
  //   - a ready video is only cleaned up once it is posted on every platform (never while it is still waiting for the owner's links);
  //   - each row is first tombstoned (status canceled, error "retention: removing"), then its files are removed, then its child rows and
  //     the row itself are deleted; any step that fails leaves the tombstone for the next run to finish;
  //   - one row's failure never stops the others. Posting history (video_posts) has no link to the row and is kept.
  const columns = "id, campaign_asset_id, storage_path, thumbnail_path, status, error";
  const { data: old, error: candidatesError } = await client.from("video_renders").select(columns).in("status", ["ready", "failed"]).lt("updated_at", cutoff);
  if (candidatesError) throw new Error(`pruneOldVideoRenders failed to load candidates: ${candidatesError.message}`);
  // Rows a previous run (or a Dismiss) tombstoned but could not finish.
  const { data: tombstones } = await client.from("video_renders").select(columns).eq("status", "canceled").eq("error", RETENTION_MARKER);
  const rows = [...(old ?? []), ...(tombstones ?? [])] as Array<VideoRenderRow & { campaign_asset_id: string; error: string | null }>;
  if (rows.length === 0) return `0 renders older than ${VIDEO_RETENTION_DAYS}d`;

  // Which ready videos are posted on every platform.
  const readyAssetIds = [...new Set(rows.filter((r) => r.status === "ready").map((r) => r.campaign_asset_id))];
  const fullyPosted = new Set<string>();
  if (readyAssetIds.length > 0) {
    const { data: posts } = await client.from("video_posts").select("campaign_asset_id, platform").in("campaign_asset_id", readyAssetIds);
    const byAsset = new Map<string, Set<string>>();
    for (const p of (posts ?? []) as Array<{ campaign_asset_id: string; platform: string }>) {
      byAsset.set(p.campaign_asset_id, (byAsset.get(p.campaign_asset_id) ?? new Set()).add(p.platform));
    }
    for (const [assetId, platforms] of byAsset) if (RETENTION_PLATFORMS.every((pl) => platforms.has(pl))) fullyPosted.add(assetId);
  }

  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status === "ready" && !fullyPosted.has(row.campaign_asset_id)) {
      kept++;
      continue;
    }
    try {
      await removeRenderSafely(client, row.id, [row.storage_path, row.thumbnail_path]);
      deleted++;
    } catch (err) {
      failed++;
      console.warn(`[video retention] render ${row.id} not removed this run:`, err instanceof Error ? err.message : err);
    }
  }
  return `${deleted} removed, ${kept} kept (ready and not posted everywhere yet), ${failed} to retry next run`;
}

/** Marks a row that retention is removing; the next run finishes any row left with this marker. */
export const RETENTION_MARKER = "retention: removing";
/** A ready video is cleaned up only after it is posted on all of these. */
export const RETENTION_PLATFORMS = ["tiktok", "youtube_shorts", "instagram"];

/**
 * Tombstone, then files, then child rows and the row (P0 2026-11-15). Shared by retention and Dismiss. Throws on a failed step; the
 * tombstone stays, so the row is never shown as ready without its file and the next run can finish it.
 */
export async function removeRenderSafely(client: SupabaseClient, videoRenderId: string, paths: Array<string | null>): Promise<void> {
  const { error: tombError } = await client.from("video_renders").update({ status: "canceled", error: RETENTION_MARKER, updated_at: new Date().toISOString() }).eq("id", videoRenderId);
  if (tombError) throw new Error(`tombstone failed: ${tombError.message}`);
  const files = paths.filter((p): p is string => Boolean(p));
  if (files.length > 0) {
    const { error: storageError } = await client.storage.from(STORAGE_BUCKET).remove(files);
    if (storageError) throw new Error(`file delete failed: ${storageError.message}`);
  }
  const { error: notifError } = await client.from("video_render_notifications").delete().eq("video_render_id", videoRenderId);
  if (notifError) throw new Error(`notification rows delete failed: ${notifError.message}`);
  const { error: reserveError } = await client.from("video_storage_reservations").delete().eq("video_render_id", videoRenderId);
  if (reserveError) throw new Error(`storage reservation delete failed: ${reserveError.message}`);
  const { error: rowError } = await client.from("video_renders").delete().eq("id", videoRenderId);
  if (rowError) throw new Error(`render row delete failed: ${rowError.message}`);
}
