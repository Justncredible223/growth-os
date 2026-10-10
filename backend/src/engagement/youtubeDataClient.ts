import { YOUTUBE_UNIT_COSTS } from "./policy.js";
import type { VideoMetadata } from "./types.js";

export class YoutubeDataError extends Error {}

const API_BASE = "https://www.googleapis.com/youtube/v3";

/** Called with the endpoint name and unit cost BEFORE each request; throwing aborts the call (the quota guard). */
export type UnitSpender = (endpoint: string, units: number) => Promise<void>;

/** A video is a "Short" for our purposes at or under this many seconds (YouTube Shorts allow up to 3 minutes). */
export const SHORTS_MAX_SECONDS = 180;

/** ISO-8601 duration ("PT1M5S") to seconds. Null when unparseable. */
export function parseIsoDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

export interface TopComment {
  text: string;
}

/**
 * Read-only YouTube Data API v3 client authenticated with an API key (no OAuth, no write scope, nothing here can
 * post). The key is sent in the x-goog-api-key header so it never appears in a URL, a log line or an error message.
 */
export class YoutubeDataClient {
  constructor(
    private apiKey: string,
    private spendUnits: UnitSpender,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(resource: string, params: Record<string, string>, endpoint: string, units: number): Promise<T> {
    await this.spendUnits(endpoint, units);
    const url = `${API_BASE}/${resource}?${new URLSearchParams(params).toString()}`;
    const res = await this.fetchImpl(url, { headers: { "x-goog-api-key": this.apiKey, Accept: "application/json" } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new YoutubeDataError(`YouTube ${resource}.list failed: HTTP ${res.status} -- ${body}`);
    }
    return (await res.json()) as T;
  }

  /** videos.list, 1 unit for up to 50 ids. */
  async videos(ids: string[]): Promise<Array<VideoMetadata & { durationSeconds: number | null; publishedAt: string | null }>> {
    if (ids.length === 0) return [];
    const json = await this.get<{
      items?: Array<{
        id: string;
        snippet?: { title?: string; publishedAt?: string; channelId?: string; channelTitle?: string; description?: string; thumbnails?: Record<string, { url?: string }> };
        statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        contentDetails?: { duration?: string };
      }>;
    }>("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(0, 50).join(",") }, "videos.list", YOUTUBE_UNIT_COSTS.videosList);

    return (json.items ?? []).map((item) => {
      const thumbs = item.snippet?.thumbnails ?? {};
      const stats: Record<string, number> = {};
      for (const [key, raw] of Object.entries(item.statistics ?? {})) {
        const n = Number(raw);
        if (Number.isFinite(n)) stats[key] = n;
      }
      return {
        platform: "youtube" as const,
        externalId: item.id,
        url: `https://www.youtube.com/shorts/${item.id}`,
        title: item.snippet?.title ?? "(untitled)",
        creatorId: item.snippet?.channelId ?? "",
        creatorName: item.snippet?.channelTitle ?? "",
        thumbnailUrl: thumbs.medium?.url ?? thumbs.default?.url ?? null,
        description: item.snippet?.description ? item.snippet.description.slice(0, 400) : null,
        stats: Object.keys(stats).length > 0 ? stats : null,
        durationSeconds: parseIsoDurationSeconds(item.contentDetails?.duration),
        publishedAt: item.snippet?.publishedAt ?? null,
      };
    });
  }

  /** channels.list, 1 unit: resolves a channel id or @handle to its uploads playlist. */
  async uploadsPlaylist(channel: string): Promise<{ channelId: string; playlistId: string } | null> {
    const params: Record<string, string> = { part: "contentDetails" };
    if (channel.startsWith("@")) params.forHandle = channel;
    else params.id = channel;
    const json = await this.get<{ items?: Array<{ id: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(
      "channels",
      params,
      "channels.list",
      YOUTUBE_UNIT_COSTS.channelsList,
    );
    const item = json.items?.[0];
    const playlistId = item?.contentDetails?.relatedPlaylists?.uploads;
    return item && playlistId ? { channelId: item.id, playlistId } : null;
  }

  /** playlistItems.list, 1 unit: the newest video ids of a playlist. */
  async playlistVideoIds(playlistId: string, maxResults = 5): Promise<string[]> {
    const json = await this.get<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>(
      "playlistItems",
      { part: "contentDetails", playlistId, maxResults: String(maxResults) },
      "playlistItems.list",
      YOUTUBE_UNIT_COSTS.playlistItemsList,
    );
    return (json.items ?? []).map((i) => i.contentDetails?.videoId).filter((id): id is string => Boolean(id));
  }

  /** search.list, 100 units: recent short videos for a query. Use sparingly. */
  async searchRecentShorts(query: string, publishedAfterIso: string, maxResults = 10): Promise<string[]> {
    const json = await this.get<{ items?: Array<{ id?: { videoId?: string } }> }>(
      "search",
      { part: "snippet", type: "video", videoDuration: "short", order: "date", q: query, publishedAfter: publishedAfterIso, maxResults: String(maxResults) },
      "search.list",
      YOUTUBE_UNIT_COSTS.searchList,
    );
    return (json.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => Boolean(id));
  }

  /** commentThreads.list, 1 unit: top comments as plain text snippets. Comments disabled returns an empty list. */
  async topComments(videoId: string, maxResults = 5): Promise<string[]> {
    await this.spendUnits("commentThreads.list", YOUTUBE_UNIT_COSTS.commentThreadsList);
    const url = `${API_BASE}/commentThreads?${new URLSearchParams({ part: "snippet", videoId, order: "relevance", textFormat: "plainText", maxResults: String(maxResults) }).toString()}`;
    const res = await this.fetchImpl(url, { headers: { "x-goog-api-key": this.apiKey, Accept: "application/json" } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 403 && body.includes("commentsDisabled")) return [];
      throw new YoutubeDataError(`YouTube commentThreads.list failed: HTTP ${res.status} -- ${body}`);
    }
    const json = (await res.json()) as { items?: Array<{ snippet?: { topLevelComment?: { snippet?: { textDisplay?: string } } } }> };
    return (json.items ?? [])
      .map((i) => i.snippet?.topLevelComment?.snippet?.textDisplay?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "")
      .filter((t) => t.length > 0);
  }
}
