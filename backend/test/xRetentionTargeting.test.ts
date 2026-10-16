import { describe, it, expect } from "vitest";
import { FEED_POST_CATEGORY_TARGETS } from "../src/content/dailyXFeedPost";
import { HUMAN_POST_VOICE_RULES } from "../src/content/humanReplyVoice";
import { AGENT_SYSTEM_PROMPTS } from "../src/content/reviewAgents";
import { MIN_DAILY_SET_SCORE } from "../src/prospecting/prospectingDailySelection";
import { scoreProspectingCandidate } from "../src/prospecting/prospectingScoring";
import { PROSPECTING_TOPICS } from "../src/prospecting/prospectingTopics";

/**
 * 2026-10-15 growth audit: the account keeps losing followers. The X feed was 55% product pitch with a forced tie-in on
 * every post, and cold replies were ranked by raw reach under crowded threads. These pin the corrected shape.
 */
describe("X feed mix", () => {
  it("sums to 100% and no longer makes product and cta the majority", () => {
    const total = Object.values(FEED_POST_CATEGORY_TARGETS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(FEED_POST_CATEGORY_TARGETS.product_demo + FEED_POST_CATEGORY_TARGETS.cta).toBeLessThanOrEqual(0.4);
    expect(FEED_POST_CATEGORY_TARGETS.education + FEED_POST_CATEGORY_TARGETS.psychology).toBeGreaterThanOrEqual(0.5);
  });

  it("does not require a product clause on education, psychology or conversation posts", () => {
    expect(HUMAN_POST_VOICE_RULES).toMatch(/education, psychology or conversation_starter post does\s+not have to/);
  });

  it("keeps the growth reviewer from failing a post for having no product mention", () => {
    expect(AGENT_SYSTEM_PROMPTS.growth_strategist).toMatch(/does NOT need a product mention and must not be failed/);
    expect(AGENT_SYSTEM_PROMPTS.growth_strategist).not.toMatch(/35% product functionality/);
  });
});

describe("cold reply targeting", () => {
  const now = new Date("2026-10-15T20:00:00Z");
  const topic = PROSPECTING_TOPICS[0]!;
  const base = (over: Record<string, unknown>) =>
    scoreProspectingCandidate({
      topic,
      postText: "Blew another eval on a size-up after two losses. Same story every time, same lesson ignored.",
      authorFollowerCount: 5_000,
      authorVerified: false,
      postCreatedAt: new Date(now.getTime() - 60 * 60 * 1000),
      publicMetrics: { reply_count: 3, quote_count: 0, like_count: 8 },
      now,
      ...over,
    } as any);

  it("a thread with 30 replies already costs points, where it used to be free until 100", () => {
    const quiet = base({ publicMetrics: { reply_count: 3, quote_count: 0, like_count: 8 } });
    const busy = base({ publicMetrics: { reply_count: 30, quote_count: 0, like_count: 8 } });
    expect(busy.breakdown.crowdedThread).toBeDefined();
    expect(quiet.breakdown.crowdedThread).toBeUndefined();
  });

  it("penalties step up with the thread's size", () => {
    const pen = (n: number) => {
      const s = base({ publicMetrics: { reply_count: n, quote_count: 0, like_count: 0 } });
      return Number((s.breakdown.crowdedThread ?? "").match(/-(\d+)/)?.[1] ?? 0);
    };
    expect([pen(10), pen(30), pen(60), pen(150), pen(400)]).toEqual([0, 5, 10, 18, 25]);
  });

  it("an account of 1k to 30k followers gets a bonus that a tiny or a huge one does not", () => {
    expect(base({ authorFollowerCount: 5_000 }).breakdown.midSizedAccount).toBeDefined();
    expect(base({ authorFollowerCount: 200 }).breakdown.midSizedAccount).toBeUndefined();
    expect(base({ authorFollowerCount: 400_000 }).breakdown.midSizedAccount).toBeUndefined();
  });

  it("raises the bar a post must clear before it is offered at all", () => {
    expect(MIN_DAILY_SET_SCORE).toBeGreaterThanOrEqual(45);
  });
});
