import { describe, it, expect, vi } from "vitest";
import { refillProspectingQueue } from "../src/prospecting/prospectingRefill";
import { BUFFER_TARGET, DAILY_SEARCH_BUDGET_USD, DAILY_SEARCH_CAP, MAX_TOPICS_BUFFER, MAX_TOPICS_MANUAL, MONTHLY_PROSPECTING_BUDGET_USD, VET_MAX_PER_RUN, planSearchBreadth } from "../src/prospecting/prospectingEligibility";
import { getTodayXSearchCount } from "../src/cost/costTracking";
import { prospectingRunExtras } from "../src/prospecting/prospectingRunDeps";

const fakeClient = {} as any;
const NOW = new Date("2026-10-24T20:00:00Z");

describe("refillProspectingQueue (2026-10-24)", () => {
  it("runs the search with the shared run wiring and reports a short summary", async () => {
    const run = vi.fn(async () => ({ skipped: false, topicsSearched: ["a"], postsRead: 10, newCandidates: 3, excludedAsSpam: 0, excludedAsIrrelevant: 4, costUsd: 0.03, screenedOut: 1, searchRequests: 1 }));
    const message = await refillProspectingQueue(fakeClient, { run: run as any, adapter: {} as any, now: NOW });
    expect(message).toBe("refill: 3 new, 1 screened out, 1 searches");
    const deps = (run.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(typeof deps.screenRelevance).toBe("function");
    expect(typeof deps.getTodaySearchCount).toBe("function");
    expect(typeof deps.getMonthSpendUsd).toBe("function");
    expect(deps.runIndexOverride).toBeUndefined(); // a refill is not a manual search: it only tops up to the buffer
    expect(typeof deps.runIndexOffset).toBe("number");
  });

  it("reports a skip (buffer met, budget, daily limit) without treating it as a failure", async () => {
    const run = vi.fn(async () => ({ skipped: true, skipReason: "enough_waiting (2 selectable)", topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 }));
    expect(await refillProspectingQueue(fakeClient, { run: run as any, adapter: {} as any, now: NOW })).toBe("refill skipped -- enough_waiting (2 selectable)");
  });

  it("never throws: a failed refill must not undo or delay saving the reply", async () => {
    const run = vi.fn(async () => {
      throw new Error("X unavailable");
    });
    await expect(refillProspectingQueue(fakeClient, { run: run as any, adapter: {} as any, now: NOW })).resolves.toBe("refill failed -- X unavailable");
  });

  it("starts from a different topic slice each 20 minutes", async () => {
    const offsets: number[] = [];
    const run = vi.fn(async (deps: any) => {
      offsets.push(deps.runIndexOffset);
      return { skipped: true, skipReason: "x", topicsSearched: [], postsRead: 0, newCandidates: 0, excludedAsSpam: 0, excludedAsIrrelevant: 0, costUsd: 0 };
    });
    await refillProspectingQueue(fakeClient, { run: run as any, adapter: {} as any, now: new Date("2026-10-24T20:00:00Z") });
    await refillProspectingQueue(fakeClient, { run: run as any, adapter: {} as any, now: new Date("2026-10-24T20:21:00Z") });
    expect(offsets[0]).not.toBe(offsets[1]);
  });
});

describe("search limits (2026-10-24)", () => {
  it("raises the monthly cap to $20 and sets the daily limit, buffer and vetting sizes", () => {
    expect(MONTHLY_PROSPECTING_BUDGET_USD).toBe(20);
    expect(DAILY_SEARCH_CAP).toBe(30);
    expect(DAILY_SEARCH_BUDGET_USD).toBe(0.25); // temporary one-week setting from 2026-10-26 (was 0.5)
    expect(BUFFER_TARGET).toBe(2);
    expect(VET_MAX_PER_RUN).toBe(8);
  });

  it("a scheduled or refill search skips at the buffer target and otherwise searches until the buffer is met", () => {
    expect(planSearchBreadth(BUFFER_TARGET)).toMatchObject({ skip: true });
    expect(planSearchBreadth(0)).toEqual({ skip: false, maxTopics: MAX_TOPICS_BUFFER, target: BUFFER_TARGET });
    expect(planSearchBreadth(1)).toEqual({ skip: false, maxTopics: MAX_TOPICS_BUFFER, target: BUFFER_TARGET });
  });

  it("an owner-tapped search always searches and wants one more usable post than is waiting", () => {
    expect(planSearchBreadth(5, true)).toEqual({ skip: false, maxTopics: MAX_TOPICS_MANUAL, target: 6 });
    expect(planSearchBreadth(0, true)).toEqual({ skip: false, maxTopics: MAX_TOPICS_MANUAL, target: 1 });
  });
});

describe("getTodayXSearchCount", () => {
  it("counts one row per recorded search request for the Arizona day", async () => {
    const seen: Array<[string, unknown]> = [];
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const chain: any = {
      select: () => chain,
      gte: (col: string, v: unknown) => (seen.push([col, v]), chain),
      lt: () => chain,
      in: (col: string, v: unknown) => (seen.push([col, v]), chain),
      order: () => chain,
      range: async () => ({ data: rows, error: null }),
    };
    const client = { from: () => chain } as any;
    expect(await getTodayXSearchCount(client, new Date("2026-10-24T20:00:00Z"))).toBe(3);
    expect(seen).toContainEqual(["event_type", ["x_search_read"]]);
    // Arizona midnight is 07:00 UTC.
    expect(seen).toContainEqual(["created_at", "2026-10-24T07:00:00.000Z"]);
  });
});

describe("prospectingRunExtras", () => {
  it("provides the spend gate, pause switch, daily count and relevance screen", () => {
    const extras = prospectingRunExtras(fakeClient);
    expect(Object.keys(extras).sort()).toEqual(["getMonthSpendUsd", "getTodaySearchCount", "getTodaySearchSpendUsd", "isPaused", "screenRelevance"]);
  });
});
