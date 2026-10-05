/**
 * Converts a validated `ScenePlan` (src/shortform -- the hand-authored
 * pilot content, backed by verified-manifest.json) into a `RenderPlan`
 * (this file's own real production type, consumed by render.ts's
 * buildFfmpegArgs / renderVideo -- the SAME code the GitHub Actions worker
 * calls via scripts/video-worker/render-single.ts).
 *
 * ScenePlan and RenderPlan are genuinely different systems (see this
 * repo's own render-pipeline trace, 2026-09-23): RenderPlan scenes
 * normally get clipPath/imagePath from stockFootage.ts/uiScreens.ts,
 * driven by an LLM-generated shot list, with no concept of a verified
 * asset, a citable fact, or a claim. This adapter is the smallest bridge
 * between the two -- it does NOT change how a normal (stock-footage)
 * campaign video is produced; it only lets a ScenePlan reach the real
 * renderer at all.
 *
 * Never bypasses claim/evidence validation: `buildRenderPlanScenes` throws
 * on any structural validation failure (missing asset, insufficient
 * footage, an unevidenced/wrong-asset claim, an unreadable crop, ...)
 * rather than rendering a plan that failed validation.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessRunner } from "./processRunner.js";
import type { Scene as RenderScene } from "./types.js";
import { VideoFactoryError, type WordCue } from "./types.js";
import { alignHeadlineToSpeech, buildHeadlineWordVariants, escapeAssText, mergeBrandNameWordCues, type SceneLabelCue } from "./captions.js";
import { ASSETS_DIR, validateScenePlan } from "../../src/shortform/scenePlan.js";
import type { CaptionCue } from "./types.js";
import type { ScenePlan, SceneSpec, VerifiedManifest, VerifiedAsset } from "../../src/shortform/types.js";
import { synthesizeOfflineNarration } from "./localTts.js";
import { generateVoiceover, measureAudioDuration, DEFAULT_VOICE } from "./voiceover.js";
import { BOUNDARY_SILENCE_SECONDS, SILENCE_THRESHOLD_DB, parseSilences, speechSegments, splitProblem, type Segment, type SuppliedVoice } from "./suppliedVoice.js";
import { CARD_SHADOW_SPREAD, PLATFORM_OVERLAY_ZONES, assertCardClearsOverlays, computeCardLayout, type CardLayout } from "./render.js";
import { computePayoffCard, type PayoffCard } from "../../src/shortform/payoffLayout.js";
import { PAYOFF_BACKGROUNDS, buildPayoffCues, buildPayoffCursorCues } from "./payoffCues.js";
import { buildChartCues } from "./chartCues.js";
import { createMockRenderer, type MockRenderer } from "./mockCard.js";
import { mockStyleFor } from "../../src/shortform/mockStyle.js";

export interface AdaptedScenes {
  scenes: RenderScene[];
  captionCues: CaptionCue[];
  sceneLabelCues: SceneLabelCue[];
  totalDurationSeconds: number;
}

function findAsset(manifest: VerifiedManifest, assetId: string): VerifiedAsset {
  const asset = manifest.assets.find((a) => a.id === assetId);
  if (!asset) throw new VideoFactoryError(`Adapter: asset "${assetId}" is not in the manifest (should have been caught by validateScenePlan).`);
  return asset;
}

/**
 * Crops a still image asset to `crop` (source pixel coordinates) and
 * blacks out any of the asset's own `privateRegions` that overlap it,
 * writing the result into `outDir` -- so the unmodified, existing
 * `imagePath` render path (a full-image pan, with no crop support of its
 * own) only ever sees an image that is already exactly the intended
 * evidence crop. Pure local ffmpeg, no network.
 */
