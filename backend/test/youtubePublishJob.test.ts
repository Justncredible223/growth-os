import { describe, it, expect, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { createPublishYoutubeJobHandler, PUBLISH_YOUTUBE_JOB_TYPE, type PublishYoutubeJobDeps } from "../src/video/youtubePublishJob";
import { InMemoryVideoPerformanceRepository } from "../src/shortform/performanceRepository";
import type { Job } from "../src/jobs/types";
import type { YoutubeUploadClient } from "../src/signals/adapters/youtubeUploadClient";

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: "job-1",
    jobType: PUBLISH_YOUTUBE_JOB_TYPE,
    payload,
    status: "running",
    idempotencyKey: null,
    attempts: 1,
    maxAttempts: 3,
    runAfter: new Date(0),
    lastError: null,
  };
}

const VIDEO_SCRIPT = {
  hook: "hook",
  script: "script body",
  shotList: ["scene 1"],
  youtubeTitle: "A great video",
  youtubeDescription: "Body text @fillbookhq\n#FuturesTrading #PropFirmTrading #TradingJournal",
  tiktokCaption: "tt caption",
  hashtags: ["FuturesTrading", "PropFirmTrading", "TradingJournal"],
  disclosureCta: null,
};

function makeFake(): FakeSupabaseClient {
  return new FakeSupabaseClient({
    campaign_assets: [
      {
        id: "asset-1",
        platform: "youtube_shorts",
        asset_type: "video_script",
        campaign_id: "camp-1",
        campaigns: { thesis: "Trading discipline", status: "approved", decided_by: "owner", decided_at: "2026-09-01T00:00:00Z" },
      },
    ],
    content_versions: [
      { campaign_asset_id: "asset-1", version: 1, body: "flattened", metadata: { videoScript: VIDEO_SCRIPT } },
    ],
    video_renders: [
      { id: "render-1", campaign_asset_id: "asset-1", status: "ready", storage_path: "render-1.mp4", duration_seconds: 30 },
    ],
    platform_publications: [],
    video_publication_metadata: [],
  });
}

function withStorage(fake: FakeSupabaseClient, download: () => Promise<{ data: any; error: any }>) {
  const client = asSupabase(fake);
  client.storage = { from: () => ({ download }) };
  return client;
}

