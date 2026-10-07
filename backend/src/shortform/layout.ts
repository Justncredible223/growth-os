import type { AspectRatio, Platform, PlanIssue, Rect, SceneSpec, VerifiedAsset } from "./types.js";
import { validateRecordingScene } from "./recordingLayout.js";
import { PAYOFF, computePayoffCard, payoffWordCount, splitPayoffHeadline } from "./payoffLayout.js";

/** Vertical short-form canvas for both TikTok and YouTube Shorts. */
export const CANVAS = { width: 1080, height: 1920 } as const;

/**
 * Areas each platform's own UI covers (profile/like buttons on the right, caption and
 * music bar at the bottom). Conservative on purpose: nothing a viewer must read goes here.
 */
export const SAFE_INSETS: Record<Platform, { top: number; bottom: number; left: number; right: number }> = {
  tiktok: { top: 150, bottom: 380, left: 60, right: 120 },
  youtube_shorts: { top: 120, bottom: 300, left: 60, right: 120 },
};

/** Smallest text sizes (px on the 1080 wide canvas) that stay readable on a phone. */
export const MIN_FONT = { headline: 64, caption: 48, disclosure: 36 } as const;
export const DEFAULT_FONT = { headline: 76, caption: 52, disclosure: 40 } as const;

export const TEXT_LIMITS = {
  headlineChars: 48,
  captionChars: 110,
  disclosureChars: 110,
  titleChars: 70,
  tiktokCaptionChars: 2200,
  youtubeDescriptionChars: 5000,
  maxSeconds: 60,
  targetMaxSeconds: 35,
} as const;

/** Average glyph width as a fraction of font size for the wide display face (Poppins). Deliberately pessimistic. */
const CHAR_WIDTH_EM = 0.6;
const LINE_HEIGHT_EM = 1.25;

/** Highest uniform scale-up of a screenshot crop before it stops being crisp. */
export const UPSCALE_WARN = 2.5;
export const UPSCALE_MAX = 4;
/** Below this, screenshot text is shrunk enough that a viewer cannot read it without the headline. */
export const DOWNSCALE_WARN = 0.6;

export function rectContains(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function platformsOf(platform: SceneSpec["platform"]): Platform[] {
  return platform === "both" ? ["tiktok", "youtube_shorts"] : [platform];
}

export function safeRect(platform: Platform): Rect {
  const i = SAFE_INSETS[platform];
  return { x: i.left, y: i.top, w: CANVAS.width - i.left - i.right, h: CANVAS.height - i.top - i.bottom };
}

export interface LayoutBoxes {
  safe: Rect;
  headline: Rect;
  media: Rect;
  disclosure: Rect;
  caption: Rect;
}

const HEADLINE_H = 240;
const DISCLOSURE_H = 70;
const CAPTION_H = 250;
const GAP = 20;

/** The fixed vertical stack every scene uses. All boxes sit inside the platform's safe area by construction, and a test proves it. */
export function layoutBoxes(platform: Platform): LayoutBoxes {
  const safe = safeRect(platform);
  const mediaH = safe.h - HEADLINE_H - DISCLOSURE_H - CAPTION_H - GAP * 3;
  const headline: Rect = { x: safe.x, y: safe.y, w: safe.w, h: HEADLINE_H };
  const media: Rect = { x: safe.x, y: headline.y + HEADLINE_H + GAP, w: safe.w, h: mediaH };
  const disclosure: Rect = { x: safe.x, y: media.y + mediaH + GAP, w: safe.w, h: DISCLOSURE_H };
  const caption: Rect = { x: safe.x, y: disclosure.y + DISCLOSURE_H + GAP, w: safe.w, h: CAPTION_H };
  return { safe, headline, media, disclosure, caption };
}

/** Word-wrap estimate: how many lines `text` needs at `fontPx` inside `boxWidth`, and whether a single word is wider than the box. */
export function estimateLines(text: string, fontPx: number, boxWidth: number): { lines: number; wordTooWide: boolean } {
  const charW = fontPx * CHAR_WIDTH_EM;
  const maxChars = Math.max(1, Math.floor(boxWidth / charW));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: 0, wordTooWide: false };
  let lines = 1;
  let current = 0;
  let wordTooWide = false;
  for (const word of words) {
    if (word.length > maxChars) wordTooWide = true;
    if (current === 0) current = word.length;
    else if (current + 1 + word.length <= maxChars) current += 1 + word.length;
    else {
      lines += 1;
      current = word.length;
    }
  }
  return { lines, wordTooWide };
}

