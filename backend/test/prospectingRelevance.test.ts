import { describe, it, expect } from "vitest";
import { whyNotReplyWorthy, CRYPTO_QUERY_EXCLUSIONS, FUTURES_QUERY_ANCHORS, OPTIONS_QUERY_EXCLUSIONS, isOptionsPost, MIN_PROSPECT_FOLLOWERS, isBroadcastContent, isPlausiblyTradingRelated, isPromoContent, isReplyWorthyPost, isTooSmallToBeWorthIt, withCryptoExclusions } from "../src/prospecting/prospectingRelevance";

/**
 * Regression coverage for a real, confirmed bug: Prospecting surfaced
 * posts with zero connection to futures/prop-firm trading -- a sci-fi
 * story teaser scored 51 and got queued under the "Hesitation" topic
 * purely from generic engagement/length heuristics that never checked
 * the post text itself. This predicate is the $0 pre-filter that closes
 * that gap, run before any LLM call is made.
 */
describe("isPlausiblyTradingRelated", () => {
  it("rejects the exact sci-fi post that exposed this bug live", () => {
    const postText =
      'What if trust begins where certainty ends?\nIn #2084, a civilization built on prediction discovers the one thing an algorithm cannot give you: a reason...';
    expect(isPlausiblyTradingRelated(postText)).toBe(false);
  });

  it("rejects a generic non-trading post using only bare generic words like 'entry' or 'performance'", () => {
    expect(isPlausiblyTradingRelated("Every entry into the competition counts toward your final performance score.")).toBe(false);
    expect(isPlausiblyTradingRelated("The event's performance metrics were announced at the entry gate.")).toBe(false);
  });

  it("accepts a genuine futures post", () => {
    expect(isPlausiblyTradingRelated("Been trading MNQ futures for two years and still get nervous before the open.")).toBe(true);
  });

  it("accepts a genuine prop-firm post that has futures-only rules, even with no mention of 'futures' at all", () => {
    expect(isPlausiblyTradingRelated("Failed my prop firm evaluation because of a trailing drawdown rule I didn't fully understand.")).toBe(true);
    expect(isPlausiblyTradingRelated("My funded account got pulled today. Consistency rule got me again.")).toBe(true);
  });

  it("a bare prop firm or funded account mention is not enough (2026-10-25: a forex funded-account brag and a creator's video teaser got through)", () => {
    expect(isPlausiblyTradingRelated("Weekend vibes. Alhamdulillah a $50K Funded account secured with my favourite prop firm")).toBe(false);
    expect(isPlausiblyTradingRelated("Video later today on how to pass prop firm challenges with a much higher success rate and at a much quicker pace")).toBe(false);
    expect(isReplyWorthyPost("Video later today on how to pass prop firm challenges with a much higher success rate on ES futures")).toBe(false);
    expect(isReplyWorthyPost("New video out now on how I pass Topstep combines on MNQ futures")).toBe(false);
    expect(isReplyWorthyPost("Alhamdulillah a $50K Funded account secured with Topstep on MNQ futures")).toBe(false);
  });

  it("real futures vocabulary counts without the word futures (2026-10-29): firm names, ORB, ticks, micro contracts", () => {
    expect(isPlausiblyTradingRelated("Blew my Apex eval again by revenge trading after a stop out. Same mistake every week.")).toBe(true);
    expect(isPlausiblyTradingRelated("Took the ORB trade, stopped for 12 ticks, then it ran without me. Why do I keep cutting my trades early?")).toBe(true);
    expect(isPlausiblyTradingRelated("Trading 3 micro contracts instead of 1 is why my loss limit went so fast.")).toBe(true);
    expect(isPlausiblyTradingRelated("Revenge trading after a loss is the real account killer for everyone.")).toBe(false);
  });

  it("index and session language counts (2026-10-30), but stock posts still do not", () => {
    expect(isPlausiblyTradingRelated("Nasdaq NY Session trade today, stopped out once then took the second setup and it paid.")).toBe(true);
    expect(isPlausiblyTradingRelated("Every S&P 500 trade I took this week lost, my stop loss placement is the problem.")).toBe(true);
    expect(isPlausiblyTradingRelated("Best stocks to trade on the Nasdaq this week, my stock picks and setups.")).toBe(false);
  });

  it("the futures anchor can be left off for prop-specific phrases, keeping the other exclusions", () => {
    const q = withCryptoExclusions('"blew my eval"', { futuresAnchor: false });
    expect(q).toBe('("blew my eval") ' + CRYPTO_QUERY_EXCLUSIONS + ' ' + OPTIONS_QUERY_EXCLUSIONS + ' -has:links');
    expect(q).not.toContain("MNQ");
  });

  it("the full wrapped query still fits X's 512 character limit with the widest topic group", () => {
    const widest = "x".repeat(180);
    expect((withCryptoExclusions(widest) + " -is:retweet -is:reply lang:en").length).toBeLessThanOrEqual(512);
  });

  it("needs a futures signal: strong trading context with no futures evidence no longer qualifies", () => {
    expect(isPlausiblyTradingRelated("Overtrading after a losing streak is how most funded accounts actually blow up.")).toBe(false);
    expect(isPlausiblyTradingRelated("Overtrading after a losing streak is how most funded futures accounts actually blow up.")).toBe(true);
  });

  it("catches other real trading-discipline vocabulary with no 'futures' or 'trading' word present", () => {
    expect(isPlausiblyTradingRelated("Hit my daily loss limit again on NQ. Same mistake, third time this month.")).toBe(true);
    expect(isPlausiblyTradingRelated("Hit my daily loss limit again. Same mistake, third time this month.")).toBe(false);
    // Futures only (2026-10-24): generic risk words with no futures or prop-firm signal no longer qualify.
    expect(isPlausiblyTradingRelated("Position sizing is the one thing nobody teaches new traders properly.")).toBe(false);
    expect(isPlausiblyTradingRelated("Position sizing is the one thing nobody teaches new futures traders properly.")).toBe(true);
  });

  it("rejects ordinary text that happens to contain short substrings without real trading meaning", () => {
    expect(isPlausiblyTradingRelated("The market for artisanal bread has never been better in this neighborhood.")).toBe(false);
    expect(isPlausiblyTradingRelated("She wrote in her journal about the discipline it takes to finish a marathon.")).toBe(false);
  });
});