async function buildCroppedStill(asset: VerifiedAsset, crop: { x: number; y: number; w: number; h: number }, outDir: string, runner: ProcessRunner, index: number): Promise<string> {
  const srcPath = join(ASSETS_DIR, asset.file);
  const outPath = join(outDir, `still-${index}-${asset.id.replace(/[^a-z0-9.-]/gi, "_")}.png`);
  const filters = [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`];
  for (const pr of asset.privateRegions ?? []) {
    const mx = pr.region.x - crop.x;
    const my = pr.region.y - crop.y;
    if (mx + pr.region.w <= 0 || my + pr.region.h <= 0 || mx >= crop.w || my >= crop.h) continue;
    filters.push(`drawbox=x=${mx}:y=${my}:w=${pr.region.w}:h=${pr.region.h}:color=black:t=fill`);
  }
  const result = await runner.run("ffmpeg", ["-y", "-i", srcPath, "-vf", filters.join(","), outPath], {});
  if (result.exitCode !== 0) throw new VideoFactoryError(`Adapter: failed to pre-crop still asset ${asset.id}: ${result.stderr || result.stdout}`);
  return outPath;
}

/** Where a text-only card scene's headline block starts. */
const TEXT_ONLY_CARD_TOP = 880;

/** The designed full-canvas background shared by every card scene: a deep blue-to-near-black vertical gradient. */
async function buildCardBackground(outDir: string, runner: ProcessRunner, theme: "bright" | "dark" = "dark"): Promise<string> {
  const outPath = join(outDir, theme === "dark" ? "card-background.png" : `card-background-${theme}.png`);
  const { top, bottom } = PAYOFF_BACKGROUNDS[theme];
  const result = await runner.run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `gradients=s=1080x1920:c0=${top}:c1=${bottom}:x0=540:y0=0:x1=540:y1=1500:nb_colors=2`,
    "-frames:v", "1", outPath,
  ], {});
  if (result.exitCode !== 0) throw new VideoFactoryError(`Adapter: failed to build the card background: ${result.stderr || result.stdout}`);
  return outPath;
}

/** A rounded-rectangle alpha mask for the card, and a soft pre-blurred shadow CARD_SHADOW_SPREAD larger on every side. */
async function buildCardMaskAndShadow(layout: Pick<CardLayout, "width" | "height" | "radius">, outDir: string, runner: ProcessRunner, index: number, glow?: { r: number; g: number; b: number; alpha: number }): Promise<{ maskPath: string; shadowPath: string }> {
  const r = layout.radius;
  const inside = (pad: number) =>
    `if(gt(abs(X-W/2),W/2-${pad})+gt(abs(Y-H/2),H/2-${pad}),0,` +
    `if(gt(abs(X-W/2),W/2-${pad + r})*gt(abs(Y-H/2),H/2-${pad + r}),lte(hypot(abs(X-W/2)-(W/2-${pad + r}),abs(Y-H/2)-(H/2-${pad + r})),${r}),1))`;
  const maskPath = join(outDir, `card-mask-${index}.png`);
  const mask = await runner.run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=black:s=${layout.width}x${layout.height},format=gray`,
    "-vf", `geq=lum='255*${inside(0)}'`, "-frames:v", "1", maskPath,
  ], {});
  if (mask.exitCode !== 0) throw new VideoFactoryError(`Adapter: failed to build card mask ${index}: ${mask.stderr || mask.stdout}`);
  const shadowPath = join(outDir, `card-shadow-${index}.png`);
  const spread = CARD_SHADOW_SPREAD;
  const shadow = await runner.run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=black@0:s=${layout.width + 2 * spread}x${layout.height + 2 * spread},format=rgba`,
    "-vf", `geq=r=${glow?.r ?? 0}:g=${glow?.g ?? 0}:b=${glow?.b ?? 0}:a='${glow?.alpha ?? 150}*${inside(spread)}',boxblur=24:2`, "-frames:v", "1", shadowPath,
  ], {});
  if (shadow.exitCode !== 0) throw new VideoFactoryError(`Adapter: failed to build card shadow ${index}: ${shadow.stderr || shadow.stdout}`);
  return { maskPath, shadowPath };
}

/**
 * Validates `plan` against `manifest` (throws on any error-severity issue
 * -- never renders an invalid plan), then builds everything render.ts's
 * `RenderPlan` needs from it: per-scene Scene records (clipPath/imagePath/
 * sourceCrop/privacyMasks/clipTimeRangeSeconds/label), CaptionCue[] (the
 * headline+caption text, since a ScenePlan has no per-word TTS timing to
 * build the real word-highlight cues from -- see the caller's own
 * "audio synchronization unverified" reporting), and SceneLabelCue[]
 * (disclosure text, reusing the exact mechanism scenes.ts already uses for
 * "FILLBOOK · EXAMPLE DATA").
 */
export async function buildRenderPlanScenes(
  plan: ScenePlan,
  manifest: VerifiedManifest,
  outDir: string,
  runner: ProcessRunner,
  /** Real per-scene word timings from the production voice. When given, the FIRST scene's headline is highlighted word by word as it is spoken; omitted (offline voice, silent previews), every headline stays plain static text. */
  wordCuesBySceneId?: Record<string, WordCue[]>,
  /** Position of this video in the render rotation; picks its mock look (palette, alignment, window chrome). Omitted, the original look. */
  styleIndex?: number,
): Promise<AdaptedScenes> {
  const validation = validateScenePlan(plan, manifest, { checkFiles: true });
  if (!validation.ok) {
    const errors = validation.issues.filter((i) => i.severity === "error").map((i) => `${i.sceneId}: ${i.code} -- ${i.message}`);
    throw new VideoFactoryError(`Adapter: refusing to render "${plan.planId}" -- it fails its own claim/evidence/timing validation:\n${errors.join("\n")}`);
  }
  mkdirSync(outDir, { recursive: true });
  const backgroundPath = await buildCardBackground(outDir, runner);
  // Payoff scenes pick a theme per scene; each still is built once, on first use.
  const themedBackgrounds = new Map<"bright" | "dark", string>([["dark", backgroundPath]]);
  const backgroundFor = async (theme: "bright" | "dark"): Promise<string> => {
    let path = themedBackgrounds.get(theme);
    if (!path) {
      path = await buildCardBackground(outDir, runner, theme);
      themedBackgrounds.set(theme, path);
    }
    return path;
  };

  // A "mock" chart scene is an HTML slide screenshotted by Chromium; one browser serves every mock scene of the plan.
  let mockRenderer: MockRenderer | null = null;
  const mockStyle = mockStyleFor(styleIndex);
  const scenes: RenderScene[] = [];
  const captionCues: CaptionCue[] = [];
  const sceneLabelCues: SceneLabelCue[] = [];
  let elapsed = 0;

  try {
    for (const [i, s] of plan.scenes.entries()) {
      // "hook" (render.ts) applies a push-in zoom plus a 35%-opacity black
      // scrim, designed for a generic stock-footage opener where legibility
      // of the background doesn't matter. A scene with real verified
      // evidence must never get that treatment just for being first --
      // "product" (real screenshots' own existing kind) renders it at full
      // clarity instead, regardless of scene index.
      // A chart scene names the recording its numbers come from but shows none of it, so it is never a "product" scene.
      const chart = s.layout === "chart" ? s.chart : undefined;
      const kind = s.cta ? "cta" : s.assetId && !chart ? "product" : i === 0 ? "hook" : "explanation";
      const label = s.disclosure ? s.disclosure.toUpperCase() : "";
      const backgroundColor = "0x05070a"; // brand-dark fallback for a text-only scene, matches scenes.ts's own hook/explanation color

      const renderScene: RenderScene = { kind, label, durationSeconds: s.durationSeconds, backgroundColor, narration: s.narration };
      let cardLayout: CardLayout | null = null;
      let payoffCard: PayoffCard | null = null;
      const payoff = s.layout === "payoff" ? s.payoff : undefined;
      let mockFrames: { pattern: string; count: number } | undefined;
      let sceneBackground = chart ? await backgroundFor("dark") : payoff ? await backgroundFor(payoff.theme) : backgroundPath;
      if (chart?.kind === "mock") {
        mockRenderer ??= await createMockRenderer(outDir);
        const beat = await mockRenderer.renderBeat({ chart, headline: s.headline, captionText: s.captionText, cta: s.cta, style: mockStyle }, outDir, `mock-${i}`);
        sceneBackground = beat.stillPath;
        mockFrames = { pattern: beat.pattern, count: beat.count };
      }
      if (!s.assetId || chart) renderScene.card = { backgroundPath: sceneBackground, ...(mockFrames ? { frames: mockFrames } : {}) };

      if (s.assetId && !chart) {
        const asset = findAsset(manifest, s.assetId);
        if (asset.kind === "screen_recording") {
          if (!s.clipTimeRangeSeconds) throw new VideoFactoryError(`Adapter: scene "${s.sceneId}" uses a screen_recording asset with no clipTimeRangeSeconds (should have been caught by validateScenePlan).`);
          // renderVideo() runs ffmpeg with cwd=outDir and references every
          // input by plain basename (see render.ts's renderBasename doc
          // comment) -- same convention render-single.ts's copyClipToDir
          // follows for stock footage, so a clip living outside outDir (the
          // manifest's own assets/ dir) must be copied in first.
          const destPath = join(outDir, `clip-${i}-${asset.id.replace(/[^a-z0-9.-]/gi, "_")}${asset.file.slice(asset.file.lastIndexOf("."))}`);
          copyFileSync(join(ASSETS_DIR, asset.file), destPath);
          renderScene.clipPath = destPath;
          renderScene.clipTimeRangeSeconds = s.clipTimeRangeSeconds;
          if (s.crop) renderScene.sourceCrop = s.crop;
          if (asset.privateRegions?.length) renderScene.privacyMasks = asset.privateRegions.map((pr) => pr.region);
          if (s.crop && payoff) {
            payoffCard = computePayoffCard(s.crop);
            const right = payoffCard.x + payoffCard.width;
            const bottom = payoffCard.y + payoffCard.height;
            if (right > PLATFORM_OVERLAY_ZONES.rightColumn.x || bottom > PLATFORM_OVERLAY_ZONES.captionTop) {
              throw new VideoFactoryError(`Adapter: payoff card for "${s.sceneId}" (x to ${right}, y to ${bottom}) would run under a platform overlay.`);
            }
            // A dark card on a dark theme needs an edge: a soft cool glow instead of the usual black shadow.
            const glow = payoff.theme === "dark" ? { r: 70, g: 150, b: 200, alpha: 210 } : undefined;
            const { maskPath, shadowPath } = await buildCardMaskAndShadow(payoffCard, outDir, runner, i, glow);
            renderScene.card = {
              backgroundPath: sceneBackground,
              evidence: { x: payoffCard.x, y: payoffCard.y, width: payoffCard.width, height: payoffCard.height, maskPath, shadowPath },
            };
          } else if (s.crop) {
            cardLayout = computeCardLayout(s.crop.w, s.crop.h);
            assertCardClearsOverlays(cardLayout);
            const { maskPath, shadowPath } = await buildCardMaskAndShadow(cardLayout, outDir, runner, i);
            renderScene.card = {
              backgroundPath,
              evidence: { x: cardLayout.x, y: cardLayout.y, width: cardLayout.width, height: cardLayout.height, maskPath, shadowPath },
            };
          }
        } else if (s.crop) {
          renderScene.imagePath = await buildCroppedStill(asset, s.crop, outDir, runner, i);
        } else {
          // No crop: same copy-into-outDir/basename-reference requirement as the clip case above.
          const destPath = join(outDir, `still-${i}-${asset.id.replace(/[^a-z0-9.-]/gi, "_")}${asset.file.slice(asset.file.lastIndexOf("."))}`);
          copyFileSync(join(ASSETS_DIR, asset.file), destPath);
          renderScene.imagePath = destPath;
        }
      }

      scenes.push(renderScene);

      const start = elapsed;
      const end = elapsed + s.durationSeconds;
      if (chart?.kind === "mock") {
        // Everything is already in the HTML still (headline, mock, caption, invitation); no vector text is drawn over it.
      } else if (chart) {
        // Chart layout: the headline, the chart up to this scene's beat, and the beat's caption, all drawn as vector cues.
        captionCues.push(...buildChartCues({ chart, headline: s.headline, captionText: s.captionText, cta: s.cta, start, end }));
      } else if (renderScene.card && payoff) {
        // Payoff layout: the big figure + line + caption block (animated), drawn above the zoomed card, in the top band.
        captionCues.push(...buildPayoffCues({ headline: s.headline, captionText: s.captionText, cta: s.cta, start, end, spec: payoff, hasCard: Boolean(payoffCard) }));
        if (payoff.cursor && payoffCard && s.crop && s.focalRegion) {
          captionCues.push(...buildPayoffCursorCues({ card: payoffCard, crop: s.crop, focal: s.focalRegion, start, end: end + (plan.scenes[i + 1]?.transition.durationSeconds ?? 0) }));
        }
      } else if (renderScene.card) {
        // Card layout: the headline and a smaller, softer caption as one block, directly under the evidence card, or
        // in the upper-middle of the frame on a text-only scene. The closing scene's caption uses the accent color.
        const captionColor = s.cta ? "&HCFB822&" : "&HC4B39F&";
        const marginV = cardLayout ? cardLayout.textTop : TEXT_ONLY_CARD_TOP;
        // The whole caption block for a given rendering of the headline. Text-only scenes get a short accent bar (an
        // ASS vector drawing) above the headline.
        const buildBlock = (headlineMarkup: string): string => {
          const parts = [cardLayout ? "" : `{\\p1\\c&HCFB822&}m 0 0 l 140 0 140 10 0 10{\\p0\\c&HFFFFFF&}`, headlineMarkup];
          if (s.captionText) parts.push(`{\\fs22} `, `{\\fs46\\c${captionColor}}${escapeAssText(s.captionText)}`);
          // The CTA text itself (e.g. "Follow @fillbookhq") was previously only used to pick this
          // scene's accent caption color and to feed pilotMetadata()'s cta/handlePlacement fields --
          // it was never actually painted onto the video, so a finished render never showed the
          // invitation it claimed to make (confirmed by grepping a real render's captions.ass for
          // "fillbook"/"follow": no match). Render it as its own line so the on-screen closing card
          // matches what the metadata reports.
          if (s.cta) parts.push(`{\\fs22} `, `{\\fs38\\c&HCFB822&}${escapeAssText(s.cta)}`);
          return parts.filter(Boolean).join("\\N");
        };
        // The hook (first scene): highlight its headline word by word as it is spoken, each word popping in. Only when
        // real word timings exist AND the headline is literally the first words of the narration -- otherwise the
        // highlight would land on the wrong words, so the plain static headline stays.
        const spokenHeadline = i === 0 && s.headline ? alignHeadlineToSpeech(s.headline, mergeBrandNameWordCues(wordCuesBySceneId?.[s.sceneId] ?? [])) : null;
        if (spokenHeadline) {
          for (const v of buildHeadlineWordVariants(spokenHeadline, start, end)) {
            captionCues.push({ text: buildBlock(v.markup), startSeconds: v.startSeconds, endSeconds: v.endSeconds, style: "Card", marginV });
          }
        } else {
          const text = buildBlock(s.headline ? escapeAssText(s.headline) : "");
          if (text) captionCues.push({ text, startSeconds: start, endSeconds: end, style: "Card", marginV });
        }
      } else {
        const captionParts = [s.headline, s.captionText, s.cta].filter((v): v is string => Boolean(v)).map(escapeAssText);
        const captionText = captionParts.join("\\N");
        // Hook style is middle-centered and reserves no space for anything
        // else -- correct for a pure opening beat, wrong for a scene that also
        // shows real evidence (kind "product" here). Caption is bottom-anchored,
        // clear of the evidence band render.ts's sourceCrop treatment reserves.
        if (captionText) captionCues.push({ text: captionText, startSeconds: start, endSeconds: end, style: kind === "hook" ? "Hook" : "Caption" });
      }
      // The fade into scene i+1 runs from this scene's nominal end for that transition's duration, with this
      // scene's footage still visible -- so an evidence scene keeps its label through that fade, and the next
      // scene's label waits for it to finish, never leaving fading evidence unlabeled or under another label.
      const outgoingFade = s.assetId && !chart ? (plan.scenes[i + 1]?.transition.durationSeconds ?? 0) : 0;
      const incomingDelay = i > 0 && plan.scenes[i - 1]!.assetId && plan.scenes[i - 1]!.layout !== "chart" ? s.transition.durationSeconds : 0;
      if (label) sceneLabelCues.push({ label, startSeconds: start + incomingDelay, endSeconds: end + outgoingFade, ...(renderScene.card ? { style: "CardLabel" as const } : {}) });
      elapsed = end;
    }

  } finally {
    await mockRenderer?.close();
  }

  return { scenes, captionCues, sceneLabelCues, totalDurationSeconds: elapsed };
}

/**
 * Returns a copy of `plan` with each scene's `durationSeconds` replaced by
 * its REAL measured narration duration (`durationsBySceneId`) -- every
 * other field (claims, crop, clipTimeRangeSeconds, disclosure, ...)
 * untouched. The pilots' own authored durations (pilots.ts) are a
 * best-guess for the local, silent preview; a real render must validate
 * clip-footage sufficiency and crossfade timing against what the
 * narration ACTUALLY takes to say, not that guess -- so callers building a
 * real-audio render pass the result of this through `buildRenderPlanScenes`
 * instead of the original `plan`, letting `validateScenePlan`'s own timing
 * checks run against real numbers.
 */
export function applyRealDurations(plan: ScenePlan, durationsBySceneId: Record<string, number>): ScenePlan {
  const scenes: SceneSpec[] = plan.scenes.map((s) => {
    const real = durationsBySceneId[s.sceneId];
    if (real === undefined) throw new VideoFactoryError(`applyRealDurations: no measured duration for scene "${s.sceneId}".`);
    return { ...s, durationSeconds: real };
  });
  return { ...plan, scenes };
}

export interface RealNarrationResult {
  voiceoverPath: string;
  durationsBySceneId: Record<string, number>;
  /** Real word timings per scene (seconds from that scene's own audio start). Only the production voice reports them; the offline voice leaves this out. */
  wordCuesBySceneId?: Record<string, WordCue[]>;
  /** What actually produced this audio -- every caller/report must say this, never imply a finished narration when it wasn't the real production voice. */
  provenance: "edge_tts" | "offline_sapi" | "supplied" | "none";
}

const MIN_SILENT_SCENE_SECONDS = 1.5;
/** Silence kept before and after a trimmed line (seconds): enough to breathe, short enough to cut on. */
const TRIM_LEAD_SECONDS = 0.06;
const TRIM_TAIL_SECONDS = 0.14;

/**
 * Synthesizes one part per scene (via `synthesizeOne`, which returns its
 * own measured duration) and concatenates them in scene order into one
 * voiceover track, re-encoding rather than stream-copying so a mix of
 * sources (e.g. edge-tts's own mp3 encoder vs. this file's silence
 * generator) never hits a concat-demuxer codec-parameter mismatch. A
 * text-only scene (no narration) gets a short, explicit silence instead of
 * being skipped, so every scene has a real duration entry -- shared by
 * both the offline (SAPI) and real (edge-tts) narration paths below.
 */
async function synthesizePerSceneAndConcat(
  plan: ScenePlan,
  outDir: string,
  runner: ProcessRunner,
  partExt: string,
  synthesizeOne: (text: string, partPath: string, sceneId: string) => Promise<number>,
  voiceoverBasename: string,
): Promise<{ voiceoverPath: string; durationsBySceneId: Record<string, number> }> {
  mkdirSync(outDir, { recursive: true });
  const partPaths: string[] = [];
  const durationsBySceneId: Record<string, number> = {};

  for (const [i, s] of plan.scenes.entries()) {
    const partPath = join(outDir, `narration-${i}-${s.sceneId}.${partExt}`);
    if (s.narration.trim().length === 0) {
      const result = await runner.run("ffmpeg", ["-y", "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono:d=${MIN_SILENT_SCENE_SECONDS}`, "-c:a", "libmp3lame", partPath], {});
      if (result.exitCode !== 0) throw new VideoFactoryError(`Failed to build silence for scene "${s.sceneId}": ${result.stderr || result.stdout}`);
      durationsBySceneId[s.sceneId] = MIN_SILENT_SCENE_SECONDS;
    } else {
      durationsBySceneId[s.sceneId] = await synthesizeOne(s.narration, partPath, s.sceneId);
    }
    partPaths.push(partPath);
  }

  const listPath = join(outDir, "narration-concat-list.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(listPath, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");
  const voiceoverPath = join(outDir, voiceoverBasename);
  const concatResult = await runner.run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "libmp3lame", voiceoverPath], {});
  if (concatResult.exitCode !== 0) throw new VideoFactoryError(`Failed to concatenate per-scene narration: ${concatResult.stderr || concatResult.stdout}`);

  return { voiceoverPath, durationsBySceneId };
}

