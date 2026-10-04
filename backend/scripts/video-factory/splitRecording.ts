import type { Silence } from "./suppliedVoice.js";

/**
 * Cutting a recording that has NO timing markup into one part per line (owner decision, 2026-10-03: ElevenLabs v4 takes plain
 * text, no break tags). The lines are all complete sentences, so the pause the voice leaves after each full stop is longer than
 * the pauses inside a line (after a colon or a comma). A file of N lines is therefore cut at its N-1 longest pauses. Two
 * checks guard the cut, because a wrong cut would silently put one beat's words under another beat:
 *
 *   ambiguity   the shortest pause chosen must be clearly longer than the longest pause left over, or the choice is a guess;
 *   share       each part's length must be near the share its line's words predict (a part that is far too long or short
 *               means a cut landed inside a line).
 */
export const CUT_MIN_PAUSE_SECONDS = 0.12;
/** Pauses this close to the start or end of the file are lead-in and tail, not a boundary between lines. */
export const EDGE_SECONDS = 0.1;
/** The shortest chosen pause must be at least this many times the longest pause not chosen. */
export const MIN_AMBIGUITY_RATIO = 1.3;
/** A part's share of the file may differ from the share its words predict by at most this much (0-1). */
export const MAX_SHARE_ERROR = 0.12;

export interface Cut {
  /** The middle of the pause: where the file is cut. */
  at: number;
  /** How long the pause is (seconds). */
  pause: number;
}

export interface CutChoice {
  cuts: Cut[];
  /** The longest pause that was NOT chosen (seconds), or 0 when every pause was needed. */
  nextBest: number;
  /** Shortest chosen pause divided by `nextBest` (Infinity when nothing was left over). */
  ratio: number;
}

/** The `lineCount - 1` longest pauses inside the file, in time order. Null when the file has too few pauses to cut. */
export function chooseCuts(silences: Silence[], totalSeconds: number, lineCount: number): CutChoice | null {
  const inner = silences
    .filter((s) => s.end !== null && s.start > EDGE_SECONDS && s.end < totalSeconds - EDGE_SECONDS && s.end - s.start >= CUT_MIN_PAUSE_SECONDS)
    .map((s) => ({ at: (s.start + (s.end as number)) / 2, pause: (s.end as number) - s.start }));
  const need = lineCount - 1;
  if (inner.length < need) return null;
  const byLength = [...inner].sort((a, b) => b.pause - a.pause);
  const chosen = byLength.slice(0, need).sort((a, b) => a.at - b.at);
  const nextBest = byLength[need]?.pause ?? 0;
  const shortest = Math.min(...chosen.map((c) => c.pause));
  return { cuts: chosen, nextBest, ratio: nextBest === 0 ? Infinity : shortest / nextBest };
}

const SMALL = [2, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 3, 1, 2, 2, 2, 2, 3, 2, 2];
const TENS = [0, 0, 2, 2, 2, 2, 2, 3, 2, 2];

/** Syllables in the spoken form of a whole number (an estimate: "one thousand seven hundred twenty-five" is 9). */
export function numberSyllables(n: number): number {
  if (n < 20) return SMALL[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? SMALL[n % 10]! : 0);
  if (n < 1000) return SMALL[Math.floor(n / 100)]! + 2 + (n % 100 ? numberSyllables(n % 100) : 0);
  return numberSyllables(Math.floor(n / 1000)) + 2 + (n % 1000 ? numberSyllables(n % 1000) : 0);
}

/** How long a line takes to say, in syllables (an estimate good to about a quarter). */
export function lineWeight(line: string): number {
  let total = 0;
  for (const raw of line.split(/\s+/).filter(Boolean)) {
    const money = raw.includes("$") ? 2 : 0; // "dollars"
    const percent = raw.includes("%") ? 2 : 0; // "percent"
    const token = raw.replace(/[$%,]/g, "").replace(/[.:;!?]+$/, "");
    if (/^-?\d+(?:\.\d+)?$/.test(token)) {
      const [whole, decimals] = token.replace("-", "").split(".");
      total += numberSyllables(Number(whole)) + money + percent;
      if (decimals) total += 1 + [...decimals].reduce((n, d) => n + numberSyllables(Number(d)), 0); // "point" + each digit
      continue;
    }
    if (/&/.test(token)) {
      total += 3; // "P and L"
      continue;
    }
    total += Math.max(1, (token.toLowerCase().match(/[aeiouy]+/g) ?? []).length);
  }
  return total;
}

export interface ShareCheck {
  /** Each part's measured share of the whole (0-1). */
  actual: number[];
  /** Each part's share predicted from its words (0-1). */
  predicted: number[];
  /** Largest difference between a measured and a predicted share. */
  worst: number;
  ok: boolean;
}

/** Compares each part's length with the length its line's words predict. `partSeconds` are the measured parts, in order. */
export function checkShares(lines: string[], partSeconds: number[]): ShareCheck {
  const weights = lines.map(lineWeight);
  const wTotal = weights.reduce((a, b) => a + b, 0);
  const sTotal = partSeconds.reduce((a, b) => a + b, 0);
  const predicted = weights.map((w) => w / wTotal);
  const actual = partSeconds.map((s) => s / sTotal);
  const worst = Math.max(...actual.map((a, i) => Math.abs(a - predicted[i]!)));
  return { actual, predicted, worst, ok: worst <= MAX_SHARE_ERROR };
}

