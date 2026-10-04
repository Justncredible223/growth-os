import { describe, it, expect } from "vitest";
import { ONE_PER_DAY_ZONE, conceptRequestedToday, nextDayStart, oneADayMessage, startOfDay } from "../src/video/dailyLimit";
import { MANUAL_MOTION_CONCEPT_TITLE_PREFIX } from "../src/opportunities/manualMotionConcept";

const T = (name: string) => `${MANUAL_MOTION_CONCEPT_TITLE_PREFIX}${name}`;

describe("a day is a calendar day in Arizona", () => {
  it("is the Arizona zone, the same day the render cap and posting plan use", () => {
    expect(ONE_PER_DAY_ZONE).toBe("America/Phoenix");
  });

  it("starts at midnight Arizona: 07:00 UTC all year (Arizona has no daylight saving)", () => {
    expect(startOfDay(new Date("2026-10-03T15:30:00Z")).toISOString()).toBe("2026-10-03T07:00:00.000Z");
    expect(startOfDay(new Date("2026-12-15T15:30:00Z")).toISOString()).toBe("2026-12-15T07:00:00.000Z");
  });

  it("belongs to the previous Arizona day just after 07:00 UTC's midnight", () => {
    // 06:00 UTC on Oct 4 is 11 pm Arizona on Oct 3.
    expect(startOfDay(new Date("2026-10-04T06:00:00Z")).toISOString()).toBe("2026-10-03T07:00:00.000Z");
  });

  it("lifts at the next Arizona midnight, and every day is 24 hours (no clock change)", () => {
    expect(nextDayStart(new Date("2026-10-03T15:30:00Z")).toISOString()).toBe("2026-10-04T07:00:00.000Z");
    const start = startOfDay(new Date("2026-11-01T12:00:00Z"));
    expect((nextDayStart(new Date("2026-11-01T12:00:00Z")).getTime() - start.getTime()) / 3_600_000).toBe(24);
  });
});

describe("what counts as today's request", () => {
  it("counts a draft waiting in Approvals or approved", () => {
    expect(conceptRequestedToday({ campaigns: [{ thesis: T("A"), status: "in_review" }], pendingTitles: [] })).toBe(T("A"));
    expect(conceptRequestedToday({ campaigns: [{ thesis: T("B"), status: "approved" }], pendingTitles: [] })).toBe(T("B"));
  });

  it("counts a request that is still queued or running", () => {
    expect(conceptRequestedToday({ campaigns: [], pendingTitles: [T("C")] })).toBe(T("C"));
  });

  it("does not count a rejected or retired draft, or a draft that was only started: the day's request is free again", () => {
    expect(conceptRequestedToday({ campaigns: [{ thesis: T("D"), status: "retired" }, { thesis: T("E"), status: "draft" }], pendingTitles: [] })).toBeNull();
  });

  it("ignores campaigns that are not motion-concept requests", () => {
    expect(conceptRequestedToday({ campaigns: [{ thesis: "A blog post", status: "in_review" }], pendingTitles: [] })).toBeNull();
  });
});

describe("the refusal message", () => {
  it("names today's concept and when the next request opens, in Arizona time", () => {
    const msg = oneADayMessage(T("5 contracts against a plan of 3"), new Date("2026-10-03T15:30:00Z"));
    expect(msg).toContain("One video a day");
    expect(msg).toContain('"5 contracts against a plan of 3"');
    expect(msg).toMatch(/Sun.*12:00 AM Arizona/);
    expect(msg).toMatch(/Reject that draft/);
  });
});
