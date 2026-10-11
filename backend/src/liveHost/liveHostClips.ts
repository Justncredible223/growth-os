import { buildTrackedUrl } from "./liveHostLinks.js";

/**
 * Clip candidates from a finished stream. Everything here works from what the Live Host itself recorded (the exact
 * spoken text and when each line finished), so no speech recognition is needed and the captions are the real words.
 *
 * Honest limits: caption timing inside a line is ESTIMATED from word count (the stage's own estimate), the clip start
 * is derived from when the worker confirmed the line finished minus the estimated speech length, and the recording
 * start time has to be supplied. Nothing is published from here: every candidate leaves as `pending_approval`.
 */
export interface SpokenLine {
  id: string;
  kind: string;
  segment: string | null;
  text: string;
  /** When the worker confirmed the line was finished, ISO. */
  spokenAt: string | null;
  /** Names of viewers the line replies to (for the privacy flag only). */
  repliedTo: string[];
  /** The viewer question the line answers, when it is a reply. */
  question: string | null;
}

export interface ClipScore {
  total: number;
  parts: { hook: number; clarity: number; value: number; entertainment: number; standalone: number; brand: number };
  flags: string[];
}

export interface ClipCandidate {
  lineId: string;
  segment: string | null;
  score: ClipScore;
  /** Seconds from the start of the recording. */
  startSeconds: number;
  endSeconds: number;
  captions: Array<{ index: number; startSeconds: number; endSeconds: number; text: string }>;
  title: string;
  description: string;
  trackingLink: string;
  status: "pending_approval";
  timingIsEstimated: true;
}

const WORDS_PER_SECOND = 2.7;
const TRADING_TERMS = /\b(drawdown|loss limit|daily loss|consistency|buffer|stop|contracts?|risk|r-multiple|evaluation|funded|payout|profit target|position size|revenge|overtrad\w*|journal\w*|setup|win rate|trailing)\b/i;
const ADVICE_LIKE = /\b(you should (?:buy|sell|short|long)|buy now|sell now|guaranteed|will hit|going to hit|price target)\b/i;
const FUNNY_SEGMENTS = new Set(["roast_my_trade", "tilt_o_meter", "eval_graveyard", "famous_last_words", "rate_my_excuse"]);

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function estimatedSeconds(text: string): number {
  return Math.max(1.5, wordCount(text) / WORDS_PER_SECOND);
}

export function scoreLine(line: SpokenLine): ClipScore {
  const flags: string[] = [];
  const words = wordCount(line.text);
  const firstSentence = line.text.split(/(?<=[.!?])\s+/)[0] ?? line.text;
  const firstWords = wordCount(firstSentence);

  // Opening hook: a short first sentence, with a number, a question or a contrast.
  let hook = 0;
  if (firstWords >= 4 && firstWords <= 16) hook += 0.5;
  if (/\d|\?|\bbut\b|\bnever\b|\bnobody\b|\bmost\b|\bwithout\b/i.test(firstSentence)) hook += 0.5;

  // Clarity: long enough to teach something, short enough to be a short.
  const clarity = words >= 18 && words <= 60 ? 1 : words >= 12 && words <= 75 ? 0.5 : 0;

  const value = TRADING_TERMS.test(line.text) ? 1 : 0;
  const entertainment = line.segment && FUNNY_SEGMENTS.has(line.segment) ? 0.8 : /\b(candle|tilt|invoice|subscription|therapy)\b/i.test(line.text) ? 0.5 : 0;

  // Standalone: makes sense without chat. A reply is standalone only if the question can be shown with it.
  let standalone = 1;
  if (/^(?:that|this|it|they|he|she|yes|no|right|exactly)\b/i.test(line.text.trim())) {
    standalone = 0.3;
    flags.push("opens on a pronoun that needs context");
  }
  if (line.kind === "reply" && !line.question) {
    standalone = Math.min(standalone, 0.3);
    flags.push("reply without its question");
  }

  const brand = /fill-?book/i.test(line.text) ? 0.3 : 0.15;
  if (ADVICE_LIKE.test(line.text)) flags.push("reads like a trade call: do not publish");
  if (line.repliedTo.length > 0) flags.push("names a viewer: show a handle only with their consent or cut the name");
  if (/\$\d|\d+(?:\.\d+)?\s?(?:%|percent)/.test(line.text)) flags.push("contains figures: check against the verified sources before publishing");
  if (/example data|demo account/i.test(line.text) === false && /\$\d{3,}/.test(line.text)) flags.push("dollar figure not labeled as example data");

  const parts = { hook, clarity, value, entertainment, standalone, brand };
  const total = Math.round((hook * 2 + clarity * 1.5 + value * 2 + entertainment * 1 + standalone * 2 + brand) * 100) / 100;
  return { total: flags.some((f) => f.startsWith("reads like a trade call")) ? 0 : total, parts, flags };
}

/** Splits spoken text into caption chunks of at most `maxWords` words, with estimated times. */
export function captionChunks(text: string, startSeconds: number, maxWords = 5): ClipCandidate["captions"] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const per = 1 / WORDS_PER_SECOND;
  const chunks: ClipCandidate["captions"] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const part = words.slice(i, i + maxWords);
    chunks.push({ index: chunks.length + 1, startSeconds: startSeconds + i * per, endSeconds: startSeconds + (i + part.length) * per, text: part.join(" ") });
  }
  return chunks;
}

function srtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** SRT for one clip, times relative to the clip start. */
export function toSrt(candidate: ClipCandidate): string {
  return candidate.captions
    .map((c) => `${c.index}\n${srtTime(c.startSeconds - candidate.startSeconds)} --> ${srtTime(c.endSeconds - candidate.startSeconds)}\n${c.text}\n`)
    .join("\n");
}

export function titleFor(text: string): string {
  const first = (text.split(/(?<=[.!?])\s+/)[0] ?? text).replace(/\s+/g, " ").trim();
  const cut = first.length > 70 ? `${first.slice(0, 67).replace(/\s+\S*$/, "")}...` : first;
  return cut;
}

export interface BuildClipsInput {
  lines: SpokenLine[];
  /** ISO time the recording started. */
  recordingStartedAt: string;
  episode: string;
  maxClips?: number;
  minScore?: number;
}

/** The review queue: best-scoring lines first, each pending approval. Lines without a confirmed time are skipped. */
export function buildClipQueue(input: BuildClipsInput): ClipCandidate[] {
  const recordingStart = new Date(input.recordingStartedAt).getTime();
  const out: ClipCandidate[] = [];
  for (const line of input.lines) {
    if (!line.spokenAt || line.kind === "filler") continue;
    const score = scoreLine(line);
    if (score.total < (input.minScore ?? 5)) continue;
    const length = estimatedSeconds(line.text);
    const endSeconds = (new Date(line.spokenAt).getTime() - recordingStart) / 1000;
    const startSeconds = Math.max(0, endSeconds - length - 0.3);
    if (endSeconds <= 0) continue;
    const link = buildTrackedUrl({ placement: "short", episode: input.episode });
    const title = titleFor(line.text);
    out.push({
      lineId: line.id,
      segment: line.segment,
      score,
      startSeconds,
      endSeconds: endSeconds + 0.4,
      captions: captionChunks(line.text, startSeconds + 0.3),
      title,
      description: `${line.text}\n\nTilt is an AI character. Education and entertainment only, not financial advice.\nFillbook, the trading journal for futures traders: ${link}`,
      trackingLink: link,
      status: "pending_approval",
      timingIsEstimated: true,
    });
  }
  return out.sort((a, b) => b.score.total - a.score.total).slice(0, input.maxClips ?? 10);
}
