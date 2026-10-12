/**
 * Instant answers: the questions every stream gets (hello, what is Fillbook, what does it cost, who are you...) are
 * answered from pre-written, pre-checked lines with no model call, so the reply starts as soon as the chat message
 * is read instead of after a 3 to 8 second draft. Anything that is not one of these goes to the normal drafter.
 *
 * Every line here states only facts already in the persona's approved Fillbook block, uses only the approved
 * prices, and is run through checkSpokenLine by the caller exactly like a model-written line.
 */

export interface InstantAnswer {
  key: string;
  text: string;
  /** True when the line names Fillbook (it counts as a mention and needs the mention to be allowed). */
  mentionsBrand: boolean;
}

export interface InstantContext {
  /** Already cleaned with safeAuthorName. */
  authorName: string;
  /** False on TikTok: the website is never said, the bio is pointed to. */
  websiteAllowed: boolean;
  /** Lines said recently (Tilt's part only); an answer that was just said is not repeated word for word. */
  recentLines: string[];
}

const MAX_WORDS = 10;

const GREETING = /^(?:hi+|hello+|hey+|heya|hiya|yo+|sup|howdy|gm|what'?s up|good (?:morning|afternoon|evening))(?:\s+(?:tilt|everyone|chat|guys|there|candle))?[\s!.?]*$/i;
const WHO_ARE_YOU = /\bwho (?:are|r) (?:you|u)\b|\bwhat (?:are|r) (?:you|u)\b|\bwhat'?s your name\b|\bwhat is your name\b/i;
const IS_AI = /\b(?:are|r) (?:you|u) (?:an? )?(?:ai|bot|real|human|robot|a person)\b/i;
const WHAT_IS_FILLBOOK = /\b(?:what(?:'s| is| does)|tell me about|explain|whats)\b.{0,24}\bfill[\s-]?book(?:\s?hq)?\b|\bfill[\s-]?book(?:\s?hq)?\b.{0,12}\b(?:what|about)\b/i;
const PRICE = /\b(?:how much|price|prices|pricing|costs?|subscription)\b|\b(?:is|does|it|this|that)\b.{0,14}\bfree\b|\bfree (?:plan|trial|version|tier)\b|\bwhat (?:are|r) (?:the )?plans\b/i;
const FEATURES = /\bwhat (?:can|does) (?:it|fill[\s-]?book(?:\s?hq)?) do\b|\bfeatures?\b|\bhow does (?:it|fill[\s-]?book(?:\s?hq)?) work\b|\bwhat do you (?:do|offer)\b/i;
const WHERE = /\b(?:link|website|site|url|where (?:can|do) (?:i|we) (?:find|get|sign|go))\b/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function pick(variants: string[], recentLines: string[]): string | null {
  const recent = recentLines.map((line) => line.trim().toLowerCase());
  for (const variant of variants) if (!recent.includes(variant.trim().toLowerCase())) return variant;
  return null;
}

/** Returns a ready-to-speak answer for a short, common message, or null when the model should answer it. */
export function matchInstantAnswer(body: string, context: InstantContext): InstantAnswer | null {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length === 0 || words(text) > MAX_WORDS) return null;
  const name = context.authorName;
  const where = context.websiteAllowed ? "fillbookhq dot com" : "the link in the bio";
  const make = (key: string, variants: string[], mentionsBrand: boolean): InstantAnswer | null => {
    const line = pick(variants, context.recentLines);
    return line ? { key, text: line, mentionsBrand } : null;
  };

  if (GREETING.test(text)) {
    return make(
      "greeting",
      [
        `Hey ${name}, welcome in. I'm Tilt, a cartoon candle. Ask me anything about futures trading.`,
        `${name}! Good to see you. Throw a trade, a rule or a mistake at me and I'll take it from there.`,
        `Welcome back, ${name}. What are we looking at?`,
      ],
      false,
    );
  }
  if (IS_AI.test(text)) {
    return make("is-ai", [`Yes, ${name}, I'm an AI character. A cartoon candle with opinions about risk, not a person and not a financial advisor.`], false);
  }
  if (WHO_ARE_YOU.test(text)) {
    return make("who", [`I'm Tilt, ${name}. A cartoon candle who lives in a trading journal, and I'm an AI. Ask me about futures, prop firm rules or your habits.`], false);
  }
  if (WHAT_IS_FILLBOOK.test(text)) {
    return make(
      "what-is-fillbook",
      [
        `Fillbook is a trading journal built for futures traders and prop accounts. It logs your trades, flags behavior like revenge trades, and tracks your drawdown and daily loss limits. It lives at ${where}.`,
        `Fillbook is the journal I live in. It tags your trades, shows where your edge leaks, and keeps your prop account rules in view. Find it at ${where}.`,
      ],
      true,
    );
  }
  if (PRICE.test(text)) {
    return make(
      "price",
      [`There is a free plan, ${name}. Core is twenty-four ninety-nine a month and Elite is thirty-nine ninety-nine a month. Details are at ${where}.`],
      true,
    );
  }
  if (FEATURES.test(text)) {
    return make(
      "features",
      [
        `It logs your trades and tags behavior like revenge trades and oversizing, tracks prop account drawdown and daily loss limits, and replays your trades against a firm's rules. More at ${where}.`,
      ],
      true,
    );
  }
  if (WHERE.test(text)) {
    return make("where", [context.websiteAllowed ? `It's at fillbookhq dot com, ${name}. There's a free plan and a sample dashboard with no signup.` : `The link is in the bio, ${name}. There's a free plan.`], true);
  }
  return null;
}