/**
 * OFFLINE (SAPI) narration -- for local verification only, never
 * production. See localTts.ts's own doc comment for why this exists and
 * what it deliberately does not try to match about the real voice.
 */
export async function synthesizeRealNarrationAudio(plan: ScenePlan, outDir: string, runner: ProcessRunner): Promise<RealNarrationResult> {
  const { voiceoverPath, durationsBySceneId } = await synthesizePerSceneAndConcat(
    plan,
    outDir,
    runner,
    "wav",
    async (text, partPath) => (await synthesizeOfflineNarration(text, partPath, runner)).durationSeconds,
    "voiceover-offline-narration.mp3",
  );
  return { voiceoverPath, durationsBySceneId, provenance: "offline_sapi" };
}

/**
 * REAL production narration -- the same edge-tts voice/pipeline
 * (voiceover.ts's generateVoiceover) every ordinary campaign's narration
 * already uses, just called once per scene instead of once for a whole
 * script, so each scene's real spoken duration is known directly (its
 * `durationSeconds`) rather than inferred from word-boundary slicing. This
 * is what render-single.ts's real ScenePlan-matched path calls -- the
 * offline SAPI version above is local-verification-only.
 */
export async function synthesizeProductionNarrationAudio(
  plan: ScenePlan,
  outDir: string,
  runner: ProcessRunner,
  options: {
    rate?: string;
    /** Pads a scene's audio with silence up to this length, so a one-line beat still holds long enough to read after its entrance animation. */
    minSceneSeconds?: number;
    /** Cuts the silence the voice leaves before and after each line (down to a short lead and tail), so beats follow the speech instead of its pauses. */
    trimSilence?: boolean;
  } = {},
): Promise<RealNarrationResult> {
  const wordCuesBySceneId: Record<string, WordCue[]> = {};
  const { voiceoverPath, durationsBySceneId } = await synthesizePerSceneAndConcat(
    plan,
    outDir,
    runner,
    "mp3",
    async (text, partPath, sceneId) => {
      const sceneOutDir = dirname(partPath);
      const result = await generateVoiceover(text, sceneOutDir, runner, DEFAULT_VOICE, options.rate);
      copyFileSync(result.mp3Path, partPath);
      wordCuesBySceneId[sceneId] = result.wordCues;
      return finishNarrationPart(partPath, sceneId, result.durationSeconds, options, runner);
    },
    "voiceover-production-narration.mp3",
  );
  return { voiceoverPath, durationsBySceneId, wordCuesBySceneId, provenance: "edge_tts" };
}