/**
 * Regression coverage for a second real, confirmed bug (2026-09-07): the
 * owner's phone showed crypto-only posts ("$USELESS locked in the
 * profits... a 15% move in less than 2h") as actionable Prospecting
 * cards under the "Overtrading volume" topic label -- this predicate
 * already rejected them correctly (proven below), the bug was that
 * nothing called it until the owner tapped Draft reply. See
 * prospectingHandlers.ts's listProspectingQueue for the fix that applies
 * this gate before a candidate is ever shown.
 */
describe("isPlausiblyTradingRelated -- crypto-only content", () => {
  it("rejects the exact crypto posts that exposed this bug live, before any LLM call", () => {
    expect(isPlausiblyTradingRelated("$USELESS locked in the profits")).toBe(false);
    expect(isPlausiblyTradingRelated("Not bad a 15% move in less than 2h...")).toBe(false);
  });

  it("rejects other crypto-only content -- coin/token speculation, meme coins, altcoins, DeFi, NFT/Web3", () => {
    expect(isPlausiblyTradingRelated("$DOGE about to send it, aping in with my last stack")).toBe(false);
    expect(isPlausiblyTradingRelated("This new altcoin just 10x'd, should've bought the dip")).toBe(false);
    expect(isPlausiblyTradingRelated("Just aped into this new DeFi yield farm, APY is insane right now")).toBe(false);
    expect(isPlausiblyTradingRelated("Minted my first NFT today, welcome to web3")).toBe(false);
  });

  it("rejects a bare percentage-move post with no futures/trading-discipline context", () => {
    expect(isPlausiblyTradingRelated("Up 40% this week, best run of my life")).toBe(false);
  });

  it("a post mentioning crypto remains eligible when it also clearly discusses futures/prop-firm/funded-account/risk-discipline context", () => {
    expect(isPlausiblyTradingRelated("Blew up my funded account trying to revenge trade back losses from a bad crypto futures position")).toBe(true);
    expect(isPlausiblyTradingRelated("Failed my prop firm evaluation -- was overleveraged on BTC futures and hit my daily loss limit")).toBe(true);
  });

  it("'overtrading' alone is no longer sufficient -- it's too generic to anchor a post to futures/trading-discipline content on its own", () => {
    expect(isPlausiblyTradingRelated("overtrading volume")).toBe(false);
    expect(isPlausiblyTradingRelated("I really struggled with overtrading this week")).toBe(false);
  });

  it("a genuine overtrading post still passes via its own other trading-discipline anchor, with a futures signal", () => {
    expect(isPlausiblyTradingRelated("Overtrading after a losing streak is how most funded futures accounts actually blow up.")).toBe(true);
  });

  it("no other generic word alone (volume, discipline, performance, entry, move, profits) is sufficient", () => {
    expect(isPlausiblyTradingRelated("Volume was huge today, what a move")).toBe(false);
    expect(isPlausiblyTradingRelated("Discipline and performance are everything")).toBe(false);
    expect(isPlausiblyTradingRelated("Locked in profits on this entry")).toBe(false);
  });
});

