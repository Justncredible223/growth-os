import { describe, it, expect } from "vitest";
import { DAILY_SET_MAX, MIN_DAILY_SET_SCORE, selectDailyWorkingSet } from "../src/prospecting/prospectingDailySelection";
import type { ProspectingCandidate } from "../src/prospecting/types";

function candidate(overrides: Partial<ProspectingCandidate> & Pick<ProspectingCandidate, "id" | "opportunityScore">): ProspectingCandidate {
  return {
    platform: "x",
    externalId: overrides.id,
    discoveryQuery: "drawdown",
    authorHandle: `handle-${overrides.id}`,
    authorExternalId: `author-${overrides.id}`,
    authorName: null,
    authorFollowerCount: null,
    authorVerified: null,
    postText: "some post",
    postUrl: "https://x.com/i/web/status/1",
    postCreatedAt: null,
    publicMetrics: {},
    scoreBreakdown: {},
    creatorCandidate: false,
    status: "new",
    shownAt: null,
    openedAt: null,
    draftReply: null,
    finalReply: null,
    replyMentionsFillbook: null,
    replyUsedLink: null,
    repliedAt: null,
    skipReason: null,
    discoveredAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("selectDailyWorkingSet", () => {
  it("never fills the set with candidates below MIN_DAILY_SET_SCORE, even if that means fewer than DAILY_SET_MIN", () => {
    const pool = [candidate({ id: "1", opportunityScore: 30 }), candidate({ id: "2", opportunityScore: 25 })];
    const result = selectDailyWorkingSet(pool);
    expect(result.selected).toHaveLength(0);
    expect(result.belowQualityBar).toHaveLength(2);
  });

  it("selects at most DAILY_SET_MAX, deferring the rest as real backlog (not discarded)", () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: `${i}`, opportunityScore: MIN_DAILY_SET_SCORE + 10, authorExternalId: `author-${i}` }),
    );
    const result = selectDailyWorkingSet(pool);
    expect(result.selected).toHaveLength(DAILY_SET_MAX);
    expect(result.deferred).toHaveLength(20 - DAILY_SET_MAX);
  });

  it("shows fewer than DAILY_SET_MAX when fewer genuinely qualify -- never force-fills with weak posts", () => {
    const pool = [
      candidate({ id: "1", opportunityScore: 60 }),
      candidate({ id: "2", opportunityScore: 55 }),
      candidate({ id: "3", opportunityScore: 20 }), // below bar
    ];
    const result = selectDailyWorkingSet(pool);
    expect(result.selected).toHaveLength(2);
  });

  it("picks at most one candidate per author per day, keeping that author's highest-scored post", () => {
    const pool = [
      candidate({ id: "1", opportunityScore: 60, authorExternalId: "same-author" }),
      candidate({ id: "2", opportunityScore: 65, authorExternalId: "same-author" }),
      candidate({ id: "3", opportunityScore: 50, authorExternalId: "other-author" }),
    ];
    const result = selectDailyWorkingSet(pool);
    const sameAuthorPicks = result.selected.filter((c) => c.authorExternalId === "same-author");
    expect(sameAuthorPicks).toHaveLength(1);
    expect(sameAuthorPicks[0]!.id).toBe("2"); // the higher-scored of the two
    expect(result.deferred.map((c) => c.id)).toContain("1");
  });

  it("falls back to authorHandle, then id, when authorExternalId is null -- never treats two different unknown authors as the same person", () => {
    const pool = [
      candidate({ id: "1", opportunityScore: 60, authorExternalId: null, authorHandle: null }),
      candidate({ id: "2", opportunityScore: 55, authorExternalId: null, authorHandle: null }),
    ];
    const result = selectDailyWorkingSet(pool);
    expect(result.selected).toHaveLength(2);
  });

  it("breaks score ties by more recent discovery first", () => {
    const pool = [
      candidate({ id: "old", opportunityScore: 50, discoveredAt: "2026-09-01T00:00:00Z", authorExternalId: "a" }),
      candidate({ id: "new", opportunityScore: 50, discoveredAt: "2026-09-02T00:00:00Z", authorExternalId: "b" }),
    ];
    const result = selectDailyWorkingSet(pool);
    expect(result.selected[0]!.id).toBe("new");
  });

  it("returns an empty selection for an empty pool without erroring", () => {
    const result = selectDailyWorkingSet([]);
    expect(result).toEqual({ selected: [], deferred: [], belowQualityBar: [], tooOldForToday: [] });
  });
});