/**
 * The last step for one beat's audio: optionally cut the silence around the line, then pad it with silence up to the beat's
 * minimum length. Returns the beat's final length. Shared by the built-in voice and a recording the owner supplied.
 */
async function finishNarrationPart(
  partPath: string,
  sceneId: string,
  spokenSeconds: number,
  options: { minSceneSeconds?: number; trimSilence?: boolean },
  runner: ProcessRunner,
): Promise<number> {
  let spoken = spokenSeconds;
  if (options.trimSilence) {
    const trimmedPath = partPath.replace(/\.mp3$/, ".trimmed.mp3");
    // Leading silence is removed, then the audio is reversed so the same filter removes the trailing silence, then flipped back.
    const filter = `silenceremove=start_periods=1:start_silence=${TRIM_LEAD_SECONDS}:start_threshold=-42dB,areverse,silenceremove=start_periods=1:start_silence=${TRIM_TAIL_SECONDS}:start_threshold=-42dB,areverse`;
    const trimmed = await runner.run("ffmpeg", ["-y", "-i", partPath, "-af", filter, "-c:a", "libmp3lame", trimmedPath], {});
    if (trimmed.exitCode !== 0) throw new VideoFactoryError(`Failed to trim narration for scene "${sceneId}": ${trimmed.stderr || trimmed.stdout}`);
    copyFileSync(trimmedPath, partPath);
    spoken = await measureAudioDuration(partPath, runner);
  }
  const min = options.minSceneSeconds;
  if (min !== undefined && spoken < min) {
    const paddedPath = partPath.replace(/\.mp3$/, ".padded.mp3");
    const padded = await runner.run("ffmpeg", ["-y", "-i", partPath, "-af", `apad=whole_dur=${min.toFixed(3)}`, "-t", min.toFixed(3), "-c:a", "libmp3lame", paddedPath], {});
    if (padded.exitCode !== 0) throw new VideoFactoryError(`Failed to pad narration for scene "${sceneId}": ${padded.stderr || padded.stdout}`);
    copyFileSync(paddedPath, partPath);
    return min;
  }
  return spoken;
}

