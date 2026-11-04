/**
 * Reply spacing (owner rule 2026-11-04): a reply with two parts is shown as two short paragraphs with one blank line
 * between them, never one run-on block. The drafting prompt asks for it, and this is the mechanical backstop for when a
 * model runs the sentences together. It only ever changes whitespace: no word is added, removed or reordered.
 *
 * It runs AFTER the guardrails have approved a draft, so what they checked is what the owner reads. Splitting turns one
 * space into a two-newline break, which is one character longer, so it is skipped when that would pass the length limit.
 */

/** A reply shorter than this stays on one line: a short sentence or two does not need a break. */
export const SPACING_MIN_CHARS = 80;

/** Words that end in a full stop without ending a sentence ("vs. Apex", "e.g. a stop"). Compared lower-cased, without the stop. */
const NON_TERMINAL = new Set(["vs", "e.g", "i.e", "etc", "approx", "avg", "no", "inc", "u.s", "mr", "ms", "dr", "st"]);

/** Splits at a stop, question mark or exclamation mark followed by space and a capital, digit, dollar sign, quote, bracket or @. */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const boundary = /([.!?])\s+(?=[A-Z0-9$"'(@])/g;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const end = m.index + 1;
    const word = text.slice(start, end).split(/\s+/).pop()!.replace(/[.!?]+$/, "").toLowerCase();
    if (m[1] === "." && NON_TERMINAL.has(word)) continue;
    parts.push(text.slice(start, end));
    start = m.index + m[0].length;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Two or more sentences become two paragraphs: the first sentence, a blank line, then the rest. Text that already has a
 * line break keeps its own paragraphs (with runs of blank lines squeezed to one). Anything short, single-sentence, or that
 * would pass `maxLength` once split is returned unchanged apart from trimming.
 */
export function paragraphizeReply(text: string, maxLength = 280): string {
  const trimmed = text.trim();
  if (/\n/.test(trimmed)) return trimmed.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (trimmed.length < SPACING_MIN_CHARS) return trimmed;
  const sentences = splitSentences(trimmed);
  if (sentences.length < 2) return trimmed;
  const split = `${sentences[0]}\n\n${sentences.slice(1).join(" ")}`;
  return split.length > maxLength ? trimmed : split;
}
