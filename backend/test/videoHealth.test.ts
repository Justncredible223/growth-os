import { describe, it, expect } from "vitest";
import { assessVideoLoop, type VideoHealthInput } from "../src/video/videoHealth";

const now = new Date("2026-10-04T18:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600000).toISOString();
const base = (over: Partial<VideoHealthInput> = {}): VideoHealthInput => ({
  now,
  renders: [],
  postedAssetIds: [],
  youtubePostCount: 0,
  lastYoutubeStatsAt: null,
  publishingFlagsOn: [],
  postingTablesExist: true,
  ...over,
});
const render = (id: string, status: string, createdHoursAgo: number, updatedHoursAgo = createdHoursAgo) => ({ id, campaignAssetId: `a-${id}`, status, createdAt: ago(createdHoursAgo), updatedAt: ago(updatedHoursAgo) });
const item = (items: ReturnType<typeof assessVideoLoop>, label: string) => items.find((i) => i.label === label);

describe("assessVideoLoop", () => {
  it("is healthy when renders are fine and the flags are off", () => {
    const items = assessVideoLoop(base({ renders: [render("1", "ready", 5, 5)], postedAssetIds: ["a-1"] }));
    expect(items.every((i) => i.status === "HEALTHY")).toBe(true);
  });

  it("flags failed renders this week, and a stuck queue as down", () => {
    expect(item(assessVideoLoop(base({ renders: [render("1", "failed", 5), render("2", "ready", 6)] })), "Video rendering")).toMatchObject({ status: "DEGRADED" });
    expect(item(assessVideoLoop(base({ renders: [render("1", "queued", 3, 3)] })), "Video rendering")).toMatchObject({ status: "DOWN" });
    expect(item(assessVideoLoop(base({ renders: [render("1", "queued", 0.2, 0.2)] })), "Video rendering")).toMatchObject({ status: "HEALTHY" });
  });

  it("flags a finished video with no post link after two days, but not a fresh one or one that was posted", () => {
    expect(item(assessVideoLoop(base({ renders: [render("1", "ready", 80, 80)] })), "Video posting")).toMatchObject({ status: "DEGRADED" });
    expect(item(assessVideoLoop(base({ renders: [render("1", "ready", 20, 20)] })), "Video posting")).toMatchObject({ status: "HEALTHY" });
    expect(item(assessVideoLoop(base({ renders: [render("1", "ready", 80, 80)], postedAssetIds: ["a-1"] })), "Video posting")).toMatchObject({ status: "HEALTHY" });
  });

  it("flags YouTube numbers that stopped syncing", () => {
    expect(item(assessVideoLoop(base({ youtubePostCount: 2, lastYoutubeStatsAt: ago(100) })), "YouTube stats")).toMatchObject({ status: "DEGRADED" });
    expect(item(assessVideoLoop(base({ youtubePostCount: 2, lastYoutubeStatsAt: null })), "YouTube stats")).toMatchObject({ status: "DEGRADED" });
    expect(item(assessVideoLoop(base({ youtubePostCount: 2, lastYoutubeStatsAt: ago(5) })), "YouTube stats")).toMatchObject({ status: "HEALTHY" });
    expect(item(assessVideoLoop(base()), "YouTube stats")).toBeUndefined();
  });

  it("warns when an auto-publish flag is on", () => {
    expect(item(assessVideoLoop(base({ publishingFlagsOn: ["TIKTOK_PUBLISHING_ENABLED"] })), "Auto-publishing")).toMatchObject({ status: "DEGRADED" });
  });

  it("says posting isn't set up when the tables are missing", () => {
    const items = assessVideoLoop(base({ postingTablesExist: false }));
    expect(item(items, "Video posting")).toMatchObject({ status: "NOT_CONNECTED" });
    expect(item(items, "YouTube stats")).toBeUndefined();
  });
});
