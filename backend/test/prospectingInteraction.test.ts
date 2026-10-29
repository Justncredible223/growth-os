import { describe, it, expect } from "vitest";
import { BURIED_AT_REPLIES, QUOTE_MIN_IMPRESSIONS, suggestInteraction } from "../src/prospecting/prospectingInteraction";
import { scoreProspectingCandidate } from "../src/prospecting/prospectingScoring";
import { replyReachSection, type OwnPostRow, type ReplyTargetByCandidate } from "../src/posting/weeklyDigest";
import type { ProspectingTopic } from "../src/prospecting/prospectingTopics";

const base = { followers: 5000, replyCount: 3, impressionCount: 400 };

describe("suggestInteraction", () => {
  it("answers a question with one rule or number", () => {
    const s = suggestInteraction({ ...base, postText: "How do you handle the trailing drawdown on a Topstep funded account trading MNQ?" });
    expect([s.action, s.angleKind]).toEqual(["reply", "answer"]);
  });

  it("acknowledges a loss or breach in one line, then the rule", () => {
    const s = suggestInteraction({ ...base, postText: "Blew my funded account today after the daily loss limit hit on NQ. Back to the eval." });
    expect([s.action, s.angleKind]).toEqual(["reply", "loss"]);
    expect(s.angle).toMatch(/one line/);
  });

  it("checks the math on a post with numbers", () => {
    const s = suggestInteraction({ ...base, postText: "Made $1,788 on Monday and the rest of the week was $85. Futures is a grind." });
    expect([s.action, s.angleKind]).toEqual(["reply", "math"]);
  });

  it("falls back to adding one detail", () => {
    const s = suggestInteraction({ ...base, postText: "Honestly the hardest part of trading a funded account is waiting for the setup to come to you." });
    expect([s.action, s.angleKind]).toEqual(["reply", "detail"]);
  });

  it("suggests only engaging with a buried thread or a post with too little to answer", () => {
    expect(suggestInteraction({ ...base, replyCount: BURIED_AT_REPLIES, postText: "What is your daily loss limit on a 50K combine and how do you size it?" }).action).toBe("engage");
    expect(suggestInteraction({ ...base, postText: "Green day on NQ." }).action).toBe("engage");
  });

  it("suggests a quote only for a travelling statement with numbers", () => {
    const post = "A 40% consistency rule means a $1,200 day caps your total profit at $3,000 before a payout. Read yours.";
    const small = { ...base, followers: 400 };
    expect(suggestInteraction({ ...small, impressionCount: QUOTE_MIN_IMPRESSIONS * 5, postText: post }).action).toBe("quote");
    expect(suggestInteraction({ ...small, impressionCount: 900, postText: post }).action).toBe("reply");
    expect(suggestInteraction({ ...small, followers: 900_000, impressionCount: QUOTE_MIN_IMPRESSIONS * 5, postText: post }).action).toBe("reply");
    expect(suggestInteraction({ ...small, impressionCount: QUOTE_MIN_IMPRESSIONS * 5, postText: post + " Does yours?" }).action).toBe("reply");
  });
});

describe("the score breakdown carries the suggestion", () => {
  const topic: ProspectingTopic = { key: "futures_trader", query: '"futures trader"', label: "Futures trader", replyClass: "C" };
  it("adds the action, the angle and its kind", () => {
    const r = scoreProspectingCandidate({
      topic,
      postText: "How do you size up after two green days on a funded NQ futures account?",
      postCreatedAt: new Date("2026-10-28T17:00:00Z"),
      publicMetrics: {},
      authorFollowerCount: 5000,
      authorVerified: false,
      previouslyEngaged: false,
      now: new Date("2026-10-28T18:00:00Z"),
    });
    expect(r.breakdown.suggestedAction).toBe("reply");
    expect(r.breakdown.angleKind).toBe("answer");
    expect(r.breakdown.suggestedAngle).toMatch(/Answer the question/);
  });
});

describe("weekly review groups replies by the suggested angle", () => {
  it("shows a median per angle kind once a group has enough replies", () => {
    const posts: OwnPostRow[] = [];
    const targets: ReplyTargetByCandidate = new Map();
    [10, 20, 30].forEach((views, i) => {
      posts.push({ tweetId: `t${i}`, kind: "reply", text: "x", createdAt: "2026-10-28T20:00:00Z", impressions: views, prospectingCandidateId: `c${i}` });
      targets.set(`c${i}`, { authorFollowers: 5000, postCreatedAt: "2026-10-28T19:30:00Z", angleKind: "answer", suggestedAction: "reply" });
    });
    const lines = replyReachSection(posts, targets)!.join("\n");
    expect(lines).toMatch(/replies that answered a question: 3 replies, median 20 views/);
    expect(lines).not.toMatch(/replies that checked the math/);
  });
});
