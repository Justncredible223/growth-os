import { containsBannedGenericPhrase, containsUnverifiedClaim, dashProblem } from "../content/xReplyGuardrails.js";

/**
 * Mechanical checks for the Live Host. Two directions:
 *
 *   - INPUT (what chat said): decides whether a message may reach the model at all, and cleans the viewer's name
 *     before it is ever spoken. The host is responsible for everything said on its stream, including a name or a
 *     comment read back, and both well-known AI streamers that were banned were banned for one generated line.
 *   - OUTPUT (what the host is about to say): the last gate before the firewall. A line that fails is never
 *     spoken; the drafter retries with the reason.
 *
 * These are deliberately blunt, high-precision checks. Tone and judgment live in the prompt (liveHostPersona.ts).
 */

/** Longest line the host speaks in one go. About 25 seconds at the stage voice's pace; longer loses a live room. */
export const MAX_SPOKEN_CHARS = 420;
/** Longest chat message passed to the model. Anything longer is cut, never rejected. */
export const MAX_MESSAGE_CHARS = 300;
export const MAX_AUTHOR_NAME_CHARS = 24;
/** Spoken in place of a name that is empty or not safe to say. */
export const FALLBACK_AUTHOR_NAME = "friend";

/**
 * Words that must never be spoken or shown, and that mark a chat message as not worth answering. Slurs and
 * explicit sexual terms only: ordinary swearing is left to the prompt, since chat in this niche swears freely.
 * Matched on letters only, so spacing and punctuation tricks ("f a g") do not get through.
 */
const HARD_BLOCKED_TERMS = [
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "tranny",
  "kike",
  "spic",
  "chink",
  "wetback",
  "rape",
  "rapist",
  "pedophile",
  "pedo",
  "childporn",
  "killyourself",
  "kys",
  "hitler",
  "holocaust",
  "nazi",
];

/** Short blocked terms that are also substrings of ordinary words ("spice", "skyscraper"), matched as whole words only. */
const WHOLE_WORD_ONLY = new Set(["spic", "kys", "pedo", "rape", "chink", "kike", "nazi"]);

function lettersOnly(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, "");
}

/** The blocked term found in the text, or null. */
export function findBlockedTerm(text: string): string | null {
  const squashed = lettersOnly(text);
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  for (const term of HARD_BLOCKED_TERMS) {
    if (WHOLE_WORD_ONLY.has(term)) {
      if (words.has(term)) return term;
    } else if (squashed.includes(term)) {
      return term;
    }
  }
  return null;
}

/**
 * Topics the host does not engage with on a brand stream. A message that is only about one of these is skipped
 * rather than answered, so the model is never asked to improvise on them.
 */
const OFF_LIMITS_TOPIC = /\b(?:trump|biden|harris|democrats?|republicans?|election|abortion|israel|palestin\w*|gaza|hamas|ukraine|putin|immigra\w+|jews?|muslims?|christians?|suicide|self[- ]harm)\b/i;

/**
 * Attempts to give the host new instructions through chat. Chat is data, never instructions; the prompt says so
 * too. These are skipped outright so the cheapest attacks never cost a model call.
 */
