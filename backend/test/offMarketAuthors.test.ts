import { describe, it, expect } from "vitest";
import { isOffMarketAuthorWithoutFutures, isPromoContent, isReplyWorthyBase, whyNotReplyWorthy } from "../src/prospecting/prospectingRelevance";

/** ChatGPT B3 decision 2026-11-21: a crypto prop firm and a forex prop firm got replies. Both posts named no market. */
const COINPROP_POST = "A green P&L can hide a broken plan.\n\nBefore your next session, review one trade.\n\nDid you follow your entry, position sizing, and exit rules, or did the result make you overlook a mistake?\n\nWith CoinProp Trading Journal, review your execution, fees, and hold times.";
const FUNDYOURFX_POST = "$100K Funded Account or $2K Personal Account?\n\nWhich one would you choose?";
const COIN = { authorHandle: "coinprop_io", authorName: "CoinProp" };
const FX = { authorHandle: "FundYourFX", authorName: "Fund Your FX" };

describe("off-market authors (crypto and forex brands)", () => {
  it("drops the two audit posts at the free gate", () => {
    expect(isReplyWorthyBase(COINPROP_POST, COIN)).toBe(false);
    expect(isReplyWorthyBase(FUNDYOURFX_POST, FX)).toBe(false);
  });
  it("gives the forex account its own reason, because its post is otherwise clean", () => {
    expect(whyNotReplyWorthy(FUNDYOURFX_POST, FX)).toBe("off_market_author");
  });
  it("the crypto journal brand's post is also recognised as the company advertising itself", () => {
    expect(isPromoContent(COINPROP_POST)).toBe(true);
  });
  it("never decides on the account name alone: a futures post from a mixed-market account passes", () => {
    const post = "Trailing drawdown on my Topstep combine moved up with every green NQ day, and I only noticed after the fact.";
    expect(isOffMarketAuthorWithoutFutures(post, FX)).toBe(false);
    expect(isReplyWorthyBase(post, FX)).toBe(true);
  });
  it("does nothing when no author is given or the name has no off-market brand", () => {
    expect(isOffMarketAuthorWithoutFutures(FUNDYOURFX_POST)).toBe(false);
    expect(isOffMarketAuthorWithoutFutures(FUNDYOURFX_POST, { authorHandle: "fredtrades", authorName: "Fred" })).toBe(false);
  });
  it("leaves an ordinary trader's journaling post alone", () => {
    expect(isPromoContent("Reviewing my trading journal before the next session. Two oversized trades on NQ last week.")).toBe(false);
  });
});
