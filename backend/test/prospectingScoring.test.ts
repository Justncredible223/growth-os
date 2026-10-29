import { describe, it, expect } from "vitest";
import { scoreProspectingCandidate, recencyPointsForAge } from "../src/prospecting/prospectingScoring";
import { MIN_DAILY_SET_SCORE } from "../src/prospecting/prospectingDailySelection";
import type { ProspectingTopic } from "../src/prospecting/prospectingTopics";

const topic: ProspectingTopic = { key: "trading_journal", query: '"trading journal"', label: "Trading journal", replyClass: "A" };
const now = new Date("2026-09-01T12:00:00Z");

function baseInput(overrides: Partial<Parameters<typeof scoreProspectingCandidate>[0]> = {}) {
  return {
    topic,
    postText: "How do you actually review your trades at the end of the week?",
    postCreatedAt: now,
    publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3 },
    authorFollowerCount: 500,
    authorVerified: false,
    previouslyEngaged: false,
    now,
    ...overrides,
  };
}

describe("scoreProspectingCandidate", () => {
  it("excludes hashtag-stuffed/listicle-formatted posts (found live: a bot account scored 65+ before this check)", () => {
    const result = scoreProspectingCandidate(
      baseInput({
        postText: "What's your best pair?\n\n.\n.\n.\n.\n\nforex trading tips\nforex trading psychology\nforex risk management\nforex market structure",
      }),
    );
    expect(result.excluded).toBe(true);
  });

  it("excludes prop-firm discount-ad formatting (found live: scored 59+ before this check)", () => {
    const result = scoreProspectingCandidate(
      baseInput({
        postText: "Get a 1 Step $100K Nano Account for only $240:\n\n💰 10% Profit Target\n📉 4% Max Daily Loss\n🛡️ No time limit",
      }),
    );
    expect(result.excluded).toBe(true);
  });

  it("does NOT exclude a trader who writes one unpunctuated sentence per line (found live 2026-10-28: dropped as spam every day)", () => {
    const result = scoreProspectingCandidate(
      baseInput({
        postText: ["Prop firm question for the timeline", "What blows more funded accounts", "Oversizing one setup", "Or revenge trading after the loss", "Futures traders, which one is it?"].join("\n"),
      }),
    );
    expect(result.excluded).toBe(false);
  });

  it("does NOT exclude a real conversational multi-line post (periods/questions, not short tag fragments)", () => {
    const result = scoreProspectingCandidate(
      baseInput({
        postText:
          "Two trading bots. Same strategy, same signals, the same 60% win rate. One runs 3x leverage. The other runs none. A year later, the results tell a very different story.",
      }),
    );
    expect(result.excluded).toBe(false);
  });

  it("excludes obvious spam/signal-selling posts outright, not just down-ranks them", () => {
    const result = scoreProspectingCandidate(baseInput({ postText: "DM me for signals, 100% win rate guaranteed!!!" }));
    expect(result.excluded).toBe(true);
    expect(result.score).toBe(0);
    expect(result.exclusionReason).toMatch(/spam/i);
  });

  it("REVISED (2026-09-16, explicit owner direction): reach now weighs enough that a large quiet account can outrank a small engaged one -- 'it's more likely people will see our replies and check us out.' Still log-scaled/capped, never a bare follower-count ranking -- see the next test for the engagement gap that still isn't erased by reach alone.", () => {
    const smallButRelevant = scoreProspectingCandidate(
      baseInput({ authorFollowerCount: 200, publicMetrics: { reply_count: 10, quote_count: 2, like_count: 40 } }),
    );
    const bigButQuiet = scoreProspectingCandidate(
      baseInput({ authorFollowerCount: 500_000, publicMetrics: { reply_count: 0, quote_count: 0, like_count: 0 } }),
    );
    expect(bigButQuiet.score).toBeGreaterThan(smallButRelevant.score);
  });

  it("a small account's own strong engagement can still close most of a reach gap against a similarly-quiet large account", () => {
    const smallEngaged = scoreProspectingCandidate(
      baseInput({ authorFollowerCount: 200, publicMetrics: { reply_count: 10, quote_count: 2, like_count: 40 } }),
    );
    const largeEngaged = scoreProspectingCandidate(
      baseInput({ authorFollowerCount: 500_000, publicMetrics: { reply_count: 10, quote_count: 2, like_count: 40 } }),
    );
    // Same engagement either way -- the large account still wins on reach alone, but a small account is never locked out of a strong score.
    expect(largeEngaged.score).toBeGreaterThan(smallEngaged.score);
    expect(smallEngaged.score).toBeGreaterThanOrEqual(MIN_DAILY_SET_SCORE);
  });

  it("REFINED (2026-09-07 freshness/audience-quality review): a very-low-follower account is not hard-excluded -- a genuinely relevant, engaged post from a near-zero-follower account can still clear MIN_DAILY_SET_SCORE", () => {
    const tinyAccount = scoreProspectingCandidate(
      baseInput({
        authorFollowerCount: 3,
        publicMetrics: { reply_count: 8, quote_count: 1, like_count: 20 },
        postText: "How do you actually decide when to cut a losing trade instead of hoping it comes back?",
      }),
    );
    expect(tinyAccount.excluded).toBe(false);
    expect(tinyAccount.score).toBeGreaterThanOrEqual(MIN_DAILY_SET_SCORE);
  });

  it("follower count meaningfully moves the score -- still log-scaled and capped (never a bare follower-count ranking), but no longer a minor nudge -- see this file's REVISED reach-weight test above", () => {
    const zeroFollowers = scoreProspectingCandidate(baseInput({ authorFollowerCount: 0 }));
    const hundredKFollowers = scoreProspectingCandidate(baseInput({ authorFollowerCount: 100_000 }));
    expect(hundredKFollowers.score).toBeGreaterThan(zeroFollowers.score); // it does influence ranking...
    expect(hundredKFollowers.score - zeroFollowers.score).toBeLessThanOrEqual(35); // ...bounded by the capped reach-points range, never unlimited
  });

  it("caps author-reach points regardless of how large the follower count is", () => {
    const huge = scoreProspectingCandidate(baseInput({ authorFollowerCount: 50_000_000 }));
    const large = scoreProspectingCandidate(baseInput({ authorFollowerCount: 1_000_000 }));
    // Reach is log-scaled and capped -- a 50x larger following shouldn't move the score much.
    expect(huge.score - large.score).toBeLessThan(5);
  });

  it("scores a post asking a real question higher than a same-topic post with no question and little context", () => {
    const withQuestion = scoreProspectingCandidate(baseInput({ postText: "How do you actually review your trades at the end of the week?" }));
    const withoutQuestion = scoreProspectingCandidate(baseInput({ postText: "journal" }));
    expect(withQuestion.score).toBeGreaterThan(withoutQuestion.score);
  });

  it("gives a bonus for a previously-engaged author, but it alone cannot flip exclusion", () => {
    const engaged = scoreProspectingCandidate(baseInput({ previouslyEngaged: true }));
    const notEngaged = scoreProspectingCandidate(baseInput({ previouslyEngaged: false }));
    expect(engaged.score).toBeGreaterThan(notEngaged.score);

    const stillSpam = scoreProspectingCandidate(baseInput({ previouslyEngaged: true, postText: "click the link in my bio for free signals" }));
    expect(stillSpam.excluded).toBe(true);
  });

  it("never returns a score outside 0-100", () => {
    const result = scoreProspectingCandidate(
      baseInput({ authorFollowerCount: 10_000_000, authorVerified: true, publicMetrics: { reply_count: 100_000, quote_count: 50_000, like_count: 1_000_000 } }),
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("includes a human-readable breakdown for every scored (non-excluded) candidate", () => {
    const result = scoreProspectingCandidate(baseInput());
    expect(result.excluded).toBe(false);
    expect(Object.keys(result.breakdown)).toEqual(
      expect.arrayContaining(["topicRelevance", "activeDiscussion", "authorReach", "recency", "authenticity", "valueOpportunity", "priorRelationship"]),
    );
  });
});

describe("scoreProspectingCandidate -- reach review (2026-09-21)", () => {
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("a 1-hour-old post outranks an otherwise identical 20-hour-old post by a real margin", () => {
    const fresh = scoreProspectingCandidate(baseInput({ postCreatedAt: hoursAgo(1) }));
    const older = scoreProspectingCandidate(baseInput({ postCreatedAt: hoursAgo(20) }));
    expect(fresh.score - older.score).toBeGreaterThanOrEqual(10);
  });

  it("recency steps down as a post ages", () => {
    const pts = (h: number) => recencyPointsForAge(h * 3_600_000);
    expect([pts(0.5), pts(2), pts(5), pts(10), pts(20), pts(48), pts(100)]).toEqual([25, 20, 15, 10, 6, 3, 1]);
  });

  it("penalizes a thread that already has hundreds of replies, since a new reply would be buried", () => {
    const quiet = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 20, quote_count: 0, like_count: 10 } }));
    const crowded = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 400, quote_count: 0, like_count: 10 } }));
    expect(crowded.breakdown.crowdedThread).toContain("buried");
    expect(quiet.breakdown.crowdedThread).toBeUndefined();
    expect(crowded.score).toBeLessThan(quiet.score);
  });

  it("does not penalize a large account with a fresh, quiet post, which is still the best case", () => {
    const bigFresh = scoreProspectingCandidate(baseInput({ authorFollowerCount: 500_000, postCreatedAt: hoursAgo(0.5), publicMetrics: { reply_count: 2, quote_count: 0, like_count: 5 } }));
    expect(bigFresh.breakdown.crowdedThread).toBeUndefined();
    expect(bigFresh.score).toBeGreaterThan(70);
  });
});

