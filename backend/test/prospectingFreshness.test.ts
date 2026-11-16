import { describe, it, expect } from "vitest";
import {
  currentPostAgeMs,
  effectiveScoreForSelection,
  isEligibleForDailySelection,
  recencyDecayMultiplier,
  MAX_AGE_FOR_DAILY_SELECTION_MS,
  RECENCY_DECAY_START_MS,
} from "../src/prospecting/prospectingFreshness";

const NOW = new Date("2026-09-07T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

describe("currentPostAgeMs", () => {
  it("returns null for a missing postCreatedAt -- no evidence to compute an age from", () => {
    expect(currentPostAgeMs(null, NOW)).toBeNull();
  });

  it("returns null for an unparseable postCreatedAt rather than NaN", () => {
    expect(currentPostAgeMs("not a real date", NOW)).toBeNull();
  });

  it("returns the real elapsed milliseconds for a valid timestamp", () => {
    expect(currentPostAgeMs(hoursAgo(5), NOW)).toBe(5 * HOUR);
  });
});

describe("recencyDecayMultiplier", () => {
  it("applies no penalty for a post right now", () => {
    expect(recencyDecayMultiplier(hoursAgo(0), NOW)).toBe(1);
  });

  it("applies no penalty anywhere up to and including 4h old", () => {
    expect(recencyDecayMultiplier(hoursAgo(1), NOW)).toBe(1);
    expect(recencyDecayMultiplier(hoursAgo(4), NOW)).toBe(1);
    expect(recencyDecayMultiplier(new Date(NOW.getTime() - RECENCY_DECAY_START_MS).toISOString(), NOW)).toBe(1);
  });

  it("decays meaningfully for an 8h-old post -- partway between the 4h and 12h boundaries", () => {
    const multiplier = recencyDecayMultiplier(hoursAgo(8), NOW);
    expect(multiplier).toBeLessThan(1);
    expect(multiplier).toBeGreaterThan(0.45); // still above the 12h floor
    expect(multiplier).toBeCloseTo(0.725, 2); // halfway through the 4h-12h decay range
  });

  it("reaches its floor at exactly the 12h cutoff, never below it", () => {
    const atCutoff = recencyDecayMultiplier(new Date(NOW.getTime() - MAX_AGE_FOR_DAILY_SELECTION_MS).toISOString(), NOW);
    expect(atCutoff).toBeCloseTo(0.45, 5);
  });

  it("never penalizes a candidate with an unknown post time -- missing data is not treated as stale", () => {
    expect(recencyDecayMultiplier(null, NOW)).toBe(1);
  });

  it("clamps at the floor for a post far past 12h -- even though it will separately be excluded by eligibility, the multiplier itself never goes negative or keeps falling", () => {
    const wayOld = recencyDecayMultiplier(hoursAgo(24 * 30), NOW);
    expect(wayOld).toBeCloseTo(0.45, 5);
  });
});

describe("effectiveScoreForSelection", () => {
  it("returns the stored score unchanged for a fresh post", () => {
    expect(effectiveScoreForSelection(70, hoursAgo(1), NOW)).toBe(70);
  });

  it("returns a reduced score for an 8h-old post", () => {
    const effective = effectiveScoreForSelection(70, hoursAgo(8), NOW);
    expect(effective).toBeLessThan(70);
    expect(effective).toBeCloseTo(70 * 0.725, 1);
  });

  it("never mutates the stored score for a candidate with no known post time", () => {
    expect(effectiveScoreForSelection(55, null, NOW)).toBe(55);
  });
});

describe("isEligibleForDailySelection", () => {
  it("is eligible for a fresh post", () => {
    expect(isEligibleForDailySelection(hoursAgo(1), NOW)).toBe(true);
  });

  it("is eligible for a 4h-old post", () => {
    expect(isEligibleForDailySelection(hoursAgo(4), NOW)).toBe(true);
  });

  it("is eligible for an 8h-old post", () => {
    expect(isEligibleForDailySelection(hoursAgo(8), NOW)).toBe(true);
  });

  it("is still eligible at exactly the 12h boundary -- 'older than 12 hours' means strictly greater, not equal", () => {
    const atCutoff = new Date(NOW.getTime() - MAX_AGE_FOR_DAILY_SELECTION_MS).toISOString();
    expect(isEligibleForDailySelection(atCutoff, NOW)).toBe(true);
  });

  it("is NOT eligible one minute past the 12h boundary", () => {
    const justPastCutoff = new Date(NOW.getTime() - MAX_AGE_FOR_DAILY_SELECTION_MS - 60_000).toISOString();
    expect(isEligibleForDailySelection(justPastCutoff, NOW)).toBe(false);
  });

  it("is not eligible for a post several days old", () => {
    expect(isEligibleForDailySelection(hoursAgo(24 * 5), NOW)).toBe(false);
  });

  it("is eligible when postCreatedAt is unknown -- never excludes on missing data", () => {
    expect(isEligibleForDailySelection(null, NOW)).toBe(true);
  });
});

describe("P2 age-window test switch (2026-11-15)", () => {
  it("defaults to 12 hours; PROSPECTING_AGE_WINDOW_HOURS=24 gives 24 hours and keeps a 50-point post above the 45 bar for about 11 hours", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.stubEnv("PROSPECTING_AGE_WINDOW_HOURS", "24");
    const f = await import("../src/prospecting/prospectingFreshness");
    const now = new Date("2026-11-16T12:00:00Z");
    const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    expect(f.MAX_AGE_FOR_DAILY_SELECTION_MS).toBe(24 * 3600_000);
    expect(50 * f.recencyDecayMultiplier(ago(10.5), now)).toBeGreaterThanOrEqual(45);
    expect(50 * f.recencyDecayMultiplier(ago(11.5), now)).toBeLessThan(45);
    vi.unstubAllEnvs();
    vi.resetModules();
    const base = await import("../src/prospecting/prospectingFreshness");
    expect(base.MAX_AGE_FOR_DAILY_SELECTION_MS).toBe(12 * 3600_000);
  });
});