/**
 * Regression coverage for a third real, confirmed leak (2026-09-16,
 * owner-reported): crypto trading shares almost all its vocabulary with
 * futures/prop-firm trading ("futures", "leverage", "liquidated",
 * "stop-loss", "drawdown" apply equally to a crypto perpetual swap), so a
 * post that matches a TRADING_RELEVANCE_PATTERNS anchor via that shared
 * vocabulary previously passed straight through even when it was clearly
 * crypto-only, not futures/prop-firm content -- unlike the earlier
 * crypto-only bug above, these posts DO contain a real relevance anchor
 * (that's exactly what let them slip past the first gate).
 */
describe("isPlausiblyTradingRelated -- crypto content sharing futures/trading vocabulary", () => {
  it("rejects a crypto post that also matches a real trading-relevance anchor", () => {
    expect(isPlausiblyTradingRelated("Bitcoin futures liquidated my whole position overnight, brutal leverage lesson")).toBe(false);
    expect(isPlausiblyTradingRelated("My biggest drawdown ever came from an ETH perpetual futures trade")).toBe(false);
    expect(isPlausiblyTradingRelated("Set a stop-loss on my crypto position for once, actually helped")).toBe(false);
  });

  it("rejects other crypto-specific vocabulary paired with a relevance anchor", () => {
    expect(isPlausiblyTradingRelated("This memecoin trading strategy got me liquidated twice this week")).toBe(false);
    expect(isPlausiblyTradingRelated("DeFi trading taught me more about risk management than anything else")).toBe(false);
  });

  it("still passes a crypto-mentioning post when it also has clear prop-firm/manual-discipline content -- same override reasoning as the automated-trading exclusion", () => {
    expect(isPlausiblyTradingRelated("Blew up my funded account trying to revenge trade back losses from a bad crypto futures position")).toBe(true);
    expect(isPlausiblyTradingRelated("Failed my prop firm evaluation -- was overleveraged on BTC futures and hit my daily loss limit")).toBe(true);
  });

  it("still rejects plain crypto speculation with no relevance anchor at all (unchanged baseline behavior)", () => {
    expect(isPlausiblyTradingRelated("$DOGE about to send it, aping in with my last stack")).toBe(false);
  });
});