export function textOverflows(text: string, fontPx: number, box: Rect): boolean {
  const { lines, wordTooWide } = estimateLines(text, fontPx, box.w);
  return wordTooWide || lines * fontPx * LINE_HEIGHT_EM > box.h;
}

/**
 * Same measurement as estimateLines, but returns the actual wrapped lines
 * instead of just a count -- so a caption's REAL line breaks are chosen
 * here, once, by the same measurement validateSceneText checks against,
 * rather than left to ASS's own WrapStyle auto-wrap (which uses its own
 * font-metric guess and can legitimately disagree with this estimate,
 * meaning a caption that "passed" validation could still wrap differently
 * -- or overflow -- on screen). Never shrinks the font to make text fit;
 * that is a scene-authoring decision (see this task's own instruction not
 * to solve overflow by shrinking), not something a renderer does silently.
 */
export function wrapText(text: string, fontPx: number, boxWidth: number): string[] {
  const charW = fontPx * CHAR_WIDTH_EM;
  const maxChars = Math.max(1, Math.floor(boxWidth / charW));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function aspectValue(aspect: AspectRatio): number | null {
  if (aspect === "9:16") return 9 / 16;
  if (aspect === "4:5") return 4 / 5;
  if (aspect === "1:1") return 1;
  return null;
}

/** Uniform (never anisotropic) fit of a crop inside a media box. */
export function fitCrop(crop: Rect, media: Rect): { scale: number; width: number; height: number; x: number; y: number } {
  const scale = Math.min(media.w / crop.w, media.h / crop.h);
  const width = crop.w * scale;
  const height = crop.h * scale;
  return { scale, width, height, x: media.x + (media.w - width) / 2, y: media.y + (media.h - height) / 2 };
}

export function validateOutputDimensions(width: number, height: number): PlanIssue[] {
  if (width === CANVAS.width && height === CANVAS.height) return [];
  return [
    {
      severity: "error",
      code: "unsupported_output_dimensions",
      message: `Output is ${width}x${height}; short-form video must be exactly ${CANVAS.width}x${CANVAS.height} (9:16).`,
    },
  ];
}

export function validateCropBounds(crop: Rect | null, asset: VerifiedAsset, sceneId: string, layout?: SceneSpec["layout"]): PlanIssue[] {
  const issue = (code: string, message: string): PlanIssue => ({ severity: "error", code, sceneId, message });
  if (!crop) return [issue("missing_crop", "A scene with a screenshot needs an explicit crop rectangle.")];
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every(Number.isFinite)) return [issue("invalid_crop_bounds", "Crop values must be finite numbers.")];
  if (![x, y, w, h].every(Number.isInteger)) return [issue("invalid_crop_bounds", "Crop values must be whole pixels.")];
  const problems: PlanIssue[] = [];
  if (x < 0 || y < 0) problems.push(issue("invalid_crop_bounds", `Crop starts outside the image (x=${x}, y=${y}).`));
  // A payoff scene is a deliberate tight zoom on one line of the product, so its floor is lower.
  const minSide = layout === "payoff" ? 50 : 120;
  if (w < minSide || h < minSide) problems.push(issue("invalid_crop_bounds", `Crop is too small to read (${w}x${h}); each side must be at least ${minSide}px.`));
  if (x + w > asset.width || y + h > asset.height) {
    problems.push(issue("invalid_crop_bounds", `Crop ${w}x${h} at (${x},${y}) runs past the ${asset.width}x${asset.height} image.`));
  }
  return problems;
}

