import { describe, it, expect } from "vitest";
import { FILLBOOK_SHOWCASE_VIEWS, SHOWCASE_IDS, formatShowcaseViews } from "../src/content/fillbookShowcase";
import { PROSPECTING_TOPICS, replyClassForKey } from "../src/prospecting/prospectingTopics";
import { isPlausiblyTradingRelated } from "../src/prospecting/prospectingRelevance";
import { buildProspectingSystemPrompt, prospectingPlatformProfile } from "../src/prospecting/prospectingReplyWriter";
import { buildInboundSystemPrompt } from "../src/inbound/inboundResponseWriter";

const OWN_VIEW_IDS = ["capital_curve", "drawdown_odds", "size_from_account", "cost_of_trading", "instrument_and_hours", "margin_exposure"];
const OWN_TOPIC_KEYS = ["self_funded", "own_capital_futures", "live_futures_account", "futures_margin", "margin_call_futures", "small_account_futures", "trading_costs_futures"];

describe("self-funded (own-money) futures traders in Prospecting", () => {
  it("searches for them: every own-capital topic is in the rotation with a futures anchor", () => {
    for (const key of OWN_TOPIC_KEYS) {
      const topic = PROSPECTING_TOPICS.find((t) => t.key === key);
      expect(topic, key).toBeDefined();
      expect(topic!.query.toLowerCase()).toContain("futures");
      expect(replyClassForKey(key)).toMatch(/[AB]/);
    }
  });

  it("keeps their posts through the relevance gate, and still drops crypto look-alikes", () => {
    expect(isPlausiblyTradingRelated("Self-funded futures trader here. Added another $2k to my live account after a bad week.")).toBe(true);
    expect(isPlausiblyTradingRelated("Futures margin on MES jumped overnight and I got a margin call")).toBe(true);
    expect(isPlausiblyTradingRelated("Self-funded on a crypto exchange, perpetual futures with 50x leverage on BTC")).toBe(false);
  });

  it("knows six own-money Fillbook views, each tagged for that audience and offered as a reply choice", () => {
    for (const id of OWN_VIEW_IDS) {
      const view = FILLBOOK_SHOWCASE_VIEWS.find((v) => v.id === id);
      expect(view?.audience, id).toBe("own");
      expect(SHOWCASE_IDS).toContain(id);
    }
  });

  it("tags every view with an audience and never lets a firm-rule view reach a self-funded trader", () => {
    for (const view of FILLBOOK_SHOWCASE_VIEWS) expect(["prop", "own", "both"]).toContain(view.audience);
    for (const id of ["account_buffer", "consistency_cap", "rule_simulator", "payout_timeline"]) {
      expect(FILLBOOK_SHOWCASE_VIEWS.find((v) => v.id === id)?.audience).toBe("prop");
    }
    const block = formatShowcaseViews();
    expect(block.indexOf("Only for a trader risking their own money")).toBeGreaterThan(block.indexOf("Only for a trader dealing with a prop firm"));
    expect(block.slice(block.indexOf("Only for a trader risking their own money"))).toContain("- capital_curve:");
    expect(block.slice(0, block.indexOf("Only for a trader dealing with a prop firm"))).not.toContain("- capital_curve:");
  });

  for (const [name, prompt] of [
    ["cold reply (Prospecting)", buildProspectingSystemPrompt(prospectingPlatformProfile("x"))],
    ["inbound reply", buildInboundSystemPrompt("x")],
  ] as const) {
    it(`${name} prompt describes both audiences and forbids advice, pricing and plan talk for self-funded traders`, () => {
      expect(prompt).toContain("self-funded");
      expect(prompt).toContain("- capital_curve:");
      expect(prompt).toMatch(/never tell them how many contracts to trade/);
      expect(prompt).toMatch(/called Own Capital, \$14\.99 a\s+month/);
      expect(prompt).toMatch(/Never mention it to a prop-firm trader/);
      expect(prompt).toMatch(/Never name any other\s+plan or price/);
      expect(prompt).toMatch(/anything about taxes/);
    });
  }
});
