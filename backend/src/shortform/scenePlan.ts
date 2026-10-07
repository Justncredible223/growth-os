import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateChartScene, validateIllustrativeChart } from "./chart.js";
import { validateSceneClaims } from "./claims.js";
import { TEXT_LIMITS, validateMotionTiming, validatePrivacyMasks, validateSceneFraming, validateSceneText } from "./layout.js";
import { OFFICIAL_HANDLE, type PlanIssue, type PlanValidation, type RequiredAsset, type SceneSpec, type ScenePlan, type VerifiedAsset, type VerifiedManifest } from "./types.js";

export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "video-factory", "assets");
export const MANIFEST_PATH = join(ASSETS_DIR, "verified-manifest.json");

export function loadManifest(path: string = MANIFEST_PATH): VerifiedManifest {
  return JSON.parse(readFileSync(path, "utf8")) as VerifiedManifest;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A content hash of everything a viewer would actually see/hear if this
 * plan were rendered -- hook, and every scene's narration/headline/
 * captionText/disclosure/claims, crop and clip range. Deliberately
 * excludes fields that don't change what's shown (variationId, transition
 * timing) so an unrelated authoring tweak doesn't spuriously invalidate an
 * already-approved reference. This is the "version" half of the explicit
 * scene-plan identifier + version contract a render-time consumer checks
 * an approved script's `motionScenePlan.scenePlanHash` against (see
 * motionCatalog.ts's resolveMotionScenePlan): a hook-text match alone is
 * NOT authorization to substitute a plan's narration/claims for whatever
 * an approved script actually says -- the approved script must carry this
 * exact hash, computed from the plan version it was generated against, so
 * a coincidental same-hook-different-body script (or pilots.ts changing
 * after generation) can never silently select the wrong content.
 */
export function computeScenePlanHash(plan: ScenePlan): string {
  const canonical = {
    hook: plan.hook,
    scenes: plan.scenes.map((s) => ({
      sceneId: s.sceneId,
      narration: s.narration,
      headline: s.headline,
      captionText: s.captionText,
      disclosure: s.disclosure,
      assetId: s.assetId,
      crop: s.crop,
      clipTimeRangeSeconds: s.clipTimeRangeSeconds ?? null,
      claims: s.claims.map((c) => ({ id: c.id, type: c.type, text: c.text, evidence: c.evidence })),
      // Only present on payoff-layout scenes, so every existing plan's hash is unchanged.
      ...(s.payoff ? { payoff: s.payoff, layout: s.layout } : {}),
      // Only present on chart-layout scenes, so every existing plan's hash is unchanged.
      ...(s.chart ? { chart: s.chart, layout: s.layout } : {}),
      // Only present on recording-layout scenes, so every existing plan's hash is unchanged.
      ...(s.recording ? { recording: s.recording, layout: s.layout } : {}),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface ValidateOptions {
  /** Directory the manifest's `file` paths are relative to. Defaults to the bundled assets. */
  assetsDir?: string;
  /** Verify each used asset exists on disk and still matches its recorded SHA-256. Off in pure unit tests. */
  checkFiles?: boolean;
}

function countHandle(text: string): number {
  return (text.toLowerCase().match(/@fillbookhq/g) ?? []).length;
}

function sceneVisualText(scene: SceneSpec): string {
  return [scene.headline, scene.captionText, scene.disclosure ?? "", scene.cta ?? ""].join("\n");
}

/**
 * Validates a whole scene plan. Never throws and never repairs: it reports every problem so a human
 * can fix the plan. A plan that needs an asset that does not exist is reported as blocked, not patched.
 */
export function validateScenePlan(plan: ScenePlan, manifest: VerifiedManifest, options: ValidateOptions = {}): PlanValidation {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], code: string, message: string, sceneId?: string) => issues.push({ severity, code, message, sceneId });
  const missingAssets = new Map<string, RequiredAsset>();
  const byId = new Map(manifest.assets.map((a) => [a.id, a] as const));
  const required = new Map(plan.requiredAssets.map((r) => [r.id, r] as const));

  if (!plan.planId.trim()) add("error", "missing_plan_id", "The plan has no id.");
  if (!plan.title.trim()) add("error", "missing_title", "The plan has no title.");
  else if (plan.title.length > TEXT_LIMITS.titleChars) add("error", "title_too_long", `Title is ${plan.title.length} characters; the limit is ${TEXT_LIMITS.titleChars}.`);
  if (!plan.series.trim()) add("error", "missing_series", "The plan has no series.");
  if (plan.scenes.length === 0) add("error", "no_scenes", "The plan has no scenes.");

  const ids = new Set<string>();
  let total = 0;
  const usedAssets = new Map<string, VerifiedAsset>();

  for (const scene of plan.scenes) {
    if (ids.has(scene.sceneId)) add("error", "duplicate_scene_id", `Scene id "${scene.sceneId}" is used twice.`, scene.sceneId);
    ids.add(scene.sceneId);
    total += scene.durationSeconds;

    if (!(scene.durationSeconds > 0)) add("error", "invalid_duration", "Scene duration must be greater than zero.", scene.sceneId);
    for (const [field, value] of [
      ["narration", scene.narration],
      ["takeaway", scene.takeaway],
      ["headline", scene.headline],
      ["caption", scene.captionText],
    ] as const) {
      if (!value.trim()) add("error", "missing_scene_text", `Scene ${scene.sceneId} has no ${field}.`, scene.sceneId);
    }
    if (scene.experimentId !== plan.experimentId || scene.variationId !== plan.variationId) {
      add("error", "experiment_mismatch", `Scene ${scene.sceneId} carries ${scene.experimentId}/${scene.variationId}, but the plan is ${plan.experimentId}/${plan.variationId}.`, scene.sceneId);
    }
    if (scene.transition.type === "fade" && !(scene.transition.durationSeconds > 0 && scene.transition.durationSeconds < scene.durationSeconds)) {
      add("error", "invalid_transition", "A fade transition must be shorter than its scene.", scene.sceneId);
    }

    issues.push(...validateSceneText(scene));

    if (scene.assetId === null) {
      // A chart scene with no recording behind it is illustrative arithmetic: the arithmetic is its evidence (chart.ts).
      if (scene.layout === "chart") issues.push(...validateIllustrativeChart(scene));
      issues.push(...validateSceneClaims(scene, undefined));
      continue;
    }

    const asset = byId.get(scene.assetId);
    if (!asset) {
      const req = required.get(scene.assetId);
      if (req) {
        missingAssets.set(req.id, req);
        add("error", "missing_asset", `Scene ${scene.sceneId} needs "${req.id}", which does not exist yet: ${req.description}`, scene.sceneId);
      } else {
        add("error", "unknown_asset", `Scene ${scene.sceneId} uses "${scene.assetId}", which is neither in the verified manifest nor declared as a required asset.`, scene.sceneId);
      }
      continue;
    }

    usedAssets.set(asset.id, asset);
    if (scene.layout === "chart") {
      // A chart scene draws numbers taken from the recording's facts and shows none of the recording itself: no crop, no
      // clip window, nothing to mask. Its numbers are checked against the facts it cites instead (chart.ts).
      issues.push(...validateChartScene(scene, asset));
      issues.push(...validateSceneClaims(scene, asset));
      if (asset.dataLabel && !(scene.disclosure ?? "").toLowerCase().includes(asset.dataLabel.toLowerCase())) {
        add("error", "missing_demo_label", `${asset.id} is demo data; the scene must show "${asset.dataLabel}" on screen.`, scene.sceneId);
      }
      continue;
    }
    // validateSceneFraming's checks (crop bounds, focal region, chrome,
    // aspect/upscale) are generic across every asset kind, including
    // screen_recording -- only the CLIP-TIME dimension is unique to motion
    // assets, so validateMotionTiming runs IN ADDITION, not instead of it.
    issues.push(...validateSceneFraming(scene, asset));
    if (asset.kind === "screen_recording") issues.push(...validateMotionTiming(scene, asset));
    issues.push(...validatePrivacyMasks(scene, asset));
    issues.push(...validateSceneClaims(scene, asset));

    if (asset.dataLabel && !(scene.disclosure ?? "").toLowerCase().includes(asset.dataLabel.toLowerCase())) {
      add("error", "missing_demo_label", `${asset.id} is demo data; the scene must show "${asset.dataLabel}" on screen.`, scene.sceneId);
    }
  }

  if (total > TEXT_LIMITS.maxSeconds) add("error", "video_too_long", `Total ${total.toFixed(1)}s is over the ${TEXT_LIMITS.maxSeconds}s limit.`);
  else if (total > TEXT_LIMITS.targetMaxSeconds) add("review", "video_long", `Total ${total.toFixed(1)}s is over the ${TEXT_LIMITS.targetMaxSeconds}s target; short videos hold viewers better.`);

  const datasets = new Set<string>([...[...usedAssets.values()].map((a) => a.dataset), ...plan.requiredAssets.map((r) => r.dataset).filter((d): d is string => Boolean(d))]);
  if (datasets.size > 1) {
    add("error", "mixed_datasets", `The plan mixes demo datasets (${[...datasets].join(", ")}); numbers from different captures can contradict each other on screen.`);
  }

  const last = plan.scenes[plan.scenes.length - 1];
  if (last) {
    const handleCount = plan.scenes.reduce((n, s) => n + countHandle(sceneVisualText(s)), 0);
    if (handleCount !== 1 || countHandle(sceneVisualText(last)) !== 1) {
      add("error", "handle_placement", `${OFFICIAL_HANDLE} must appear exactly once in the video's visual text, in the closing scene (found ${handleCount}).`, last.sceneId);
    }
    const ctaScenes = plan.scenes.filter((s) => s.cta && s.cta.trim());
    if (ctaScenes.length !== 1 || ctaScenes[0] !== last) {
      add("error", "cta_placement", "Exactly one scene, the last, carries the invitation (CTA).", last.sceneId);
    }
  }

  if (options.checkFiles) {
    const dir = options.assetsDir ?? ASSETS_DIR;
    for (const asset of usedAssets.values()) {
      const file = join(dir, asset.file);
      if (!existsSync(file)) add("error", "asset_file_missing", `${asset.id}: ${asset.file} is not on disk.`);
      else if (sha256File(file) !== asset.sha256) add("error", "asset_hash_mismatch", `${asset.id}: ${asset.file} has changed since it was verified. Re-verify it and update the manifest.`);
    }
  }

  const unverified = [...usedAssets.values()].filter((a) => !a.verifiedByOwner).map((a) => a.id);
  if (unverified.length > 0) add("review", "asset_not_owner_verified", `The owner has not yet confirmed the facts and regions for: ${unverified.join(", ")}. Check them in the contact sheet.`);

  const errors = issues.filter((i) => i.severity === "error");
  return { ok: errors.length === 0, blockedByMissingAssets: missingAssets.size > 0, missingAssets: [...missingAssets.values()], issues };
}
