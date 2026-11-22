/**
 * Deterministic checks from the 2026-11-21 audit of the last 20 posted Prospecting replies (ChatGPT decision F1 to F5).
 * Prompt wording alone is not a guardrail, so each of these runs in code: at discovery and draft time on the post (F3, F4)
 * and on every drafted option before the owner sees it (F1, F2). Cold prospecting only: Inbound and customer-support replies
 * do not use these.
 */

/** F4: a post that tags @grok is a question put to Grok, so a Fillbook reply under it speaks to the wrong audience. */
export function isAddressedToGrok(postText: string): boolean {
  return /(^|[^\w])@grok\b/i.test(postText);
}

const ILLNESS_OR_GRIEF = [
  /\b(?:i\s*(?:feel|am|'m)\s+(?:so\s+|really\s+|very\s+)?(?:sick|ill)\b(?!\s+of\b)|feel(?:ing)?\s+(?:so\s+|really\s+|very\s+)?(?:sick|ill)\b(?!\s+of\b)|(?:so\s+)?sick\s+today\b)/i,
  /\b(?:in the hospital|hospital|surgery|diagnos(?:ed|is)|chemo|cancer|miscarriage|funeral|passed away|passing of|grie(?:f|ving)|mourning)\b/i,
  /\blost my (?:dad|mom|father|mother|wife|husband|brother|sister|son|daughter|friend|dog)\b/i,
];
const MONEY_DISTRESS = [
  /\b(?:in debt|debt|credit card debt|maxed(?: out)?(?: my)? cards?|behind on (?:rent|bills)|can'?t (?:afford|pay)|evict(?:ed|ion)|bankrupt(?:cy)?|lost my job|laid off|unemployed|payday loans?|loan shark)\b/i,
];

/**
 * F3: illness, grief, debt or money trouble. Cold prospecting skips these by default: a reply is either an off-key joke or
 * unsolicited financial advice. Returns the reason, or null.
 */
export function sensitivePersonalReason(postText: string): "illness_or_grief" | "money_distress" | null {
  const text = postText.normalize("NFKC");
  if (ILLNESS_OR_GRIEF.some((p) => p.test(text))) return "illness_or_grief";
  if (MONEY_DISTRESS.some((p) => p.test(text))) return "money_distress";
  return null;
}

const FIRM_NAMES =
  "Topstep|Apex|Take Profit Trader|TakeProfitTrader|TPT|Bulenox|Tradeify|My Funded Futures|MyFundedFutures|MFFU|Elite Trader Funding|FundedNext|Alpha Futures|Hyperprop|Lucid|Legends Trading|Blusky|Phidias";
const FIRM_RULE_ASSERTION = new RegExp(
  `\\b(?:${FIRM_NAMES})\\b[^.!?\\n]*\\b(?:still|always|never|most|all of|every|only|no longer|doesn'?t|does not|has no|have no|won'?t|can'?t)\\b|\\b(?:still|always|never|most|only|no longer)\\b[^.!?\\n]*\\b(?:${FIRM_NAMES})\\b`,
  "i",
);
const WIN_RATE_THRESHOLD = [
  /\b(?:win ?rate|winrate)\b[^.!?\n]{0,40}\b(?:above|below|over|under|at least|needs? to (?:be|stay)|stays?|has to (?:be|stay))\b[^.!?\n]{0,25}?\b(\d{2,3}(?:\.\d+)?)\s?%/gi,
  /\b(\d{2,3}(?:\.\d+)?)\s?%[^.!?\n]{0,25}\b(?:win ?rate|winrate)\b[^.!?\n]{0,40}\b(?:to break ?even|just to break ?even|needed|required)\b/gi,
  /\bbreak-?even\b[^.!?\n]{0,40}?\b(\d{2,3}(?:\.\d+)?)\s?%/gi,
];

function figuresIn(text: string): Set<string> {
  return new Set([...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]));
}

/**
 * F2: a stated threshold or firm rule the verified knowledge does not contain. Two shapes are caught: a win-rate or break-even
 * percentage that is not in the post itself (the audit's "about 52% after commissions"), and a prop firm named in the same
 * sentence as a sweeping rule word such as "still", "most", "only" or "never" (the audit's "Topstep still has that on most
 * accounts"). A question, or a sentence framed as something to check, is allowed. Returns a reason the drafter can fix, or null.
 */
export function unsupportedFactProblem(reply: string, postText: string): string | null {
  const inPost = figuresIn(postText.normalize("NFKC"));
  for (const sentence of reply.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\?\s*$/.test(sentence)) continue;
    for (const pattern of WIN_RATE_THRESHOLD) {
      pattern.lastIndex = 0;
      for (const m of sentence.matchAll(pattern)) {
        if (!inPost.has(m[1]!)) {
          return `states a win-rate or break-even threshold (${m[1]}%) that is not in the post or the verified knowledge. Reframe it as something to check ("check whether it clears breakeven after costs") or use only a number from their post`;
        }
      }
    }
    const framedAsCheck = /\b(?:check|confirm|verify|read|look up|worth checking)\b/i.test(sentence);
    if (!framedAsCheck && FIRM_RULE_ASSERTION.test(sentence)) {
      return "states a prop firm's rule as fact (a firm name with still, most, only, never or similar) that the verified knowledge does not contain. Describe the pattern in their post instead, or tell them to check that firm's rule";
    }
  }
  return null;
}

/** F1: the journal-lens shapes the audit found in 7 of 20 replies ("In a log, compare...", "tag every trade...", "sort a month by..."). */
const LOG_LENS =
  /\b(?:in (?:a|your|the) (?:trade )?(?:log|journal)\b|tag (?:every|each) trade|sort (?:a|your|the) (?:month|week)|compare (?:net )?p&l|compare (?:the )?(?:average|trades per day)|compare (?:the )?(?:weeks?|days?) (?:before|after))/i;

export function usesLogLens(text: string): boolean {
  return LOG_LENS.test(text);
}

/** How many of the most recent posted replies may already use the journal lens before a new one must take a different shape. */
export const LOG_LENS_RECENT_WINDOW = 8;
export const LOG_LENS_RECENT_MAX = 2;

/** F1: a soft problem (one retry, then shown) when the journal lens is already in the recent replies. */
export function logLensProblem(text: string, recentReplies: readonly string[]): string | null {
  if (!usesLogLens(text)) return null;
  const used = recentReplies.slice(0, LOG_LENS_RECENT_WINDOW).filter(usesLogLens).length;
  return used >= LOG_LENS_RECENT_MAX
    ? `uses the "in a log, compare..." shape, which ${used} of the last ${Math.min(LOG_LENS_RECENT_WINDOW, recentReplies.length)} replies already use. Take a different shape: a plain observation, a rule's real mechanic, or a direct answer to what they asked`
    : null;
}