describe("thread traffic (2026-10-24)", () => {
  it("a post that already has impressions outscores the same post with none, capped at +10", () => {
    const quiet = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3 } }));
    const seen = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3, impression_count: 400 } }));
    const huge = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3, impression_count: 5_000_000 } }));
    expect(seen.score).toBeGreaterThan(quiet.score);
    expect(seen.breakdown.threadTraffic).toMatch(/400 impressions/);
    expect(huge.breakdown.threadTraffic).toMatch(/capped at 10/);
    expect(quiet.breakdown.threadTraffic).toBeUndefined();
  });

  it("a thread seen by 10x its author's followers gets the breakout bonus (+12), a normal one does not", () => {
    const small = baseInput({ authorFollowerCount: 30, publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3, impression_count: 5_000 } });
    const breakout = scoreProspectingCandidate(small);
    const normal = scoreProspectingCandidate(baseInput({ authorFollowerCount: 30_000, publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3, impression_count: 5_000 } }));
    expect(breakout.breakdown.breakoutThread).toMatch(/\+12/);
    expect(normal.breakdown.breakoutThread).toBeUndefined();
  });

  it("a post with no impression count reported is not penalised", () => {
    const a = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3 } }));
    const b = scoreProspectingCandidate(baseInput({ publicMetrics: { reply_count: 1, quote_count: 0, like_count: 3, impression_count: 0 } }));
    expect(b.score).toBe(a.score);
  });
});