/**
 * Regression coverage for two more real, confirmed leaks found live
 * (2026-09-17, first fresh prospecting run after the crypto-exclusion
 * fix above): \bcrypto\b never matched the single most common real-world
 * spelling "cryptocurrency" (no word boundary between "crypto" and
 * "currency"), and a coordinated crypto-exchange airdrop spam campaign
 * used the literal phrase "Futures trading" in its own copy specifically
 * to clear the relevance gate.
 */
describe("isPlausiblyTradingRelated -- cryptocurrency spelling and airdrop/KYC spam", () => {
  it("rejects 'cryptocurrency' (not just bare 'crypto') paired with a relevance anchor -- the exact live post that exposed this", () => {
    expect(isPlausiblyTradingRelated("#WEEX is a cryptocurrency exchange offering spot and futures trading.")).toBe(false);
  });

  it("rejects crypto-exchange airdrop/KYC spam even when it explicitly says 'futures trading' -- the exact live post that exposed this", () => {
    expect(
      isPlausiblyTradingRelated(
        "CoinUp's Million CPX Airdrop is now live. Complete the required KYC, deposit and Futures trading tasks to earn CPX. Bring friends through your referral link and you can both unlock extra rewards.",
      ),
    ).toBe(false);
    expect(
      isPlausiblyTradingRelated(
        "Want to earn CPX? CoinUp's Million CPX Airdrop is live from Sep 15-30. Complete KYC, deposit and Futures trading tasks, then invite qualified friends for additional rewards.",
      ),
    ).toBe(false);
  });

  it("bare 'airdrop' and 'KYC' alone are excluding signals even without an exchange name", () => {
    expect(isPlausiblyTradingRelated("Futures trading airdrop live now, don't miss out")).toBe(false);
    expect(isPlausiblyTradingRelated("Complete KYC to start futures trading on our platform")).toBe(false);
  });

  it("does not falsely exclude unrelated words that merely start with 'crypto' (e.g. cryptography)", () => {
    expect(isPlausiblyTradingRelated("Learned some cryptography basics while building a futures trading journal app")).toBe(true);
  });
});

describe("crypto leakage closed 2026-10-04", () => {
  it("rejects posts that use coin names, exchanges, cashtags or on-chain slang with no futures anchor", () => {
    for (const text of [
      "Added to my $WIF position, trading the pump with 20x leverage",
      "Longed SOL on Hyperliquid, my stop-loss got hit, trading is rough",
      "my wallet got liquidated overnight, trader tilt is real",
      "degen trading week: revenge trading on perps again",
      "Binance futures trading drawdown today",
    ]) {
      expect(isPlausiblyTradingRelated(text), text).toBe(false);
    }
  });

  it("keeps futures and prop-firm posts, including futures cashtags", () => {
    expect(isPlausiblyTradingRelated("Blew my funded account on $NQ today after revenge trading. Trailing drawdown is brutal.")).toBe(true);
    expect(isPlausiblyTradingRelated("Prop firm consistency rule hit me again, $ES day")).toBe(true);
    expect(isPlausiblyTradingRelated("Trading journal habit: review every trade, $MNQ size too big")).toBe(true);
  });

  it("wraps each discovery query so the exclusions apply to the whole of an OR", () => {
    expect(withCryptoExclusions('"a" OR "b"')).toBe('("a" OR "b") ' + FUTURES_QUERY_ANCHORS + ' ' + CRYPTO_QUERY_EXCLUSIONS + ' ' + OPTIONS_QUERY_EXCLUSIONS + ' -has:links');
  });
});

