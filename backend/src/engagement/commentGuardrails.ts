import { checkReplyGuardrails } from "../content/xReplyGuardrails.js";
import type { EngagementPlatform } from "./types.js";

/** TikTok comments are capped at 150 characters; YouTube allows far more but a short comment reads like a person. */
export const COMMENT_MAX_CHARS: Record<EngagementPlatform, number> = { youtube: 280, tiktok: 150 };
export const COMMENT_MIN_CHARS = 12;

/** Promotion and self-reference. A comment under someone else's video is never a pitch (YouTube spam policy). */
const PROMO_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bcheck (?:it |this |that |us |me |my |our )?out\b/i, reason: 'says "check out"' },
  { pattern: /\blink in (?:my |our |the )?(?:bio|profile|description|comments?)\b/i, reason: "points to a link in bio" },
  { pattern: /\b(?:my|our) (?:channel|page|profile|account|app|platform|tool|journal|site|website|videos?|content)\b/i, reason: "points to the commenter's own channel or product" },
  { pattern: /\b(?:subscribe|sub to|sub for sub|follow (?:me|us|back|my)|dm (?:me|us)|visit (?:us|my)|sign ?up|free trial|promo code|discount|giveaway)\b/i, reason: "is a promotional call to action" },
  { pattern: /\bfill-?book\b/i, reason: "names the brand: engagement comments never mention Fillbook" },
  { pattern: /(^|\s)@\w+/, reason: "@-mentions another account" },
];

/** Generic praise that reads as comment spam no matter how it is phrased. */
const GENERIC_PRAISE =
  /^\s*(?:great|good|nice|awesome|amazing|excellent|cool|interesting|helpful|useful|informative) (?:video|content|stuff|post|short|vid|info)\b|\b(?:love|enjoy|like) (?:your|this|the) (?:content|videos?|channel)\b|\bkeep (?:it up|up the (?:good|great) work)\b|^\s*first\b/i;

/** Financial advice or calls: never from the brand account, never in someone else's comment section. */
const ADVICE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\byou should (?:buy|sell|short|long|take|enter|exit|trade|hold|size up|go all in)\b/i, reason: "gives financial advice" },
  { pattern: /\b(?:buy|sell|go long|go short|short|long) (?:it |this |that )?(?:now|here|at \d)/i, reason: "gives a trade call" },
  { pattern: /\b(?:price target|financial advice|can't lose|cannot lose|sure thing|easy money|get rich|passive income)\b/i, reason: "gives or implies financial advice or easy money" },
];

/**
 * First-person experience markers. The comment is posted under the owner's own account, so it must never assert a
 * personal trading experience, result, loss, routine or feeling the owner did not write. A deterministic backstop
 * to the prompt rule (engagementDrafter.ts). Matching is on a normalized copy (curly quotes folded to straight).
 *
 * Lookbehind/lookahead keep acronyms and abbreviations out: "AI", "iPhone", "I.R.S.", "A.I.", "i.e." do not match.
 * Uppercase "US" (the session / the country) is deliberately NOT matched; only the lowercase pronoun "us" is.
 */
export const FIRST_PERSON_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // I, I'm, I've, I'd, I'll (any case: lazy "i" counts)
  { pattern: /(?<![\w.'-])i(?:'(?:m|ve|d|ll))?(?![\w'-]|\.\w)/i, label: "I" },
  { pattern: /(?<![\w.'-])(?:im|ive)(?![\w'-])/i, label: "I'm / I've" },
  { pattern: /(?<![\w.'-])(?:my|mine|myself|me)(?![\w'-])/i, label: "my / me" },
  { pattern: /(?<![\w.'-])(?:we|our|ours|ourselves)(?:'(?:re|ve|d|ll))?(?![\w'-])/i, label: "we / our" },
  { pattern: /(?<![\w.'-])us(?![\w'-])/, label: "us" },
  { pattern: /\b(?:been there|same here|can relate|so relatable|speaking from (?:personal )?experience|from personal experience|learned (?:it|this|that) the hard way)\b/i, label: "claims shared experience" },
];

/** Returns the marker that makes `text` sound like the commenter's own trading experience, or null. */
export function findInventedExperience(text: string): string | null {
  const normalized = text.replace(/[\u2018\u2019\u02BC\u2032]/g, "'");
  for (const { pattern, label } of FIRST_PERSON_PATTERNS) {
    const m = pattern.exec(normalized);
    if (m) return `${label}: "${m[0].trim()}"`;
  }
  return null;
}

/** Returns the first hard problem with a comment, or null. Reuses the project's reply guardrails (links, AI tells, claims). */
export function checkEngagementComment(text: string, platform: EngagementPlatform): string | null {
  const trimmed = text.trim();
  if (trimmed.length < COMMENT_MIN_CHARS) return `is too short (under ${COMMENT_MIN_CHARS} characters)`;
  const max = COMMENT_MAX_CHARS[platform];
  if (trimmed.length > max) return `is too long for ${platform} (${trimmed.length} characters, keep it under ${max})`;
  if (GENERIC_PRAISE.test(trimmed)) return "is generic praise that reads as comment spam: say something specific to this video";
  for (const { pattern, reason } of PROMO_PATTERNS) if (pattern.test(trimmed)) return reason;
  for (const { pattern, reason } of ADVICE_PATTERNS) if (pattern.test(trimmed)) return reason;
  const violation = checkReplyGuardrails(trimmed, false);
  if (violation) return violation.reason;
  const experience = findInventedExperience(trimmed);
  if (experience) {
    return `speaks in the first person (${experience}): it would claim a trading experience the owner never described. Write about what the video says or ask a specific question, in the second or third person`;
  }
  return null;
}
