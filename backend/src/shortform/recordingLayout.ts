import type { PlanIssue, Rect, SceneSpec } from "./types.js";

/**
 * Geometry of a "recording" scene (see RecordingSpec in types.ts): a large headline at the top, the real screen recording
 * cropped to the proof in a rounded card under it, then the beat's caption, and on the closing beat the invitation. Pure, so
 * the validator and the renderer share one computation and a test can pin it.
 *
 * Everything the viewer must read sits in one column, x 40 to 920: that keeps it left of the platforms' right-hand button
 * column (x >= 930 from y 740 down) at every height, and above the platforms' caption area (y >= 1600).
 */
export const RECORDING = {
  /** The column the card and the text live in. */
  columnLeft: 40,
  columnWidth: 880,
  textLeft: 60,
  textWidth: 860,
  /** Top of the headline block (the "Demo data" label sits above it, at y 168). */
  headlineTop: 250,
  /** The headline's gap to the card. */
  cardGap: 40,
  /** Largest enlargement of the recording (it is a 2.5x capture, so beyond this it would look soft). */
  maxScale: 1.25,
  captionFont: 62,
  captionPitch: 78,
  captionGap: 56,
  ctaFont: 54,
  ctaPitch: 68,
  ctaGap: 36,
  /** Width of one glyph as a fraction of the ASS font size for Poppins ExtraBold (measured on a real render: 17 characters at size 100 are 437 px wide). */
  glyphEm: 0.27,
  /** Nothing may be drawn at or below this y (the platforms' caption area starts at 1600). */
  safeBottom: 1560,
  /** Where the platforms' right-hand button column starts: a card reaching past x 930 must end above y 740. */
  rightColumn: { x: 930, y: 740 },
} as const;

/** The largest font (at most `max`) at which the widest of `lines` fits `width`. */
export function fitLinesFont(lines: readonly string[], max: number, width: number, min = 60): number {
  const widest = Math.max(1, ...lines.map((l) => l.length));
  let fs = max;
  while (fs > min && widest * RECORDING.glyphEm * fs > width) fs -= 2;
  return fs;
}

