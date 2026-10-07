import type { CaptionCue } from "./types.js";
import { escapeAssText } from "./captions.js";
import { roundedRectPath } from "./chartCues.js";
import { RECORDING, mapToFrame, type RecordingLayout } from "../../src/shortform/recordingLayout.js";
import type { ChartTone, Rect, RecordingSpec } from "../../src/shortform/types.js";

/**
 * The text and rings of a "recording" scene, drawn as ASS vector cues over the cropped recording (the recording itself is
 * composited by render.ts as a rounded card). Pure: the same input always gives the same cues.
 *
 *   - the headline, large, from the very first frame of the scene (no fade, no pop: the first video frame already says it)
 *   - the caption under the card, and on the closing beat the invitation
 *   - one amber ring per highlight, popping in a third of a second after the scene starts and holding
 */
const COLOR = {
  ink: "&HF8F4F0&",
  soft: "&HC4B39F&",
  accent: "&HCFB822&",
  ring: "&H3CC8FF&",
  good: "&H96B02A&",
  bad: "&H4444EF&",
} as const;
const LAYER_RING = 3;
const LAYER_TEXT = 2;
const RING_PAD = 8;
const RING_DELAY_SECONDS = 0.3;

const fmt = (n: number): string => String(Math.round(n * 10) / 10);
const toneColor = (t: ChartTone): string => (t === "bad" ? COLOR.bad : COLOR.good);

export interface RecordingCueInput {
  spec: RecordingSpec;
  layout: RecordingLayout;
  crop: Rect;
  captionText: string;
  cta: string | null;
  /** Scene window in video seconds. */
  start: number;
  end: number;
}

export function buildRecordingCues(input: RecordingCueInput): CaptionCue[] {
  const { spec, layout, crop, start, end } = input;
  const cues: CaptionCue[] = [];
  const push = (text: string, from: number, to: number, layer: number) => cues.push({ text, startSeconds: Math.max(start, from), endSeconds: Math.min(end, to), style: "Chart", layer });

  // The headline: from the first frame; on the opening beat the last line is in the accent colour.
  layout.headlineLines.forEach((line, i) => {
    const y = RECORDING.headlineTop + i * layout.headlinePitch + layout.headlinePitch / 2;
    const color = spec.hook && i === layout.headlineLines.length - 1 ? toneColor(spec.accent) : COLOR.ink;
    push(`{\\an4\\pos(${RECORDING.textLeft},${fmt(y)})\\fs${layout.headlineFont}\\c${color}}${escapeAssText(line)}`, start, end, LAYER_TEXT);
  });

  // The caption under the card, then the invitation.
  layout.captionLines.forEach((line, i) => {
    const y = layout.captionTop + i * RECORDING.captionPitch + RECORDING.captionPitch / 2;
    push(`{\\an4\\pos(${RECORDING.textLeft},${fmt(y)})\\fs${RECORDING.captionFont}\\c${COLOR.soft}}${escapeAssText(line)}`, start, end, LAYER_TEXT);
  });
  layout.ctaLines.forEach((line, i) => {
    const y = layout.ctaTop + i * RECORDING.ctaPitch + RECORDING.ctaPitch / 2;
    push(`{\\an4\\pos(${RECORDING.textLeft},${fmt(y)})\\fs${RECORDING.ctaFont}\\c${COLOR.accent}}${escapeAssText(line)}`, start, end, LAYER_TEXT);
  });

  // The rings, on the figure being spoken about: a short pop, then held.
  for (const h of spec.highlights) {
    const r = mapToFrame(layout, crop, h);
    const w = r.w + 2 * RING_PAD;
    const hh = r.h + 2 * RING_PAD;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const path = roundedRectPath(w, hh, Math.min(22, hh / 2));
    const at = start + RING_DELAY_SECONDS;
    push(`{\\an5\\pos(${fmt(cx)},${fmt(cy)})\\1c${COLOR.ring}\\1a&HE6&\\3c${COLOR.ring}\\bord7\\shad0\\fscx114\\fscy114\\t(0,240,\\fscx100\\fscy100)\\p1}${path}{\\p0}`, at, end, LAYER_RING);
  }
  return cues;
}
