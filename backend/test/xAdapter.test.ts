import { describe, it, expect, vi } from "vitest";
import { XSignalAdapter, XApiError } from "../src/signals/adapters/xAdapter";
import { InMemoryXTokenStore } from "../src/signals/adapters/xTokenStore";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("XSignalAdapter", () => {
  const now = new Date("2026-09-01T12:00:00Z");

  it("uses the stored access token when it isn't near expiry", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [] }),
    );
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    await adapter.fetchOwnMentions("123", undefined, now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0]!;
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer valid-token");
  });

  it("refreshes the access token when it's near expiry and persists the new pair", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "stale-token",
      refreshToken: "old-refresh",
      expiresAt: new Date(now.getTime() + 1000),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 7200 }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    await adapter.fetchOwnMentions("123", undefined, now);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const refreshCall = fetchMock.mock.calls[0]!;
    expect(refreshCall[0]).toBe("https://api.x.com/2/oauth2/token");
    const mentionsCall = fetchMock.mock.calls[1]!;
    expect((mentionsCall[1].headers as Record<string, string>).Authorization).toBe("Bearer new-token");

    const saved = await store.load();
    expect(saved?.accessToken).toBe("new-token");
    expect(saved?.refreshToken).toBe("new-refresh");
  });

  it("falls back to the existing refresh token if the refresh response doesn't rotate it", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "stale-token",
      refreshToken: "stable-refresh",
      expiresAt: new Date(now.getTime() + 1000),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-token", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    await adapter.fetchOwnMentions("123", undefined, now);

    const saved = await store.load();
    expect(saved?.refreshToken).toBe("stable-refresh");
  });

  it("throws XApiError with actionable guidance when no tokens are stored", async () => {
    const store = new InMemoryXTokenStore(null);
    const adapter = new XSignalAdapter("client-id", "client-secret", store, vi.fn());

    await expect(adapter.fetchOwnMentions("123", undefined, now)).rejects.toThrow(XApiError);
    await expect(adapter.fetchOwnMentions("123", undefined, now)).rejects.toThrow(/Generate a user Access Token/);
  });

  it("throws XApiError with the response body on a failed API call", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ errors: [{ detail: "Not authorized" }] }, false, 403),
    );
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    await expect(adapter.fetchOwnMentions("123", undefined, now)).rejects.toThrow(/HTTP 403/);
  });

  it("maps mention fields correctly, including missing optional fields", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "1",
            text: "hello @FillbookHQ",
            author_id: "42",
            created_at: "2026-09-01T10:00:00Z",
            public_metrics: { like_count: 3 },
            conversation_id: "conv-1",
            in_reply_to_user_id: "999",
            referenced_tweets: [{ type: "replied_to", id: "parent-1" }],
          },
          { id: "2", text: "no extra fields" },
        ],
        includes: { users: [{ id: "42", username: "someTrader" }] },
      }),
    );
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    const mentions = await adapter.fetchOwnMentions("123", undefined, now);

    expect(mentions).toEqual([
      {
        id: "1",
        text: "hello @FillbookHQ",
        authorId: "42",
        authorHandle: "someTrader",
        createdAt: new Date("2026-09-01T10:00:00Z"),
        publicMetrics: { like_count: 3 },
        inReplyToUserId: "999",
        conversationId: "conv-1",
        referencedTweets: [{ type: "replied_to", id: "parent-1" }],
      },
      {
        id: "2",
        text: "no extra fields",
        authorId: null,
        authorHandle: null,
        createdAt: null,
        publicMetrics: null,
        inReplyToUserId: null,
        conversationId: null,
        referencedTweets: [],
      },
    ]);
  });

  it("requests the fields needed for reply-threading and real handles (not just text)", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    await adapter.fetchOwnMentions("123", undefined, now);

    const [url] = fetchMock.mock.calls[0]!;
    const requested = new URL(url as string);
    expect(requested.searchParams.get("tweet.fields")).toContain("conversation_id");
    expect(requested.searchParams.get("tweet.fields")).toContain("in_reply_to_user_id");
    expect(requested.searchParams.get("tweet.fields")).toContain("referenced_tweets");
    expect(requested.searchParams.get("expansions")).toBe("author_id");
    expect(requested.searchParams.get("user.fields")).toBe("username");
  });

  it("resolves the own user id from /users/me", async () => {
    const store = new InMemoryXTokenStore({
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: "999" } }));
    const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

    const id = await adapter.resolveOwnUserId(now);

    expect(id).toBe("999");
  });

  describe("searchRecentPosts", () => {
    it("maps search results including author metrics, and excludes retweets/replies from the query", async () => {
      const store = new InMemoryXTokenStore({
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: "1",
              text: "how do prop firm consistency rules even work",
              author_id: "42",
              created_at: "2026-09-01T10:00:00Z",
              public_metrics: { reply_count: 2, like_count: 5 },
              lang: "en",
            },
          ],
          includes: {
            users: [{ id: "42", username: "someTrader", name: "Some Trader", verified: false, public_metrics: { followers_count: 1200 } }],
          },
        }),
      );
      const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

      const results = await adapter.searchRecentPosts('"prop firm"', 15, now);

      expect(results).toEqual([
        {
          id: "1",
          text: "how do prop firm consistency rules even work",
          authorId: "42",
          authorHandle: "someTrader",
          authorName: "Some Trader",
          authorFollowerCount: 1200,
          authorVerified: false,
          createdAt: new Date("2026-09-01T10:00:00Z"),
          publicMetrics: { reply_count: 2, like_count: 5 },
          lang: "en",
        },
      ]);

      const [url] = fetchMock.mock.calls[0]!;
      const requested = new URL(url as string);
      expect(requested.pathname).toBe("/2/tweets/search/recent");
      expect(requested.searchParams.get("query")).toBe('"prop firm" -is:retweet -is:reply lang:en');
    });

    it("clamps max_results into X's accepted 10-100 range", async () => {
      const store = new InMemoryXTokenStore({
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

      await adapter.searchRecentPosts("drawdown", 2, now);
      let requested = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(requested.searchParams.get("max_results")).toBe("10");

      await adapter.searchRecentPosts("drawdown", 500, now);
      requested = new URL(fetchMock.mock.calls[1]![0] as string);
      expect(requested.searchParams.get("max_results")).toBe("100");
    });

    it("does not set start_time when maxAgeMs is omitted -- existing callers (Partnerships discovery) are unaffected", async () => {
      const store = new InMemoryXTokenStore({
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

      await adapter.searchRecentPosts("drawdown", 15, now);

      const requested = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(requested.searchParams.has("start_time")).toBe(false);
    });

    it("sets start_time to X's own supported recency filter when maxAgeMs is given -- real bounded discovery-time freshness (2026-09-07 review), not client-side-only filtering", async () => {
      const store = new InMemoryXTokenStore({
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
      const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);
      const seventyTwoHoursMs = 72 * 60 * 60 * 1000;

      await adapter.searchRecentPosts("drawdown", 15, now, seventyTwoHoursMs);

      const requested = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(requested.searchParams.get("start_time")).toBe(new Date(now.getTime() - seventyTwoHoursMs).toISOString());
    });

    it("does not fabricate author data when X returns no user expansion for a post", async () => {
      const store = new InMemoryXTokenStore({
        accessToken: "valid-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "1", text: "hi" }] }));
      const adapter = new XSignalAdapter("client-id", "client-secret", store, fetchMock);

      const results = await adapter.searchRecentPosts("drawdown", 15, now);

      expect(results[0]!.authorHandle).toBeNull();
      expect(results[0]!.authorFollowerCount).toBeNull();
      expect(results[0]!.authorVerified).toBeNull();
    });
  });
});

describe("P0 2026-11-15: mentions follow pagination after a since_id, and warn at the cap", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const store = () => new InMemoryXTokenStore({ accessToken: "t", refreshToken: "r", expiresAt: new Date(now.getTime() + 3600_000) });
  const page = (ids: string[], next?: string) => jsonResponse({ data: ids.map((id) => ({ id, text: "hi", author_id: "9" })), ...(next ? { meta: { next_token: next } } : {}) });

  it("reads every page until there is no next token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page(["5", "4"], "p2")).mockResolvedValueOnce(page(["3", "2"]));
    const adapter = new XSignalAdapter("c", "s", store(), fetchMock);
    const items = await adapter.fetchOwnMentions("123", "1", now);
    expect(items.map((m) => m.id)).toEqual(["5", "4", "3", "2"]);
    expect(adapter.mentionsTruncated()).toBe(false);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("pagination_token=p2");
  });

  it("stops at 5 pages and says so", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page(["9"], "more"));
    const adapter = new XSignalAdapter("c", "s", store(), fetchMock);
    await adapter.fetchOwnMentions("123", "1", now);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(adapter.mentionsTruncated()).toBe(true);
  });

  it("without a since_id it reads one page, as before", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page(["9"], "more"));
    const adapter = new XSignalAdapter("c", "s", store(), fetchMock);
    await adapter.fetchOwnMentions("123", undefined, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(adapter.mentionsTruncated()).toBe(false);
  });
});
