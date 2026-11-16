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

import { summarizeStepFailures } from "../src/jobs/stepFailures";
import { describeTodaysVideo } from "../src/video/todaysVideo";

describe("Home P1 (2026-11-15)", () => {
  it("groups failed scheduled steps by step, newest first", () => {
    const rows = [
      { created_at: "2026-11-15T10:00:00Z", reason: "old", context: { job: "growth-pulse", step: "x_inbound" } },
      { created_at: "2026-11-15T16:00:00Z", reason: "newest", context: { job: "growth-pulse", step: "x_inbound" } },
      { created_at: "2026-11-15T12:00:00Z", reason: "other", context: { job: "daily-pipeline", step: "auto_draft" } },
      { created_at: "2026-11-15T13:00:00Z", reason: "no step", context: {} },
    ];
    const out = summarizeStepFailures(rows);
    expect(out.map((f) => f.step)).toEqual(["x_inbound", "auto_draft"]);
    expect(out[0]).toMatchObject({ count: 2, lastDetail: "newest" });
  });

  it("shows a failed draft on the video card unless a newer script exists", () => {
    const base = { pendingTitles: [], render: null, platformsPosted: [], startOfToday: "2026-11-15T07:00:00Z" };
    const failedDraft = { title: "Break and retest", error: "reviewer timed out", at: "2026-11-15T18:00:00Z" };
    expect(describeTodaysVideo({ ...base, latest: null, failedDraft })).toMatchObject({ state: "failed", headline: "Draft failed" });
    const newer = { thesis: "x", status: "in_review", createdAt: "2026-11-15T19:00:00Z" };
    expect(describeTodaysVideo({ ...base, latest: newer, failedDraft }).state).toBe("needs_approval");
  });
});

describe("fully posted video whose render was cleaned up", () => {
  it("is not reported as a missing render", () => {
    const input = {
      pendingTitles: [], render: null, startOfToday: "2026-11-15T07:00:00Z",
      latest: { thesis: "Supply and demand", status: "approved", createdAt: "2026-11-14T10:00:00Z" },
      platformsPosted: ["tiktok", "youtube_shorts", "instagram"],
    };
    expect(describeTodaysVideo(input).headline).toBe("No video yet today");
    expect(describeTodaysVideo({ ...input, platformsPosted: [] }).headline).toBe("No render yet");
  });
});
