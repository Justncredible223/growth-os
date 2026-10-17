import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordVideoPost } from "../src/posting/postingRepository";
import { FakeSupabaseClient } from "./helpers/fakeSupabase";

/**
 * The posting plan's three per-platform links replaced the Video Status screen's single "I posted this" field
 * (2026-09-26), so saving one must also feed what that field fed: content_publications, and for YouTube,
 * video_renders.published_url.
 */
function setup() {
  const fake = new FakeSupabaseClient({
    campaign_assets: [{ id: "asset-1", campaigns: { thesis: "What does moving your stop cost?" } }],
    video_renders: [{ id: "render-1", campaign_asset_id: "asset-1", status: "ready", published_url: null }],
  });
  return { fake, client: fake as unknown as SupabaseClient };
}

describe("recordVideoPost keeps the old published-link consumers fed", () => {
  it("a YouTube link lands in video_posts, content_publications and video_renders.published_url", async () => {
    const { fake, client } = setup();
    const url = "https://youtube.com/shorts/abcdefghijk";
    await recordVideoPost(client, { campaignAssetId: "asset-1", videoRenderId: "render-1", platform: "youtube_shorts", url });
    expect(fake.tables["video_posts"]?.[0]).toMatchObject({ platform: "youtube_shorts", url, external_id: "abcdefghijk" });
    expect(fake.tables["content_publications"]?.[0]).toMatchObject({ campaign_asset_id: "asset-1", channel: "youtube", actual_url: url });
    expect(fake.tables["video_renders"]?.[0]?.published_url).toBe(url);
  });

  it("a TikTok link is recorded as a publication but leaves the render's YouTube link alone", async () => {
    const { fake, client } = setup();
    await recordVideoPost(client, { campaignAssetId: "asset-1", platform: "tiktok", url: "https://www.tiktok.com/@fillbookhq/video/1" });
    expect(fake.tables["content_publications"]?.[0]).toMatchObject({ channel: "tiktok" });
    expect(fake.tables["video_renders"]?.[0]?.published_url).toBeNull();
  });

  it("a failed publications sync never fails the post itself", async () => {
    const { fake, client } = setup();
    fake.failTable("content_publications", { message: "db down" });
    await expect(recordVideoPost(client, { campaignAssetId: "asset-1", platform: "instagram", url: "https://instagram.com/reel/x" })).resolves.toBeUndefined();
    expect(fake.tables["video_posts"]).toHaveLength(1);
  });
});

describe("recordVideoPost: one YouTube post per 48 hours", () => {
  const NOW = new Date("2026-10-18T20:00:00Z");
  function withEarlierYoutube(postedAt: string) {
    const { fake, client } = setup();
    fake.tables["video_posts"] = [{ campaign_asset_id: "asset-0", platform: "youtube_shorts", url: "https://youtube.com/shorts/old", posted_at: postedAt }];
    return { fake, client };
  }

  it("refuses a YouTube link for another video within 48 hours of the last YouTube post, and saves nothing", async () => {
    const { fake, client } = withEarlierYoutube("2026-10-17T19:00:00Z");
    await expect(recordVideoPost(client, { campaignAssetId: "asset-1", platform: "youtube_shorts", url: "https://youtube.com/shorts/abcdefghijk" }, NOW)).rejects.toThrow(/One YouTube post per 48 hours/);
    expect(fake.tables["video_posts"]).toHaveLength(1);
  });

  it("allows it after 48 hours, and never limits TikTok", async () => {
    const { client } = withEarlierYoutube("2026-10-16T19:00:00Z");
    await expect(recordVideoPost(client, { campaignAssetId: "asset-1", platform: "youtube_shorts", url: "https://youtube.com/shorts/abcdefghijk" }, NOW)).resolves.toBeUndefined();
    const recent = withEarlierYoutube("2026-10-18T19:00:00Z");
    await expect(recordVideoPost(recent.client, { campaignAssetId: "asset-1", platform: "tiktok", url: "https://www.tiktok.com/@fillbookhq/video/1" }, NOW)).resolves.toBeUndefined();
  });

  it("lets the same video's YouTube link be corrected at any time", async () => {
    const { fake, client } = setup();
    fake.tables["video_posts"] = [{ campaign_asset_id: "asset-1", platform: "youtube_shorts", url: "https://youtube.com/shorts/typo", posted_at: "2026-10-18T19:00:00Z" }];
    await expect(recordVideoPost(client, { campaignAssetId: "asset-1", platform: "youtube_shorts", url: "https://youtube.com/shorts/abcdefghijk" }, NOW)).resolves.toBeUndefined();
  });
});