/** The spans [start, end] of each part when the file is cut at `cuts`. */
export function partSpans(cuts: Cut[], totalSeconds: number): Array<[number, number]> {
  const edges = [0, ...cuts.map((c) => c.at), totalSeconds];
  return edges.slice(0, -1).map((start, i) => [start, edges[i + 1]!]);
}

/** The best size-matched choice must beat the next different choice by at least this much (a share difference, 0-1). */
export const MIN_SIZE_MARGIN = 0.04;
/** And its own worst share error must be at most this (0-1). */
export const MAX_SIZE_ERROR = 0.07;

export interface SizeChoice {
  choice: CutChoice;
  worst: number;
  /** The worst share error of the next best different choice (what a wrong cut would have cost). */
  runnerUp: number;
}

function* combinations<T>(items: T[], k: number, start = 0, chosen: T[] = []): Generator<T[]> {
  if (chosen.length === k) {
    yield [...chosen];
    return;
  }
  for (let i = start; i < items.length; i++) {
    chosen.push(items[i]!);
    yield* combinations(items, k, i + 1, chosen);
    chosen.pop();
  }
}

/**
 * For a file whose longest pauses cannot be told apart from the pauses inside lines (a colon leaves as long a pause as a full
 * stop), picks the set of pauses that makes every part the length its words predict. It is accepted only when that choice is
 * both close (worst share error within MAX_SIZE_ERROR) and clearly better than any other choice (by MIN_SIZE_MARGIN), so a
 * file where two choices fit equally well is refused rather than guessed.
 */
export function chooseCutsBySize(silences: Silence[], totalSeconds: number, lines: string[]): SizeChoice | null {
  const inner = silences
    .filter((s) => s.end !== null && s.start > EDGE_SECONDS && s.end < totalSeconds - EDGE_SECONDS && s.end - s.start >= CUT_MIN_PAUSE_SECONDS)
    .map((s) => ({ at: (s.start + (s.end as number)) / 2, pause: (s.end as number) - s.start }));
  const k = lines.length - 1;
  if (inner.length < k || inner.length > 16) return null;
  const scored: Array<{ cuts: Cut[]; worst: number }> = [];
  for (const cuts of combinations(inner, k)) {
    const spans = partSpans(cuts, totalSeconds);
    scored.push({ cuts, worst: checkShares(lines, spans.map(([a, b]) => b - a)).worst });
  }
  scored.sort((a, b) => a.worst - b.worst);
  const best = scored[0]!;
  const runnerUp = scored[1]?.worst ?? 1;
  if (best.worst > MAX_SIZE_ERROR || runnerUp - best.worst < MIN_SIZE_MARGIN) return null;
  const rest = inner.filter((c) => !best.cuts.includes(c));
  const nextBest = rest.length ? Math.max(...rest.map((c) => c.pause)) : 0;
  const shortest = Math.min(...best.cuts.map((c) => c.pause));
  return { choice: { cuts: best.cuts, nextBest, ratio: nextBest === 0 ? Infinity : shortest / nextBest }, worst: best.worst, runnerUp };
}

/** Pauses a voice leaves inside a line: after a colon, semicolon or comma that is not the line's last character. */
export function internalPauseCount(line: string): number {
  // A comma between digits ("$1,725") is part of a number, not a pause.
  return (line.trim().replace(/[.!?]+$/, "").replace(/(\d),(?=\d)/g, "$1").match(/[:;,]/g) ?? []).length;
}

/**
 * When the number of pauses found is exactly the number the punctuation predicts (one after each colon or comma inside a line,
 * one after each full stop between lines), the pauses are matched to their places in order and the ones that fall after a
 * line are the cuts. Used when a colon pauses as long as a full stop, so length alone cannot tell them apart. Returns null
 * when the counts differ, which means a pause was missed or added and the order cannot be trusted.
 */
export function chooseCutsBySlots(silences: Silence[], totalSeconds: number, lines: string[]): CutChoice | null {
  const inner = silences
    .filter((s) => s.end !== null && s.start > EDGE_SECONDS && s.end < totalSeconds - EDGE_SECONDS && s.end - s.start >= CUT_MIN_PAUSE_SECONDS)
    .map((s) => ({ at: (s.start + (s.end as number)) / 2, pause: (s.end as number) - s.start }));
  const slots: boolean[] = []; // true = a boundary between lines, false = a pause inside a line
  lines.forEach((line, i) => {
    for (let k = 0; k < internalPauseCount(line); k++) slots.push(false);
    if (i < lines.length - 1) slots.push(true);
  });
  if (inner.length !== slots.length) return null;
  const cuts = inner.filter((_, i) => slots[i]);
  const rest = inner.filter((_, i) => !slots[i]);
  const nextBest = rest.length ? Math.max(...rest.map((c) => c.pause)) : 0;
  const shortest = Math.min(...cuts.map((c) => c.pause));
  return { cuts, nextBest, ratio: nextBest === 0 ? Infinity : shortest / nextBest };
}
