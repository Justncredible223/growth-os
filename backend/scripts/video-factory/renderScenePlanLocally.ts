#!/usr/bin/env node
/**
 * Renders a pilot ScenePlan (src/shortform/pilots.ts) through the REAL
 * production renderer -- render.ts's renderVideo/buildFfmpegArgs, the
 * exact same code scripts/video-worker/render-single.ts calls in the
 * GitHub Actions worker -- not a second, standalone preview pipeline.
 *
 * LOCAL TEST ONLY: no network calls (no edge-tts, no Supabase, no GitHub
 * Actions), no upload, no publish. Narration audio is a silent placeholder
 * (see scenePlanAdapter's buildSilentPlaceholderAudio) since generating
 * real narration needs edge-tts, a network call this task explicitly
 * disables -- every report from this script must say audio sync is
 * UNVERIFIED, never imply a finished, ready-to-publish render.
 *
 *   npx tsx scripts/video-factory/renderScenePlanLocally.ts pilot-3
 *   npx tsx scripts/video-factory/renderScenePlanLocally.ts chart-bars-sized-up   (motion-render concepts work too)
 *   npx tsx scripts/video-factory/renderScenePlanLocally.ts chart-bars-conviction 5   (a mock concept in the look for rotation index 5)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PILOTS } from "../../src/shortform/pilots.js";
import { MOTION_SCENE_PLANS } from "../../src/shortform/motionPlans.js";
import { loadManifest } from "../../src/shortform/scenePlan.js";
import { buildRenderPlanScenes, buildSilentPlaceholderAudio } from "./scenePlanAdapter.js";
import { buildAssFile } from "./captions.js";
import { renderVideo } from "./render.js";
import { createProcessRunner } from "./processRunner.js";
import type { RenderPlan } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(here, "..", "..", "out", "render-test");
const SILENCE_PAD_SECONDS = 0.3;

async function main() {
  const filter = process.argv[2];
  const plans = [...PILOTS, ...MOTION_SCENE_PLANS].filter((p) => !filter || p.planId.includes(filter));
  if (plans.length === 0) throw new Error(`No pilot matches "${filter}".`);

  const manifest = loadManifest();
  const runner = createProcessRunner();
  mkdirSync(OUT_ROOT, { recursive: true });

  for (const plan of plans) {
    const outDir = join(OUT_ROOT, plan.planId);
    mkdirSync(outDir, { recursive: true });

    const styleIndex = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
    const adapted = await buildRenderPlanScenes(plan, manifest, outDir, runner, undefined, styleIndex);

    // adapted.captionCues already IS a full CaptionCue[] (headline+caption
    // text, per-scene timing) -- not built via the real buildCaptionCues
    // (that needs real per-word TTS timing, which this local test
    // deliberately does not generate; see this file's own doc comment).
    const assPath = join(outDir, "captions.ass");
    writeFileSync(assPath, buildAssFile(adapted.captionCues, adapted.sceneLabelCues), "utf-8");

    const voiceoverPath = join(outDir, "voiceover-silent-placeholder.mp3");
    await buildSilentPlaceholderAudio(adapted.totalDurationSeconds, voiceoverPath, runner);

    const outputPath = join(outDir, "final.mp4");
    const renderPlan: RenderPlan = {
      scenes: adapted.scenes,
      totalDurationSeconds: adapted.totalDurationSeconds,
      voiceoverPath,
      assPath,
      outputPath,
      silencePadSeconds: SILENCE_PAD_SECONDS,
    };

    console.log(`\n=== Rendering ${plan.planId} through the REAL render.ts renderVideo() ===`);
    await renderVideo(renderPlan, runner);
    console.log(`Rendered: ${outputPath}`);
    console.log(`AUDIO SYNC UNVERIFIED: voiceover is a silent placeholder (${adapted.totalDurationSeconds.toFixed(1)}s) -- no real narration was generated (edge-tts is a network call, disabled for this local test).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
