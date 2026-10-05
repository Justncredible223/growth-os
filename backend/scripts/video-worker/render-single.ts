#!/usr/bin/env node
/**
 * One-shot render script for GitHub Actions.
 * Reads VIDEO_RENDER_ID and CAMPAIGN_ASSET_ID from env, renders the video,
 * uploads to Supabase Storage, sends FCM push notifications, and exits.
 * Called by .github/workflows/video-render.yml — not the polling loop.
 *
 * `runRender` below is the whole worker as a plain, dependency-injected
 * function (client/runner/workDir/sendPush all passed in) specifically so
 * it's testable end-to-end (test/video-worker/render-single.test.ts) with
 * a fake Supabase client/storage/push sender and the REAL local ffmpeg --
 * `main()` is just the thin CLI wrapper that builds real dependencies from
 * env vars and calls it. No behavior changed by this split: main() does
 * exactly what it always did, just via runRender.
 *
 * Motion selection (2026-09-23, revised same day): before falling back to
 * stock footage/UI screenshots, checks whether this approved script
 * carries an EXPLICIT `motionScenePlan` reference (scenePlanId + a content
 * hash) to one of the hand-authored, verified-evidence pilots
 * (src/shortform/pilots.ts) -- see motionCatalog.ts's resolveMotionScenePlan
 * for the full contract. Hook-TEXT matching alone was the original design
 * and was found insufficient (a coincidentally identical hook on a script
 * with different approved body/figures/claims would still have selected
 * that pilot's canned narration) -- fixed by requiring an explicit
 * reference embedded at generation time, hash-verified against the
 * CURRENT plan at render time, so neither a same-hook-different-body
 * script nor a stale/modified plan can select the wrong content. When it
 * resolves, the whole video is built from that ScenePlan via
 * scenePlanAdapter.ts (the same validated adapter proven in
 * scripts/video-factory/renderScenePlanLocally.ts) instead of the
 * shot-list/stock-footage path below -- narration comes from the SAME
 * generateVoiceover (edge-tts) call every other campaign already uses,
 * just once per scene. When no reference is present (the normal case for
 * the vast majority of campaigns), the existing pipeline runs completely
 * unchanged. Either way, `RenderRunResult.motionSelection` records exactly
 * what was decided and why -- never a silent choice in either direction.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "../../src/lib/supabaseClient.js";
import {
  reserveVideoStorageBytes,
  commitVideoStorageReservation,
  releaseVideoStorageReservation,
} from "../../src/video/videoStorageReservation.js";
import { MAX_VIDEO_STORAGE_BYTES } from "../../src/video/videoRenderEligibility.js";
import { loadFromSupabase, assertApproved } from "../video-factory/loadApprovedScript.js";
import { generateVoiceover, DEFAULT_VOICE } from "../video-factory/voiceover.js";
import { buildCaptionCues, buildAssFile, mergeBrandNameWordCues } from "../video-factory/captions.js";
import { buildScenePlan, buildSceneLabelCues } from "../video-factory/scenes.js";
import { renderVideo, renderThumbnailCard } from "../video-factory/render.js";
import { assignUiScreens, assignHookFallbackScreen, copyUiScreenToDir } from "../video-factory/uiScreens.js";
import { pickMusic } from "../video-factory/music.js";
import { copyClipToDir, fetchStockClip, getSceneQuery, getVideoQuery, type StockFootageCredentials } from "../video-factory/stockFootage.js";
import { inspectClip } from "../video-factory/clipQuality.js";
import { runFfprobeJson, validateOutput } from "../video-factory/validate.js";
import { createProcessRunner, requireExecutable, type ProcessRunner } from "../video-factory/processRunner.js";
import { sendRenderNotification } from "./pushSender.js";
import type { RenderPlan } from "../video-factory/types.js";
import { JobQueue } from "../../src/jobs/jobQueue.js";
import { SupabaseJobQueueRepository } from "../../src/jobs/supabaseJobQueueRepository.js";
import { PUBLISH_YOUTUBE_JOB_TYPE } from "../../src/video/youtubePublishJob.js";
import { PUBLISH_TIKTOK_JOB_TYPE } from "../../src/video/tiktokPublishJob.js";
import { resolveMotionScenePlan, summarizeUsedAssets, type CatalogAssetSummary } from "../video-factory/motionCatalog.js";
import { buildRenderPlanScenes, applyRealDurations, synthesizeProductionNarrationAudio, synthesizeRealNarrationAudio, synthesizeSilentNarration, synthesizeSuppliedNarrationAudio } from "../video-factory/scenePlanAdapter.js";
import { findSuppliedVoice } from "../video-factory/suppliedVoice.js";
import { loadManifest } from "../../src/shortform/scenePlan.js";
import { isPayoffPlan, isNarratedMockPlan, MOCK_NARRATION } from "../../src/shortform/motionPlans.js";
import { mockStyleFor } from "../../src/shortform/mockStyle.js";
import { assertMeetsRenderBar } from "../../src/shortform/storyScore.js";
import { PAYOFF_SPEECH_RATE, PAYOFF_TRANSITION_SECONDS } from "../video-factory/payoffCues.js";
import type { ScenePlan } from "../../src/shortform/types.js";

const STORAGE_BUCKET = "rendered-videos";
// Just enough tail that TTS/AAC never clips the last word. No brand card or
// dead air after the voice: the script's last line flows back into the hook,
// so the video loops cleanly (rewatches are a strong TikTok ranking signal).
const SILENCE_PAD_SECONDS = 0.3;
const DEFAULT_WORK_DIR = process.env.VIDEO_WORKER_WORK_DIR ?? "/tmp/fillbook-video-worker";

// Directory name kept generic (not "_shutterstock-cache") so a future
// provider swap doesn't orphan an already-downloaded clip library.
const STOCK_CLIP_CACHE_NAME = "_stock-footage-cache";

export interface RenderWorkerDeps {
  client: SupabaseClient;
  runner: ProcessRunner;
  workDir: string;
  sendPush: typeof sendRenderNotification;
}

export interface MotionSelectionReport {
  usedVerifiedScenePlan: boolean;
  /** Always populated, both when motion was used and when it wasn't -- see motionCatalog.ts's resolveMotionScenePlan. */
  reason: string;
  assetsUsed: CatalogAssetSummary[];
  narrationProvenance: "edge_tts" | "offline_sapi" | "supplied" | "none" | null;
}

