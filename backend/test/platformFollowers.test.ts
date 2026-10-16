import { describe, it, expect, vi } from "vitest";
import {
  FollowerInputError,
  fetchYoutubeSubscribers,
  isFollowerPlatform,
  isMissingPlatformFollowerTable,
  parseFollowerCount,
  recordPlatformFollowers,
  runYoutubeFollowerStep,
} from "../src/posting/platformFollowers";

const NOW = new Date("2026-10-16T14:00:00Z"); // Arizona day 2026-10-16

function fakeClient(opts: { history?: Array<{ day: string; followers: number }>; readError?: { message: string; code?: string }; onUpsert?: (row: any, conf: any) => void }) {
  return {
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        order: () => Promise.resolve({ data: opts.history ?? [], error: opts.readError ?? null }),
        upsert: (row: any, conf: any) => {
          opts.onUpsert?.(row, conf);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  } as any;
}

const okFetch = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as typeof fetch;

describe("parseFollowerCount", () => {
  it("accepts whole numbers, numeric strings and thousands separators", () => {
    expect(parseFollowerCount(67)).toBe(67);
    expect(parseFollowerCount("1,204")).toBe(1204);
    expect(parseFollowerCount(0)).toBe(0);
  });
  it("refuses negatives, fractions, blanks and junk instead of rounding", () => {
    for (const bad of [-1, 3.5, "", "abc", null, undefined, NaN, 2e9]) {
      expect(() => parseFollowerCount(bad)).toThrow(FollowerInputError);
    }
  });
});

describe("platform guard", () => {
  it("knows the three platforms only", () => {
    expect(isFollowerPlatform("tiktok")).toBe(true);
    expect(isFollowerPlatform("x")).toBe(false);
  });
  it("recognises a missing table error", () => {
    expect(isMissingPlatformFollowerTable('relation "platform_follower_snapshots" does not exist')).toBe(true);
    expect(isMissingPlatformFollowerTable("something else")).toBe(false);
  });
});

describe("recordPlatformFollowers", () => {
  it("upserts one row per platform per day and reports the change", async () => {
    const onUpsert = vi.fn();
    const line = await recordPlatformFollowers(fakeClient({ history: [{ day: "2026-10-15", followers: 60 }], onUpsert }), "tiktok", 67, NOW, "manual");
    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "tiktok", day: "2026-10-16", followers: 67, source: "manual" }),
      { onConflict: "platform,day" },
    );
    expect(line).toBe("67 followers (+7 vs yesterday)");
  });

  it("says so, and writes nothing, when migration 0054 is not applied", async () => {
    const onUpsert = vi.fn();
    const client = fakeClient({ readError: { message: 'relation "platform_follower_snapshots" does not exist' }, onUpsert });
    expect(await recordPlatformFollowers(client, "tiktok", 5, NOW, "manual")).toMatch(/migration 0054/);
    expect(onUpsert).not.toHaveBeenCalled();
  });
});

describe("fetchYoutubeSubscribers", () => {
  it("reads statistics by handle with the key in a header, never the URL", async () => {
    const f = okFetch({ items: [{ statistics: { subscriberCount: "12" } }] });
    expect(await fetchYoutubeSubscribers("@FillbookHQ", "SECRET", f)).toBe(12);
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toContain("forHandle=%40FillbookHQ");
    expect(url).not.toContain("SECRET");
    expect(init.headers["x-goog-api-key"]).toBe("SECRET");
  });
  it("uses id= for a channel id and returns null for a hidden count or no channel", async () => {
    const f = okFetch({ items: [{ statistics: { hiddenSubscriberCount: true } }] });
    expect(await fetchYoutubeSubscribers("UC123", "k", f)).toBeNull();
    expect((f as any).mock.calls[0][0]).toContain("id=UC123");
    expect(await fetchYoutubeSubscribers("@x", "k", okFetch({}))).toBeNull();
  });
  it("throws on an HTTP error without echoing the key", async () => {
    await expect(fetchYoutubeSubscribers("@x", "SECRET", okFetch({ error: "quota" }, 403))).rejects.toThrow(/HTTP 403/);
  });
});

describe("runYoutubeFollowerStep", () => {
  it("skips quietly without an API key", async () => {
    expect(await runYoutubeFollowerStep({ client: fakeClient({}), now: NOW, env: {} })).toMatch(/YOUTUBE_API_KEY/);
  });

  it("makes no call when today is already recorded", async () => {
    const f = okFetch({});
    const out = await runYoutubeFollowerStep({ client: fakeClient({ history: [{ day: "2026-10-16", followers: 9 }] }), now: NOW, env: { YOUTUBE_API_KEY: "k" }, fetchImpl: f });
    expect(out).toBe("already recorded today: 9 subscribers (first reading, nothing to compare yet)");
    expect(f).not.toHaveBeenCalled();
  });

  it("reads, records and reports subscribers, honouring YOUTUBE_CHANNEL", async () => {
    const onUpsert = vi.fn();
    const f = okFetch({ items: [{ statistics: { subscriberCount: "11" } }] });
    const out = await runYoutubeFollowerStep({
      client: fakeClient({ history: [{ day: "2026-10-15", followers: 10 }], onUpsert }),
      now: NOW,
      env: { YOUTUBE_API_KEY: "k", YOUTUBE_CHANNEL: "UCabc" },
      fetchImpl: f,
    });
    expect(out).toBe("11 subscribers (+1 vs yesterday)");
    expect((f as any).mock.calls[0][0]).toContain("id=UCabc");
    expect(onUpsert).toHaveBeenCalledWith(expect.objectContaining({ platform: "youtube", followers: 11, source: "api" }), expect.anything());
  });

  it("reports an unfindable channel rather than failing the pipeline", async () => {
    const out = await runYoutubeFollowerStep({ client: fakeClient({}), now: NOW, env: { YOUTUBE_API_KEY: "k" }, fetchImpl: okFetch({ items: [] }) });
    expect(out).toMatch(/not found or its subscriber count is hidden/);
  });
});
