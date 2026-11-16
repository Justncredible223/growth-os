import { describe, it, expect, vi } from "vitest";
import { YoutubeCommentAdapter, YoutubeApiError, createYoutubeCommentAdapter } from "../src/signals/adapters/youtubeAdapter";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function commentThreadItem(overrides: Partial<{ id: string; textDisplay: string; authorDisplayName: string; authorChannelId: string; publishedAt: string }> = {}) {
  return {
    id: overrides.id ?? "thread-1",
    snippet: {
      topLevelComment: {
        snippet: {
          textDisplay: overrides.textDisplay ?? "Great video!",
          authorDisplayName: overrides.authorDisplayName ?? "Some Trader",
          authorChannelId: { value: overrides.authorChannelId ?? "channel-1" },
          publishedAt: overrides.publishedAt ?? "2026-09-01T12:00:00Z",
        },
      },
    },
  };
}

describe("YoutubeCommentAdapter.fetchTopLevelComments", () => {
  it("maps a real commentThreads.list response into YoutubeComment[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [commentThreadItem()] }));
    const adapter = new YoutubeCommentAdapter("test-key", fetchMock);

    const comments = await adapter.fetchTopLevelComments("video-1");

    expect(comments).toEqual([
      {
        id: "thread-1",
        text: "Great video!",
        authorDisplayName: "Some Trader",
        authorChannelId: "channel-1",
        publishedAt: new Date("2026-09-01T12:00:00Z"),
      },
    ]);
  });

  it("requests order=time and the given videoId, with the API key as a query param (no OAuth)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    const adapter = new YoutubeCommentAdapter("test-key", fetchMock);

    await adapter.fetchTopLevelComments("video-123");

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("videoId")).toBe("video-123");
    expect(url.searchParams.get("order")).toBe("time");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(fetchMock.mock.calls[0]![1]).toBeUndefined(); // no Authorization header/init object at all
  });

  it("returns an empty array (not an error) when comments are disabled on the video", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { errors: [{ reason: "commentsDisabled" }] } }, false, 403),
    );
    const adapter = new YoutubeCommentAdapter("test-key", fetchMock);

    const comments = await adapter.fetchTopLevelComments("video-1");

    expect(comments).toEqual([]);
  });

  it("returns an empty array when the video was deleted or made private (404 videoNotFound)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { errors: [{ reason: "videoNotFound" }] } }, false, 404));
    const adapter = new YoutubeCommentAdapter("test-key", fetchMock);

    expect(await adapter.fetchTopLevelComments("video-gone")).toEqual([]);
  });

  it("throws YoutubeApiError for any other failure (bad key, quota exceeded)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "quota exceeded" } }, false, 403));
    const adapter = new YoutubeCommentAdapter("test-key", fetchMock);

    await expect(adapter.fetchTopLevelComments("video-1")).rejects.toThrow(YoutubeApiError);
  });

  it("tolerates a missing snippet/author gracefully rather than throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [{ id: "thread-2", snippet: {} }] }));
    const adapter = new YoutubeCommentAdapter("test-key", fetchMock);

    const comments = await adapter.fetchTopLevelComments("video-1");

    expect(comments).toEqual([{ id: "thread-2", text: "", authorDisplayName: null, authorChannelId: null, publishedAt: null }]);
  });
});

describe("createYoutubeCommentAdapter", () => {
  it("throws a clear error when YOUTUBE_API_KEY is missing", () => {
    expect(() => createYoutubeCommentAdapter({})).toThrow(/YOUTUBE_API_KEY is not set/);
  });

  it("builds a real adapter when the env var is present", () => {
    expect(() => createYoutubeCommentAdapter({ YOUTUBE_API_KEY: "real-key" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
