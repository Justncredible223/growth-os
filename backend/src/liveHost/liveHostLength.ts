/**
 * How long a spoken line may be. A line that runs past about twenty seconds loses the room, and voicing time grows
 * with length (a 65-word opening took 7.2 seconds to voice on the owner's laptop), so the length is held in code
 * and not left to the prompt: the model is asked to cut a long draft once, and whatever is still too long is
 * trimmed here before it reaches the stage.
 */

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface LengthContext {
  /** Duo mode: the owner is on camera and the pace of the back and forth is the show. */
  duo: boolean;
  /** One of the run-of-show beats (opening, sign-off). */
  show: boolean;
  /** A segment (idle or pressed), as opposed to an answer to chat or the co-host. */
  segment: boolean;
  /** A join welcome: people are leaving as it is spoken. */
  joinWelcome: boolean;
}

/** The most words a line may have, or null where the existing character limit is enough. */
export function spokenWordLimit(context: LengthContext): number | null {
  if (context.joinWelcome) return 40;
  if (context.show) return 60;
  if (context.duo) return context.segment ? 60 : 55;
  if (context.segment) return 70;
  return null;
}

const MUST_KEEP = /\b(?:not (?:financial )?advice|entertainment)\b/i;

/** Splits spoken text into sentences, keeping the end punctuation with each one. */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  return (parts ?? []).map((part) => part.trim()).filter(Boolean);
}

/**
 * Cuts a line down to `limit` words by dropping whole sentences, middle first: the first sentence is the hook and
 * the last is the turn back to the co-host or the question to chat, so those are kept. A sentence carrying the
 * "entertainment, not advice" disclaimer is never dropped, so a trimmed line can stay over the limit rather than
 * lose it. If even the first and last sentences together are too long, only the first is kept. Never returns an
 * empty string for non-empty input.
 */
export function trimToWords(text: string, limit: number): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0 || wordCount(text) <= limit) return text.trim();
  const keep = sentences.map((_, index) => index === 0 || index === sentences.length - 1 || MUST_KEEP.test(sentences[index]!));
  const total = () => sentences.reduce((sum, sentence, index) => sum + (keep[index] ? wordCount(sentence) : 0), 0);

  // Re-add middle sentences, nearest the end first, only while they still fit.
  for (let index = sentences.length - 2; index > 0; index--) {
    if (keep[index]) continue;
    if (total() + wordCount(sentences[index]!) <= limit) keep[index] = true;
  }
  if (total() > limit) {
    // The hook and the turn do not fit together: keep the hook and any disclaimer, and drop the ending.
    const last = sentences.length - 1;
    if (last > 0 && !MUST_KEEP.test(sentences[last]!)) keep[last] = false;
  }
  const kept = sentences.filter((_, index) => keep[index]);
  const result = kept.join(" ").trim();
  if (wordCount(result) > limit && kept.length === 1 && !MUST_KEEP.test(result)) {
    // A single sentence that is itself too long: cut at the word limit and close it.
    const words = result.split(/\s+/).slice(0, limit).join(" ").replace(/[,;:]+$/, "");
    return /[.!?]$/.test(words) ? words : `${words}.`;
  }
  return result;
}
