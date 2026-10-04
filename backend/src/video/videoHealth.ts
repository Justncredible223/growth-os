import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Health of the daily video loop (owner request 2026-10-04): renders failing or stuck, finished videos nobody posted, YouTube
 * numbers not syncing, and the auto-publish flags that must stay off. Each item reads the database and says what is wrong.
 */
export interface VideoHealthItem {
  label: string;
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "NOT_CONNECTED";
  detail: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A queued render older than this has not been picked up. */
export const STUCK_RENDER_MINUTES = 45;
/** A ready video this old with no saved post link is probably forgotten. */
export const UNPOSTED_AFTER_DAYS = 2;
/** YouTube numbers are pulled 3 times a day; older than this means the sync is broken. */
export const YOUTUBE_SYNC_STALE_DAYS = 2;

export interface VideoHealthInput {
  now: Date;
  renders: Array<{ id: string; campaignAssetId: string; status: string; createdAt: string; updatedAt: string }>;
  /** campaign_asset_ids that have at least one saved post link. */
  postedAssetIds: string[];
  youtubePostCount: number;
  lastYoutubeStatsAt: string | null;
  /** Names of the auto-publish env flags currently set to "true". */
  publishingFlagsOn: string[];
  /** False when video_posts does not exist yet (migration 0043 not applied). */
  postingTablesExist: boolean;
}

export function assessVideoLoop(input: VideoHealthInput): VideoHealthItem[] {
  const { now } = input;
  const items: VideoHealthItem[] = [];

  const recent = input.renders.filter((r) => now.getTime() - new Date(r.createdAt).getTime() < 7 * DAY_MS);
  const failed = recent.filter((r) => r.status === "failed");
  const stuck = input.renders.filter((r) => r.status === "queued" && now.getTime() - new Date(r.updatedAt).getTime() > STUCK_RENDER_MINUTES * 60 * 1000);
  if (stuck.length > 0) {
    items.push({ label: "Video rendering", status: "DOWN", detail: `${stuck.length} render${stuck.length === 1 ? "" : "s"} queued for over ${STUCK_RENDER_MINUTES} minutes and not picked up.` });
  } else if (failed.length > 0) {
    items.push({ label: "Video rendering", status: "DEGRADED", detail: `${failed.length} of the last ${recent.length} renders this week failed. Retry from Video Status.` });
  } else {
    items.push({ label: "Video rendering", status: "HEALTHY", detail: recent.length === 0 ? "No renders this week." : `${recent.length} render${recent.length === 1 ? "" : "s"} this week, none failed or stuck.` });
  }

  if (!input.postingTablesExist) {
    items.push({ label: "Video posting", status: "NOT_CONNECTED", detail: "Post tracking isn't set up yet: apply migration 0043 in Supabase." });
  } else {
    const posted = new Set(input.postedAssetIds);
    const forgotten = input.renders.filter(
      (r) => r.status === "ready" && !posted.has(r.campaignAssetId) && now.getTime() - new Date(r.updatedAt).getTime() > UNPOSTED_AFTER_DAYS * DAY_MS && now.getTime() - new Date(r.updatedAt).getTime() < 14 * DAY_MS,
    );
    items.push(
      forgotten.length > 0
        ? { label: "Video posting", status: "DEGRADED", detail: `${forgotten.length} finished video${forgotten.length === 1 ? " has" : "s have"} no post link after ${UNPOSTED_AFTER_DAYS} days. Post it and add the link, or dismiss it.` }
        : { label: "Video posting", status: "HEALTHY", detail: "Every finished video from the last two weeks has a post link or is under 2 days old." },
    );

    if (input.youtubePostCount > 0) {
      const last = input.lastYoutubeStatsAt ? new Date(input.lastYoutubeStatsAt).getTime() : null;
      const stale = last === null || now.getTime() - last > YOUTUBE_SYNC_STALE_DAYS * DAY_MS;
      items.push(
        stale
          ? { label: "YouTube stats", status: "DEGRADED", detail: last === null ? "YouTube posts exist but no numbers have been pulled yet." : `Last YouTube numbers are over ${YOUTUBE_SYNC_STALE_DAYS} days old (${input.lastYoutubeStatsAt}).` }
          : { label: "YouTube stats", status: "HEALTHY", detail: `Verified live -- last pulled ${input.lastYoutubeStatsAt}` },
      );
    }
  }

  items.push(
    input.publishingFlagsOn.length > 0
      ? {
          label: "Auto-publishing",
          status: "HEALTHY",
          detail: `${input.publishingFlagsOn.join(", ")} is on. This only uploads drafts (YouTube as a private video, TikTok into your inbox); nothing goes public until you publish it.`,
        }
      : { label: "Auto-publishing", status: "HEALTHY", detail: "Off. Nothing is uploaded to YouTube or TikTok on its own." },
  );
  return items;
}

const PUBLISHING_FLAGS = ["YOUTUBE_PUBLISHING_ENABLED", "TIKTOK_PUBLISHING_ENABLED"];

/** Reads the database and returns the video-loop health items. */
export async function loadVideoHealth(client: SupabaseClient, now: Date = new Date()): Promise<VideoHealthItem[]> {
  const since = new Date(now.getTime() - 14 * DAY_MS).toISOString();
  const { data: renderRows, error } = await client.from("video_renders").select("id, campaign_asset_id, status, created_at, updated_at").gte("created_at", since);
  if (error) throw new Error(`video health: render lookup failed: ${error.message}`);
  const renders = ((renderRows ?? []) as Array<{ id: string; campaign_asset_id: string; status: string; created_at: string; updated_at: string }>).map((r) => ({
    id: r.id,
    campaignAssetId: r.campaign_asset_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const { data: postRows, error: postError } = await client.from("video_posts").select("id, campaign_asset_id, platform");
  const postingTablesExist = !postError;
  const posts = postingTablesExist ? ((postRows ?? []) as Array<{ id: string; campaign_asset_id: string; platform: string }>) : [];
  const youtubeIds = posts.filter((p) => p.platform === "youtube_shorts").map((p) => p.id);

  let lastYoutubeStatsAt: string | null = null;
  if (youtubeIds.length > 0) {
    const { data: metric } = await client
      .from("video_post_metrics")
      .select("captured_at")
      .in("video_post_id", youtubeIds)
      .eq("source", "api")
      .order("captured_at", { ascending: false })
      .limit(1);
    lastYoutubeStatsAt = ((metric ?? []) as Array<{ captured_at: string }>)[0]?.captured_at ?? null;
  }

  return assessVideoLoop({
    now,
    renders,
    postedAssetIds: posts.map((p) => p.campaign_asset_id),
    youtubePostCount: youtubeIds.length,
    lastYoutubeStatsAt,
    publishingFlagsOn: PUBLISHING_FLAGS.filter((f) => process.env[f] === "true"),
    postingTablesExist,
  });
}