describe("newsletters and articles are not conversations (2026-10-04)", () => {
  it("flags the real examples that reached the queue", () => {
    expect(isBroadcastContent("# The Complete Masterclass: Intertwining Futures Trading and Sports Betting Philosophies\n\nWelcome to today's complete session.")).toBe(true);
    expect(isBroadcastContent("The Opening Edge\nSunday Futures Open Outlook\nOctober 4, 2026\n\nTonight's open finds the global macro tape navigating...")).toBe(true);
  });

  it("flags a very long post and thread numbering", () => {
    expect(isBroadcastContent("word ".repeat(200))).toBe(true);
    expect(isBroadcastContent("Why traders blow funded accounts 1/8")).toBe(true);
  });

  it("keeps ordinary conversational posts", () => {
    const post = "He keeps sabotaging progress, cutting winners, holding losers.\n\nLesson: old identity will hunt you. Funded futures trader here, still fighting it.";
    expect(isBroadcastContent(post)).toBe(false);
    expect(isReplyWorthyPost(post)).toBe(true);
    expect(isBroadcastContent("Blew my funded account again on the open. Revenge trading is real.")).toBe(false);
  });

  it("isReplyWorthyPost still rejects off-topic and crypto posts", () => {
    expect(isReplyWorthyPost("Lovely weather today, going for a run")).toBe(false);
    expect(isReplyWorthyPost("Longed SOL on Hyperliquid with 20x leverage, trading is rough")).toBe(false);
  });
});

describe("ads and tiny accounts (2026-10-04)", () => {
  const ads = [
    "Prop trading just got a fight night.\n\n$100K account.\n\n$4K STATIC drawdown.\n\nTop 10% gets PAID.\n\nTrade today. Get paid today. https://t.co/DZszaxgsXy",
    "A huge trading day should not create a payout problem.\n\nThat is why there is NO CONSISTENCY RULE on iFunds instant Funding. Make the profit. Request the payout.\n\nhttps://t.co/daEc0D1kZo",
    "At Rabofund, we reward traders, not lucky days. 2 Steps Classic: 40% consistency rule, clearly explained. Link in bio.",
    "Blowups happen when you break the rules.\n\nProp Firm Compliance tracks your strict limits.\n\nPass the evaluation and secure the funding. https://t.co/IN268yN6Dx",
  ];
  it("flags the prop-firm ads that reached the queue", () => {
    for (const ad of ads) expect(isPromoContent(ad), ad).toBe(true);
  });

  it("keeps real trader posts, including one that ends on a link", () => {
    expect(isPromoContent("Most traders I talk to are actually profitable.\n\nThey just blow one funded account and decide something is broken.")).toBe(false);
    expect(isPromoContent("Yesterday I heard a trader friend keeps cutting winners, holding losers.\n\nLesson: old identity will hunt you.")).toBe(false);
    expect(isReplyWorthyPost("Blew my funded account on the open, trailing drawdown again. Wrote it up here https://t.co/abc")).toBe(true);
  });

  it("drops AI trading-agent hype", () => {
    expect(isReplyWorthyPost("One of the biggest problems with AI agents is proving that they work. Evaluate the trading agent beyond max drawdown.")).toBe(false);
  });

  it("no longer rejects small accounts (2026-10-27: a 30-follower thread gave a reply 10k views); an unknown count is fine", () => {
    expect(MIN_PROSPECT_FOLLOWERS).toBe(0);
    expect(isTooSmallToBeWorthIt(0)).toBe(false);
    expect(isTooSmallToBeWorthIt(30)).toBe(false);
    expect(isTooSmallToBeWorthIt(null)).toBe(false);
  });
});

