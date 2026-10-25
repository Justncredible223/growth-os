import { checkReplySoftStyle } from "../content/xReplyGuardrails.js";

/**
 * Reply-style experiment (owner direction 2026-10-16). The cold-reply drafter returns TWO options in one model
 * call so the owner can pick, and which one was actually posted is recorded so the Monday review can compare
 * views and likes per style. Nothing here posts anything; the owner still posts every reply by hand.
 */
export type DraftStyle = "sharp" | "helpful" | "fillbook";

export interface DraftOption {
  style: DraftStyle;
  text: string;
}

/** What gets recorded for a posted reply. "edited" = the posted text matched neither option; "legacy" = a single-style draft. */
export type PostedStyle = DraftStyle | "edited" | "legacy";

/**
 * THE REVERT SWITCH. true = Prospecting cold replies are drafted as two options (sharp + helpful) with the style block
 * in the prompt; false = exactly the previous single-draft behavior (old prompt, one reply). Nothing else needs to change.
 */
export const PROSPECTING_TWO_OPTION_DRAFTS = true;

export const SHARP_MIN_WORDS = 8;
export const SHARP_MAX_WORDS = 25;
export const HELPFUL_MAX_SENTENCES = 2;

/** Where the options live on the row: inside the existing score_breakdown JSON column, so no migration is needed. */
export const DRAFT_OPTIONS_KEY = "draft_options";
export const POSTED_STYLE_KEY = "posted_style";

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** True when the post itself brings up Fillbook, the only case where a cold reply may name it. */
export function postMentionsFillbook(postText: string): boolean {
  return /\bfillbook/i.test(postText);
}

/**
 * Slogan shapes the sharp option drifts into (owner-flagged 2026-10-24: the tidy two-beat line is itself a bot tell). Kept narrow on
 * purpose: the shared soft patterns once matched 70% of what the model writes, so only the exact personification and
 * punchline-closer shapes are caught here, and only for the sharp option.
 */
const SHARP_SLOGAN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:doesn'?t|does not|don'?t|do not) (?:care|forgive|forget)\b/i, reason: "gives an abstract thing a mind (\"doesn't care\"), a slogan shape" },
  { pattern: /\b(?:just|only|simply) (?:knows|remembers|counts|waits)\b/i, reason: 'closes on a punchline ("it just knows"), a slogan shape' },
];

/** True when the line is two very short sentences back to back, the balanced slogan rhythm. */
function isTwoBeatSlogan(text: string): boolean {
  const parts = text.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length === 2 && parts.every((p) => wordCount(p) <= 7);
}

/** Soft style problems for one option (a retry hint, never a reason to refuse). Null when it is fine. */
export function optionSoftProblem(style: DraftStyle, text: string): string | null {
  const base = checkReplySoftStyle(text)?.reason;
  if (base) return base;
  if (style === "sharp") {
    const words = wordCount(text);
    if (words < SHARP_MIN_WORDS || words > SHARP_MAX_WORDS) return `is ${words} words; the sharp option must be ${SHARP_MIN_WORDS} to ${SHARP_MAX_WORDS} words`;
    if (sentenceCount(text) > 2) return "runs more than two short sentences; the sharp option is a single line";
    const slogan = SHARP_SLOGAN_PATTERNS.find(({ pattern }) => pattern.test(text));
    if (slogan) return slogan.reason;
    if (isTwoBeatSlogan(text)) return "is two short balanced sentences, a slogan rhythm; make it one specific, uneven sentence";
    return null;
  }
  const sentences = sentenceCount(text);
  if (style === "fillbook") {
    if (!/\bfillbook/i.test(text)) return "does not name Fillbook; the Fillbook option must name it and one view";
    return sentences > HELPFUL_MAX_SENTENCES ? `runs ${sentences} sentences; the Fillbook option is at most ${HELPFUL_MAX_SENTENCES}` : null;
  }
  if (sentences > HELPFUL_MAX_SENTENCES) return `runs ${sentences} sentences; the helpful option is at most ${HELPFUL_MAX_SENTENCES}`;
  return null;
}

/** Parses the stored JSON, tolerating anything malformed (returns null rather than throwing). */
export function parseDraftOptions(raw: unknown): DraftOption[] | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const out: DraftOption[] = [];
  for (const item of value) {
    const style = (item as { style?: unknown })?.style;
    const text = (item as { text?: unknown })?.text;
    if ((style === "sharp" || style === "helpful" || style === "fillbook") && typeof text === "string" && text.trim()) out.push({ style, text });
  }
  return out.length > 0 ? out : null;
}

/** Which style the posted text is. Whitespace-insensitive exact match to an option; anything else is "edited". */
export function matchPostedStyle(postedText: string | null | undefined, options: DraftOption[] | null | undefined, draftReply: string | null | undefined): PostedStyle {
  const posted = normalize(postedText ?? "");
  if (!posted) return "edited";
  if (options && options.length > 0) {
    const hit = options.find((o) => normalize(o.text) === posted);
    return hit ? hit.style : "edited";
  }
  return draftReply && normalize(draftReply) === posted ? "legacy" : "edited";
}