/** Framing rules for one scene against its asset: bounds, focal region, chrome, sidebar, stretch, blur. */
export function validateSceneFraming(scene: SceneSpec, asset: VerifiedAsset): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], code: string, message: string) => issues.push({ severity, code, sceneId: scene.sceneId, message });
  const bounds = validateCropBounds(scene.crop, asset, scene.sceneId, scene.layout);
  issues.push(...bounds);
  if (bounds.length > 0 || !scene.crop) return issues;
  const crop = scene.crop;

  if (!scene.focalRegion) add("error", "missing_focal_region", "Every screenshot scene names the focal region the viewer should look at.");
  else if (!rectContains(crop, scene.focalRegion)) add("error", "focal_region_outside_crop", "The focal region is not fully inside the crop.");

  if (!scene.allowChrome) {
    for (const chrome of asset.chromeRegions) {
      if (rectsIntersect(crop, chrome)) {
        add("error", "crop_includes_app_chrome", "The crop includes the app's header/nav bar. Crop it out, or set allowChrome deliberately.");
        break;
      }
    }
  }

  if (asset.kind === "desktop_ui") {
    if (scene.layout !== "full_card") add("error", "desktop_screenshot_not_card", "A desktop screenshot must be framed as a card, never filled into the portrait frame.");
    if (asset.sidebarRegion && !scene.keepSidebar && rectsIntersect(crop, asset.sidebarRegion)) {
      add("error", "sidebar_not_removed", "The crop includes the desktop sidebar. Remove it, or set keepSidebar deliberately.");
    }
    if (!scene.intentionalFullPage && crop.w >= asset.width * 0.9 && crop.h >= asset.height * 0.9) {
      add("error", "full_desktop_page", "Do not scale a full desktop page into a portrait frame. Crop to the card that carries the point.");
    }
  }

  if (scene.layout === "recording") {
    // A recording scene is framed by recordingLayout.ts (headline, card in the safe column, caption): the generic media-box
    // aspect and scale checks below do not apply. Its rings must sit inside the crop and its whole block inside the safe zones.
    issues.push(...validateRecordingScene(scene));
    return issues;
  }

  if (scene.layout === "payoff") {
    // A payoff card is a deliberate tight zoom on ONE element, framed by computePayoffCard, so the generic
    // media-box aspect and scale checks below do not apply. It instead shows a tiny card as a review item.
    const card = computePayoffCard(crop);
    if (card.width < 420) add("review", "payoff_card_small", `The zoomed card is only ${card.width}px wide; widen the crop so it reads as one clear element.`);
    if (card.scale >= PAYOFF.upscaleWarn) add("review", "crop_soft", `The payoff card enlarges this crop ${card.scale.toFixed(1)}x and may look soft.`);
    return issues;
  }

  const cropAspect = crop.w / crop.h;
  const boxes = layoutBoxes("tiktok").media;
  if (scene.layout === "fill") {
    const target = boxes.w / boxes.h;
    if (Math.abs(cropAspect - target) / target > 0.02) {
      add("error", "crop_would_stretch_or_crop", `Layout "fill" needs a crop with the media frame's aspect (${target.toFixed(3)}); this crop is ${cropAspect.toFixed(3)}.`);
    }
  } else {
    const declared = aspectValue(scene.aspectRatio);
    if (declared !== null && Math.abs(cropAspect - declared) / declared > 0.03) {
      add("error", "crop_aspect_mismatch", `Crop aspect ${cropAspect.toFixed(3)} does not match the declared ${scene.aspectRatio}.`);
    }
  }

  for (const platform of platformsOf(scene.platform)) {
    const fit = fitCrop(crop, layoutBoxes(platform).media);
    if (fit.scale < DOWNSCALE_WARN) add("review", "screenshot_text_small", `On ${platform} this crop is shrunk to ${(fit.scale * 100).toFixed(0)}% of its source, so the text inside it will be small. Make sure the headline carries the key figure.`);
    if (fit.scale > UPSCALE_MAX) add("error", "crop_too_blurry", `On ${platform} this crop would be enlarged ${fit.scale.toFixed(1)}x. Use a larger crop or a sharper capture.`);
    else if (fit.scale > UPSCALE_WARN) add("review", "crop_soft", `On ${platform} this crop is enlarged ${fit.scale.toFixed(1)}x and may look soft.`);
  }
  return issues;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Max words on one payoff screen, counting the big figure (redesign brief: 5-7 words per screen). */
export const PAYOFF_MAX_WORDS = 7;
export const PAYOFF_MAX_HEADLINE_CHARS = 34;

