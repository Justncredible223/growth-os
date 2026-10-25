import { describe, it, expect } from "vitest";
import {
  MONTHLY_PROSPECTING_BUDGET_USD,
  QUEUE_FULL_THRESHOLD,
  STALE_EXPIRY_DAYS,
  evaluateMonthlyBudget,
  evaluateQueueCapacity,
  isStaleCandidate,
  selectTopicsForRun,
} from "../src/prospecting/prospectingEligibility";

describe("evaluateQueueCapacity", () => {
  it("stays eligible below the threshold", () => {
    expect(evaluateQueueCapacity(QUEUE_FULL_THRESHOLD - 1).eligible).toBe(true);
  });

  it("blocks at or above the threshold, with a reason naming the actual count", () => {
    const result = evaluateQueueCapacity(QUEUE_FULL_THRESHOLD);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain(String(QUEUE_FULL_THRESHOLD));
  });
});

describe("evaluateMonthlyBudget", () => {
  // Pins the owner-approved value (2026-09-18: "Raise the cap to $15"; 2026-10-24: raised to $20 after the real spend) so an
  // accidental edit to the constant is caught rather than silently shipped.
  // The rest of this suite derives from the constant on purpose; this one
  // assertion is the deliberate exception.
  it("uses the owner-approved $20.00 monthly cap", () => {
    expect(MONTHLY_PROSPECTING_BUDGET_USD).toBe(20);
  });

  it("reports the actual cap in the skip reason the UI surfaces", () => {
    const result = evaluateMonthlyBudget(MONTHLY_PROSPECTING_BUDGET_USD);
    expect(result.reason).toContain("cap is $20.00");
  });

  it("stays eligible under budget", () => {
    expect(evaluateMonthlyBudget(MONTHLY_PROSPECTING_BUDGET_USD - 0.01).eligible).toBe(true);
  });

  it("blocks at or over budget", () => {
    const result = evaluateMonthlyBudget(MONTHLY_PROSPECTING_BUDGET_USD);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/monthly_budget_reached/);
  });
});

describe("isStaleCandidate", () => {
  const now = new Date("2026-09-15T00:00:00Z");

  it("is not stale just under the window", () => {
    const discoveredAt = new Date(now.getTime() - (STALE_EXPIRY_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isStaleCandidate(discoveredAt, now)).toBe(false);
  });

  it("is stale just over the window", () => {
    const discoveredAt = new Date(now.getTime() - (STALE_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isStaleCandidate(discoveredAt, now)).toBe(true);
  });

  it("a freshly discovered candidate is never stale", () => {
    expect(isStaleCandidate(now.toISOString(), now)).toBe(false);
  });
});

describe("selectTopicsForRun", () => {
  const topics = ["a", "b", "c", "d", "e"];

  it("returns the requested count, wrapping around the list", () => {
    expect(selectTopicsForRun(topics, 0, 3)).toEqual(["a", "b", "c"]);
  });

  it("advances the window on later day indices instead of always starting at the same place", () => {
    const day0 = selectTopicsForRun(topics, 0, 3);
    const day1 = selectTopicsForRun(topics, 1, 3);
    expect(day1).not.toEqual(day0);
  });

  it("covers the full list across consecutive day indices rather than only ever using the first N", () => {
    const seen = new Set<string>();
    for (let day = 0; day < topics.length; day++) {
      for (const t of selectTopicsForRun(topics, day, 2)) seen.add(t);
    }
    expect(seen.size).toBe(topics.length);
  });

  it("never returns more items than exist in the topic list", () => {
    expect(selectTopicsForRun(topics, 0, 100)).toHaveLength(topics.length);
  });

  it("returns an empty array for an empty topic list", () => {
    expect(selectTopicsForRun([], 3, 5)).toEqual([]);
  });
});
