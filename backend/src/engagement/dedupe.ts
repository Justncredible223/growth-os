/**
 * Near-duplicate detection for comment drafts. YouTube's spam policy bans repetitive, templated comments, so every
 * new draft is compared against the last N drafted/posted comments and against its siblings.
 */

export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  const normalized = normalizeForDedupe(text);
  return normalized ? normalized.split(" ") : [];
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function bigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Two long comments that open with the same words are a template, however the rest differs. */
const TEMPLATE_OPENER_WORDS = 4;

/** 0..1. Exact match after normalization is 1; a shared templated opener counts as a duplicate too. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  if (ta.join(" ") === tb.join(" ")) return 1;
  // Very short comments only collide when identical.
  if (ta.length < 4 || tb.length < 4) return 0;
  let score = Math.max(jaccard(bigrams(ta), bigrams(tb)), jaccard(new Set(ta), new Set(tb)));
  if (ta.length >= 6 && tb.length >= 6 && ta.slice(0, TEMPLATE_OPENER_WORDS).join(" ") === tb.slice(0, TEMPLATE_OPENER_WORDS).join(" ")) {
    score = Math.max(score, 0.9);
  }
  return score;
}

export const NEAR_DUPLICATE_THRESHOLD = 0.6;

export interface DuplicateMatch {
  index: number;
  score: number;
}

export function findNearDuplicate(candidate: string, history: string[], threshold = NEAR_DUPLICATE_THRESHOLD): DuplicateMatch | null {
  let best: DuplicateMatch | null = null;
  for (let index = 0; index < history.length; index++) {
    const score = similarity(candidate, history[index]!);
    if (score >= threshold && (best === null || score > best.score)) best = { index, score };
  }
  return best;
}

export interface DistinctSelection {
  accepted: string[];
  rejected: Array<{ text: string; reason: string }>;
}

/** Keeps candidates that are not near-duplicates of history or of an earlier accepted candidate. */
export function selectDistinct(candidates: string[], history: string[], threshold = NEAR_DUPLICATE_THRESHOLD): DistinctSelection {
  const accepted: string[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];
  for (const text of candidates) {
    if (findNearDuplicate(text, history, threshold)) {
      rejected.push({ text, reason: "is nearly identical to a recent comment" });
    } else if (findNearDuplicate(text, accepted, threshold)) {
      rejected.push({ text, reason: "is nearly identical to another option" });
    } else {
      accepted.push(text);
    }
  }
  return { accepted, rejected };
}
