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
  return violation ? violation.reason : null;
}
