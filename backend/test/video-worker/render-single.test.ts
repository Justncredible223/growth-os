import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProcessRunner } from "../../scripts/video-factory/processRunner";
import { runRender } from "../../scripts/video-worker/render-single";
import { PILOT_1, PILOT_2 } from "../../src/shortform/pilots";
import { mockPayoutGapPlan as chartAPlan } from "../../src/shortform/chartMockConcepts";
import { computeScenePlanHash } from "../../src/shortform/scenePlan";
import { buildVideoScriptFromScenePlan } from "../../src/content/videoScriptWriter";

// These tests exercise request states, pipeline mechanics and render paths with real pilots as their fixtures. The story
// bar (only A and A+ concepts render) has its own tests in storyBar.test.ts, so it is switched off here: otherwise every
// test that happens to pick a lower-graded pilot would fail for a reason it is not about.
vi.mock("../../src/shortform/storyScore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shortform/storyScore")>();
  return { ...actual, assertMeetsRenderBar: () => {}, renderBar: () => ({ ok: true, score: 100, grade: "A+" as const, fixes: [] }) };
});

// The chart-card plan below draws mock slides. Its slide rendering (a real headless Chromium) is tested for real in
// mockLayout.test.ts; here the browser is stubbed so this suite stays fast and needs no browser installed.
vi.mock("../../scripts/video-factory/mockCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/video-factory/mockCard")>();
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  return {
    ...actual,
    createMockRenderer: async () => ({
      render: async (_frame: unknown, outPath: string) => {
        writeFileSync(outPath, "png");
        return outPath;
      },
      renderBeat: async (_frame: unknown, dir: string, prefix: string) => {
        const stillPath = join(dir, `${prefix}.png`);
        writeFileSync(stillPath, "png");
        return { stillPath, pattern: `${prefix}-%03d.png`, count: 30 };
      },
      close: async () => {},
    }),
  };
});

/**
 * Exercises the real worker entry point (`runRender`) end to end, with a
 * fake Supabase client/storage and a fake push sender (per this task's
 * "mocked database/storage/notification boundaries"), and a fake
 * ProcessRunner that mimics ffmpeg/ffprobe/python3's real observable
 * behavior (writes the files each real tool would write, returns the JSON
 * shapes each real caller parses) instead of actually invoking them --
 * same convention this repo's own voiceover.test.ts/render.test.ts already
 * use, so this suite runs fast, deterministically, and with no network
 * call at all (not even edge-tts, despite that being what production
 * really uses -- the fake python3 handler below stands in for it). What
 * IS real and unmocked: which code path is chosen, what render.ts's own
 * buildFfmpegArgs/renderVideo are actually called with, and every existing
 * safeguard (approval gate, storage/budget checks, validation).
 *
 * Real, non-mocked, network-free end-to-end proof that the pipeline
 * produces an actual playable MP4 with real motion lives in
 * scripts/video-factory/renderScenePlanLocally.ts (previously verified)
 * and scripts/video-worker/verifyRealNarratedRender.ts (offline-narrated
 * production-path proof) -- this suite is about the DECISION logic and
 * safeguards, not re-proving ffmpeg's own output.
 */

const WIDTH = 1080;
const HEIGHT = 1920;
/** Every fake narration measurement reports this -- see createFakeRunner's own doc comment for why the FINAL video's fake duration is derived from these rather than a second, independent guess. */
const FAKE_NARRATION_SECONDS = 2.0;

const SAMPLE_WORDS = JSON.stringify([
  { text: "Hello", startSeconds: 0.05, endSeconds: 0.4 },
  { text: "there.", startSeconds: 0.45, endSeconds: 0.9 },
]);

function resolveAgainstCwd(maybeRelativePath: string, cwd?: string): string {
  if (!cwd || /^[a-zA-Z]:[\\/]/.test(maybeRelativePath) || maybeRelativePath.startsWith("/")) return maybeRelativePath;
  return join(cwd, maybeRelativePath);
}

/**
 * Mimics real ffmpeg/ffprobe/python3 just enough for runRender's own call
 * sites (see this file's doc comment) -- never a real subprocess. Tracks
 * total narration duration across calls (every per-scene or full-script
 * narration measurement reports FAKE_NARRATION_SECONDS) so the FINAL
 * video's fake probed duration is internally consistent with whichever
 * code path actually ran, the same relationship validateOutput itself
 * checks -- a fixed, unrelated guess for the final probe would make
 * validateOutput's own duration-matches-narration check spuriously fail.
 */
