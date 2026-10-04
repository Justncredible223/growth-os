#!/usr/bin/env node
/**
 * Renders the "payoff" redesign variants of a pilot (src/shortform/payoffPilots.ts) through the real renderer --
 * the same narration -> real-duration validation -> adapter -> render.ts path scripts/video-worker/render-single.ts
 * uses for a verified-motion video.
 *
 * LOCAL ONLY: writes MP4s under out/payoff/<planId>/. No upload, no publish, no Supabase, no GitHub Actions. The one
 * network call is the free edge-tts voice (the same voice every campaign uses); pass --voice=offline for Windows SAPI
 * with no network at all (never the production voice).
 *
 *   npx tsx scripts/video-factory/renderPayoffLocally.ts [a|b|c] [--voice=edge|offline]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MOTION_SCENE_PLANS, isPayoffPlan, isNarratedMockPlan, MOCK_NARRATION } from "../../src/shortform/motionPlans.js";
import { loadManifest } from "../../src/shortform/scenePlan.js";
import { applyRealDurations, buildRenderPlanScenes, synthesizeProductionNarrationAudio, synthesizeRealNarrationAudio, synthesizeSilentNarration } from "./scenePlanAdapter.js";
import { buildAssFile } from "./captions.js";
import { PAYOFF_SPEECH_RATE, PAYOFF_TRANSITION_SECONDS } from "./payoffCues.js";
import { renderVideo } from "./render.js";
import { pickMusic } from "./music.js";
import { createProcessRunner } from "./processRunner.js";
import type { RenderPlan } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(here, "..", "..", "out", "payoff");
const SILENCE_PAD_SECONDS = 0.3;

async function main() {
  const voice = process.argv.find((a) => a.startsWith("--voice="))?.slice("--voice=".length) ?? "edge";
  if (voice !== "edge" && voice !== "offline") throw new Error(`--voice must be "edge" or "offline", got "${voice}".`);
  const filter = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const plans = MOTION_SCENE_PLANS.filter(isPayoffPlan).filter((p) => !filter || p.planId.includes(filter));
  if (plans.length === 0) throw new Error(`No payoff plan matches "${filter}".`);

  const manifest = loadManifest();
  const runner = createProcessRunner();
  mkdirSync(OUT_ROOT, { recursive: true });

  for (const plan of plans) {
    const outDir = join(OUT_ROOT, plan.planId);
    mkdirSync(outDir, { recursive: true });
    console.log(`\n=== ${plan.planId} (${voice} voice) ===`);
    const narration =
      plan.voiceover === "none"
        ? await synthesizeSilentNarration(plan, outDir, runner)
        : voice === "offline"
          ? await synthesizeRealNarrationAudio(plan, outDir, runner)
          : await synthesizeProductionNarrationAudio(plan, outDir, runner, isNarratedMockPlan(plan) ? MOCK_NARRATION : { rate: PAYOFF_SPEECH_RATE });
    const adjusted = applyRealDurations(plan, narration.durationsBySceneId);
    const adapted = await buildRenderPlanScenes(adjusted, manifest, outDir, runner, narration.wordCuesBySceneId);
    const assPath = join(outDir, "captions.ass");
    writeFileSync(assPath, buildAssFile(adapted.captionCues, adapted.sceneLabelCues), "utf-8");
    const outputPath = join(outDir, "final.mp4");
    const music = await pickMusic(parseInt(plan.planId.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0", 16) || 0, adapted.totalDurationSeconds, runner);
    const renderPlan: RenderPlan = {
      scenes: adapted.scenes,
      totalDurationSeconds: adapted.totalDurationSeconds,
      voiceoverPath: narration.voiceoverPath,
      assPath,
      outputPath,
      silencePadSeconds: SILENCE_PAD_SECONDS,
      maxTransitionSeconds: PAYOFF_TRANSITION_SECONDS,
      musicFile: music?.file,
      musicStartSeconds: music?.startSeconds,
    };
    // ffmpeg intermittently dies with "Cannot allocate memory" (exit -12) on these filter graphs (also seen on the
    // owner's machine, 2026-09-25). It is not deterministic, so retry once before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        await renderVideo(renderPlan, runner);
        break;
      } catch (err) {
        const oom = err instanceof Error && /Cannot allocate memory/.test(err.message);
        if (!oom || attempt >= 3) throw err;
        console.log(`  ffmpeg ran out of memory (attempt ${attempt}); retrying`);
      }
    }
    const sceneSeconds = adapted.scenes.map((s) => s.durationSeconds.toFixed(1)).join(" / ");
    console.log(`Rendered ${outputPath}\n  ${adapted.totalDurationSeconds.toFixed(1)}s total; scenes ${sceneSeconds}s; narration: ${narration.provenance}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
