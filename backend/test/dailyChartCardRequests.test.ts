import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distinctConcepts } from "../src/shortform/conceptVariety";
import { MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";
import { DAILY_CONCEPT_ORDER } from "../src/shortform/dailyConcepts";
import { EXTRA_OFFERED_CONCEPT_IDS, OFFERED_DAILY_CONCEPT_IDS } from "../src/shortform/motionPlans";
import { LOW_SUPPLY_AT, MAX_CHART_CARDS_WAITING, VIDEO_REQUEST_WEEKDAYS, isVideoRequestDay, offeredChartConcepts, runDailyChartCardRequests, type ConceptState, type DailyChartCardDeps } from "../src/video/dailyChartCardRequests";
import { manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept";

const concepts = offeredChartConcepts();
const titleOf = (i: number) => manualMotionConceptTitle(concepts[i]!);

// Tuesday 2026-10-27, 05:00 in Arizona: a request day.
const A_TUESDAY = new Date("2026-10-27T12:00:00Z");

function deps(opts: { now?: Date; paused?: boolean; today?: string | null; states?: Array<[number, ConceptState]>; fail?: (id: string) => boolean } = {}) {
  const requested: string[] = [];
  const d: DailyChartCardDeps = {
    now: () => opts.now ?? A_TUESDAY,
    isPaused: async () => opts.paused ?? false,
    states: async () => new Map((opts.states ?? []).map(([i, s]) => [titleOf(i), s] as const)),
    requestedToday: async () => opts.today ?? null,
    request: vi.fn(async (id: string) => {
      if (opts.fail?.(id)) throw new Error(`boom ${id}`);
      requested.push(id);
      return { campaignRunRequestId: `run-${id}`, opportunityId: `opp-${id}` };
    }),
  };
  return { d, requested };
}

describe("the concepts the daily refill draws from", () => {
  it("are the explainers only: no extras, no clips, none of the 30 older daily concepts, none of the first twelve, none of the illustrative win-rate ones", () => {
    expect(EXTRA_OFFERED_CONCEPT_IDS).toEqual([]);
    expect(concepts).toHaveLength(OFFERED_DAILY_CONCEPT_IDS.length);
    expect(concepts.every((c) => /^(explain|strategy)-/.test(c.id))).toBe(true);
    expect(concepts.some((c) => DAILY_CONCEPT_ORDER.includes(c.id))).toBe(false);
    expect(concepts.some((c) => c.id.startsWith("chart-"))).toBe(false);
  });

  it("are served in the explainers' fixed 30-day order, copy trading across accounts first", () => {
    expect(concepts.map((c) => c.id)).toEqual([...OFFERED_DAILY_CONCEPT_IDS, ...EXTRA_OFFERED_CONCEPT_IDS]);
    expect(concepts[0]!.id).toBe("explain-01-copy-trading-risk");
    expect(concepts.map((c) => c.id)).toContain("strategy-01-orb-range-trigger");
  });
});

describe("two videos a week (owner 2026-10-24)", () => {
  it("requests on Tuesday and Friday only", () => {
    expect(VIDEO_REQUEST_WEEKDAYS).toEqual([2, 5]);
  });

  it("reads the weekday in Arizona, not UTC", () => {
    // 2026-10-28T03:00Z is Wednesday in UTC but still Tuesday 20:00 in Arizona.
    expect(isVideoRequestDay(new Date("2026-10-28T03:00:00Z"))).toBe(true);
    // 2026-10-27T03:00Z is Monday 20:00 in Arizona.
    expect(isVideoRequestDay(new Date("2026-10-27T03:00:00Z"))).toBe(false);
    expect(isVideoRequestDay(new Date("2026-10-30T18:00:00Z"))).toBe(true); // Friday
    expect(isVideoRequestDay(new Date("2026-10-24T18:00:00Z"))).toBe(false); // Saturday
  });

  it("skips without reading state or requesting on any other day", async () => {
    const { d, requested } = deps({ now: new Date("2026-10-29T18:00:00Z") }); // Thursday
    const states = vi.fn(d.states);
    const requestedToday = vi.fn(d.requestedToday);
    const report = await runDailyChartCardRequests({ ...d, states, requestedToday });
    expect(report).toMatch(/two videos a week.*Tuesday and Friday.*Thursday/);
    expect(requested).toEqual([]);
    expect(states).not.toHaveBeenCalled();
    expect(requestedToday).not.toHaveBeenCalled();
  });

  it("requests on a Friday", async () => {
    const { d, requested } = deps({ now: new Date("2026-10-30T18:00:00Z") });
    await runDailyChartCardRequests(d);
    expect(requested).toHaveLength(1);
  });
});

describe("runDailyChartCardRequests", () => {
  it("requests nothing while the system is paused", async () => {
    const { d, requested } = deps({ paused: true });
    expect(await runDailyChartCardRequests(d)).toMatch(/paused/);
    expect(requested).toEqual([]);
  });

  it("requests ONE concept a day, the next in the daily order", async () => {
    expect(MAX_CHART_CARDS_WAITING).toBe(1);
    const { d, requested } = deps();
    const report = await runDailyChartCardRequests(d);
    expect(requested).toEqual([concepts[0]!.id]);
    expect(report).toContain("requested 1");
  });

  it("requests nothing when a concept was already requested today, by hand or by an earlier run", async () => {
    const { d, requested } = deps({ today: "Motion concept request: 5 contracts against a plan of 3" });
    expect(await runDailyChartCardRequests(d)).toMatch(/one video a day.*5 contracts against a plan of 3/);
    expect(requested).toEqual([]);
  });

  it("does nothing while one is still waiting in Approvals", async () => {
    const { d, requested } = deps({ states: [[0, "waiting"]] });
    expect(await runDailyChartCardRequests(d)).toMatch(/already waiting/);
    expect(requested).toEqual([]);
  });

  it("never requests a concept that is made, rejected or waiting, so each is used exactly once", async () => {
    const { d, requested } = deps({ states: [[0, "made"], [1, "rejected"]] });
    await runDailyChartCardRequests(d);
    expect(requested).toEqual([concepts[2]!.id]);
  });

  it("says so when every concept is used up", async () => {
    const { d, requested } = deps({ states: concepts.map((_, i) => [i, "made"] as [number, ConceptState]) });
    expect(await runDailyChartCardRequests(d)).toMatch(/no unused chart concepts left/);
    expect(requested).toEqual([]);
  });

  it("warns when the unused supply runs low", async () => {
    // Supply is counted in DIFFERENT concepts: the near-copies of a made one are hidden, so they are not supply.
    const distinct = distinctConcepts(concepts, [], (id) => MOTION_SCENE_PLANS.find((p) => p.planId === id));
    const used = distinct.slice(0, distinct.length - LOW_SUPPLY_AT).map((c) => [concepts.indexOf(c), "made"] as [number, ConceptState]);
    const { d } = deps({ states: used });
    expect(await runDailyChartCardRequests(d)).toMatch(/LOW SUPPLY/);
  });

  it("fails loudly when the one request cannot be made", async () => {
    const none = deps({ fail: () => true });
    await expect(runDailyChartCardRequests(none.d)).rejects.toThrow(/could not request any chart card/);
  });
});

describe("the daily refill stays wired in and stays inside its limits", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("runs as its own isolated step of the growth pulse's video group, with the one-a-day check wired in", () => {
    const src = read("api/growth-pulse.ts");
    expect(src).toContain('runStep("chart_card_requests"');
    expect(src).toContain("requestedToday: () => motionRequestedToday(client)");
    expect(src.indexOf("if (runVideoReconciliation)")).toBeLessThan(src.indexOf('runStep("chart_card_requests"'));
  });

  it("only ever queues a request: nothing in the refill approves, renders or publishes", () => {
    // Comments explain what the refill does NOT do, so they are stripped before looking for anything that does it.
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const code = strip(read("src/video/dailyChartCardRequests.ts") + read("src/opportunities/requestMotionConcept.ts"));
    expect(code).not.toMatch(/approve|enqueue_video_render|publish|youtube|tiktok/i);
  });

  it("the one-a-day check only reads: it never writes or calls a procedure", () => {
    const code = strip(read("src/video/dailyLimit.ts"));
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  });
});