/**
 * Narration from a recording the owner supplied (see suppliedVoice.ts): one file cut at its long pauses into one part per
 * beat, or one file per beat. The parts then get the same trim, padding and joining as the built-in voice, so the two sound
 * and time alike. Fails loudly, with the pauses it found, when a single file does not hold exactly one part per beat.
 */
export async function synthesizeSuppliedNarrationAudio(
  plan: ScenePlan,
  supplied: SuppliedVoice,
  outDir: string,
  runner: ProcessRunner,
  options: { minSceneSeconds?: number; trimSilence?: boolean } = {},
): Promise<RealNarrationResult> {
  mkdirSync(outDir, { recursive: true });
  const indexOfScene = new Map(plan.scenes.map((sc, i) => [sc.sceneId, i] as const));
  let segments: Segment[] = [];
  if (supplied.kind === "single") {
    const total = await measureAudioDuration(supplied.path, runner);
    const detect = await runner.run("ffmpeg", ["-i", supplied.path, "-af", `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${BOUNDARY_SILENCE_SECONDS}`, "-f", "null", "-"], {});
    if (detect.exitCode !== 0) throw new VideoFactoryError(`Could not read the recording for "${plan.planId}": ${detect.stderr || detect.stdout}`);
    segments = speechSegments(parseSilences(`${detect.stderr}\n${detect.stdout}`), total);
    if (segments.length !== plan.scenes.length) throw new VideoFactoryError(splitProblem(plan.planId, segments, plan.scenes.length));
  } else if (supplied.paths.length !== plan.scenes.length) {
    throw new VideoFactoryError(`The recording for "${plan.planId}" has ${supplied.paths.length} files but the video has ${plan.scenes.length} beats.`);
  }
  const { voiceoverPath, durationsBySceneId } = await synthesizePerSceneAndConcat(
    plan,
    outDir,
    runner,
    "mp3",
    async (_text, partPath, sceneId) => {
      const i = indexOfScene.get(sceneId)!;
      const args =
        supplied.kind === "single"
          ? ["-y", "-ss", Math.max(0, segments[i]!.start - 0.04).toFixed(3), "-to", (segments[i]!.end + 0.04).toFixed(3), "-i", supplied.path, "-c:a", "libmp3lame", partPath]
          : ["-y", "-i", supplied.paths[i]!, "-c:a", "libmp3lame", partPath];
      const cut = await runner.run("ffmpeg", args, {});
      if (cut.exitCode !== 0) throw new VideoFactoryError(`Failed to prepare the recording for scene "${sceneId}": ${cut.stderr || cut.stdout}`);
      return finishNarrationPart(partPath, sceneId, await measureAudioDuration(partPath, runner), options, runner);
    },
    "voiceover-supplied-narration.mp3",
  );
  return { voiceoverPath, durationsBySceneId, provenance: "supplied" };
}