const INJECTION_ATTEMPT = /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|above|your)\b.{0,30}\b(?:instructions?|rules?|prompt)\b|\bsystem prompt\b|\byou are now\b|\bpretend (?:to be|you(?:'re| are))\b|\brepeat after me\b|\bsay exactly\b/i;

const LINK_PATTERN = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|io|co|app|net|org|gg|xyz|ly|me|tv)\b/gi;

export interface MessageScreening {
  /** Null when the message may be answered. */
  blockedReason: string | null;
  /** The message text as the model may see it: links removed, whitespace collapsed, cut to length. */
  cleanBody: string;
}

/** Decides whether one chat message may reach the model, and returns the cleaned text. */
export function screenIncomingMessage(body: string): MessageScreening {
  const collapsed = body.replace(/\s+/g, " ").trim();
  const cleanBody = collapsed.replace(LINK_PATTERN, "[link]").slice(0, MAX_MESSAGE_CHARS);
  if (cleanBody.replace(/\[link\]/g, "").trim().length === 0) return { blockedReason: "empty or link-only message", cleanBody };
  const blocked = findBlockedTerm(collapsed);
  if (blocked) return { blockedReason: "contains a blocked term", cleanBody };
  if (INJECTION_ATTEMPT.test(collapsed)) return { blockedReason: "tries to give the host instructions", cleanBody };
  if (OFF_LIMITS_TOPIC.test(collapsed)) return { blockedReason: "off-limits topic for the stream", cleanBody };
  return { blockedReason: null, cleanBody };
}

/**
 * A viewer's display name, made safe to speak and show: letters, digits and spaces only, cut to length. A name
 * that is empty afterwards, or that carries a blocked term or a link, becomes "friend". Names are the easiest way
 * to make a host say something it should not, so nothing else from the raw name survives.
 */
export function safeAuthorName(rawName: string): string {
  if (LINK_PATTERN.test(rawName)) {
    LINK_PATTERN.lastIndex = 0;
    return FALLBACK_AUTHOR_NAME;
  }
  LINK_PATTERN.lastIndex = 0;
  const cleaned = rawName
    .replace(/^@+/, "")
    .replace(/[_.\-]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTHOR_NAME_CHARS)
    .trim();
  if (cleaned.length < 2) return FALLBACK_AUTHOR_NAME;
  if (findBlockedTerm(cleaned)) return FALLBACK_AUTHOR_NAME;
  if (OFF_LIMITS_TOPIC.test(cleaned)) return FALLBACK_AUTHOR_NAME;
  return cleaned;
}

/**
 * Anything that reads as telling a viewer what to trade, or predicting a price. The host talks about process,
 * rules and psychology; it never gives a call. "Not financial advice" style disclaimers do not match.
 */
const TRADE_CALL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:you should|you need to|i(?:'d| would)|just|go ahead and|time to)\s+(?:buy|sell|short|long|go long|go short|enter|size up|add to|hold)\b/i,
    reason: "tells a viewer what to trade",
  },
  { pattern: /\b(?:buy|sell|short|long)\s+(?:it\s+)?(?:now|here|today|the dip|the open|at the open|the close)\b/i, reason: "gives a trade call" },
  {
    pattern: /\b(?:nq|es|mnq|mes|ym|rty|cl|gc|gold|oil|bitcoin|btc|the market|price|it)\s+(?:will|is going to|is gonna|should)\s+(?:hit|reach|go to|rally|dump|pump|moon|tank|drop|crash|break)\b/i,
    reason: "predicts where a market will go",
  },
  { pattern: /\b(?:price target|my target is|take profit at|stop(?: loss)? at)\s*\$?\d/i, reason: "gives a price level to trade" },
  { pattern: /\b(?:easy|free|guaranteed|risk[- ]free)\s+(?:money|profits?|payouts?|gains)\b/i, reason: "implies easy or risk-free money" },
];

const EMOJI = /\p{Extended_Pictographic}/u;
const APPROVED_SPOKEN_DOMAIN = "fillbookhq.com";

export interface SpokenLineContext {
  /**
   * False when the host has mentioned Fillbook too often lately and no viewer asked about it. A line that
   * mentions Fillbook anyway is rejected, which is what keeps the stream from turning into an advert.
   */
  fillbookMentionAllowed: boolean;
}

/** True when the text mentions the product by name or domain. */
export function mentionsFillbook(text: string): boolean {
  return /fill-?book/i.test(text);
}

/**
 * Every mechanical check on a line the host is about to speak. Returns the first problem, phrased to complete
 * "the line ...", or null for a clean line. Brand-rule vocabulary (the table-driven check) is run separately by
 * the caller because it needs the database.
 */
export function checkSpokenLine(text: string, context: SpokenLineContext): string | null {
  const line = text.trim();
  if (line.length === 0) return "is empty";
  if (line.length > MAX_SPOKEN_CHARS) return `is too long to say in one go (${line.length} characters, the limit is ${MAX_SPOKEN_CHARS})`;

  if (findBlockedTerm(line)) return "contains a blocked term";
  if (OFF_LIMITS_TOPIC.test(line)) return "touches an off-limits topic";

  const tradeCall = TRADE_CALL_PATTERNS.find(({ pattern }) => pattern.test(line));
  if (tradeCall) return tradeCall.reason;

  const unverified = containsUnverifiedClaim(line);
  if (unverified) return unverified.reason;
  const generic = containsBannedGenericPhrase(line);
  if (generic) return generic.reason;
  const dash = dashProblem(line);
  if (dash) return dash.reason;

  if (EMOJI.test(line)) return "contains an emoji, which the voice cannot say";
  if (/#\w+/.test(line)) return "contains a hashtag";

  const links = line.match(LINK_PATTERN) ?? [];
  LINK_PATTERN.lastIndex = 0;
  const badLink = links.find((link) => !link.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").startsWith(APPROVED_SPOKEN_DOMAIN));
  if (badLink) return `mentions a link that is not ${APPROVED_SPOKEN_DOMAIN}`;

  if (!context.fillbookMentionAllowed && mentionsFillbook(line)) {
    return "mentions Fillbook again although it has come up too often lately and nobody asked about it";
  }
  return null;
}