/** Payoff-specific text rules: a spec, a big figure as the headline's first token, and a short line under it. */
export function validatePayoffText(scene: SceneSpec): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], code: string, message: string) => issues.push({ severity, code, sceneId: scene.sceneId, message });
  if (!scene.payoff) add("error", "payoff_missing_spec", 'A scene with layout "payoff" needs a payoff spec (theme and motion).');
  const text = splitPayoffHeadline(scene.headline);
  // A text-only payoff scene (a qualification or closing line) has no card to caption, so it may lead with words.
  if (!text && scene.assetId !== null && !scene.payoff?.leadWithWords) add("error", "payoff_headline_no_figure", "A payoff headline starts with the big figure, e.g. \"$1,725 left before your floor\".");
  const words = payoffWordCount(scene.headline);
  if (words > PAYOFF_MAX_WORDS) add("error", "payoff_too_many_words", `Payoff headline has ${words} words; the limit is ${PAYOFF_MAX_WORDS} per screen.`);
  if (scene.headline.trim().length > PAYOFF_MAX_HEADLINE_CHARS) add("error", "payoff_headline_too_long", `Payoff headline is ${scene.headline.trim().length} characters; the limit is ${PAYOFF_MAX_HEADLINE_CHARS}.`);
  return issues;
}

/** Text length, font size and overflow checks against the fixed layout boxes of every platform the scene targets. */
export function validateSceneText(scene: SceneSpec): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], code: string, message: string) => issues.push({ severity, code, sceneId: scene.sceneId, message });
  const headlineFont = scene.fontSizes?.headline ?? DEFAULT_FONT.headline;
  const captionFont = scene.fontSizes?.caption ?? DEFAULT_FONT.caption;

  if (headlineFont < MIN_FONT.headline) add("error", "headline_font_too_small", `Headline font ${headlineFont}px is under the ${MIN_FONT.headline}px minimum.`);
  if (captionFont < MIN_FONT.caption) add("error", "caption_font_too_small", `Caption font ${captionFont}px is under the ${MIN_FONT.caption}px minimum.`);
  if (scene.headline.trim().length > TEXT_LIMITS.headlineChars) add("error", "headline_too_long", `Headline is ${scene.headline.trim().length} characters; the limit is ${TEXT_LIMITS.headlineChars}.`);
  if (scene.captionText.trim().length > TEXT_LIMITS.captionChars) add("error", "caption_too_long", `On-screen caption is ${scene.captionText.trim().length} characters; the limit is ${TEXT_LIMITS.captionChars}.`);
  if (scene.disclosure && scene.disclosure.length > TEXT_LIMITS.disclosureChars) add("error", "disclosure_too_long", `Disclosure is ${scene.disclosure.length} characters; the limit is ${TEXT_LIMITS.disclosureChars}.`);

  if (scene.layout === "payoff") issues.push(...validatePayoffText(scene));

  for (const platform of platformsOf(scene.platform)) {
    const boxes = layoutBoxes(platform);
    if (scene.layout !== "payoff" && scene.layout !== "chart" && scene.layout !== "recording" && textOverflows(scene.headline, headlineFont, boxes.headline)) add("error", "headline_overflow", `Headline does not fit its box on ${platform} at ${headlineFont}px.`);
    if (textOverflows(scene.captionText, captionFont, boxes.caption)) add("error", "caption_overflow", `Caption does not fit its box on ${platform} at ${captionFont}px.`);
    if (scene.disclosure && textOverflows(scene.disclosure, DEFAULT_FONT.disclosure, boxes.disclosure)) add("error", "disclosure_overflow", `Disclosure does not fit its box on ${platform}.`);
  }

  for (const [field, text] of [
    ["narration", scene.narration],
    ["headline", scene.headline],
    ["caption", scene.captionText],
    ["disclosure", scene.disclosure ?? ""],
    ["cta", scene.cta ?? ""],
  ] as const) {
    if (EMAIL_RE.test(text) && !text.toLowerCase().includes("@fillbookhq")) add("error", "personal_identifier_in_text", `The scene ${field} contains an email-like identifier.`);
  }
  return issues;
}

/**
 * A `screen_recording` scene's clip range (divided by its playback speed)
 * must actually cover the scene's on-screen durationSeconds -- explicitly
 * an error, never silently patched by looping or freezing the last frame
 * to fill the gap (see this task's own instruction). Also checks the
 * requested range doesn't run past what was actually captured.
 */