function fakeBlob(bytes: number[] = [1, 2, 3]) {
  return { arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

describe("createPublishYoutubeJobHandler", () => {
  it("uploads the rendered video as a private draft, routes through the firewall as EXTERNAL_DRAFT, and records a drafted publication + metadata row", async () => {
    const fake = makeFake();
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideo = vi.fn().mockResolvedValue("yt-external-id");
    const performanceRepo = new InMemoryVideoPerformanceRepository();
    const auditSink = vi.fn().mockResolvedValue(undefined);
    const deps: PublishYoutubeJobDeps = {
      client,
      uploadClient: { uploadVideo } as unknown as YoutubeUploadClient,
      performanceRepo,
      auditSink,
    };

    const handler = createPublishYoutubeJobHandler(deps);
    await handler(makeJob({ videoRenderId: "render-1" }));

    expect(auditSink).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: "youtube.upload_private_draft",
        actionClass: "EXTERNAL_DRAFT",
        outcome: "drafted",
      }),
    );

    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(uploadVideo.mock.calls[0]?.[0]).toMatchObject({
      title: "A great video",
      description: VIDEO_SCRIPT.youtubeDescription,
    });

    const publication = (fake.tables.platform_publications ?? []).find((r) => r.video_render_id === "render-1");
    expect(publication).toMatchObject({ status: "drafted", external_video_id: "yt-external-id", platform: "youtube" });
    expect(publication?.published_at).toBeTruthy();

    const metaEntries = [...performanceRepo.metadata.values()];
    expect(metaEntries).toHaveLength(1);
    expect(metaEntries[0]).toMatchObject({
      platform: "youtube_shorts",
      title: "A great video",
      experimentId: "asset-1",
      variationId: "render-1",
      publishedUrl: "https://www.youtube.com/watch?v=yt-external-id",
    });
  });

  it("is idempotent: does not re-upload when already drafted or published", async () => {
    const fake = makeFake();
    fake.tables.platform_publications = [
      { id: "pub-1", video_render_id: "render-1", platform: "youtube", status: "drafted", external_video_id: "already-there" },
    ];
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideo = vi.fn().mockResolvedValue("should-not-be-called");
    const deps: PublishYoutubeJobDeps = {
      client,
      uploadClient: { uploadVideo } as unknown as YoutubeUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await createPublishYoutubeJobHandler(deps)(makeJob({ videoRenderId: "render-1" }));

    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it("marks the publication failed and rethrows when the upload fails", async () => {
    const fake = makeFake();
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideo = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    const deps: PublishYoutubeJobDeps = {
      client,
      uploadClient: { uploadVideo } as unknown as YoutubeUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createPublishYoutubeJobHandler(deps)(makeJob({ videoRenderId: "render-1" }))).rejects.toThrow("quota exceeded");

    const publication = (fake.tables.platform_publications ?? []).find((r) => r.video_render_id === "render-1");
    expect(publication).toMatchObject({ status: "failed", error: "quota exceeded" });
  });

  it("throws for a render that is not ready to publish", async () => {
    const fake = makeFake();
    fake.tables.video_renders = [{ id: "render-1", campaign_asset_id: "asset-1", status: "rendering", storage_path: null, duration_seconds: null }];
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const deps: PublishYoutubeJobDeps = {
      client,
      uploadClient: { uploadVideo: vi.fn() } as unknown as YoutubeUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createPublishYoutubeJobHandler(deps)(makeJob({ videoRenderId: "render-1" }))).rejects.toThrow("not ready to publish");
  });
});

describe("YouTube every other day", () => {
  const NOW = new Date("2026-10-18T19:00:00Z");
  function depsFor(fake: FakeSupabaseClient, uploadVideo: ReturnType<typeof vi.fn>): PublishYoutubeJobDeps {
    return {
      client: withStorage(fake, async () => ({ data: fakeBlob(), error: null })),
      uploadClient: { uploadVideo } as unknown as YoutubeUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
      now: () => NOW,
    };
  }

  it("skips the upload when another video went to YouTube within 40 hours, and records nothing for this render", async () => {
    const fake = makeFake();
    fake.tables.platform_publications = [
      { id: "pub-0", video_render_id: "render-0", platform: "youtube", status: "drafted", updated_at: "2026-10-17T19:05:00Z" },
    ];
    const uploadVideo = vi.fn();
    await createPublishYoutubeJobHandler(depsFor(fake, uploadVideo))(makeJob({ videoRenderId: "render-1" }));
    expect(uploadVideo).not.toHaveBeenCalled();
    expect((fake.tables.platform_publications ?? []).some((r) => r.video_render_id === "render-1")).toBe(false);
  });

  it("uploads when the last YouTube draft is older than 40 hours", async () => {
    const fake = makeFake();
    fake.tables.platform_publications = [
      { id: "pub-0", video_render_id: "render-0", platform: "youtube", status: "drafted", updated_at: "2026-10-16T19:05:00Z" },
    ];
    const uploadVideo = vi.fn().mockResolvedValue("yt-new");
    await createPublishYoutubeJobHandler(depsFor(fake, uploadVideo))(makeJob({ videoRenderId: "render-1" }));
    expect(uploadVideo).toHaveBeenCalledTimes(1);
  });

  it("a failed attempt does not count as a recent upload", async () => {
    const fake = makeFake();
    fake.tables.platform_publications = [
      { id: "pub-0", video_render_id: "render-0", platform: "youtube", status: "failed", updated_at: "2026-10-18T10:00:00Z" },
    ];
    const uploadVideo = vi.fn().mockResolvedValue("yt-new");
    await createPublishYoutubeJobHandler(depsFor(fake, uploadVideo))(makeJob({ videoRenderId: "render-1" }));
    expect(uploadVideo).toHaveBeenCalledTimes(1);
  });
});
