import { describe, it, expect } from "vitest";
import { EXPANDED_READS_WINDOW_DAYS, RESULTS_PER_QUERY, expandedReadsActive, resultsPerQueryFor } from "../src/prospecting/prospectingEligibility";

/** The 7-day expanded-reads experiment (ChatGPT decision 2026-11-21, P3): off by default, 2x at most, reverts by date alone. */
describe("expanded reads experiment", () => {
  const start = "2026-11-24";
  it("is off when the flag is unset or malformed", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(resultsPerQueryFor(now, undefined)).toBe(RESULTS_PER_QUERY);
    expect(resultsPerQueryFor(now, "")).toBe(RESULTS_PER_QUERY);
    expect(resultsPerQueryFor(now, "next week")).toBe(RESULTS_PER_QUERY);
  });
  it("doubles reads (never more) inside the seven-day window", () => {
    expect(resultsPerQueryFor(new Date("2026-11-24T00:00:00Z"), start)).toBe(RESULTS_PER_QUERY * 2);
    expect(resultsPerQueryFor(new Date("2026-11-30T23:59:59Z"), start)).toBe(RESULTS_PER_QUERY * 2);
  });
  it("is off before the start day and reverts by itself after the window", () => {
    expect(expandedReadsActive(new Date("2026-11-23T23:59:59Z"), start)).toBe(false);
    expect(expandedReadsActive(new Date("2026-12-01T00:00:00Z"), start)).toBe(false);
    expect(resultsPerQueryFor(new Date("2026-12-15T00:00:00Z"), start)).toBe(RESULTS_PER_QUERY);
    expect(EXPANDED_READS_WINDOW_DAYS).toBe(7);
  });
});
