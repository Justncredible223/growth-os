import type { SupabaseClient } from "@supabase/supabase-js";
import { createYoutubeAnalyticsClient, type YoutubeAnalyticsClient, type YoutubeVideoAnalytics } from "../signals/adapters/youtubeAnalyticsClient.js";
import { emptyMetrics, type PlatformMetrics } from "../shortform/metadata.js";
import { SupabaseVideoPerformanceRepository, type VideoPerformanceRepository } from "../shortform/performanceRepository.js";

export interface YoutubeAnalyticsRefreshDeps {
  client: SupabaseClient;
  analyticsClient: YoutubeAnalyticsClient;
  performanceRepo: VideoPerformanceRepository;
}

export function createYoutubeAnalyticsRefreshDeps(client: SupabaseClient, env: NodeJS.ProcessEnv = process.env): YoutubeAnalyticsRefreshDeps {
  return {
    client,
    analyticsClient: createYoutubeAnalyticsClient(client, env),
    performanceRepo: new SupabaseVideoPerformanceRepository(client),
  };
}

export interface YoutubeAnalyticsRefreshResult {
  publishedVideos: number;
  metricsRecorded: number;
  skippedNoMetadata: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toMetrics(a: YoutubeVideoAnalytics, capturedAt: string): PlatformMetrics {
  const metrics = emptyMetrics(capturedAt, "api");
  metrics.views = a.views;
  metrics.likes = a.likes;
  metrics.comments = a.comments;
  metrics.shares = a.shares;
  metrics.averageViewDurationSeconds = a.averageViewDurationSeconds;
  metrics.percentageViewed = a.averageViewPercentage;
  // Net change, same "can be negative on YouTube" convention documented on
  // PlatformMetrics.followersGained -- not clamped to zero.
  metrics.followersGained = a.subscribersGained !== null && a.subscribersLost !== null ? a.subscribersGained - a.subscribersLost : null;
  // Not obtainable from this report (retention curve / engaged-views /
  // website-click / attribution numbers need either a different YouTube API
  // surface or this project's own link tracking) -- left null rather than
  // guessed, same discipline metadata.ts documents for every metric field.
  return metrics;
}

/**
 * Pulls YouTube Analytics for every published automated video and upserts
 * the numbers as source='api' rows. Wired as an extra step inside the
 * existing /api/daily-pipeline cron handler (see api/daily-pipeline.ts) --
 * NOT a separate Vercel Cron entry, since the Hobby plan's 2-cron-job cap
 * is already spent on that same endpoint's two `?group=` entries.
 *
 * startDate/endDate default to a trailing 30-day window ending 2 days ago:
 * YouTube Analytics data for a given day isn't fully finalized until ~48h
 * later, so ending "yesterday" risks reading partial numbers that would
 * then look like a drop once the real count lands. 30 days keeps a fresh
 * cadence's early metrics visible without a second, separate "which
 * videos need their FIRST pull" query.
 */
export async function refreshYoutubeAnalytics(
  deps: YoutubeAnalyticsRefreshDeps,
  now: Date = new Date(),
): Promise<YoutubeAnalyticsRefreshResult> {
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() - 2);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 30);

  const { data, error } = await deps.client
    .from("platform_publications")
    .select("video_render_id, external_video_id")
    .eq("platform", "youtube")
    // 'drafted' (uploaded private, awaiting the owner making it public) and
    // 'published' (confirmed public) both have real analytics -- YouTube
    // Analytics works for the channel owner's own videos regardless of
    // privacyStatus, so there's no reason to wait for the owner's action
    // before pulling numbers.
    .in("status", ["drafted", "published"])
    .not("external_video_id", "is", null);
  // The automated-upload tables (migrations 0038/0039) are not in the live database: videos are posted by hand and tracked in video_posts,
  // whose YouTube numbers come from syncYoutubeStats. With no such table there is nothing to refresh here, so this is not a failure.
  if (error && /(platform_publications|video_publication_metadata)/.test(error.message) && /(does not exist|schema cache|PGRST205|42P01)/i.test(error.message)) {
    return { publishedVideos: 0, metricsRecorded: 0, skippedNoMetadata: 0 };
  }
  if (error) throw new Error(`load platform_publications failed: ${error.message}`);
  const publications = (data ?? []) as Array<{ video_render_id: string; external_video_id: string }>;
  if (publications.length === 0) return { publishedVideos: 0, metricsRecorded: 0, skippedNoMetadata: 0 };

  const videoRenderIdByExternalId = new Map(publications.map((p) => [p.external_video_id, p.video_render_id]));
  const analytics = await deps.analyticsClient.fetchVideoMetrics(
    [...videoRenderIdByExternalId.keys()],
    isoDate(startDate),
    isoDate(endDate),
  );

  const capturedAt = now.toISOString();
  let metricsRecorded = 0;
  let skippedNoMetadata = 0;
  for (const row of analytics) {
    const videoRenderId = videoRenderIdByExternalId.get(row.videoId);
    if (!videoRenderId) continue;

    // Metadata rows written by the automated publish job (see
    // youtubePublishJob.ts's buildAutoPublishedMetadata) always set
    // variation_id = the video_render_id, which is a uuid unique across
    // the whole table -- so a direct lookup on that column alone finds the
    // right row without also needing experiment_id.
    const { data: metaRow, error: metaError } = await deps.client
      .from("video_publication_metadata")
      .select("id")
      .eq("platform", "youtube_shorts")
      .eq("variation_id", videoRenderId)
      .maybeSingle();
    if (metaError) throw new Error(`load video_publication_metadata failed: ${metaError.message}`);
    if (!metaRow) {
      skippedNoMetadata += 1;
      continue;
    }

    await deps.performanceRepo.recordMetrics((metaRow as { id: string }).id, toMetrics(row, capturedAt));
    metricsRecorded += 1;
  }

  return { publishedVideos: publications.length, metricsRecorded, skippedNoMetadata };
}