/** Greedy word wrap by character budget. */
export function wrapLines(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Characters of `fs`-sized text that fit the text column. */
export const charsPerLine = (fs: number): number => Math.floor(RECORDING.textWidth / (RECORDING.glyphEm * fs));

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export interface RecordingLayout {
  headlineFont: number;
  headlinePitch: number;
  /** y of the first headline line's centre, and the bottom of the block. */
  headlineLines: string[];
  headlineBottom: number;
  card: { x: number; y: number; width: number; height: number; radius: number; scale: number };
  captionLines: string[];
  captionTop: number;
  ctaLines: string[];
  ctaTop: number;
  /** The lowest y anything is drawn at. */
  bottom: number;
}

export interface RecordingTextInput {
  headline: string;
  captionText: string;
  cta: string | null;
  /** The first beat shows the hook at hook size; later beats show a shorter line a little smaller. */
  hook: boolean;
}

/** How the headline of a recording beat is split into display lines and sized. The first beat's lines come from the concept. */
export function headlineLayout(text: string, hook: boolean, lines?: readonly string[]): { lines: string[]; font: number } {
  const wanted = hook ? 150 : 124;
  const split = lines && lines.length > 0 ? [...lines] : wrapLines(text, charsPerLine(wanted));
  const font = fitLinesFont(split, wanted, RECORDING.textWidth);
  // A wrapped line that still does not fit at the fitted size means the headline is too long for this beat.
  return { lines: split, font };
}

export function computeRecordingLayout(crop: Rect, input: RecordingTextInput, headlineLines?: readonly string[]): RecordingLayout {
  const { lines, font } = headlineLayout(input.headline, input.hook, headlineLines);
  const pitch = Math.round(font * 1.0);
  const headlineBottom = RECORDING.headlineTop + lines.length * pitch;
  const scale = Math.min(RECORDING.columnWidth / crop.w, RECORDING.maxScale);
  const width = even(crop.w * scale);
  const height = even(crop.h * scale);
  const x = RECORDING.columnLeft + Math.round((RECORDING.columnWidth - width) / 2);
  const y = headlineBottom + RECORDING.cardGap;
  const cardBottom = y + height;
  const captionLines = input.captionText ? wrapLines(input.captionText, charsPerLine(RECORDING.captionFont)) : [];
  const captionTop = cardBottom + RECORDING.captionGap;
  const captionBottom = captionTop + captionLines.length * RECORDING.captionPitch;
  const ctaLines = input.cta ? wrapLines(input.cta, charsPerLine(RECORDING.ctaFont)) : [];
  const ctaTop = captionBottom + RECORDING.ctaGap;
  const bottom = ctaLines.length > 0 ? ctaTop + ctaLines.length * RECORDING.ctaPitch : captionBottom;
  return {
    headlineFont: font,
    headlinePitch: pitch,
    headlineLines: lines,
    headlineBottom,
    card: { x, y, width, height, radius: Math.round(40 * scale), scale },
    captionLines,
    captionTop,
    ctaLines,
    ctaTop,
    bottom,
  };
}

/** A rectangle in the source recording's pixels, mapped to the frame. */
export function mapToFrame(layout: RecordingLayout, crop: Rect, r: Rect): Rect {
  const s = layout.card.scale;
  return { x: layout.card.x + (r.x - crop.x) * s, y: layout.card.y + (r.y - crop.y) * s, w: r.w * s, h: r.h * s };
}

/** Why this layout would put something under a platform overlay or off the safe area, or an empty list when it is fine. */
export function recordingSafetyProblems(layout: RecordingLayout): string[] {
  const problems: string[] = [];
  const { x, y, width, height } = layout.card;
  const right = x + width;
  const bottom = y + height;
  if (right > RECORDING.rightColumn.x && bottom > RECORDING.rightColumn.y) problems.push(`the card (x ${x}-${right}, y ${y}-${bottom}) would run under the platforms' right-hand buttons (x >= ${RECORDING.rightColumn.x}, y >= ${RECORDING.rightColumn.y})`);
  if (layout.bottom > RECORDING.safeBottom) problems.push(`the text block runs to y ${layout.bottom}, past the safe bottom ${RECORDING.safeBottom}`);
  if (layout.headlineLines.some((l) => l.length * RECORDING.glyphEm * layout.headlineFont > RECORDING.textWidth + 1)) problems.push("a headline line is wider than the text column");
  if (layout.headlineLines.length > 3) problems.push(`the headline needs ${layout.headlineLines.length} lines; the limit is 3`);
  return problems;
}

/** The recording layout checks for one scene, as validator issues. */
export function validateRecordingScene(scene: SceneSpec): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue["severity"], code: string, message: string) => issues.push({ severity, code, sceneId: scene.sceneId, message });
  const rec = scene.recording;
  if (!rec) {
    add("error", "recording_missing_spec", 'A scene with layout "recording" needs a recording spec (rings and accent).');
    return issues;
  }
  if (!scene.crop) return issues;
  const crop = scene.crop;
  if (rec.highlights.length === 0) add("error", "recording_no_highlight", "A recording scene rings the figure being spoken about: give it at least one highlight.");
  for (const h of rec.highlights) {
    const inside = h.x >= crop.x && h.y >= crop.y && h.x + h.w <= crop.x + crop.w && h.y + h.h <= crop.y + crop.h;
    if (!inside) add("error", "recording_highlight_outside_crop", `A highlight (${h.w}x${h.h} at ${h.x},${h.y}) is not fully inside the crop.`);
  }
  if (rec.lines.join(" ") !== scene.headline) add("error", "recording_lines_mismatch", "The headline lines, joined with spaces, must equal the scene headline.");
  const layout = computeRecordingLayout(crop, { headline: scene.headline, captionText: scene.captionText, cta: scene.cta, hook: rec.hook }, rec.lines);
  for (const problem of recordingSafetyProblems(layout)) add("error", "recording_unsafe_layout", `Recording scene: ${problem}.`);
  if (layout.card.scale > 1.2) add("review", "crop_soft", `The recording is enlarged ${layout.card.scale.toFixed(2)}x and may look slightly soft.`);
  return issues;
}