function createFakeRunner(finalDurationSeconds?: number): ProcessRunner {
  let narrationTotalSeconds = 0;
  const run = vi.fn(async (command: string, args: string[] = [], options?: { cwd?: string }) => {
    if (args.includes("-version") || args.includes("--version")) return { stdout: "", stderr: "", exitCode: 0 };
    if (command === "ffprobe") {
      const path = String(args[args.length - 1]);
      const wantsStreams = args.includes("-show_streams");
      const isNarrationProbe = /voiceover\.mp3$/.test(path);
      // A per-beat narration part measured again after silence trimming reports the same fake length, without counting toward the total twice.
      const isPartProbe = /narration-\d+-[^/\\]*\.mp3$/.test(path);
      // A silent plan (voiceover none) has no narration to total up, so its final video's probed duration is given directly.
      const duration = isNarrationProbe || isPartProbe ? FAKE_NARRATION_SECONDS : finalDurationSeconds ?? (narrationTotalSeconds || FAKE_NARRATION_SECONDS);
      if (isNarrationProbe) narrationTotalSeconds += FAKE_NARRATION_SECONDS;
      const streams = wantsStreams
        ? [
            { codec_type: "video", codec_name: "h264", width: WIDTH, height: HEIGHT },
            { codec_type: "audio", codec_name: "aac" },
          ]
        : [];
      return { stdout: JSON.stringify({ streams, format: { duration: String(duration), size: "500000" } }), stderr: "", exitCode: 0 };
    }
    if (command === "python3") {
      // edge_tts_words.py: writes real word-timing JSON + a media file, matching generateVoiceover's own expectations.
      const outWords = args[args.indexOf("--out-words") + 1];
      const outMedia = args[args.indexOf("--out-media") + 1];
      if (outWords) writeFileSync(outWords, SAMPLE_WORDS);
      if (outMedia) writeFileSync(outMedia, "fake-mp3-bytes");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ffmpeg") {
      // Every real ffmpeg invocation in this pipeline (renderVideo, renderThumbnailCard, buildCroppedStill, the offline-silence generator) takes its output path as the LAST argv entry, and real ffmpeg runs with `cwd` set so a basename-only path resolves there -- resolve the same way so downstream statSync/readFileSync calls succeed.
      const outPath = args[args.length - 1];
      if (outPath) writeFileSync(resolveAgainstCwd(outPath, options?.cwd), "fake-media-bytes");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unexpected command ${command}`, exitCode: 1 };
  });
  return { run };
}

type Row = Record<string, unknown> | null;

/** Minimal, chainable, thenable stand-in for supabase-js's PostgrestFilterBuilder -- just enough surface for loadApprovedScript/runRender's own query shapes. Every builder call is recorded so a test can assert on it. */
function createFakeSupabaseClient(config: { campaignAssetsRow: Row; contentVersionsRow: Row }, calls: { table: string; op: string }[]) {
  function builderFor(table: string): any {
    const builder: any = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      is: () => builder,
      eq: () => builder,
      maybeSingle: async () => {
        if (table === "campaign_assets") return { data: config.campaignAssetsRow, error: null };
        if (table === "content_versions") return { data: config.contentVersionsRow, error: null };
        return { data: null, error: null };
      },
      update: (obj: unknown) => {
        calls.push({ table, op: "update" });
        void obj;
        return builder;
      },
      // device_push_tokens' select().is() chain is awaited directly (no maybeSingle) -- resolve as an empty list so the FCM step is a no-op.
      then: (resolve: (v: unknown) => void) => resolve({ data: table === "device_push_tokens" ? [] : null, error: null }),
    };
    return builder;
  }

  return {
    from: (table: string) => builderFor(table),
    storage: {
      from: () => ({
        upload: async () => {
          calls.push({ table: "storage", op: "upload" });
          return { error: null };
        },
      }),
    },
    rpc: async (fn: string) => {
      calls.push({ table: "rpc", op: fn });
      if (fn === "reserve_video_storage_bytes") return { data: [{ reservation_id: "reservation-1", eligible: true, reason: null }], error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

interface VideoScriptFixture {
  hook: string;
  script: string;
  shotList: string[];
  youtubeTitle: string;
  youtubeDescription: string;
  tiktokCaption: string;
  hashtags: string[];
  disclosureCta: string | null;
  motionScenePlan?: { scenePlanId: string; scenePlanHash: string } | null;
}

function makeRow(videoScript: VideoScriptFixture, status: "approved" | "draft" = "approved") {
  return {
    campaignAssetsRow: {
      id: "asset-1",
      platform: "tiktok",
      asset_type: "video_script",
      campaign_id: "campaign-1",
      campaigns: { thesis: "test campaign", status, decided_by: status === "approved" ? "Owner" : null, decided_at: status === "approved" ? "2026-09-23T00:00:00Z" : null },
    },
    contentVersionsRow: { body: "n/a", metadata: { videoScript } },
  };
}

let tempDirs: string[] = [];
function tempWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "render-single-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("runRender", () => {
  it("a script with no motionScenePlan reference (an ordinary campaign) uses the standard stock-footage/UI-screenshot pipeline, unchanged, and reports the fallback explicitly (never silently)", async () => {
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: "An ordinary campaign hook, no motion concept requested.",
      script: "An ordinary campaign hook, no motion concept requested. It just talks about trading discipline in general.",
      shotList: ["Text card: the hook line", "Fillbook UI: metric card", "Text card: closing question"],
      youtubeTitle: "Some Title",
      youtubeDescription: "Some description",
      tiktokCaption: "Some caption",
      hashtags: ["#trading"],
      disclosureCta: null,
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    const result = await runRender("render-1", "asset-1", { client, runner, workDir, sendPush });

    expect(result.motionSelection.usedVerifiedScenePlan).toBe(false);
    expect(result.motionSelection.reason).toContain("no motionScenePlan reference");
    expect(result.motionSelection.assetsUsed).toEqual([]);
    expect(result.motionSelection.narrationProvenance).toBeNull();
    expect(result.storagePath).toBe("render-1.mp4");
    expect(calls.some((c) => c.table === "storage" && c.op === "upload")).toBe(true);
    expect(existsSync(join(workDir, "render-1", "final.mp4"))).toBe(true);
    // The stock/UI-screenshot codepath's own commands actually ran (unchanged behavior).
    const runMock = runner.run as unknown as ReturnType<typeof vi.fn>;
    expect(runMock.mock.calls.some((c: unknown[]) => c[0] === "python3" && (c[1] as string[]).includes("--file"))).toBe(true);
  }, 30_000);

  it("the SAME hook text as a verified pilot, but with NO motionScenePlan reference, still uses the standard pipeline -- a matching hook alone is never authorization", async () => {
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    // Exact same hook as PILOT_2, but a completely different body/figures and no explicit reference.
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: PILOT_2.hook,
      script: "This is a totally different, unapproved-for-motion script that happens to reuse the same hook line by coincidence.",
      shotList: ["Text card: unrelated content"],
      youtubeTitle: "Unrelated",
      youtubeDescription: "Unrelated description",
      tiktokCaption: "Unrelated caption",
      hashtags: ["#trading"],
      disclosureCta: null,
      // no motionScenePlan
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    const result = await runRender("render-hook-coincidence", "asset-1", { client, runner, workDir, sendPush });

    expect(result.motionSelection.usedVerifiedScenePlan).toBe(false);
    expect(result.motionSelection.assetsUsed).toEqual([]);
    // Never PILOT_2's own real assets, despite the identical hook text.
    expect(result.motionSelection.assetsUsed.some((a) => a.assetId.startsWith("rec.p2-"))).toBe(false);
  }, 30_000);

  it("a motionScenePlan reference whose hash no longer matches the current plan (stale/modified content) fails loudly instead of substituting either version", async () => {
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: PILOT_2.hook,
      script: "unused for the ScenePlan path",
      shotList: ["irrelevant"],
      youtubeTitle: "t",
      youtubeDescription: "d",
      tiktokCaption: "c",
      hashtags: ["#trading"],
      disclosureCta: null,
      motionScenePlan: { scenePlanId: PILOT_2.planId, scenePlanHash: "0".repeat(64) }, // wrong hash, as if pilots.ts changed since generation
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    await expect(runRender("render-stale-hash", "asset-1", { client, runner, workDir, sendPush })).rejects.toThrow(/content changed since this script was generated|Refusing to render/);
    expect(calls.some((c) => c.table === "storage" && c.op === "upload")).toBe(false);
  }, 30_000);

  it("a motionScenePlan reference to an unknown scenePlanId fails loudly instead of silently falling back to stock footage", async () => {
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: "Some hook",
      script: "unused",
      shotList: ["irrelevant"],
      youtubeTitle: "t",
      youtubeDescription: "d",
      tiktokCaption: "c",
      hashtags: ["#trading"],
      disclosureCta: null,
      motionScenePlan: { scenePlanId: "pilot-does-not-exist", scenePlanHash: "a".repeat(64) },
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    await expect(runRender("render-unknown-plan", "asset-1", { client, runner, workDir, sendPush })).rejects.toThrow(/not a known verified ScenePlan/);
    expect(calls.some((c) => c.table === "storage" && c.op === "upload")).toBe(false);
  }, 30_000);

  it("a script with a VALID, hash-verified motionScenePlan reference renders via the ScenePlan/verified-motion path, reporting exactly which assets were used -- never the OTHER pilots' clips", async () => {
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: PILOT_2.hook,
      // Must equal the canonical text buildVideoScriptFromScenePlan derives from
      // PILOT_2 -- resolveMotionScenePlan now checks approved-script content
      // against the plan, not just the hash, so an arbitrary placeholder here
      // would (correctly) be rejected as a diverged/edited approval.
      script: buildVideoScriptFromScenePlan(PILOT_2).script,
      shotList: ["irrelevant -- the ScenePlan path never reads shotList"],
      youtubeTitle: "Balance isn't your buffer",
      youtubeDescription: "desc",
      tiktokCaption: "caption",
      hashtags: ["#trading"],
      disclosureCta: null,
      motionScenePlan: { scenePlanId: PILOT_2.planId, scenePlanHash: computeScenePlanHash(PILOT_2) },
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    const result = await runRender("render-2", "asset-1", { client, runner, workDir, sendPush });

    expect(result.motionSelection.usedVerifiedScenePlan).toBe(true);
    expect(result.motionSelection.reason).toContain(PILOT_2.planId);
    expect(result.motionSelection.narrationProvenance).toBe("edge_tts");
    const usedIds = result.motionSelection.assetsUsed.map((a) => a.assetId);
    expect(usedIds).toContain("rec.p2-rules-buffer.v2");
    expect(usedIds.some((id) => id.startsWith("rec.p1-") || id.startsWith("rec.p3-"))).toBe(false);
    expect(existsSync(join(workDir, "render-2", "final.mp4"))).toBe(true);
    // One edge-tts call per PILOT_2 scene, not one call for a whole flat script
    // (plus the single requireExecutable "--version" probe at startup).
    const runMock = runner.run as unknown as ReturnType<typeof vi.fn>;
    const edgeTtsCalls = runMock.mock.calls.filter((c: unknown[]) => c[0] === "python3" && !(c[1] as string[]).includes("--version"));
    expect(edgeTtsCalls.length).toBe(PILOT_2.scenes.length);
  }, 30_000);

  it("a narrated product-mock plan renders via the verified-motion path with one edge-tts call per beat at +8%, reporting the recording its numbers come from", async () => {
    const plan = chartAPlan();
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: plan.hook,
      script: buildVideoScriptFromScenePlan(plan).script,
      shotList: ["irrelevant -- the ScenePlan path never reads shotList"],
      youtubeTitle: plan.title,
      youtubeDescription: "desc",
      tiktokCaption: "caption",
      hashtags: ["#trading"],
      disclosureCta: null,
      motionScenePlan: { scenePlanId: plan.planId, scenePlanHash: computeScenePlanHash(plan) },
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    const result = await runRender("render-chart", "asset-1", { client, runner, workDir, sendPush });

    expect(result.motionSelection.usedVerifiedScenePlan).toBe(true);
    expect(result.motionSelection.reason).toContain(plan.planId);
    expect(result.motionSelection.narrationProvenance).toBe("edge_tts");
    expect(result.motionSelection.assetsUsed.map((a) => a.assetId)).toContain("rec.hs-payout-account.v1");
    expect(existsSync(join(workDir, "render-chart", "final.mp4"))).toBe(true);
    // One edge-tts call per beat, all at the project voice's +8% pace (not the faster payoff pace).
    const runMock = runner.run as unknown as ReturnType<typeof vi.fn>;
    const edgeTtsCalls = runMock.mock.calls.filter((c: unknown[]) => c[0] === "python3" && !(c[1] as string[]).includes("--version"));
    expect(edgeTtsCalls.length).toBe(plan.scenes.length);
    for (const c of edgeTtsCalls) {
      const args = c[1] as string[];
      expect(args[args.indexOf("--rate") + 1]).toBe("+8%");
    }
  }, 30_000);

  it("a valid scenePlanId+hash+hook, but approved script BODY/figures/claims text altered after generation, is rejected before any narration/rendering happens", async () => {
    // Simulates a revision/edit stage rewriting the approved narration
    // while leaving the motionScenePlan reference untouched -- the plan
    // itself never changed (hash matches), so the first fix's hash check
    // alone would let this through and render PILOT_2's real evidence for
    // a script that no longer says what was actually reviewed.
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: PILOT_2.hook, // hook left alone by the hypothetical edit
      script: "This says something completely different -- different figures, different claims, edited after the fact.",
      shotList: ["irrelevant"],
      youtubeTitle: "Balance isn't your buffer",
      youtubeDescription: "desc",
      tiktokCaption: "caption",
      hashtags: ["#trading"],
      disclosureCta: null,
      motionScenePlan: { scenePlanId: PILOT_2.planId, scenePlanHash: computeScenePlanHash(PILOT_2) }, // hash is genuinely valid -- the PLAN didn't change
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    await expect(runRender("render-altered-body", "asset-1", { client, runner, workDir, sendPush })).rejects.toThrow(/no longer equals the canonical text/);
    expect(calls.some((c) => c.table === "storage" && c.op === "upload")).toBe(false);
    // Never even started narration synthesis for the rejected content.
    const runMock = runner.run as unknown as ReturnType<typeof vi.fn>;
    const edgeTtsCalls = runMock.mock.calls.filter((c: unknown[]) => c[0] === "python3" && !(c[1] as string[]).includes("--version"));
    expect(edgeTtsCalls.length).toBe(0);
  }, 30_000);

  it("a valid reference to a pilot whose manifest assets are missing/removed fails loudly instead of silently rendering with stock footage or unrelated evidence", async () => {
    vi.resetModules();
    vi.doMock("../../src/shortform/scenePlan.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/shortform/scenePlan")>();
      return { ...actual, loadManifest: () => ({ version: 1, note: "empty", assets: [] }) };
    });
    const { runRender: runRenderWithBrokenManifest } = await import("../../scripts/video-worker/render-single");

    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow({
      hook: PILOT_1.hook,
      script: buildVideoScriptFromScenePlan(PILOT_1).script, // must be canonical -- this test is about the MANIFEST failing, not the content-integrity check
      shotList: ["irrelevant"],
      youtubeTitle: "t",
      youtubeDescription: "d",
      tiktokCaption: "c",
      hashtags: ["#trading"],
      disclosureCta: null,
      motionScenePlan: { scenePlanId: PILOT_1.planId, scenePlanHash: computeScenePlanHash(PILOT_1) },
    });
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    await expect(runRenderWithBrokenManifest("render-3", "asset-1", { client, runner, workDir, sendPush })).rejects.toThrow(
      /fails its own claim\/evidence\/timing validation|not in the manifest/,
    );
    expect(calls.some((c) => c.table === "storage" && c.op === "upload")).toBe(false);

    vi.doUnmock("../../src/shortform/scenePlan.js");
    vi.resetModules();
  }, 30_000);

  it("an unapproved draft is refused before any rendering happens (existing safeguard, unaffected by the motion-selection change)", async () => {
    const runner = createFakeRunner();
    const workDir = tempWorkDir();
    const calls: { table: string; op: string }[] = [];
    const { campaignAssetsRow, contentVersionsRow } = makeRow(
      {
        hook: "Some unapproved hook",
        script: "Some unapproved hook. Never rendered.",
        shotList: ["Text card: the hook line"],
        youtubeTitle: "t",
        youtubeDescription: "d",
        tiktokCaption: "c",
        hashtags: ["#trading"],
        disclosureCta: null,
      },
      "draft",
    );
    const client = createFakeSupabaseClient({ campaignAssetsRow, contentVersionsRow }, calls);
    const sendPush = vi.fn().mockResolvedValue({ ok: true, isRevokedToken: false });

    await expect(runRender("render-4", "asset-1", { client, runner, workDir, sendPush })).rejects.toThrow(/has not been approved/);
    expect(calls.some((c) => c.table === "storage" && c.op === "upload")).toBe(false);
    // ffmpeg is invoked once up front just to confirm it's on PATH (requireExecutable's "-version" check) -- never for an actual render (no -filter_complex call).
    const runMock = runner.run as unknown as ReturnType<typeof vi.fn>;
    expect(runMock.mock.calls.some((c: unknown[]) => c[0] === "ffmpeg" && (c[1] as string[]).includes("-filter_complex"))).toBe(false);
  }, 30_000);
});
