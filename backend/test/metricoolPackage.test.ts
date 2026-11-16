import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { METRICOOL_AUTO_PUBLISH, MEDIA_URL_TTL_SECONDS, MetricoolPackageError, buildMetricoolPackage, getMetricoolPackage, metricoolPackageText } from "../src/video/metricoolPackage";
import type { VideoRenderMetadataJson } from "../src/video/videoStatusHandlers";

const META: VideoRenderMetadataJson = {
  youtubeTitle: "Daily loss limit vs drawdown buffer: Check both before the open",
  youtubeDescription: "A prop account has two numbers before the first trade.\n\nEvery number shown is demo data from a sample Fillbook account, not a real trader's results. @fillbookhq",
  tiktokCaption: "Funded 50K. Only $690 left. Demo account data. @fillbookhq",
  instagramCaption: null,
  hashtags: ["DayTrading", "PropFirm", "DailyLossLimit", "RiskManagement", "FundedTrader", "Extra"],
  disclosureCta: "Demo data",
  youtubeThumbnailConcept: null,
  pinnedComment: "x",
};
const input = { videoRenderId: "r-1", sha256: "a".repeat(64), durationSeconds: 23.4, metadata: META, mediaUrl: "https://example.supabase.co/signed/v.mp4?token=t", mediaUrlExpiresAt: "2026-11-16T08:00:00.000Z" };

describe("buildMetricoolPackage (policy 2026-11-08, team decision 2026-11-14)", () => {
  const p = buildMetricoolPackage(input);

  it("builds one post per network with the policy's flags, autopublish off", () => {
    expect(METRICOOL_AUTO_PUBLISH).toBe(false);
    const t = p.posts.tiktok as Record<string, any>;
    const y = p.posts.youtube as Record<string, any>;
    expect(t.providers).toEqual([{ network: "tiktok" }]);
    expect(y.providers).toEqual([{ network: "youtube" }]);
    for (const post of [t, y]) {
      expect(post.autoPublish).toBe(false);
      expect(post.draft).toBe(false);
      expect(post.media).toEqual([input.mediaUrl]);
      expect(post.publicationDate).toBeUndefined(); // the session adds the date only after Justin's yes
    }
    expect(t.tiktokData).toMatchObject({ privacyOption: "PUBLIC_TO_EVERYONE", disableComment: false, commercialContentOwnBrand: true, commercialContentThirdParty: false, isAigc: true });
    expect(y.youtubeData).toMatchObject({ type: "short", privacy: "public", madeForKids: false, isAiGeneratedContent: true, title: META.youtubeTitle });
  });

  it("puts the TikTok caption and at most five hashtags in the TikTok text, and the description in the YouTube text", () => {
    expect((p.posts.tiktok as any).text).toBe(`${META.tiktokCaption} #DayTrading #PropFirm #DailyLossLimit #RiskManagement #FundedTrader`);
    expect((p.posts.youtube as any).text).toBe(META.youtubeDescription);
    expect((p.posts.youtube as any).youtubeData.tags).toHaveLength(5);
  });

  it("passes its own rule checks for a clean video, and fails them for a bad caption", () => {
    expect(p.checks.every((c) => c.ok)).toBe(true);
    const bad = buildMetricoolPackage({ ...input, metadata: { ...META, tiktokCaption: "Join the giveaway fillbookhq.com/go/x-1", youtubeDescription: "No label here." } });
    const failed = bad.checks.filter((c) => !c.ok).map((c) => c.check);
    expect(failed.join(" ")).toMatch(/demo data/);
    expect(failed.join(" ")).toMatch(/giveaway/i);
    expect(failed.join(" ")).toMatch(/\/go/);
    expect(metricoolPackageText(bad)).toMatch(/CHECKS FAILED, do not queue/);
  });

  it("has an id that changes with the file or any caption, and not otherwise", () => {
    expect(p.packageId).toMatch(/^mp-[0-9a-f]{8}$/);
    expect(buildMetricoolPackage(input).packageId).toBe(p.packageId);
    expect(buildMetricoolPackage({ ...input, mediaUrl: "https://other" }).packageId).toBe(p.packageId);
    expect(buildMetricoolPackage({ ...input, sha256: "b".repeat(64) }).packageId).not.toBe(p.packageId);
    expect(buildMetricoolPackage({ ...input, metadata: { ...META, tiktokCaption: "Changed. Demo account data." } }).packageId).not.toBe(p.packageId);
  });

  it("tells Justin that copying is not approval and how to approve", () => {
    const text = metricoolPackageText(p);
    expect(text).toContain(`METRICOOL PACKAGE ${p.packageId}`);
    expect(text).toContain(`File fingerprint ${"a".repeat(64)}`);
    expect(text).toContain(`Copying this is not approval. To approve, write: approve ${p.packageId} for`);
    expect(text).toContain("Checks: all passed");
  });
});

