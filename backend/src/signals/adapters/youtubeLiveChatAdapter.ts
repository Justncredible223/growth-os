import { YoutubeApiError } from "./youtubeAdapter.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * liveChatMessages.list costs 5 quota units and the project default is 10,000 units a day, so the poll interval
 * decides how long a stream can run: at 10 seconds that is 1,800 units an hour, about five and a half hours of
 * chat reading a day. YouTube's own pollingIntervalMillis is honoured when it asks for longer.
 */
export const MIN_LIVE_CHAT_POLL_MS = 10_000;
const MAX_RESULTS = 200;

export interface YoutubeLiveChatMessage {
  id: string;
  authorDisplayName: string;
  text: string;
  publishedAt: string | null;
}

export interface YoutubeLiveChatPage {
  messages: YoutubeLiveChatMessage[];
  nextPageToken: string | null;
  /** How long to wait before the next poll, never less than MIN_LIVE_CHAT_POLL_MS. */
  pollAfterMs: number;
}

/**
 * Reads the public chat of one of the owner's own YouTube live streams through the official Data API v3, with
 * the same API key the comment adapter uses. Read-only by construction: nothing here can post a chat message,
 * and posting one would be youtube.post_comment, an EXTERNAL_WRITE (docs/EXTERNAL_WRITE_FIREWALL.md). The Live
 * Host answers out loud on the stream, never in chat.
 */
export class YoutubeLiveChatAdapter {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** The active chat id for a live video, or null when the video is not live (not started, ended, or chat off). */
  async resolveLiveChatId(videoId: string): Promise<string | null> {
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set("part", "liveStreamingDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", this.apiKey);
    const res = await this.fetchImpl(url.toString());
    if (!res.ok) throw new YoutubeApiError(`YouTube videos.list failed for video ${videoId}: HTTP ${res.status} -- ${await res.text()}`);
    const json = (await res.json()) as { items?: Array<{ liveStreamingDetails?: { activeLiveChatId?: string } }> };
    return json.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
  }

  /** One page of chat. Pass the previous page's token to get only what is new; without one YouTube returns recent history. */
  async fetchMessages(liveChatId: string, pageToken: string | null): Promise<YoutubeLiveChatPage> {
    const url = new URL(`${API_BASE}/liveChat/messages`);
    url.searchParams.set("part", "snippet,authorDetails");
    url.searchParams.set("liveChatId", liveChatId);
    url.searchParams.set("maxResults", String(MAX_RESULTS));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("key", this.apiKey);
    const res = await this.fetchImpl(url.toString());
    if (!res.ok) throw new YoutubeApiError(`YouTube liveChatMessages.list failed: HTTP ${res.status} -- ${await res.text()}`);

    const json = (await res.json()) as {
      nextPageToken?: string;
      pollingIntervalMillis?: number;
      items?: Array<{
        id: string;
        snippet?: { type?: string; displayMessage?: string; publishedAt?: string; textMessageDetails?: { messageText?: string } };
        authorDetails?: { displayName?: string };
      }>;
    };

    const messages = (json.items ?? [])
      // Only what a viewer typed. Memberships, Super Chats, deletions and other events are not questions for the host.
      .filter((item) => item.snippet?.type === "textMessageEvent")
      .map((item) => ({
        id: item.id,
        authorDisplayName: item.authorDetails?.displayName ?? "",
        text: item.snippet?.textMessageDetails?.messageText ?? item.snippet?.displayMessage ?? "",
        publishedAt: item.snippet?.publishedAt ?? null,
      }));

    return {
      messages,
      nextPageToken: json.nextPageToken ?? null,
      pollAfterMs: Math.max(MIN_LIVE_CHAT_POLL_MS, Number(json.pollingIntervalMillis) || 0),
    };
  }
}

/** Null when YOUTUBE_API_KEY is not configured: the Live Host then simply has no YouTube chat. */
export function createYoutubeLiveChatAdapter(env: NodeJS.ProcessEnv = process.env): YoutubeLiveChatAdapter | null {
  return env.YOUTUBE_API_KEY ? new YoutubeLiveChatAdapter(env.YOUTUBE_API_KEY) : null;
}
