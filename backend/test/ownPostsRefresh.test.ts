import { describe, it, expect, vi } from "vitest";
import { OWN_POSTS_MAX_READ, OWN_POSTS_MIN_INTERVAL_MS, OWN_POSTS_MIN_READ, planOwnPostsRead, runOwnPostsStep } from "../src/posting/ownPostsRefresh";
import type { XOwnTweet } from "../src/signals/adapters/xAdapter";

const now = new Date("2026-10-14T20:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 3600 * 1000;

describe("planOwnPostsRead", () => {
  it("reads when nothing was ever synced", () => {
    expect(planOwnPostsRead({ lastSyncedAt: null, recentCount: 0 }, now)).toEqual({ skip: false, maxResults: OWN_POSTS_MIN_READ });
  });
  it("skips the later slots of the same day", () => {
    const plan = planOwnPostsRead({ lastSyncedAt: ago(5 * HOUR), recentCount: 30 }, now);
    expect(plan.skip).toBe(true);
  });
  it("runs again once the interval has passed, even a little early in the day", () => {
    expect(planOwnPostsRead({ lastSyncedAt: ago(OWN_POSTS_MIN_INTERVAL_MS + 1), recentCount: 10 }, now).skip).toBe(false);
    expect(planOwnPostsRead({ lastSyncedAt: ago(19 * HOUR), recentCount: 10 }, now).skip).toBe(true);
  });
  it("force overrides the cadence", () => {
    expect(planOwnPostsRead({ lastSyncedAt: ago(HOUR), recentCount: 10 }, now, true).skip).toBe(false);
  });
  it("sizes the read to recent tweets plus a margin, clamped to 20..60", () => {
    expect(planOwnPostsRead({ lastSyncedAt: null, recentCount: 25 }, now)).toEqual({ skip: false, maxResults: 45 });
    expect(planOwnPostsRead({ lastSyncedAt: null, recentCount: 500 }, now)).toEqual({ skip: false, maxResults: OWN_POSTS_MAX_READ });
  });
});

describe("runOwnPostsStep", () => {
  const tweet = (id: string): XOwnTweet => ({ id, text: "t", createdAt: now, inReplyToTweetId: null, impressions: 5, likes: 0, replies: 0, reposts: 0 });

  it("makes no read, cost row or write when skipped, and says so in the summary", async () => {
    const fetchOwnTweets = vi.fn();
    const recordCost = vi.fn();
    const save = vi.fn();
    const out = await runOwnPostsStep({ state: { lastSyncedAt: ago(HOUR), recentCount: 5 }, now, fetchOwnTweets, recordCost, save });
    expect(fetchOwnTweets).not.toHaveBeenCalled();
    expect(recordCost).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(out).toContain("X reads: 0 tweets $0.000");
  });

  it("asks for the planned count and reports reads, cost and LLM line", async () => {
    const fetchOwnTweets = vi.fn(async () => [tweet("1"), tweet("2")]);
    const out = await runOwnPostsStep({
      state: { lastSyncedAt: null, recentCount: 10 },
      now,
      fetchOwnTweets,
      recordCost: async (n) => n * 0.001,
      save: async (t) => ({ saved: t.length, replies: 1, matched: 0 }),
    });
    expect(fetchOwnTweets).toHaveBeenCalledWith(30);
    expect(out).toContain("X reads: 2 tweets $0.002");
    expect(out).toContain("LLM: 0 calls $0.0000");
  });
});