export function validateMotionTiming(scene: SceneSpec, asset: VerifiedAsset): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (code: string, message: string) => issues.push({ severity: "error", code, sceneId: scene.sceneId, message });

  if (asset.kind !== "screen_recording") return issues;
  if (!scene.clipTimeRangeSeconds) {
    add("missing_clip_time_range", "A screen_recording scene must set clipTimeRangeSeconds (which part of the captured clip it uses).");
    return issues;
  }
  const { start, end } = scene.clipTimeRangeSeconds;
  if (!(end > start)) {
    add("invalid_clip_time_range", `clipTimeRangeSeconds end (${end}) must be after start (${start}).`);
    return issues;
  }
  if (asset.durationSeconds !== undefined && end > asset.durationSeconds + 0.05) {
    add("clip_time_range_past_capture", `clipTimeRangeSeconds end (${end}s) is past the captured clip's own duration (${asset.durationSeconds}s).`);
  }
  const speed = scene.playbackSpeed ?? 1;
  if (!(speed > 0)) {
    add("invalid_playback_speed", `playbackSpeed must be a positive number, got ${speed}.`);
    return issues;
  }
  const availableSeconds = (end - start) / speed;
  // Small tolerance for floating-point scene-duration authoring, not a loophole for genuinely short footage.
  if (availableSeconds < scene.durationSeconds - 0.05) {
    add(
      "insufficient_motion_footage",
      `Scene needs ${scene.durationSeconds.toFixed(1)}s but the clip range (${start}s-${end}s at ${speed}x) only provides ${availableSeconds.toFixed(1)}s -- ` +
        `re-capture a longer range, slow durationSeconds down to match, or fall back to a still image. Never looped/frozen to fill the gap.`,
    );
  } else if (availableSeconds < scene.durationSeconds + 0.4 - 0.05) {
    // Below the hard error above, but tight: render.ts's buildFfmpegArgs additionally needs this
    // scene's OUTGOING transition padding (up to MAX_TRANSITION_SECONDS = 0.4s -- see render.ts),
    // which this check can't compute exactly without the whole scene list, so it can't be a hard
    // error here without risking a false positive. Found by the 2026-09-27 library-wide audit
    // after a real render (not just this validator) failed on exactly this margin for
    // pilot-5-would-you-pass--c ("declared clip range is 4.30s but this scene ... needs 4.40s").
    // A "review" flag here means: run an actual render before trusting this scene, don't assume
    // validateScenePlan passing is sufficient on its own.
    issues.push({
      severity: "review",
      code: "motion_footage_margin_tight",
      sceneId: scene.sceneId,
      message: `Clip range (${start}s-${end}s) covers this scene's ${scene.durationSeconds.toFixed(1)}s duration with less than 0.4s to spare once render.ts adds transition padding -- a real render can still fail with "declared clip range is Ns but this scene needs Ms." Render and confirm before trusting this scene.`,
    });
  }
  return issues;
}

/** Masks: every private region the crop reveals must be fully covered. */
export function validatePrivacyMasks(scene: SceneSpec, asset: VerifiedAsset): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!scene.crop) return issues;
  for (const priv of asset.privateRegions) {
    if (!rectsIntersect(scene.crop, priv.region)) continue;
    const covered = scene.masks.some((m) => rectContains(m.region, priv.region));
    if (!covered) {
      issues.push({ severity: "error", code: "unmasked_private_region", sceneId: scene.sceneId, message: `A ${priv.kind} is visible in the crop and no mask fully covers it.` });
    }
  }
  for (const mask of scene.masks) {
    if (!rectsIntersect(scene.crop, mask.region)) {
      issues.push({ severity: "review", code: "mask_outside_crop", sceneId: scene.sceneId, message: "A mask sits outside the crop, so it hides nothing the viewer would see." });
    } else if (!asset.privateRegions.some((p) => rectsIntersect(mask.region, p.region))) {
      issues.push({ severity: "review", code: "mask_not_on_private_region", sceneId: scene.sceneId, message: "A mask does not overlap any known private region; confirm it is covering the right thing." });
    }
  }
  return issues;
}
