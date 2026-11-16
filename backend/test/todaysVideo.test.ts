import { describe, it, expect } from "vitest";
import { dayForTitle, describeTodaysVideo, type TodaysVideoInput } from "../src/video/todaysVideo";
import { manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept";
import { OFFERED_DAILY_CONCEPT_IDS, dailyPosition } from "../src/shortform/motionPlans";
import { listMotionConcepts } from "../scripts/video-factory/motionCatalog";

const START = "2026-10-04T04:00:00.000Z"; // midnight Eastern, Oct 4
const concept = listMotionConcepts().find((c) => c.id === "after-19-trailing-floor")!;
const THESIS = manualMotionConceptTitle(concept);

const input = (patch: Partial<TodaysVideoInput> = {}): TodaysVideoInput => ({
  pendingTitles: [],
  latest: { thesis: THESIS, status: "approved", createdAt: "2026-10-04T13:00:00.000Z" },
  render: null,
  platformsPosted: [],
  startOfToday: START,
  ...patch,
});

describe("the daily video's state for the Home card", () => {
  it("is 'none' when nothing has been requested", () => {
    const v = describeTodaysVideo(input({ latest: null }));
    expect(v.state).toBe("none");
    expect(v.title).toBeNull();
    expect(v.detail).toMatch(/Request today's video in Video Status/);
  });

  it("is 'drafting' while a request is queued or running, ahead of anything else", () => {
    const v = describeTodaysVideo(input({ pendingTitles: [THESIS], latest: { thesis: "x", status: "approved", createdAt: START } }));
    expect(v.state).toBe("drafting");
    expect(v.title).toBe("After the trade: trailing drawdown explained: how the floor moves");
    expect(v.day).toBe(dailyPosition("after-19-trailing-floor") + 1);
  });

  it("is 'needs_approval' when the script is waiting in Approvals", () => {
    const v = describeTodaysVideo(input({ latest: { thesis: THESIS, status: "in_review", createdAt: START } }));
    expect(v.state).toBe("needs_approval");
    expect(v.headline).toBe("Waiting for your approval");
  });

  it("is 'rendering' for an approved script whose render is queued or running", () => {
    for (const render of [{ status: "queued", error: null }, { status: "rendering", error: null }]) {
      expect(describeTodaysVideo(input({ render })).state).toBe("rendering");
    }
  });

  it("P1 2026-11-15: an approved script with no render row says so instead of 'Rendering' forever", () => {
    const v = describeTodaysVideo(input({ render: null }));
    expect(v.state).toBe("none");
    expect(v.headline).toBe("No render yet");
  });

  it("is 'ready' for a finished render with no post links yet", () => {
    const v = describeTodaysVideo(input({ render: { status: "ready", error: null } }));
    expect(v.state).toBe("ready");
    expect(v.detail).toMatch(/Download it in Video Status/);
  });

  it("P1 2026-11-15: is 'Partly posted' (still to finish) until every platform has a link", () => {
    const v = describeTodaysVideo(input({ render: { status: "ready", error: null }, platformsPosted: ["tiktok", "youtube_shorts"] }));
    expect(v.state).toBe("ready");
    expect(v.headline).toBe("Partly posted");
    expect(v.detail).toBe("Posted on TikTok, YouTube. Post it to the other 1 and paste the links in Video Status.");
    expect(v.platformsPosted).toEqual(["tiktok", "youtube_shorts"]);
  });

  it("is 'posted' once all three platforms have a link", () => {
    const v = describeTodaysVideo(input({ render: { status: "ready", error: null }, platformsPosted: ["tiktok", "youtube_shorts", "instagram"] }));
    expect(v.state).toBe("posted");
    expect(v.detail).toBe("Posted on 3 of 3: TikTok, YouTube, Instagram.");
  });

  it("does not call an earlier day's fully posted video today's", () => {
    const v = describeTodaysVideo(input({ latest: { thesis: THESIS, status: "approved", createdAt: "2026-10-03T13:00:00.000Z" }, render: { status: "ready", error: null }, platformsPosted: ["tiktok", "youtube_shorts", "instagram"] }));
    expect(v.state).toBe("none");
    expect(v.detail).toContain("Last video: After the trade: trailing drawdown explained: how the floor moves");
  });

  it("still shows an earlier day's video that is rendered but not posted yet", () => {
    const v = describeTodaysVideo(input({ latest: { thesis: THESIS, status: "approved", createdAt: "2026-10-03T13:00:00.000Z" }, render: { status: "ready", error: null } }));
    expect(v.state).toBe("ready");
  });

  it("is 'failed' with the reason, trimmed", () => {
    const v = describeTodaysVideo(input({ render: { status: "failed", error: "x".repeat(500) } }));
    expect(v.state).toBe("failed");
    expect(v.detail.length).toBeLessThan(170);
    expect(describeTodaysVideo(input({ render: { status: "failed", error: null } })).detail).toMatch(/did not finish/);
  });

  it("treats a canceled render as nothing in play", () => {
    expect(describeTodaysVideo(input({ render: { status: "canceled", error: null } })).state).toBe("none");
  });
});

describe("finding a request's day", () => {
  it("maps every offered concept's request title to its day", () => {
    OFFERED_DAILY_CONCEPT_IDS.forEach((id, i) => {
      const c = listMotionConcepts().find((x) => x.id === id)!;
      expect(dayForTitle(manualMotionConceptTitle(c)), id).toBe(i + 1);
    });
  });

  it("returns null for a title that is not a daily concept", () => {
    expect(dayForTitle("Motion concept request: something else")).toBeNull();
  });
});
