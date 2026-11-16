export class YoutubeApiError extends Error {}

/** One top-level comment on one of the owner's own YouTube videos (replies-to-comments are not fetched in this first version -- see ingestInboundYoutubeComments's own doc comment). */
export interface YoutubeComment {
  /** The top-level comment THREAD id (YouTube's commentThreads.list returns threads, not bare comments) -- stable, used as both the inbound row's externalId and the ingestion cursor. */
  id: string;
  text: string;
  authorDisplayName: string | null;
  /** YouTube's channel id for the commenter -- the closest equivalent to X's numeric author id; used for countPriorFromAuthor and future "who is this" lookups. Never a real @handle -- YouTube comments don't have one. */
  authorChannelId: string | null;
  publishedAt: Date | null;
}

const API_BASE = "https://www.googleapis.com/youtube/v3";
/** Comments per page. Ingestion follows the pages until it reaches the stored cursor, up to YOUTUBE_MAX_PAGES (inboundYoutubeIngestion.ts), and warns when it stops at that cap. */
const MAX_RESULTS = 50;

/**
 * Reads public comment threads on a specific YouTube video via the
 * standard YouTube Data API v3 (commentThreads.list). Deliberately an API
 * key, not OAuth -- reading a public video's public comments needs no
 * user authorization, unlike X's mentions endpoint (which reads
 * @FillbookHQ's own protected timeline). Read-only by construction: no
 * method here can post, reply to, or moderate a comment -- see
 * docs/EXTERNAL_WRITE_FIREWALL.md.
 */
export class YoutubeCommentAdapter {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Newest-first (order=time, YouTube's own default for this order value)
   * top-level comments on `videoId`. Callers stop consuming the returned
   * list once they reach an already-seen id (see
   * ingestInboundYoutubeComments) rather than this method taking a
   * since-cursor itself -- commentThreads.list has no since-id filter,
   * only opaque page tokens, so "what's new" is a client-side stop
   * condition, not a request parameter.
   */
  async fetchTopLevelComments(videoId: string): Promise<YoutubeComment[]> {
    return (await this.fetchTopLevelCommentsPage(videoId)).comments;
  }

  /** One page of comment threads, newest first, with the token for the next (older) page if there is one. */
  async fetchTopLevelCommentsPage(videoId: string, pageToken?: string): Promise<{ comments: YoutubeComment[]; nextPageToken?: string }> {
    const url = new URL(`${API_BASE}/commentThreads`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("videoId", videoId);
    url.searchParams.set("order", "time");
    url.searchParams.set("maxResults", String(MAX_RESULTS));
    url.searchParams.set("textFormat", "plainText");
    url.searchParams.set("key", this.apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await this.fetchImpl(url.toString());
    if (!res.ok) {
      const body = await res.text();
      // commentsDisabled is a real, non-exceptional case (the owner or
      // YouTube itself can turn comments off on a video) -- surfaced as a
      // typed result via the empty-array return, not an error, so a
      // caller polling several videos doesn't have one comments-disabled
      // video fail the whole run. Every other failure (bad key, quota
      // exceeded) is a real error.
      if (res.status === 403 && body.includes("commentsDisabled")) return { comments: [] };
      // A video that was deleted or made private no longer has readable comments: skip it so one gone video cannot fail the whole sync (Nov 16 2026: the System screen showed YouTube comments DOWN for this).
      if (res.status === 404 && body.includes("videoNotFound")) return { comments: [] };
      throw new YoutubeApiError(`YouTube commentThreads.list failed for video ${videoId}: HTTP ${res.status} -- ${body}`);
    }

    const json = (await res.json()) as {
      nextPageToken?: string;
      items?: Array<{
        id: string;
        snippet?: {
          topLevelComment?: {
            snippet?: {
              textDisplay?: string;
              authorDisplayName?: string;
              authorChannelId?: { value?: string };
              publishedAt?: string;
            };
          };
        };
      }>;
    };

    const comments = (json.items ?? []).map((item) => {
      const snippet = item.snippet?.topLevelComment?.snippet;
      return {
        id: item.id,
        text: snippet?.textDisplay ?? "",
        authorDisplayName: snippet?.authorDisplayName ?? null,
        authorChannelId: snippet?.authorChannelId?.value ?? null,
        publishedAt: snippet?.publishedAt ? new Date(snippet.publishedAt) : null,
      };
    });
    return { comments, nextPageToken: json.nextPageToken };
  }
}

/** Wires a real adapter from the environment. Throws early and clearly if YOUTUBE_API_KEY is missing, rather than failing confusingly on the first API call. */
export function createYoutubeCommentAdapter(env: NodeJS.ProcessEnv = process.env): YoutubeCommentAdapter {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new YoutubeApiError(
      "YOUTUBE_API_KEY is not set in the environment. Create one in Google Cloud Console (APIs & Services > " +
        "Credentials > Create API Key) with the YouTube Data API v3 enabled, then set it as an env var.",
    );
  }
  return new YoutubeCommentAdapter(apiKey);
}
