import { CANVAS, DEFAULT_FONT, fitCrop, layoutBoxes, safeRect, wrapText } from "./layout.js";
import type { Platform, Rect, SceneSpec, VerifiedAsset } from "./types.js";

/**
 * Pure builders for the LOCAL preview render: where the screenshot lands on the 1080x1920 canvas, where
 * masks go, the subtitle file that draws the text, and the ffmpeg filter graph. No I/O and no ffmpeg calls
 * here. Text is drawn with ASS subtitles, not drawtext,
 * because drawtext segfaults on this project's ffmpeg build.
 */

export interface MediaPlacement {
  crop: Rect;
  scale: number;
  /** Rounded to even pixels for the encoder. */
  width: number;
  height: number;
  x: number;
  y: number;
  /** Masks converted from source pixels to canvas pixels. */
  maskBoxes: Rect[];
  /** Outline drawn around the focal region when it is a small part of the crop, so the eye lands on the evidence. */
  focalBox: Rect | null;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Where a scene's screenshot crop lands on the canvas. Null for a text-only card. */
export function placeMedia(scene: SceneSpec, platform: Platform = "tiktok"): MediaPlacement | null {
  if (!scene.crop) return null;
  const media = layoutBoxes(platform).media;
  const fit = fitCrop(scene.crop, media);
  const width = even(fit.width);
  const height = even(fit.height);
  const x = Math.round(media.x + (media.w - width) / 2);
  const y = Math.round(media.y + (media.h - height) / 2);
  const maskBoxes = scene.masks.map((m) => ({
    x: Math.round(x + (m.region.x - scene.crop!.x) * fit.scale),
    y: Math.round(y + (m.region.y - scene.crop!.y) * fit.scale),
    w: Math.round(m.region.w * fit.scale),
    h: Math.round(m.region.h * fit.scale),
  }));
  const focal = scene.focalRegion;
  const focalIsSmallPart = focal && focal.w * focal.h < scene.crop.w * scene.crop.h * 0.5;
  const focalBox = focal && focalIsSmallPart
    ? {
        x: Math.round(x + (focal.x - scene.crop.x) * fit.scale) - 6,
        y: Math.round(y + (focal.y - scene.crop.y) * fit.scale) - 6,
        w: Math.round(focal.w * fit.scale) + 12,
        h: Math.round(focal.h * fit.scale) + 12,
      }
    : null;
  return { crop: scene.crop, scale: fit.scale, width, height, x, y, maskBoxes, focalBox };
}

export interface AssOptions {
  /** Small label at the very top of the frame, above the safe area. Preview only. */
  label: string;
  platform?: Platform;
  /** When the scene's asset does not exist: the id to show in a loud placeholder. */
  missingAssetId?: string | null;
  /** A short watermark so a preview is never mistaken for a finished video. */
  watermark?: string;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
}

function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** The subtitle file for one scene: headline, caption, disclosure, invitation, label and placeholder. */
export function buildSceneAss(scene: SceneSpec, options: AssOptions): string {
  const platform = options.platform ?? "tiktok";
  const boxes = layoutBoxes(platform);
  const { left, right } = { left: boxes.safe.x, right: CANVAS.width - (boxes.safe.x + boxes.safe.w) };
  const hFont = scene.fontSizes?.headline ?? DEFAULT_FONT.headline;
  const cFont = scene.fontSizes?.caption ?? DEFAULT_FONT.caption;
  const font = "Poppins ExtraBold";
  const end = assTime(Math.max(scene.durationSeconds, 0.1) + 0.5);
  const mediaCenterY = Math.round(boxes.media.y + boxes.media.h / 2);

  const style = (name: string, size: number, color: string, alignment: number, marginV: number, outline = 4) =>
    `Style: ${name},${font},${size},${color},&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${outline},0,${alignment},${left},${right},${marginV},1`;

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${CANVAS.width}`,
    `PlayResY: ${CANVAS.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Headline", hFont, "&H00FFFFFF", 8, boxes.headline.y),
    style("Caption", cFont, "&H00E0E0E0", 8, boxes.caption.y, 3),
    style("Disclosure", DEFAULT_FONT.disclosure, "&H0020B0FF", 8, boxes.disclosure.y, 2),
    style("Cta", 84, "&H00E6C42E", 5, 0, 5),
    style("Missing", 60, "&H004060FF", 5, 0, 4),
    style("Label", 34, "&H00B0B0B0", 7, 20, 2),
    style("Watermark", 34, "&H00808080", 2, 24, 2),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const ev = (styleName: string, text: string, extra = "") => lines.push(`Dialogue: 0,0:00:00.00,${end},${styleName},,0,0,0,,${extra}${assEscape(text)}`);
  // Wrapped here, once, by the SAME measurement validateSceneText checks
  // against (layout.ts's wrapText) -- explicit "\n" line breaks (assEscape
  // turns those into ASS's "\N"), not ASS's own WrapStyle auto-wrap, so
  // what a human sees always matches what was validated as fitting.
  const wrapped = (text: string, fontPx: number, boxWidth: number) => wrapText(text, fontPx, boxWidth).join("\n");

  if (scene.headline.trim()) ev("Headline", wrapped(scene.headline, hFont, boxes.headline.w));
  if (scene.captionText.trim()) ev("Caption", wrapped(scene.captionText, cFont, boxes.caption.w));
  if (scene.disclosure?.trim()) ev("Disclosure", wrapped(scene.disclosure, DEFAULT_FONT.disclosure, boxes.disclosure.w));
  if (scene.cta?.trim()) ev("Cta", scene.cta, `{\\pos(${Math.round(boxes.media.x + boxes.media.w / 2)},${mediaCenterY})}`);
  if (options.missingAssetId) {
    ev("Missing", `MISSING ASSET\n${options.missingAssetId}\nnot captured yet`, `{\\pos(${Math.round(boxes.media.x + boxes.media.w / 2)},${mediaCenterY})}`);
  }
  ev("Label", options.label);
  if (options.watermark) ev("Watermark", options.watermark, `{\\pos(${CANVAS.width / 2},${CANVAS.height - 24})}`);
  return lines.join("\n") + "\n";
}

export interface FilterOptions {
  assFile: string;
  fontsDir: string;
  /** Draw a solid placeholder card over the media box (missing asset). */
  placeholderBox?: Rect | null;
}

/**
 * ffmpeg filter graph for one scene. Input 0 is the solid canvas, input 1 the screenshot (when present).
 * The crop is scaled uniformly, so nothing can be stretched. Masks are drawn after the overlay so they
 * cover whatever sits under them.
 */
export function buildFilterComplex(placement: MediaPlacement | null, options: FilterOptions): string {
  const ass = `ass=${options.assFile}:fontsdir=${options.fontsDir}`;
  const parts: string[] = [];
  if (placement) {
    const { crop } = placement;
    parts.push(`[1:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${placement.width}:${placement.height}:flags=lanczos[m]`);
    let chain = `[0:v][m]overlay=${placement.x}:${placement.y}`;
    for (const box of placement.maskBoxes) chain += `,drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=black:t=fill`;
    if (placement.focalBox) chain += `,drawbox=x=${placement.focalBox.x}:y=${placement.focalBox.y}:w=${placement.focalBox.w}:h=${placement.focalBox.h}:color=0x2ec4e6:t=4`;
    parts.push(`${chain},${ass}[v]`);
  } else if (options.placeholderBox) {
    const b = options.placeholderBox;
    parts.push(`[0:v]drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=0x3a0f14:t=fill,drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=0xff4060:t=4,${ass}[v]`);
  } else {
    parts.push(`[0:v]${ass}[v]`);
  }
  return parts.join(";");
}

/** Debug overlay: platform safe areas and the fixed text boxes, so a human can see nothing important is in a covered zone. */
export function buildSafeAreaOverlay(): string {
  const chain: string[] = [];
  const outline = (r: Rect, color: string, t = 3) => chain.push(`drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=${color}:t=${t}`);
  outline(safeRect("tiktok"), "magenta");
  outline(safeRect("youtube_shorts"), "cyan");
  const boxes = layoutBoxes("tiktok");
  for (const r of [boxes.headline, boxes.media, boxes.disclosure, boxes.caption]) outline(r, "yellow@0.6", 2);
  return chain.join(",");
}
