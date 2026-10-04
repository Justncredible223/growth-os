import { describe, it, expect } from "vitest";
import { computeReplyPacing, DAILY_REPLY_CAP } from "../src/prospecting/prospectingPacing";

const NOW = new Date("2026-09-25T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

describe("computeReplyPacing (burst posting got @FillbookHQ's replies hidden, 2026-09-25)", () => {
  it("lets the first reply go with no history", () => {
    const pacing = computeReplyPacing([], NOW);
    expect(pacing).toMatchObject({ repliedLast24h: 0, lastRepliedAt: null, nextReplyAt: null, reason: null });
  });

  it("holds the next reply until 20 minutes after the last one", () => {
    const pacing = computeReplyPacing([minutesAgo(5)], NOW);
    expect(pacing.reason).toBe("cooldown");
    expect(pacing.nextReplyAt).toBe(minutesAgo(-15));
  });

  it("allows a reply once the cooldown has passed", () => {
    expect(computeReplyPacing([minutesAgo(20)], NOW).reason).toBeNull();
  });

  it("caps replies at 10 in any rolling 24 hours, reopening when the oldest of them turns 24h old", () => {
    const pacing = computeReplyPacing([30, 90, 150, 210, 300, 420, 600, 800, 1000, 1380].map(minutesAgo), NOW);
    expect(pacing.repliedLast24h).toBe(DAILY_REPLY_CAP);
    expect(pacing.reason).toBe("daily_cap");
    expect(pacing.nextReplyAt).toBe(minutesAgo(1380 - 1440));
  });

  it("does not count replies older than 24 hours toward the cap", () => {
    const pacing = computeReplyPacing([minutesAgo(60), minutesAgo(1500), minutesAgo(1600), minutesAgo(1700), minutesAgo(1800)], NOW);
    expect(pacing.repliedLast24h).toBe(1);
    expect(pacing.reason).toBeNull();
  });

  it("ignores missing and unparseable reply times", () => {
    expect(computeReplyPacing([null, "not a date"], NOW).lastRepliedAt).toBeNull();
  });
});