export interface RenderRunResult {
  storagePath: string;
  thumbnailPath: string | null;
  durationSeconds: number;
  motionSelection: MotionSelectionReport;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The verified-motion path: builds the ENTIRE RenderPlan from `plan`
 * (a ScenePlan resolved via its explicit, hash-verified motionScenePlan reference -- see resolveMotionScenePlan)
 * via scenePlanAdapter.ts, narrated with the same real edge-tts voice
 * every other campaign uses (just once per scene instead of once for the
 * whole script, so each scene's real spoken duration is known directly).
 * Never falls back to stock footage/UI screenshots partway through: a
 * script that matched a verified pilot's hook is that pilot's approved
 * evidence-based content end to end, or the render fails loudly (via
 * buildRenderPlanScenes' own validateScenePlan check) -- it never silently
 * substitutes unrelated generic footage for a claim it can't back up.
 */
async function buildVerifiedMotionPlan(
  scenePlan: ScenePlan,
  outDir: string,
  runner: ProcessRunner,
  outputPath: string,
  musicRotation?: number,
): Promise<{ plan: RenderPlan; assetsUsed: CatalogAssetSummary[]; narrationProvenance: "edge_tts" | "offline_sapi" | "supplied" | "none" }> {
  const manifest = loadManifest();
  // Payoff-layout plans (the retention redesign) are timed for a brisker voice and snappier cuts; every other plan is unchanged.
  const payoff = isPayoffPlan(scenePlan);
  // VIDEO_WORKER_OFFLINE_NARRATION is a local-verification-only escape
  // hatch (never set in the real GitHub Actions workflow) -- lets this
  // exact production code path be exercised end to end with zero network
  // calls, for a local proof render. Every caller must still report
  // `narrationProvenance` honestly (see RenderRunResult) rather than
  // implying the real edge-tts voice was used.
  // A plan with voiceover "none" has no speech: a silent track under the music bed, scenes as authored. Product mocks are narrated (MOCK_SPEECH_RATE, beats padded to MOCK_MIN_BEAT_SECONDS).
  // A recording the owner supplied (assets/voice/, see suppliedVoice.ts) is used for a narrated mock that has one; every other video keeps the built-in voice.
  const supplied = isNarratedMockPlan(scenePlan) ? findSuppliedVoice(scenePlan.planId, scenePlan.scenes.length) : null;
  const narration = scenePlan.voiceover === "none"
    ? await synthesizeSilentNarration(scenePlan, outDir, runner)
    : supplied
      ? await synthesizeSuppliedNarrationAudio(scenePlan, supplied, outDir, runner, MOCK_NARRATION)
    : process.env.VIDEO_WORKER_OFFLINE_NARRATION === "true"
      ? await synthesizeRealNarrationAudio(scenePlan, outDir, runner)
      : await synthesizeProductionNarrationAudio(scenePlan, outDir, runner, isNarratedMockPlan(scenePlan) ? MOCK_NARRATION : payoff ? { rate: PAYOFF_SPEECH_RATE } : {});
  const adjustedPlan = applyRealDurations(scenePlan, narration.durationsBySceneId);
  const seed = parseInt(outputPath.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0", 16) || 0;
  const styleIndex = musicRotation ?? seed;
  if (scenePlan.scenes.some((s) => s.chart?.kind === "mock")) console.log(`[render-single] mock look: ${mockStyleFor(styleIndex).id} (rotation index ${styleIndex})`);
  const adapted = await buildRenderPlanScenes(adjustedPlan, manifest, outDir, runner, narration.wordCuesBySceneId, styleIndex);

  const assPath = join(outDir, "captions.ass");
  writeFileSync(assPath, buildAssFile(adapted.captionCues, adapted.sceneLabelCues), "utf-8");

  const music = await pickMusic(seed, adapted.totalDurationSeconds, runner, undefined, musicRotation);
  console.log(`[render-single] music: ${music ? `${music.file.split(/[\\/]/).pop()} from ${music.startSeconds}s` : "none"} (rotation index ${musicRotation ?? "unavailable, chosen from the render id"})`);

  const plan: RenderPlan = {
    scenes: adapted.scenes,
    totalDurationSeconds: adapted.totalDurationSeconds,
    voiceoverPath: narration.voiceoverPath,
    assPath,
    outputPath,
    silencePadSeconds: SILENCE_PAD_SECONDS,
    ...(payoff ? { maxTransitionSeconds: PAYOFF_TRANSITION_SECONDS } : {}),
    musicFile: music?.file,
    musicStartSeconds: music?.startSeconds,
  };
  return { plan, assetsUsed: summarizeUsedAssets(adjustedPlan, manifest), narrationProvenance: narration.provenance === "offline_sapi" ? "offline_sapi" : narration.provenance === "none" ? "none" : narration.provenance === "supplied" ? "supplied" : "edge_tts" };
}

/** The existing, unchanged stock-footage/UI-screenshot path -- exactly the same logic this file always ran, just factored out so buildRenderPlan can choose between it and the verified-motion path above. */
async function buildStockFootagePlan(
  pkg: Awaited<ReturnType<typeof loadFromSupabase>>,
  outDir: string,
  runner: ProcessRunner,
  workDir: string,
  outputPath: string,
  musicRotation?: number,
): Promise<RenderPlan> {
  const voiceover = await generateVoiceover(pkg.videoScript.script, outDir, runner, DEFAULT_VOICE);
  const totalDurationSeconds = voiceover.durationSeconds + SILENCE_PAD_SECONDS;
  const wordCues = mergeBrandNameWordCues(voiceover.wordCues);
  const captionCues = buildCaptionCues(wordCues);
  const scenes = buildScenePlan(pkg.videoScript.shotList, totalDurationSeconds, wordCues);
  const sceneLabelCues = buildSceneLabelCues(scenes);
  const assPath = join(outDir, "captions.ass");
  writeFileSync(assPath, buildAssFile(captionCues, sceneLabelCues), "utf-8");

  // Assign video clip backgrounds to each scene -- searches Pexels and
  // Pixabay together (either key may be unset; fetchStockClip just skips
  // whichever provider has none), so the effective clip pool is the union
  // of both free libraries rather than one at a time.
  const stockCredentials: StockFootageCredentials = {
    pexelsApiKey: process.env.PEXELS_API_KEY ?? null,
    pixabayApiKey: process.env.PIXABAY_API_KEY ?? null,
  };
  const hasAnyStockProvider = Boolean(stockCredentials.pexelsApiKey || stockCredentials.pixabayApiKey);
  console.log(
    `[render-single] stock footage providers: pexels=${Boolean(stockCredentials.pexelsApiKey)} pixabay=${Boolean(stockCredentials.pixabayApiKey)}`,
  );
  const videoRenderIdLike = outputPath;
  const seed = parseInt(videoRenderIdLike.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0", 16) || 0;
  // Product scenes get a real Fillbook app screenshot (a slow vertical pan)
  // instead of stock B-roll or a flat card. Copying to outDir happens once,
  // below, after the hook fallback (next) has had its own chance to assign
  // an imagePath too -- otherwise a hook-fallback screen would be left
  // pointing at the bundled assets path instead of this render's own copy.
  assignUiScreens(scenes, seed);
  console.log(`[render-single] UI screenshots: ${scenes.filter((s) => s.imagePath).length}/${scenes.length} scenes are real app screens`);

  let scenesWithClip = 0;
  const stockClipCache = join(workDir, STOCK_CLIP_CACHE_NAME);
  // Every stock clip is looked at before it is used: the relevance filter only reads a clip's title and
  // tags, so blank-white and green-screen clips (both reached a real render on 2026-09-20) used to get through.
  const clipOptions = {
    qualityCheck: (clipPath: string) => inspectClip(clipPath, runner, outDir),
    onRejected: (clipId: string, reason: string) => console.log(`[render-single] rejected stock clip ${clipId}: ${reason}`),
  };
  for (const [i, scene] of scenes.entries()) {
    if (scene.imagePath) continue;
    if (hasAnyStockProvider) {
      // Prefer footage that matches what is being said over this scene; if that search
      // comes back empty, fall back to the scene kind's generic rotation before giving up.
      const query = getSceneQuery(scene, seed + i);
      if (query) {
        let cached = await fetchStockClip(query, scene.durationSeconds, stockClipCache, stockCredentials, clipOptions);
        if (!cached) {
          const fallbackQuery = getVideoQuery(scene.kind, seed + i);
          if (fallbackQuery && fallbackQuery !== query) {
            cached = await fetchStockClip(fallbackQuery, scene.durationSeconds, stockClipCache, stockCredentials, clipOptions);
          }
        }
        if (cached) {
          scene.clipPath = copyClipToDir(cached, outDir);
          scenesWithClip++;
          console.log(`[render-single] scene ${i} (${scene.kind}): real footage for query "${query}"`);
        } else {
          // fetchStockClip swallows the real reason (no matching results,
          // relevance filter rejected everything, or a network/API
          // failure) by design -- see its own doc comment ("no clip is
          // strictly better than an off-topic clip"). This is deliberately
          // the one place that surfaces WHICH scenes fell back, since that
          // was previously invisible in every render log.
          console.log(`[render-single] scene ${i} (${scene.kind}): no clip found for query "${query}" -- falling back to solid color`);
        }
      }
    }
  }
  console.log(`[render-single] stock footage: ${scenesWithClip}/${scenes.length} scenes got real footage`);

  // Retention-critical: the hook scene (the first ~1-3s, when a viewer decides whether to stay)
  // must never fall through to a flat color card just because stock footage wasn't configured or
  // no relevant clip was found. This only fills a hook scene that still has neither imagePath nor
  // clipPath at this point -- see assignHookFallbackScreen's own doc comment for why.
  assignHookFallbackScreen(scenes, seed);
  for (const scene of scenes) {
    if (scene.imagePath) scene.imagePath = copyUiScreenToDir(scene.imagePath, outDir);
  }
  console.log(`[render-single] hook scene visual: ${scenes[0]?.imagePath ? "screenshot" : scenes[0]?.clipPath ? "stock footage" : "FLAT COLOR CARD (retention risk)"}`);

  const music = await pickMusic(seed, totalDurationSeconds, runner, undefined, musicRotation);
  if (music) console.log(`[render-single] music: ${music.file.split(/[\/]/).pop()} from ${music.startSeconds}s`);

  return {
    scenes,
    totalDurationSeconds,
    voiceoverPath: voiceover.mp3Path,
    assPath,
    outputPath,
    silencePadSeconds: SILENCE_PAD_SECONDS,
    musicFile: music?.file,
    musicStartSeconds: music?.startSeconds,
  };
}

/**
 * This render's place among all renders, oldest first: how many render rows were created before it. Music walks through the
 * bundled tracks in that order, so no two consecutive renders share a track and every track plays before any repeats.
 * Undefined if the lookup fails (the track then comes from the render's own id, as before): music is never worth failing a render.
 */
async function musicRotationIndex(client: SupabaseClient, videoRenderId: string): Promise<number | undefined> {
  try {
    const { data: row } = await client.from("video_renders").select("created_at").eq("id", videoRenderId).maybeSingle();
    const createdAt = (row as { created_at?: string } | null)?.created_at;
    if (!createdAt) return undefined;
    const { count, error } = await client.from("video_renders").select("id", { count: "exact", head: true }).lt("created_at", createdAt);
    return error || count === null ? undefined : count;
  } catch (err) {
    console.warn("[render-single] music rotation lookup failed, using the render id:", (err as Error).message ?? err);
    return undefined;
  }
}

export async function runRender(videoRenderId: string, campaignAssetId: string, deps: RenderWorkerDeps): Promise<RenderRunResult> {
  const { client, runner, workDir, sendPush } = deps;
  await requireExecutable(runner, "ffmpeg", ["-version"]);
  await requireExecutable(runner, "ffprobe", ["-version"]);
  await requireExecutable(runner, "python3", ["--version"]);

  await client
    .from("video_renders")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", videoRenderId);

  const pkg = await loadFromSupabase(campaignAssetId, client);
  assertApproved(pkg);

  const outDir = join(workDir, videoRenderId);
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, "final.mp4");

  const musicRotation = await musicRotationIndex(client, videoRenderId);
  const motionMatch = resolveMotionScenePlan(pkg.videoScript);
  console.log(`[render-single] motion selection: ${motionMatch.reason}`);

  let plan: RenderPlan;
  let motionSelection: MotionSelectionReport;
  if (motionMatch.plan) {
    // Owner rule: only concepts that grade A or A+ are rendered, including ones approved before the rule existed.
    assertMeetsRenderBar(motionMatch.plan);
    const built = await buildVerifiedMotionPlan(motionMatch.plan, outDir, runner, outputPath, musicRotation);
    plan = built.plan;
    motionSelection = { usedVerifiedScenePlan: true, reason: motionMatch.reason, assetsUsed: built.assetsUsed, narrationProvenance: built.narrationProvenance };
  } else {
    plan = await buildStockFootagePlan(pkg, outDir, runner, workDir, outputPath, musicRotation);
    motionSelection = { usedVerifiedScenePlan: false, reason: motionMatch.reason, assetsUsed: [], narrationProvenance: null };
  }
  console.log(`[render-single] motion selection result: ${JSON.stringify(motionSelection)}`);

  await renderVideo(plan, runner);

  const ffprobeResult = await runFfprobeJson(outputPath, runner);
  const fileSizeBytes = statSync(outputPath).size;
  // Logged plainly (not just on failure) so a future storage-upload
  // rejection -- e.g. "The object exceeded the maximum allowed size", a
  // real production failure this fixed 2026-09-17 by lowering CRF and
  // adding a bitrate cap -- has an actual number in the run log to
  // diagnose against, instead of only the opaque Supabase error message.
  console.log(`[render-single] output size: ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB, duration: ${plan.totalDurationSeconds.toFixed(1)}s`);
  const validation = validateOutput(ffprobeResult, fileSizeBytes, plan.totalDurationSeconds);
  if (!validation.passed) {
    throw new Error(
      `Render validation failed: ${validation.checks
        .filter((c) => !c.passed)
        .map((c) => c.name)
        .join(", ")}`
    );
  }

  const reservation = await reserveVideoStorageBytes(client, videoRenderId, fileSizeBytes, MAX_VIDEO_STORAGE_BYTES);
  if (!reservation.eligible) {
    throw new Error(reservation.reason ?? "storage_cap_reached");
  }

  const storagePath = `${videoRenderId}.mp4`;
  try {
    const fileBuffer = readFileSync(outputPath);
    const { error: uploadError } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: false });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
    await commitVideoStorageReservation(client, reservation.reservationId as string);
  } catch (err) {
    await releaseVideoStorageReservation(client, reservation.reservationId);
    throw err;
  }

  // Best-effort: a downloadable thumbnail is a nice-to-have on top of an
  // already-successful video, not a correctness requirement -- a failure
  // here never fails the whole render, it just leaves thumbnail_path null
  // for this row.
  let thumbnailPath: string | null = null;
  try {
    const thumbnailLocalPath = join(outDir, "thumbnail.jpg");
    await renderThumbnailCard(pkg.videoScript.hook, thumbnailLocalPath, runner);
    const candidatePath = `${videoRenderId}-thumbnail.jpg`;
    const { error: thumbUploadError } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(candidatePath, readFileSync(thumbnailLocalPath), { contentType: "image/jpeg", upsert: false });
    if (thumbUploadError) throw new Error(`Thumbnail upload failed: ${thumbUploadError.message}`);
    thumbnailPath = candidatePath;
  } catch (err) {
    console.error("[render-single] thumbnail generation failed (non-fatal):", (err as Error).message ?? err);
  }

  const durationSeconds = Number(ffprobeResult.format.duration ?? plan.totalDurationSeconds);
  await client
    .from("video_renders")
    // error: null clears any stale message from a prior failed attempt on
    // the same render row (render-single doesn't reuse rows, but belt-and-
    // suspenders against a future retry path).
    .update({
      status: "ready",
      storage_path: storagePath,
      thumbnail_path: thumbnailPath,
      duration_seconds: durationSeconds,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoRenderId);

  // Automated YouTube publishing (Phase 1, 2026-09-22) -- gated behind its
  // own flag so this file is safe to merge/deploy without immediately
  // going live: with the flag unset (the default), behavior here is
  // byte-for-byte what it was before this feature existed. Enqueuing
  // through the shared job queue (rather than publishing inline, right
  // here) keeps a transient YouTube/network failure from ever affecting
  // this render's own success -- the render is already 'ready' by this
  // point regardless of whether the publish job later succeeds or fails.
  if (process.env.YOUTUBE_PUBLISHING_ENABLED === "true") {
    const jobQueue = new JobQueue(new SupabaseJobQueueRepository(client));
    await jobQueue.enqueue({
      jobType: PUBLISH_YOUTUBE_JOB_TYPE,
      payload: { videoRenderId },
      idempotencyKey: `${PUBLISH_YOUTUBE_JOB_TYPE}:${videoRenderId}`,
      maxAttempts: 3,
    });
    console.log(`[render-single] enqueued ${PUBLISH_YOUTUBE_JOB_TYPE} for ${videoRenderId}`);
  }

  // Automated TikTok drafting -- same reasoning and gating as YouTube above,
  // its own flag. "Publishing" here means TikTok's inbox/draft flow (see
  // tiktokPublishJob.ts): the owner still opens the TikTok app to finish
  // posting, matching externalWriteFirewall.ts's permanent rejection of
  // tiktok.publish_video (TikTok's real Direct Post).
  if (process.env.TIKTOK_PUBLISHING_ENABLED === "true") {
    const jobQueue = new JobQueue(new SupabaseJobQueueRepository(client));
    await jobQueue.enqueue({
      jobType: PUBLISH_TIKTOK_JOB_TYPE,
      payload: { videoRenderId },
      idempotencyKey: `${PUBLISH_TIKTOK_JOB_TYPE}:${videoRenderId}`,
      maxAttempts: 3,
    });
    console.log(`[render-single] enqueued ${PUBLISH_TIKTOK_JOB_TYPE} for ${videoRenderId}`);
  }

  // Send FCM push to all non-revoked devices
  const [{ data: devices }, { data: render }] = await Promise.all([
    client.from("device_push_tokens").select("fcm_token").is("revoked_at", null),
    client
      .from("video_renders")
      .select("campaign_assets(campaigns(thesis))")
      .eq("id", videoRenderId)
      .maybeSingle(),
  ]);

  const campaignTitle =
    (render as { campaign_assets?: { campaigns?: { thesis?: string } } } | null)
      ?.campaign_assets?.campaigns?.thesis ?? "Your video";

  for (const device of (devices ?? []) as Array<{ fcm_token: string }>) {
    await sendPush(device.fcm_token, { videoRenderId, kind: "ready", campaignTitle });
  }

  console.log(`[render-single] done: ${videoRenderId} → ${storagePath}`);
  return { storagePath, thumbnailPath, durationSeconds, motionSelection };
}

/**
 * Pushes "render failed" to every registered device (owner request, 2026-10-04: a failed render was silent until the owner opened the
 * app). Best effort: a push problem must never mask the real failure, so it never throws.
 */
export async function notifyRenderFailed(
  client: SupabaseClient,
  videoRenderId: string,
  message: string,
  sendPush: typeof sendRenderNotification,
): Promise<void> {
  try {
    const [{ data: devices }, { data: render }] = await Promise.all([
      client.from("device_push_tokens").select("fcm_token").is("revoked_at", null),
      client.from("video_renders").select("campaign_assets(campaigns(thesis))").eq("id", videoRenderId).maybeSingle(),
    ]);
    const campaignTitle =
      (render as { campaign_assets?: { campaigns?: { thesis?: string } } } | null)?.campaign_assets?.campaigns?.thesis ?? "Your video";
    for (const device of (devices ?? []) as Array<{ fcm_token: string }>) {
      await sendPush(device.fcm_token, { videoRenderId, kind: "failed", campaignTitle, error: message.slice(0, 120) });
    }
  } catch (err) {
    console.error("[render-single] failure push could not be sent:", (err as Error).message ?? err);
  }
}

async function main(): Promise<void> {
  const videoRenderId = requireEnv("VIDEO_RENDER_ID");
  const campaignAssetId = requireEnv("CAMPAIGN_ASSET_ID");

  const client = createClient(SUPABASE_URL, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const runner = createProcessRunner();

  await runRender(videoRenderId, campaignAssetId, { client, runner, workDir: DEFAULT_WORK_DIR, sendPush: sendRenderNotification });
}

// Only runs main() (which needs real env vars and touches a real Supabase
// project) when this file is actually invoked as the CLI entrypoint (the
// GitHub Actions workflow's `npx tsx render-single.ts`) -- NOT merely
// imported for its `runRender` export, which test/video-worker/
// render-single.test.ts does. Before this check existed, importing this
// module for testing unconditionally ran main() too, which failed
// immediately (VIDEO_RENDER_ID unset in a test process) and set
// process.exitCode = 1 as a side effect of the import itself -- silently
// poisoning the whole test run's exit code regardless of whether the
// actual tests passed.
const isMainModule = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (isMainModule) {
  main().catch(async (err) => {
    const message = (err as Error).message ?? String(err);
    console.error("[render-single] fatal:", message);
    // Write the failure back to the DB so the app shows the real error instead
    // of leaving the render stuck in "rendering" forever (the old Oracle VM
    // worker did this; this script previously did not).
    try {
      const videoRenderId = process.env.VIDEO_RENDER_ID;
      if (videoRenderId) {
        const { createClient } = await import("@supabase/supabase-js");
        const { SUPABASE_URL } = await import("../../src/lib/supabaseClient.js");
        const client = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
          auth: { persistSession: false },
        });
        await client
          .from("video_renders")
          .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
          .eq("id", videoRenderId);
        await notifyRenderFailed(client, videoRenderId, message, sendRenderNotification);
      }
    } catch (dbErr) {
      console.error("[render-single] also failed to write failure to DB:", (dbErr as Error).message ?? dbErr);
    }
    process.exitCode = 1;
  });
}
