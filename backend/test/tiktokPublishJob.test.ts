import { describe, it, expect, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { createPublishTiktokJobHandler, PUBLISH_TIKTOK_JOB_TYPE, type PublishTiktokJobDeps } from "../src/video/tiktokPublishJob";
import { InMemoryVideoPerformanceRepository } from "../src/shortform/performanceRepository";
import type { Job } from "../src/jobs/types";
import type { TiktokUploadClient } from "../src/signals/adapters/tiktokUploadClient";

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: "job-1",
    jobType: PUBLISH_TIKTOK_JOB_TYPE,
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
  youtubeDescription: "Body text",
  tiktokCaption: "tt caption @fillbookhq\n#FuturesTrading #PropFirmTrading #TradingJournal",
  hashtags: ["FuturesTrading", "PropFirmTrading", "TradingJournal"],
  disclosureCta: null,
};

function makeFake(): FakeSupabaseClient {
  return new FakeSupabaseClient({
    campaign_assets: [
      {
        id: "asset-1",
        platform: "tiktok",
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

describe("createPublishTiktokJobHandler", () => {
  it("uploads the rendered video to the TikTok inbox, routes through the firewall as EXTERNAL_DRAFT, and records a drafted publication + metadata row", async () => {
    const fake = makeFake();
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideoToInbox = vi.fn().mockResolvedValue("tt-publish-id");
    const performanceRepo = new InMemoryVideoPerformanceRepository();
    const auditSink = vi.fn().mockResolvedValue(undefined);
    const deps: PublishTiktokJobDeps = {
      client,
      uploadClient: { uploadVideoToInbox } as unknown as TiktokUploadClient,
      performanceRepo,
      auditSink,
    };

    const handler = createPublishTiktokJobHandler(deps);
    await handler(makeJob({ videoRenderId: "render-1" }));

    expect(auditSink).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: "tiktok.upload_draft_to_inbox",
        actionClass: "EXTERNAL_DRAFT",
        outcome: "drafted",
      }),
    );

    expect(uploadVideoToInbox).toHaveBeenCalledTimes(1);

    const publication = (fake.tables.platform_publications ?? []).find((r) => r.video_render_id === "render-1");
    expect(publication).toMatchObject({ status: "drafted", external_video_id: "tt-publish-id", platform: "tiktok" });
    expect(publication?.published_at).toBeTruthy();

    const metaEntries = [...performanceRepo.metadata.values()];
    expect(metaEntries).toHaveLength(1);
    expect(metaEntries[0]).toMatchObject({
      platform: "tiktok",
      caption: VIDEO_SCRIPT.tiktokCaption,
      experimentId: "asset-1",
      variationId: "render-1",
      publishedUrl: "",
    });
  });

  it("is idempotent: does not re-upload when already drafted or published", async () => {
    const fake = makeFake();
    fake.tables.platform_publications = [
      { id: "pub-1", video_render_id: "render-1", platform: "tiktok", status: "drafted", external_video_id: "already-there" },
    ];
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideoToInbox = vi.fn().mockResolvedValue("should-not-be-called");
    const deps: PublishTiktokJobDeps = {
      client,
      uploadClient: { uploadVideoToInbox } as unknown as TiktokUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await createPublishTiktokJobHandler(deps)(makeJob({ videoRenderId: "render-1" }));

    expect(uploadVideoToInbox).not.toHaveBeenCalled();
  });

  it("blocks before any upload when the stored script has a claim Fillbook cannot support (publish-time check, 2026-11-18)", async () => {
    const fake = makeFake();
    (fake.tables.content_versions![0] as any).metadata = { videoScript: { ...VIDEO_SCRIPT, tiktokCaption: "Pass your eval with Fillbook" } };
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideoToInbox = vi.fn().mockResolvedValue("tt-publish-id");
    const deps: PublishTiktokJobDeps = {
      client,
      uploadClient: { uploadVideoToInbox } as unknown as TiktokUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createPublishTiktokJobHandler(deps)(makeJob({ videoRenderId: "render-1" }))).rejects.toThrow(/claims Fillbook cannot support.*TikTok caption/);
    expect(uploadVideoToInbox).not.toHaveBeenCalled();
  });

  it("marks the publication failed and rethrows when the upload fails", async () => {
    const fake = makeFake();
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const uploadVideoToInbox = vi.fn().mockRejectedValue(new Error("inbox init failed"));
    const deps: PublishTiktokJobDeps = {
      client,
      uploadClient: { uploadVideoToInbox } as unknown as TiktokUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createPublishTiktokJobHandler(deps)(makeJob({ videoRenderId: "render-1" }))).rejects.toThrow("inbox init failed");

    const publication = (fake.tables.platform_publications ?? []).find((r) => r.video_render_id === "render-1");
    expect(publication).toMatchObject({ status: "failed", error: "inbox init failed" });
  });

  it("throws for a render that is not ready to publish", async () => {
    const fake = makeFake();
    fake.tables.video_renders = [{ id: "render-1", campaign_asset_id: "asset-1", status: "rendering", storage_path: null, duration_seconds: null }];
    const client = withStorage(fake, async () => ({ data: fakeBlob(), error: null }));
    const deps: PublishTiktokJobDeps = {
      client,
      uploadClient: { uploadVideoToInbox: vi.fn() } as unknown as TiktokUploadClient,
      performanceRepo: new InMemoryVideoPerformanceRepository(),
      auditSink: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createPublishTiktokJobHandler(deps)(makeJob({ videoRenderId: "render-1" }))).rejects.toThrow("not ready to publish");
  });
});
