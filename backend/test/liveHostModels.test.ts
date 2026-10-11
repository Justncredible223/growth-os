import { describe, expect, it } from "vitest";
import { ECONOMY_ALL_FROM_SPEND_FRACTION, ECONOMY_FROM_SPEND_FRACTION, FACT_SEGMENTS, parseCostMode, useFastModel } from "../src/liveHost/liveHostModels";
import { LIVE_HOST_SEGMENTS } from "../src/liveHost/liveHostPersona";

const base = { mode: "balanced" as const, segmentId: null, joinWelcome: false, duoReply: false, spendFraction: 0 };

describe("parseCostMode", () => {
  it("accepts the three modes and falls back to quality", () => {
    expect(parseCostMode("quality")).toBe("quality");
    expect(parseCostMode("low")).toBe("low");
    expect(parseCostMode("balanced")).toBe("balanced");
    expect(parseCostMode("cheap")).toBe("quality");
    expect(parseCostMode(undefined)).toBe("quality");
  });
});

describe("useFastModel", () => {
  it("always uses the fast model for join welcomes and duo replies", () => {
    expect(useFastModel({ ...base, mode: "quality", joinWelcome: true })).toBe(true);
    expect(useFastModel({ ...base, mode: "quality", duoReply: true })).toBe(true);
  });

  it("balanced: routine segments and chat answers fast, fact segments on the stronger model", () => {
    expect(useFastModel({ ...base, segmentId: "roast_my_trade" })).toBe(true);
    expect(useFastModel({ ...base, segmentId: "tilt_o_meter" })).toBe(true);
    expect(useFastModel({ ...base, segmentId: "desk_lesson" })).toBe(false);
    expect(useFastModel({ ...base, segmentId: "fillbook_spot" })).toBe(false);
    // A viewer waiting on an answer is where seconds matter most.
    expect(useFastModel({ ...base, segmentId: null })).toBe(true);
  });

  it("quality keeps everything but welcomes and duo replies on the stronger model; low sends chat answers fast too", () => {
    expect(useFastModel({ ...base, mode: "quality", segmentId: "roast_my_trade" })).toBe(false);
    expect(useFastModel({ ...base, mode: "low", segmentId: null })).toBe(true);
    expect(useFastModel({ ...base, mode: "low", segmentId: "desk_lesson" })).toBe(false);
  });

  it("goes to economy as the daily budget is used, fact segments last", () => {
    expect(useFastModel({ ...base, mode: "quality", segmentId: "roast_my_trade", spendFraction: ECONOMY_FROM_SPEND_FRACTION })).toBe(true);
    expect(useFastModel({ ...base, mode: "quality", segmentId: "desk_lesson", spendFraction: ECONOMY_FROM_SPEND_FRACTION })).toBe(false);
    expect(useFastModel({ ...base, mode: "quality", segmentId: "desk_lesson", spendFraction: ECONOMY_ALL_FROM_SPEND_FRACTION })).toBe(true);
  });

  it("only names fact segments that exist", () => {
    const ids = new Set(LIVE_HOST_SEGMENTS.map((segment) => segment.id));
    for (const id of FACT_SEGMENTS) expect(ids.has(id), id).toBe(true);
  });
});