/**
 * Regression coverage for the 2026-09-07 freshness/audience-quality
 * review: opportunity_score used to be the ONLY thing ranking ever looked
 * at, frozen at discovery time -- a candidate could sit in backlog for
 * days re-winning a slot on how fresh it WAS, not how fresh it IS, which is
 * why candidates commonly surfaced to the owner 2-4 days old. These tests
 * exercise selectDailyWorkingSet's `now` parameter directly (not just the
 * pure prospectingFreshness.ts functions in isolation) to prove the actual
 * selection behavior changed, not just its building blocks.
 */
describe("selectDailyWorkingSet -- freshness-adjusted ranking", () => {
  const NOW = new Date("2026-09-07T12:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

  it("excludes a post older than 12h from today's set entirely, regardless of how high its stored score is -- it's set aside as tooOldForToday, not scored or deferred", () => {
    const pool = [candidate({ id: "ancient", opportunityScore: 95, postCreatedAt: hoursAgo(24 * 10), authorExternalId: "a" })];
    const result = selectDailyWorkingSet(pool, NOW);
    expect(result.selected).toHaveLength(0);
    expect(result.belowQualityBar).toHaveLength(0);
    expect(result.tooOldForToday.map((c) => c.id)).toEqual(["ancient"]);
  });

  it("still selects a post at exactly the 12h boundary -- 'older than 12 hours' is strictly greater, not equal", () => {
    const pool = [candidate({ id: "boundary", opportunityScore: 90, postCreatedAt: hoursAgo(12), authorExternalId: "a" })];
    const result = selectDailyWorkingSet(pool, NOW);
    // Not hard-cut as too old. (Since 2026-10-15 the quality bar is 45, so a post this old only makes the set if its
    // frozen score is near the maximum; either way it is judged on score, not discarded by age.)
    expect(result.tooOldForToday).toHaveLength(0);
    expect([...result.selected, ...result.belowQualityBar].map((c) => c.id)).toEqual(["boundary"]);
  });

  it("a fresh, relevant candidate outranks an older candidate that has a higher FROZEN score -- proves ranking now uses today's effective score, not the stored one", () => {
    const pool = [
      // Frozen at 68 when it was fresh; now 11.7h old (near the 12h cutoff, still technically eligible)
      // -- heavily decayed today, and should no longer beat a fresh candidate scored much lower at discovery.
      candidate({ id: "old-but-was-high-scoring", opportunityScore: 68, postCreatedAt: hoursAgo(11.7), authorExternalId: "a" }),
      // Discovered just now, frozen score lower, but nothing to decay -- keeps its full value.
      candidate({ id: "fresh", opportunityScore: 55, postCreatedAt: hoursAgo(1), authorExternalId: "b" }),
    ];
    const result = selectDailyWorkingSet(pool, NOW);
    expect(result.selected.map((c) => c.id)).toEqual(["fresh"]);
    expect(result.belowQualityBar.map((c) => c.id)).toContain("old-but-was-high-scoring");
  });

  it("a candidate with no known post time is never decayed or excluded by age -- existing behavior for postCreatedAt: null is fully preserved", () => {
    const pool = [candidate({ id: "unknown-age", opportunityScore: 60, postCreatedAt: null, authorExternalId: "a" })];
    const result = selectDailyWorkingSet(pool, NOW);
    expect(result.tooOldForToday).toHaveLength(0);
    expect(result.selected.map((c) => c.id)).toEqual(["unknown-age"]);
  });

  it("defaults `now` to the real current time when omitted -- existing callers that never passed it keep working", () => {
    const pool = [candidate({ id: "1", opportunityScore: 60, postCreatedAt: null, authorExternalId: "a" })];
    const result = selectDailyWorkingSet(pool);
    expect(result.selected.map((c) => c.id)).toEqual(["1"]);
  });
});
