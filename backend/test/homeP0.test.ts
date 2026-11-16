import { describe, it, expect } from "vitest";
import { markPostedDateProblem } from "../api/summary";
import { applyPostingPlan, type TodaysVideo } from "../src/video/todaysVideo";
import { buildPostingPlan, type PlanVideo } from "../src/posting/postingPlan";
import { deriveTodayXPostView, MAX_ATTEMPTS_PER_DAY, type XFeedPostRun } from "../src/content/dailyXFeedPost";

describe("prior-day Mark posted (P0 2026-11-15)", () => {
  it("allows today and up to 7 days back, refuses the future, older days and bad dates", () => {
    expect(markPostedDateProblem("2026-11-15", "2026-11-15")).toBeNull();
    expect(markPostedDateProblem("2026-11-14", "2026-11-15")).toBeNull(); // after midnight, yesterday's draft
    expect(markPostedDateProblem("2026-11-08", "2026-11-15")).toBeNull();
    expect(markPostedDateProblem("2026-11-07", "2026-11-15")).toMatch(/last 7 days/);
    expect(markPostedDateProblem("2026-11-16", "2026-11-15")).toMatch(/hasn't happened/);
    expect(markPostedDateProblem("11/14/2026", "2026-11-15")).toMatch(/YYYY-MM-DD/);
  });
});

describe("Home video card follows the posting plan (P0 2026-11-15)", () => {
  const NOW = new Date("2026-11-15T17:00:00Z"); // 10:00 Arizona
  const none: TodaysVideo = { state: "none", title: null, day: null, headline: "No video yet today", detail: "", platformsPosted: [] };
  const v = (posts: PlanVideo["posts"]): PlanVideo => ({ campaignAssetId: "a", videoRenderId: "r", title: "Break and retest", readyAt: "2026-11-11T10:00:00Z", posts });

  it("shows yesterday's partly posted video instead of 'No video yet today'", () => {
    const plan = buildPostingPlan([v([{ platform: "tiktok", url: "https://tiktok.com/x", postedAt: "2026-11-15T05:00:00Z" }])], NOW);
    const card = applyPostingPlan(none, plan)!;
    expect(card).toMatchObject({ state: "ready", headline: "Partly posted", title: "Break and retest", platformsPosted: ["tiktok"] });
    expect(card.detail).toContain("Still to post: YouTube, Instagram");
  });

  it("says it is waiting for YouTube, with when, rather than posted everywhere", () => {
    const posts: PlanVideo["posts"] = [
      { platform: "tiktok", url: "https://tiktok.com/x", postedAt: "2026-11-15T16:00:00Z" },
      { platform: "instagram", url: "https://instagram.com/x", postedAt: "2026-11-15T16:05:00Z" },
    ];
    const card = applyPostingPlan(none, buildPostingPlan([v(posts)], NOW, "2026-11-14T19:00:00Z"))!;
    expect(card.headline).toBe("Waiting for YouTube");
    expect(card.detail).toContain("YouTube opens");
  });

  it("keeps pipeline states that need the owner, and the card as is when the plan is empty or missing", () => {
    const needs: TodaysVideo = { ...none, state: "needs_approval", headline: "Waiting for your approval" };
    const plan = buildPostingPlan([v([])], NOW);
    expect(applyPostingPlan(needs, plan)).toBe(needs);
    expect(applyPostingPlan(none, buildPostingPlan([], NOW))).toBe(none);
    expect(applyPostingPlan(none, null)).toBe(none);
  });
});

describe("Regenerate after a dismissed draft (P0 2026-11-15)", () => {
  const run = (attempts: number): XFeedPostRun => ({
    id: "1", operatingDate: "2026-11-15", status: "ready", campaignAssetId: "a", topicKey: null, triedTopicKeys: [], attempts, aiCalls: 0, costUsd: 0,
    error: null, postedAt: null, updatedAt: "2026-11-15T17:00:00Z", editorialTags: [], selectionReason: null, postedText: null,
  });
  it("offers a new draft only while attempts are left, and says why not otherwise", () => {
    expect(deriveTodayXPostView(run(1), "ready_for_owner", true, null).canRegenerate).toBe(true);
    const used = deriveTodayXPostView(run(MAX_ATTEMPTS_PER_DAY), "ready_for_owner", true, null);
    expect(used.canRegenerate).toBe(false);
    expect(used.reason).toBeTruthy();
  });
});
