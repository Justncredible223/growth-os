import { describe, expect, it } from "vitest";
import { pausedTopics, queryYieldSummary, yieldEventsFromRows, type YieldEvent } from "../src/prospecting/prospectingQueryYield";

const NOW = new Date("2026-11-16T12:00:00Z");
const ev = (at: string, topics: string[], read: number, kept: number, watchlist = false): YieldEvent => ({ at, topics, read, kept, watchlist });

describe("pausedTopics (P2, ChatGPT 2026-11-15)", () => {
  it("pauses a topic after 5 empty searches over at least 3 days, for 7 days from the latest", () => {
    const events = [
      ev("2026-11-10T15:00:00Z", ["broke_rules"], 0, 0),
      ev("2026-11-11T15:00:00Z", ["broke_rules"], 1, 0),
      ev("2026-11-12T15:00:00Z", ["broke_rules"], 0, 0),
      ev("2026-11-12T20:00:00Z", ["broke_rules"], 0, 0),
      ev("2026-11-15T20:00:00Z", ["broke_rules"], 2, 0),
    ];
    const p = pausedTopics(events, NOW).get("broke_rules")!;
    expect(p.until).toBe("2026-11-22T20:00:00.000Z");
    expect(p.reason).toMatch(/last 5 searches over 4 days/);
  });

  it("does not pause on fewer than 5 searches, on fewer than 3 days, or when any of the last 5 kept a post", () => {
    const four = [1, 2, 3, 4].map((d) => ev(`2026-11-1${d}T15:00:00Z`, ["a"], 0, 0));
    const twoDays = [0, 1, 2, 3, 4].map((i) => ev(`2026-11-1${i < 3 ? 4 : 5}T1${i}:00:00Z`, ["b"], 0, 0));
    const oneKept = [1, 2, 3, 4, 5].map((d) => ev(`2026-11-1${d}T15:00:00Z`, ["c"], 3, d === 5 ? 1 : 0));
    const paused = pausedTopics([...four, ...twoDays, ...oneKept], NOW);
    expect([...paused.keys()]).toEqual([]);
  });

  it("lets a topic back in once its 7 days are over", () => {
    const events = [1, 2, 3, 4, 5].map((d) => ev(`2026-11-0${d}T15:00:00Z`, ["d"], 0, 0));
    expect(pausedTopics(events, NOW).has("d")).toBe(false);
  });

  it("never pauses the creator watchlist", () => {
    const events = [1, 2, 3, 4, 5].map((d) => ev(`2026-11-1${d}T15:00:00Z`, [], 5, 0, true));
    expect(pausedTopics(events, NOW).size).toBe(0);
  });
});

describe("queryYieldSummary", () => {
  it("counts the last 7 days per topic and for the watchlist, with kept/read %, best first, paused topics flagged", () => {
    const events = [
      ev("2026-11-15T15:00:00Z", [], 10, 4, true),
      ev("2026-11-14T15:00:00Z", [], 10, 2, true),
      ev("2026-11-15T20:00:00Z", ["daily_loss_limit", "strategy_hopping"], 8, 3),
      ev("2026-11-01T20:00:00Z", ["daily_loss_limit"], 9, 9), // older than 7 days: not counted
      ...[10, 11, 12, 13, 15].map((d) => ev(`2026-11-${d}T15:00:00Z`, ["broke_rules"], 0, 0)),
    ];
    const rows = queryYieldSummary(events, NOW);
    expect(rows[0]).toMatchObject({ key: "watchlist", label: "Creator watchlist", runs: 2, read: 20, kept: 6, keptPct: 30, pausedUntil: null });
    expect(rows.find((r) => r.key === "daily_loss_limit")).toMatchObject({ runs: 1, read: 8, kept: 3, keptPct: 38 });
    const paused = rows.find((r) => r.key === "broke_rules")!;
    expect(paused.kept).toBe(0);
    expect(paused.keptPct).toBeNull();
    expect(paused.pausedUntil).toBe("2026-11-22T15:00:00.000Z");
  });
});

describe("yieldEventsFromRows", () => {
  it("reads the search cost events and skips rows without the funnel context", () => {
    const events = yieldEventsFromRows([
      { created_at: "2026-11-15T15:00:00Z", context: { topics: ["a", "b"], read: 3, funnel: { inserted: 1 } } },
      { created_at: "2026-11-15T15:00:00Z", context: { watchlist: true, read: 2, funnel: { inserted: 0 } } },
      { created_at: "2026-11-15T15:00:00Z", context: { query: "old row" } },
    ]);
    expect(events).toEqual([
      { at: "2026-11-15T15:00:00Z", topics: ["a", "b"], watchlist: false, read: 3, kept: 1 },
      { at: "2026-11-15T15:00:00Z", topics: [], watchlist: true, read: 2, kept: 0 },
    ]);
  });
});
