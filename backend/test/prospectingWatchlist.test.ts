import { describe, it, expect } from "vitest";
import {
  MAX_WATCHLIST_SIZE,
  MAX_WATCH_FOLLOWERS,
  MIN_WATCHLIST_SIZE,
  MIN_WATCH_FOLLOWERS,
  buildWatchlist,
  chunkWatchlist,
  isValidHandle,
  parseHandleList,
  watchlistQuery,
  type WatchlistRow,
} from "../src/prospecting/prospectingWatchlist";
import { scoreProspectingCandidate } from "../src/prospecting/prospectingScoring";
import { SupabaseProspectingRepository } from "../src/prospecting/supabaseProspectingRepository";
import type { ProspectingTopic } from "../src/prospecting/prospectingTopics";

const row = (over: Partial<WatchlistRow> = {}): WatchlistRow => ({ authorHandle: "creator1", authorFollowerCount: 5000, status: "new", opportunityScore: 70, ...over });

describe("parseHandleList", () => {
  it("trims, drops @, keeps only valid X handles and removes duplicates", () => {
    expect(parseHandleList(" @FuturesFox, ES_Ed ,bad!handle, waytoolonghandlename1, es_ed, ")).toEqual(["FuturesFox", "ES_Ed"]);
    expect(parseHandleList(undefined)).toEqual([]);
    expect(parseHandleList("")).toEqual([]);
  });
  it("validates handles", () => {
    expect(isValidHandle("abc_123")).toBe(true);
    expect(isValidHandle("has space")).toBe(false);
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("a".repeat(16))).toBe(false);
  });
});

describe("buildWatchlist", () => {
  it("adds an author who has at least one vetted, well-scored post in the follower range", () => {
    const list = buildWatchlist([row()]);
    expect(list).toEqual([{ handle: "creator1", followers: 5000, reason: "vetted" }]);
  });

  it("puts seeds first, then creators the owner replied to, then the most vetted", () => {
    const rows = [
      row({ authorHandle: "few", authorFollowerCount: 4000, opportunityScore: 60 }),
      row({ authorHandle: "many", authorFollowerCount: 4000, opportunityScore: 60 }),
      row({ authorHandle: "many", authorFollowerCount: 4000, opportunityScore: 62 }),
      row({ authorHandle: "friend", authorFollowerCount: 9000, status: "replied", opportunityScore: 40 }),
    ];
    expect(buildWatchlist(rows, ["@SeedOne"]).map((c) => [c.handle, c.reason])).toEqual([
      ["SeedOne", "seed"],
      ["friend", "replied"],
      ["many", "vetted"],
      ["few", "vetted"],
    ]);
  });

  it("leaves off authors outside the follower range, with weak posts, or mostly turned away", () => {
    const rows = [
      row({ authorHandle: "tiny", authorFollowerCount: MIN_WATCH_FOLLOWERS - 1 }),
      row({ authorHandle: "huge", authorFollowerCount: MAX_WATCH_FOLLOWERS + 1 }),
      row({ authorHandle: "weak", opportunityScore: 49 }),
      row({ authorHandle: "mixed", status: "not_relevant" }),
      row({ authorHandle: "mixed", status: "not_relevant" }),
      row({ authorHandle: "mixed", status: "new" }),
      row({ authorHandle: "nofollowers", authorFollowerCount: null }),
      row({ authorHandle: null }),
      row({ authorHandle: "bad handle!" }),
      row({ authorHandle: "ok" }),
    ];
    expect(buildWatchlist(rows).map((c) => c.handle)).toEqual(["ok"]);
  });

  it("a skipped post does not count as vetted", () => {
    expect(buildWatchlist([row({ status: "skipped" })])).toEqual([]);
  });

  it("is case-insensitive about handles and caps the list", () => {
    const rows = Array.from({ length: MAX_WATCHLIST_SIZE + 20 }, (_, i) => row({ authorHandle: `Creator${i}`, authorFollowerCount: 2000 + i }));
    rows.push(row({ authorHandle: "creator0", authorFollowerCount: 2000 }));
    const list = buildWatchlist(rows);
    expect(list).toHaveLength(MAX_WATCHLIST_SIZE);
    expect(new Set(list.map((c) => c.handle.toLowerCase())).size).toBe(MAX_WATCHLIST_SIZE);
  });

  it("needs at least MIN_WATCHLIST_SIZE creators before the search uses it (a constant callers compare against)", () => {
    expect(MIN_WATCHLIST_SIZE).toBeGreaterThanOrEqual(3);
  });
});

describe("watchlist queries", () => {
  it("builds a from: query that ORs the handles", () => {
    expect(watchlistQuery(["a", "b_c"])).toBe("(from:a OR from:b_c)");
  });

  it("splits a full list into groups that fit in one X request, never splitting a handle", () => {
    const handles = Array.from({ length: MAX_WATCHLIST_SIZE }, (_, i) => `futures_creator${i}`.slice(0, 15));
    const groups = chunkWatchlist(handles);
    expect(groups.flat()).toEqual(handles);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) expect(watchlistQuery(g).length + " -is:retweet -is:reply lang:en".length).toBeLessThanOrEqual(512);
    expect(chunkWatchlist([])).toEqual([]);
  });
});

describe("creator posts score a little higher", () => {
  const topic: ProspectingTopic = { key: "futures_trader", query: '"futures trader"', label: "Futures trader", replyClass: "C" };
  const base = { topic, postText: "How do you size up after two green days on a funded NQ futures account?", postCreatedAt: new Date("2026-10-25T17:00:00Z"), publicMetrics: {}, authorFollowerCount: 5000, authorVerified: false, previouslyEngaged: false, now: new Date("2026-10-25T18:00:00Z") };
  it("adds 6 points and says why, and never more", () => {
    const plain = scoreProspectingCandidate(base);
    const watched = scoreProspectingCandidate({ ...base, fromWatchlist: true });
    expect(watched.score - plain.score).toBeCloseTo(6, 1);
    expect(watched.breakdown.watchedCreator).toMatch(/already vetted/);
    expect(plain.breakdown.watchedCreator).toBeUndefined();
  });
});

describe("SupabaseProspectingRepository.listWatchlistRows", () => {
  it("reads the author and status columns of recent candidates and maps them", async () => {
    const calls: Array<[string, unknown?]> = [];
    const chain: any = {
      select: (cols: string) => (calls.push(["select", cols]), chain),
      gte: (c: string, v: unknown) => (calls.push([`gte ${c}`, v]), chain),
      not: (c: string) => (calls.push([`not ${c}`]), chain),
      order: () => chain,
      limit: async () => ({ data: [{ author_handle: "abc", author_follower_count: 4200, status: "ready", opportunity_score: "71.5" }], error: null }),
    };
    const repo = new SupabaseProspectingRepository({ from: () => chain } as any);
    const since = new Date("2026-09-25T00:00:00Z");
    expect(await repo.listWatchlistRows(since)).toEqual([{ authorHandle: "abc", authorFollowerCount: 4200, status: "ready", opportunityScore: 71.5 }]);
    expect(calls).toContainEqual(["gte discovered_at", since.toISOString()]);
    expect(calls).toContainEqual(["not author_handle"]);
  });
});
