import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A voiceover the owner recorded (ElevenLabs) in place of the built-in voice (owner decision, 2026-10-03). It is dropped into
 * `assets/voice/` and used automatically for the concept it is named after; a concept with no file there keeps the built-in
 * voice. Two forms are accepted, whichever is simpler to hand over:
 *
 *   <planId>.mp3            one file for the whole video, the five lines separated by a long pause (a break tag in the
 *                           script). The file is cut at those pauses, and the cut fails loudly unless it finds exactly
 *                           as many spoken parts as the video has beats.
 *   <planId>-1.mp3 ... -5.mp3   one file per beat, in beat order. No cutting, no guessing.
 *
 * `.wav` and `.m4a` work in place of `.mp3`. Nothing here talks to ElevenLabs: the owner generates the audio and hands the
 * files over, so the renderer needs no key and no network call for these videos.
 */
export const VOICE_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "voice");
export const VOICE_EXTENSIONS = ["mp3", "wav", "m4a"] as const;

/** A pause at least this long (seconds) separates two beats in a single file. A pause inside a line (a comma) is shorter. */
export const BOUNDARY_SILENCE_SECONDS = 0.7;
/** Below this level counts as silence. */
export const SILENCE_THRESHOLD_DB = -40;
/** A spoken part shorter than this (seconds) is a click or a breath, not a line. */
export const MIN_SPEECH_SECONDS = 0.25;

export type SuppliedVoice = { kind: "single"; path: string } | { kind: "parts"; paths: string[] };

/** The owner's recording for this concept, or null when there is none (the built-in voice is used). */
export function findSuppliedVoice(planId: string, sceneCount: number, dir: string = VOICE_DIR): SuppliedVoice | null {
  const find = (stem: string): string | null => {
    for (const ext of VOICE_EXTENSIONS) {
      const path = join(dir, `${stem}.${ext}`);
      if (existsSync(path)) return path;
    }
    return null;
  };
  const parts = Array.from({ length: sceneCount }, (_, i) => find(`${planId}-${i + 1}`));
  if (parts.every((p): p is string => p !== null)) return { kind: "parts", paths: parts };
  const single = find(planId);
  return single ? { kind: "single", path: single } : null;
}

export interface Silence {
  start: number;
  /** Null when the silence runs to the end of the file. */
  end: number | null;
}

/** Reads ffmpeg's `silencedetect` log (it goes to stderr) into silences, in order. */
export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (start) {
      out.push({ start: Math.max(0, Number(start[1])), end: null });
      continue;
    }
    const end = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (end && out.length > 0) out[out.length - 1]!.end = Number(end[1]);
  }
  return out;
}

export interface Segment {
  start: number;
  end: number;
}

/** The spoken parts of a file: everything between the silences, dropping anything shorter than `minSpeech`. */
export function speechSegments(silences: Silence[], totalSeconds: number, minSpeech: number = MIN_SPEECH_SECONDS): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start - cursor >= minSpeech) out.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end ?? totalSeconds);
  }
  if (totalSeconds - cursor >= minSpeech) out.push({ start: cursor, end: totalSeconds });
  return out;
}

/** The plain-words failure when a single file does not split into the beats it should. */
export function splitProblem(planId: string, found: Segment[], expected: number): string {
  const spans = found.map((s, i) => `${i + 1}: ${s.start.toFixed(1)}-${s.end.toFixed(1)}s`).join(", ");
  return (
    `The recording for "${planId}" has ${found.length} spoken part${found.length === 1 ? "" : "s"} but the video has ${expected} beats` +
    `${found.length > 0 ? ` (found ${spans})` : ""}. Separate the lines with a pause of a second or more (a <break time="1.0s" /> tag between them in the script) ` +
    `and keep each line free of long pauses, or hand over one file per beat named ${planId}-1 to ${planId}-${expected}.`
  );
}