describe("options posts are excluded like crypto posts (2026-10-24)", () => {
  it("catches the options shapes that used to reach the queue", () => {
    for (const post of [
      "SPY 0DTE calls printing again, theta crush after the open. Trading risk is real.",
      "Selling covered calls on NVDA for weekly income. Good trading psychology matters too.",
      "Iron condor on SPX, max loss defined. Position sizing keeps me in the game as a trader.",
      "Options trading taught me discipline. My drawdown after one bad week was brutal.",
      "Bought TSLA puts and the trade went against me. Revenge trading is a killer.",
      "Credit spreads look safe until implied volatility jumps. Daily loss limit saved me.",
    ]) {
      expect(isOptionsPost(post), post).toBe(true);
      expect(isPlausiblyTradingRelated(post), post).toBe(false);
    }
  });

  it("keeps futures and prop-firm posts, including words options traders also use", () => {
    for (const post of [
      "Hit my daily loss limit again on my funded account. Futures trading discipline is the real edge.",
      "Got a margin call style warning on my ES futures account after sizing up. Drawdown matters.",
      "Contract expiration rollover on NQ futures caught me off guard. Trading plan said to check.",
      "Our prop firm payout was approved after the consistency rule review. Funded trader life.",
    ]) {
      expect(isOptionsPost(post), post).toBe(false);
      expect(isPlausiblyTradingRelated(post), post).toBe(true);
    }
  });

  it("a prop-firm word alone does not rescue an options post; naming futures does", () => {
    expect(isPlausiblyTradingRelated("Blew my funded account trading 0DTE options. The prop firm drawdown rule was unforgiving for any trader.")).toBe(false);
    expect(isPlausiblyTradingRelated("Sold 0DTE options for years, now I trade ES futures on a funded account. The drawdown rule is a different game.")).toBe(true);
  });

  it("the X query exclusions stay under X's 512-character limit for every topic", async () => {
    const { PROSPECTING_TOPICS } = await import("../src/prospecting/prospectingTopics");
    for (const topic of PROSPECTING_TOPICS) expect(withCryptoExclusions(topic.query).length + " -is:retweet -is:reply lang:en".length, topic.key).toBeLessThanOrEqual(512);
  });
});

describe("futures only (2026-10-24)", () => {
  it("rejects forex, stock and generic-trading posts, even prop-firm ones, unless they name futures", () => {
    for (const post of [
      "Passed my FTMO challenge on EURUSD, the pips added up fast. Prop firm life.",
      "Forex trader here, my daily loss limit and drawdown rules keep me honest.",
      "Day trading stocks, my stop loss discipline finally clicked this month.",
      "Trading psychology is everything. Revenge trading cost me again.",
      "Risk management and position sizing separate traders from gamblers.",
    ]) expect(isPlausiblyTradingRelated(post), post).toBe(false);
  });

  it("keeps futures posts and futures prop-firm posts", () => {
    for (const post of [
      "Passed my Topstep combine on MNQ, the trailing drawdown nearly got me.",
      "Funded account payout approved after the consistency rule review.",
      "Revenge trading on ES futures cost me my daily loss limit again.",
      "Apex evaluation reset again. Trailing drawdown is brutal on NQ.",
      "Trading my own money on futures now, no prop firm. Sizing is the hard part.",
    ]) expect(isPlausiblyTradingRelated(post), post).toBe(true);
  });

  it("a forex post that names futures too is kept", () => {
    expect(isPlausiblyTradingRelated("Moved from forex to ES futures, the pips mindset did not transfer. Funded account next.")).toBe(true);
  });
});

describe("whyNotReplyWorthy (2026-10-25 funnel log)", () => {
  const cases: Array<[string, string | null]> = [
    ["Selling covered calls on NVDA for weekly income. Trading risk is real.", "options"],
    ["Passed my FTMO challenge on EURUSD, how do you manage the daily loss limit?", "forex_stock"],
    ["Bitcoin futures leverage liquidations today, what a trading day", "crypto"],
    ["Lovely weather today, going for a run", "not_trading"],
    ["Video later today on how to pass prop firm challenges with a higher success rate", "no_futures_evidence"],
    ["Alhamdulillah a $50K Funded account secured, trading day done", "no_futures_evidence"],
    ["New video out now on how I pass Topstep combines on MNQ futures", "promo"],
    ["Revenge trading cost me my funded NQ futures account again. How do you stop it?", null],
  ];
  for (const [text, expected] of cases) {
    it(`${expected ?? "passes"}: ${text.slice(0, 50)}`, () => {
      const why = whyNotReplyWorthy(text);
      if (expected === "promo") expect(["promo", "sales_funnel", "broadcast"]).toContain(why);
      else expect(why).toBe(expected);
      // The reason must agree with the gate itself.
      expect(isReplyWorthyPost(text)).toBe(expected === null);
    });
  }
});

