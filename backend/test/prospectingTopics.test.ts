import { describe, it, expect } from "vitest";
import { PROSPECTING_TOPICS, PARKED_PROSPECTING_TOPICS, discoveryLabelForKey, replyClassForKey } from "../src/prospecting/prospectingTopics";
import { isPlausiblyTradingRelated } from "../src/prospecting/prospectingRelevance";

/**
 * Regression coverage for a real, confirmed bug (2026-09-07): a topic's X
 * search query can find genuine candidates that ingestion happily accepts
 * as "new", only for prospectingHandlers.ts's listProspectingQueue() to
 * silently reclassify every one of them as 'not_relevant' the instant the
 * app fetches the queue -- because the query's own guaranteed phrase
 * never actually satisfies isPlausiblyTradingRelated()'s anchor list.
 * Confirmed live for "too_many_trades" (4 of 4 candidates from one real
 * run never reached the app) and "overtrading" (no anchor at all).
 *
 * For every topic whose query is unambiguous (a single quoted phrase,
 * optionally with one or more required bare words -- no OR/parentheses,
 * since only one branch of an OR is guaranteed present), this asserts
 * that the literal, minimal text X search guarantees a match on actually
 * passes the relevance gate. A topic added later that has this same gap
 * will fail this test immediately instead of silently starving the
 * Prospecting queue in production.
 */
function isUnambiguousQuery(query: string): boolean {
  return !query.includes(" OR ") && !query.includes("(");
}

/** Minimal literal text an unambiguous query is guaranteed to match: every quoted phrase plus every bare (unquoted) word, space-joined. */
function minimalMatchingText(query: string): string {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const bareWords = query.replace(/"[^"]+"/g, "").trim();
  return [...quoted, bareWords].filter(Boolean).join(" ");
}

describe("PROSPECTING_TOPICS queries are guaranteed to pass isPlausiblyTradingRelated", () => {
  const unambiguousTopics = PROSPECTING_TOPICS.filter((t) => isUnambiguousQuery(t.query));

  it("covers a meaningful majority of the topic list (sanity check the parser isn't skipping everything)", () => {
    expect(unambiguousTopics.length).toBeGreaterThan(PROSPECTING_TOPICS.length / 2);
  });

  for (const topic of unambiguousTopics) {
    it(`"${topic.key}" (query: ${topic.query})`, () => {
      // Every discovery query also carries a futures anchor (FUTURES_QUERY_ANCHORS), so a matching post has the topic words plus a futures signal.
      const text = `${minimalMatchingText(topic.query)} on MNQ futures`;
      expect(isPlausiblyTradingRelated(text)).toBe(true);
    });
  }
});

describe("parked low-yield topics (owner review 2026-09-20)", () => {
  const parkedKeys = PARKED_PROSPECTING_TOPICS.map((t) => t.key);

  it("takes the 12 weakest topics out of the search rotation", () => {
    expect(parkedKeys).toHaveLength(12);
    const activeKeys = new Set(PROSPECTING_TOPICS.map((t) => t.key));
    for (const key of parkedKeys) expect(activeKeys.has(key)).toBe(false);
  });

  it("keeps the high-yield topics in the rotation", () => {
    const activeKeys = new Set(PROSPECTING_TOPICS.map((t) => t.key));
    for (const key of ["revenge_trading", "trailing_drawdown", "prop_firm", "blown_account", "losing_streak", "daily_loss", "strategy_hopping", "futures_trader"]) {
      expect(activeKeys.has(key)).toBe(true);
    }
  });

  it("never lists a key twice across the active and parked lists", () => {
    const all = [...PROSPECTING_TOPICS, ...PARKED_PROSPECTING_TOPICS].map((t) => t.key);
    expect(new Set(all).size).toBe(all.length);
  });

  it("still resolves the label and reply class for rows already stored under a parked key", () => {
    expect(discoveryLabelForKey("energy_futures")).toBe("Energy futures");
    expect(replyClassForKey("energy_futures")).toBe("C");
    expect(discoveryLabelForKey("trade_review")).toBe("Trade review");
    expect(replyClassForKey("trade_review")).toBe("A");
  });

  it("still falls back safely for a key that is in neither list", () => {
    expect(discoveryLabelForKey("never_existed")).toBe("never_existed");
    expect(replyClassForKey("never_existed")).toBe("B");
  });
});