describe("getMetricoolPackage", () => {
  const bytes = Buffer.from("fake mp4 bytes");
  const fakeClient = (row: Record<string, unknown> | null, metadata: unknown = { videoScript: META }) =>
    ({
      from: (table: string) => {
        const q: any = {
          select: () => q,
          eq: () => q,
          order: () => q,
          limit: async () => ({ data: table === "content_versions" ? [{ metadata, version: 2 }] : [], error: null }),
          maybeSingle: async () => ({ data: row, error: null }),
        };
        return q;
      },
      storage: {
        from: () => ({
          download: async () => ({ data: new Blob([bytes]), error: null }),
          createSignedUrl: async (_p: string, ttl: number) => ({ data: { signedUrl: `https://signed?ttl=${ttl}` }, error: null }),
        }),
      },
    }) as never;

  it("hashes the stored file and signs a 24-hour media link for a ready render", async () => {
    const now = new Date("2026-11-15T08:00:00Z");
    const p = await getMetricoolPackage(fakeClient({ id: "r-9", campaign_asset_id: "a-1", status: "ready", storage_path: "x/final.mp4", duration_seconds: 22 }), "r-9", now);
    expect(p.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(p.mediaUrl).toBe(`https://signed?ttl=${MEDIA_URL_TTL_SECONDS}`);
    expect(MEDIA_URL_TTL_SECONDS).toBe(86400);
    expect(p.mediaUrlExpiresAt).toBe("2026-11-16T08:00:00.000Z");
  });

  it("refuses a render that is missing, not ready, or has no captions", async () => {
    await expect(getMetricoolPackage(fakeClient(null), "nope")).rejects.toBeInstanceOf(MetricoolPackageError);
    await expect(getMetricoolPackage(fakeClient({ id: "r", campaign_asset_id: "a", status: "rendering", storage_path: null, duration_seconds: null }), "r")).rejects.toBeInstanceOf(MetricoolPackageError);
    await expect(getMetricoolPackage(fakeClient({ id: "r", campaign_asset_id: "a", status: "ready", storage_path: "p", duration_seconds: 1 }, { junk: true }), "r")).rejects.toBeInstanceOf(MetricoolPackageError);
  });
});

describe("P2 2026-11-15 (ChatGPT): the package follows the posting rules", () => {
  it("leaves YouTube out while the 48-hour rule blocks it, and says so", () => {
    const p = buildMetricoolPackage({ ...input, youtubeBlockedUntil: "2026-11-17T19:00:00.000Z" });
    expect(p.posts.youtube).toBeUndefined();
    expect(p.posts.tiktok).toBeDefined();
    expect(metricoolPackageText(p)).toContain("YouTube left out: one YouTube post per 48 hours");
    expect(buildMetricoolPackage({ ...input, youtubeBlockedUntil: null }).posts.youtube).toBeDefined();
  });

  it("puts the pinned comment in as the first comment, and adds Instagram when there is an Instagram caption", () => {
    const p = buildMetricoolPackage({ ...input, metadata: { ...META, pinnedComment: "Track your drawdown in Fillbook.", instagramCaption: "Demo data. The floor moves with you." } });
    expect((p.posts.tiktok as any).firstCommentText).toBe("Track your drawdown in Fillbook.");
    expect((p.posts.youtube as any).firstCommentText).toBe("Track your drawdown in Fillbook.");
    expect((p.posts.instagram as any).providers).toEqual([{ network: "instagram" }]);
    expect(metricoolPackageText(p)).toContain("Instagram info:");
    expect(buildMetricoolPackage(input).posts.instagram).toBeUndefined();
  });
});
