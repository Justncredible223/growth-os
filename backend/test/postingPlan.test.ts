import { describe, it, expect } from "vitest";
import { needsDay7Stats } from "../src/posting/postingRepository";
import { assessReplyVisibility, buildPostingPlan, phoenixDate, phoenixInstant, type PlanVideo } from "../src/posting/postingPlan";

// 2026-09-25 10:00 Arizona = 17:00 UTC.
const NOW = new Date("2026-09-25T17:00:00Z");
const video = (id: string, readyAt: string, posts: PlanVideo["posts"] = []): PlanVideo => ({ campaignAssetId: id, videoRenderId: `r-${id}`, title: id, readyAt, posts });

describe("Arizona time helpers", () => {
  it("uses Arizona's fixed UTC-7 for the date and slot instants", () => {
    expect(phoenixDate(new Date("2026-09-26T05:30:00Z"))).toBe("2026-09-25"); // 22:30 Arizona, still the 25th
    expect(phoenixInstant("2026-09-25", "06:30").toISOString()).toBe("2026-09-25T13:30:00.000Z");
    expect(phoenixInstant("2026-09-25", "12:00").toISOString()).toBe("2026-09-25T19:00:00.000Z");
  });
});

describe("buildPostingPlan (one video a day at 12pm Arizona)", () => {
  it("fills the slot with the oldest unposted video, due once the time has passed, and counts the rest as backlog", () => {
    const plan = buildPostingPlan([video("b", "2026-09-24T02:00:00Z"), video("a", "2026-09-23T02:00:00Z"), video("c", "2026-09-25T02:00:00Z"), video("d", "2026-09-25T03:00:00Z")], NOW);
    expect(plan.date).toBe("2026-09-25");
    expect(plan.slots.map((s) => s.video?.campaignAssetId)).toEqual(["a"]);
    // 10:00 Arizona is before the 12:00 slot.
    expect(plan.slots.map((s) => s.status)).toEqual(["upcoming"]);
    expect(plan.slots[0]!.remaining).toEqual(["tiktok", "youtube_shorts", "instagram"]);
    expect(plan.backlog).toBe(3);
    const afterNoon = buildPostingPlan([video("a", "2026-09-23T02:00:00Z")], new Date("2026-09-25T20:00:00Z"));
    expect(afterNoon.slots[0]!.status).toBe("due");
  });

  it("keeps a video posted today in its slot, done once all three platforms are in", () => {
    const posts: PlanVideo["posts"] = [
      { platform: "tiktok", url: "https://tiktok.com/x", postedAt: "2026-09-25T13:40:00Z" },
      { platform: "youtube_shorts", url: "https://youtube.com/shorts/x", postedAt: "2026-09-25T13:42:00Z" },
      { platform: "instagram", url: "https://instagram.com/reel/x", postedAt: "2026-09-25T13:45:00Z" },
    ];
    const plan = buildPostingPlan([video("new", "2026-09-25T01:00:00Z"), video("posted", "2026-09-24T01:00:00Z", posts)], NOW);
    expect(plan.slots[0]).toMatchObject({ status: "done", remaining: [] });
    expect(plan.slots[0]!.video?.campaignAssetId).toBe("posted");
    // The one slot is taken by the video posted today; the new one waits for tomorrow.
    expect(plan.backlog).toBe(1);
  });

  it("shows what's left for a partly posted video", () => {
    const plan = buildPostingPlan([video("p", "2026-09-24T01:00:00Z", [{ platform: "tiktok", url: "https://tiktok.com/x", postedAt: "2026-09-25T13:40:00Z" }])], NOW);
    expect(plan.slots[0]).toMatchObject({ status: "upcoming", remaining: ["youtube_shorts", "instagram"] });
  });

  it("never brings back a video first posted on an earlier day, and leaves slots empty when nothing is ready", () => {
    const old = video("old", "2026-09-20T01:00:00Z", [{ platform: "tiktok", url: "https://tiktok.com/x", postedAt: "2026-09-24T14:00:00Z" }]);
    const plan = buildPostingPlan([old], NOW);
    expect(plan.slots.every((s) => s.status === "empty" && s.video === null)).toBe(true);
    expect(plan.backlog).toBe(0);
  });
});

describe("assessReplyVisibility (X hid the account's replies on 2026-09-24)", () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000);
  const baseline = [96, 120, 150, 200, 260, 300].map((h, i) => ({ createdAt: hoursAgo(h), impressions: [12, 18, 7, 23, 9, 15][i]! }));

  it("flags a drop when recent replies get a fraction of the account's normal views", () => {
    const recent = [20, 30, 40, 50].map((h) => ({ createdAt: hoursAgo(h), impressions: [2, 1, 4, 3][[20, 30, 40, 50].indexOf(h)]! }));
    const v = assessReplyVisibility([...recent, ...baseline], NOW);
    expect(v).toMatchObject({ status: "dropped", recentCount: 4, baselineCount: 6 });
    expect(v.recentMedian).toBe(2.5);
    expect(v.baselineMedian).toBe(13.5);
  });

  it("is ok when recent replies are close to normal", () => {
    const recent = [20, 30, 40].map((h) => ({ createdAt: hoursAgo(h), impressions: 11 }));
    expect(assessReplyVisibility([...recent, ...baseline], NOW).status).toBe("ok");
  });

  it("ignores replies under 12 hours old (still gathering views) and waits for enough data", () => {
    const tooFresh = [1, 2, 3, 4].map((h) => ({ createdAt: hoursAgo(h), impressions: 0 }));
    expect(assessReplyVisibility([...tooFresh, ...baseline], NOW).status).toBe("not_enough_data");
    expect(assessReplyVisibility(baseline.slice(0, 3), NOW).status).toBe("not_enough_data");
  });
});

describe("needsDay7Stats (asks again for the week-old TikTok/Instagram numbers)", () => {
  const posted = "2026-09-18T12:00:00Z";
  const now = new Date("2026-09-26T12:00:00Z");
  it("asks when the typed numbers were taken in the first days and the post is a week old", () => {
    expect(needsDay7Stats("tiktok", posted, { source: "manual", capturedAt: "2026-09-20T12:00:00Z" }, now)).toBe(true);
  });
  it("does not ask for YouTube, API numbers, a younger post, or numbers already taken near day 7", () => {
    expect(needsDay7Stats("youtube_shorts", posted, { source: "manual", capturedAt: "2026-09-20T12:00:00Z" }, now)).toBe(false);
    expect(needsDay7Stats("tiktok", posted, { source: "api", capturedAt: "2026-09-20T12:00:00Z" }, now)).toBe(false);
    expect(needsDay7Stats("tiktok", "2026-09-22T12:00:00Z", { source: "manual", capturedAt: "2026-09-23T12:00:00Z" }, now)).toBe(false);
    expect(needsDay7Stats("tiktok", posted, { source: "manual", capturedAt: "2026-09-25T12:00:00Z" }, now)).toBe(false);
    expect(needsDay7Stats("instagram", posted, null, now)).toBe(false);
  });
});