/**
 * A silent placeholder voiceover track of exactly `durationSeconds` --
 * used only because generating REAL narration (edge-tts) is a network
 * call, disabled for this local test render per this task's own
 * constraints. Never presented as real audio: callers must report audio
 * sync as unverified when this is used, not as a finished render.
 */
export async function buildSilentPlaceholderAudio(durationSeconds: number, outPath: string, runner: ProcessRunner): Promise<void> {
  const result = await runner.run(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono:d=${durationSeconds.toFixed(3)}`, "-c:a", "libmp3lame", outPath],
    {},
  );
  if (result.exitCode !== 0) throw new VideoFactoryError(`Adapter: failed to build placeholder silent audio: ${result.stderr || result.stdout}`);
}

/**
 * The audio for a plan with `voiceover: "none"`: a silent track the length of the plan, so the music bed is the only
 * sound. Each scene keeps the duration the plan authored; there is no speech to measure.
 */
export async function synthesizeSilentNarration(plan: ScenePlan, outDir: string, runner: ProcessRunner): Promise<RealNarrationResult> {
  mkdirSync(outDir, { recursive: true });
  const durationsBySceneId: Record<string, number> = {};
  let total = 0;
  for (const s of plan.scenes) {
    durationsBySceneId[s.sceneId] = s.durationSeconds;
    total += s.durationSeconds;
  }
  const voiceoverPath = join(outDir, "voiceover-silent.mp3");
  await buildSilentPlaceholderAudio(total, voiceoverPath, runner);
  return { voiceoverPath, durationsBySceneId, provenance: "none" };
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
