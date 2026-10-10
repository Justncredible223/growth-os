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
 * These are deliberately blunt checks. Tone and judgment live in the prompt (liveHostPersona.ts). Every pattern
 * here was revised after an independent review (2026-10-09) that listed real false positives ("therapist",
 * "you were just short of target") and real misses ("Buy NQ now", "NQ's going to 20,000"); the tests carry those
 * examples so they stay fixed.
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
 * explicit terms only: ordinary swearing is left to the prompt, since chat in this niche swears freely.
 */
const HARD_BLOCKED_TERMS = [
  "nigger",
  "nigga",
  "faggot",
  "fag",
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
  "kys",
  "hitler",
  "holocaust",
  "nazi",
];
/** Endings a blocked term may carry and still be that term ("nazis", "raped", "retarded"). */
const TERM_SUFFIX = "(?:s|es|ed|d|ing|z)?";
const BLOCKED_TERM_PATTERN = new RegExp(`^(?:${HARD_BLOCKED_TERMS.join("|")})${TERM_SUFFIX}$`);
const BLOCKED_PHRASES = [/\bkill\s+your\s*self\b/, /\bchild\s*porn/];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/**
 * Lower-cases, strips accents and maps common letter substitutions, so "N4zi" and "nàzi" read as the word they
 * are. Anything outside a-z becomes a space: a blocked term has to stand as its own word to match, which is what
 * keeps "therapist", "grape" and "skyscraper" clean.
 */
function normalizeForBlocklist(text: string, digitsAsLetters: boolean): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[0134579@$!]/g, (char) => (digitsAsLetters ? (LEET[char] ?? char) : " "))
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/**
 * The blocked term found in the text, or null. Checked twice: with digits read as the letters they stand in
 * for ("n1gger"), and with digits read as separators ("Nazis4Life").
 */
export function findBlockedTerm(text: string): string | null {
  return findBlockedTermIn(normalizeForBlocklist(text, true)) ?? findBlockedTermIn(normalizeForBlocklist(text, false));
}

function findBlockedTermIn(normalized: string): string | null {
  if (BLOCKED_PHRASES.some((pattern) => pattern.test(normalized))) return "blocked phrase";
  const words = normalized.split(" ").filter(Boolean);
  // Letters typed one at a time ("f a g g o t") are joined back into the word they spell.
  const tokens: string[] = [];
  const spelledRuns: string[] = [];
  let spelled = "";
  for (const word of words) {
    if (word.length === 1) {
      spelled += word;
      continue;
    }
    if (spelled.length > 2) spelledRuns.push(spelled);
    spelled = "";
    tokens.push(word);
  }
  if (spelled.length > 2) spelledRuns.push(spelled);
  const whole = tokens.find((token) => BLOCKED_TERM_PATTERN.test(token));
  if (whole) return whole;
  // A spelled-out run is deliberate, so a blocked term anywhere inside it counts ("you are a f a g g o t").
  for (const run of spelledRuns) {
    const inside = HARD_BLOCKED_TERMS.find((term) => term.length > 3 && run.includes(term));
    if (inside) return inside;
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

/** Signal-seller and off-platform spam. Shown on stream, these would make the host look like it endorses them. */
const PROMO_SPAM = /\b(?:telegram|whatsapp|whats app|t\.me|discord\.gg|dm me|d m me|inbox me|message me|text me|contact me|hit me up|check my (?:bio|profile|page)|link in my (?:bio|profile)|follow my (?:page|profile|signals?)|join my|my (?:signals?|telegram|whatsapp|vip)|free signals?|paid signals?|daily signals?|accurate signals?|signals? (?:group|channel|service|provider|daily)|vip (?:group|signals?|channel)|copy ?trad\w*|account (?:management|manager)|manage your account|i (?:can )?(?:help|teach) you (?:recover|trade|make|earn|profit)|recover(?:ed|y)? (?:my|your|lost) (?:funds|money|account)|(?:made|earned|profit(?:ed)?|withdrew) \$?\d[\d,.]*k?\b[^.!?]{0,40}\b(?:thanks to|with|from|because of)|thanks to (?:mr|mrs|miss|coach|sir)|10x|100x|forex signals?|crypto signals?|pump(?: group)?|onlyfans)\b/i;

const TLDS = "com|io|co|app|net|org|gg|xyz|ly|me|tv|ai|dev|us|info|live|biz|link|shop|site|online";
const LINK_SOURCE = `https?:\\/\\/\\S+|\\bwww\\.\\S+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:\\/\\S*)?`;
const linkPattern = () => new RegExp(LINK_SOURCE, "gi");
/** A domain said out loud: "tradezella dot com". */
const SPOKEN_DOMAIN = new RegExp(`\\b([a-z0-9-]+(?: ?hq)?)\\s*(?:dot|point)[ -]?(?:${TLDS})\\b`, "gi");

export interface MessageScreening {
  /** Null when the message may be answered. */
  blockedReason: string | null;
  /** The message text as the model may see it: links removed, whitespace collapsed, cut to length. */
  cleanBody: string;
}

/** Decides whether one chat message may reach the model, and returns the cleaned text. */
export function screenIncomingMessage(body: string): MessageScreening {
  const collapsed = body.replace(/\s+/g, " ").trim();
  const cleanBody = collapsed.replace(linkPattern(), "[link]").slice(0, MAX_MESSAGE_CHARS);
  if (cleanBody.replace(/\[link\]/g, "").trim().length === 0) return { blockedReason: "empty or link-only message", cleanBody };
  if (findBlockedTerm(collapsed)) return { blockedReason: "contains a blocked term", cleanBody };
  if (INJECTION_ATTEMPT.test(collapsed)) return { blockedReason: "tries to give the host instructions", cleanBody };
  if (PROMO_SPAM.test(collapsed)) return { blockedReason: "promotion or spam", cleanBody };
  if (OFF_LIMITS_TOPIC.test(collapsed)) return { blockedReason: "off-limits topic for the stream", cleanBody };
  return { blockedReason: null, cleanBody };
}

/**
 * A viewer's display name, made safe to speak and show: plain letters, digits and spaces only, cut to length. A
 * name that is empty afterwards, or that carries a blocked term, a link, a promotion or anything that reads as a
 * trade call, becomes "friend". Names are the easiest way to make a host say something it should not ("Sell
 * gold today" as a display name), so nothing else from the raw name survives.
 */
export function safeAuthorName(rawName: string): string {
  if (linkPattern().test(rawName)) return FALLBACK_AUTHOR_NAME;
  const cleaned = rawName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^@+/, "")
    .replace(/[_.\-]+/g, " ")
    // ASCII only: look-alike letters from other alphabets are how blocked words get past a filter.
    .replace(/[^A-Za-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTHOR_NAME_CHARS)
    .trim();
  if (cleaned.length < 2) return FALLBACK_AUTHOR_NAME;
  if (findBlockedTerm(cleaned)) return FALLBACK_AUTHOR_NAME;
  if (OFF_LIMITS_TOPIC.test(cleaned) || PROMO_SPAM.test(cleaned) || findTradeCall(cleaned)) return FALLBACK_AUTHOR_NAME;
  return cleaned;
}

const MARKETS = "nq|es|mnq|mes|ym|rty|cl|gc|nasdaq|the nasdaq|s&p|spx|the dow|gold|oil|crude|bitcoin|btc|the market|stocks";
const SIDES = "buy|sell|short|go long|go short|get long|get short";

/**
 * Anything that reads as telling a viewer what to trade, or predicting a price. The host talks about process,
 * rules and how things work; it never gives a call. Ordinary uses of the same words ("you were just short of
 * target", "it will break the consistency rule", "stop at two losses") are deliberately not matched.
 */
const TRADE_CALL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // "you should buy", "time to short", "go ahead and sell"
  { pattern: new RegExp(`\\b(?:you should|you need to|you could|you gotta|you have to|go ahead and|time to)\\s+(?:just\\s+)?(?:${SIDES}|long|size up|add to (?:it|that|the|your))\\b`, "i"), reason: "tells a viewer what to trade" },
  { pattern: /\byou should\s+(?:hold|exit|close|take|cut)\s+(?:it|that|this|the trade|the position|your position|your trade|profits?|the loss)\b/i, reason: "tells a viewer what to do with a trade" },
  // "I'd be buying here", "I'm long", "I would short that"
  { pattern: /\b(?:i'd|i would|i'm|i am)\s+(?:be\s+)?(?:buying|selling|shorting|buy|sell|short|long|a buyer|a seller)\b/i, reason: "says what the host would trade" },
  // Imperative at the start of a sentence: "Buy NQ now.", "Short the Nasdaq here."
  {
    pattern: new RegExp(`(?:^|[.!?,;:]\\s+)(?:just\\s+|then\\s+|and\\s+)?(?:${SIDES})\\s+(?:it|that|this|here|now|today|the dip|the open|the close|more|some|${MARKETS})\\b`, "i"),
    reason: "gives a trade call",
  },
  { pattern: new RegExp(`\\b(?:${SIDES})\\s+(?:it\\s+)?(?:right\\s+)?(?:now|here)\\b`, "i"), reason: "gives a trade call" },
  // Predictions: "NQ is going to hit 20k", "NQ's going to 20,000", "gold is going up", "the market will rally"
  {
    pattern: new RegExp(
      `\\b(?:${MARKETS})(?:'s| is| will| should| is gonna| is going to|'s gonna)\\s+(?:probably\\s+|definitely\\s+|likely\\s+|about to\\s+)?(?:going\\s+(?:to\\s+)?)?(?:hit|reach|go(?:ing)?\\s+(?:to|up|down|higher|lower)|rally|dump|pump|moon|tank|drop|crash|rip|squeeze|sell off|up|down|higher|lower|\\d)`,
      "i",
    ),
    reason: "predicts where a market will go",
  },
  // Levels: "target 18,600", "entry at 18450", "stop at 19850". Three or more digits, so "stop at 2 losses" is fine.
  { pattern: /\b(?:price target|target|take profit|entry|enter|stop(?: loss)?)\s*(?:is\s+|at\s+|of\s+|around\s+|near\s+|:\s*)?\$?\d{1,3}(?:,\d{3})+|\b(?:price target|target|take profit|entry|enter|stop(?: loss)?)\s*(?:is\s+|at\s+|of\s+|around\s+|near\s+|:\s*)?\$?\d{3,}/i, reason: "gives a price level to trade" },
  { pattern: /\b(?:easy|free|guaranteed|risk[- ]free)\s+(?:money|profits?|payouts?|gains)\b/i, reason: "implies easy or risk-free money" },
  { pattern: /\byou(?:'ll| will| are going to|'re going to)\s+(?:pass|get funded|get paid|be profitable|make money|get a payout)\b/i, reason: "promises a result" },
  // Owner rule (2026-10-09): the host never suggests anything that involves a viewer spending their money.
  {
    pattern:
      /\byou (?:should|need to|have to|gotta|might want to|could)\s+(?:just\s+|go\s+|go and\s+)?(?:buy|purchase|get|grab|sign up for|subscribe to|pay for|invest in|deposit|open|fund|upgrade to|start with)\s+(?:an?\s+|the\s+|your\s+|another\s+|some\s+|more\s+)?(?:\w+\s+){0,2}?(?:evals?|evaluations?|challenges?|funded accounts?|accounts?|resets?|subscriptions?|plans?|memberships?|courses?|indicators?|bots?|signals?|contracts?|micros?|brokers?|platforms?|firms?)\b/i,
    reason: "suggests the viewer spend money on something",
  },
  { pattern: /\b(?:i|we)(?:'d| would)?\s+(?:recommend|suggest|advise)\b|\bmy (?:advice|recommendation|suggestion)\b|\bif i were you\b/i, reason: "gives a personal recommendation" },
  { pattern: /\b(?:worth (?:the|your|every) (?:money|penny|dollar)|the best (?:prop firm|firm|broker|platform|eval|indicator|course) (?:is|would be|has to be)|go with (?:apex|topstep|tradeify|lucid|ftmo|take ?profit ?trader|my ?funded ?futures|bulenox|earn2trade)\b)/i, reason: "recommends a product or a firm" },
];

const NAMED_FIRMS = "apex|topstep|tradeify|lucid|ftmo|take ?profit ?trader|my ?funded ?futures|bulenox|earn2trade|tradovate|ninjatrader|rithmic|tradingview|tradezella|tradersync|edgewonk|webull|robinhood|interactive brokers";
/**
 * Lines that could create legal exposure whatever their intent (owner rule, 2026-10-10): a verdict on a named
 * company, a claim about customers' results, a giveaway or offer, or a request for a viewer's personal details.
 */
const LEGAL_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: new RegExp(`\\b(?:${NAMED_FIRMS})\\b[^.!?]{0,60}\\b(?:scam\\w*|fraud\\w*|rigged|rug ?pull\\w*|ponzi|steal\\w*|cheat\\w*|shady|sketchy|crooks?|legit|trustworthy|the best|the worst|garbage|trash|terrible|awful|don't pay|doesn't pay|won't pay|never pays?)\\b`, "i"), reason: "gives a verdict on a named company" },
  { pattern: new RegExp(`\\b(?:scam\\w*|fraud\\w*|rigged|ponzi|crooks?|shady|sketchy|legit|trustworthy|the best|the worst)\\b[^.!?]{0,40}\\b(?:${NAMED_FIRMS})\\b`, "i"), reason: "gives a verdict on a named company" },
  { pattern: /\b(?:fill-?book|our|the journal's) (?:users|customers|traders|members)\b[^.!?]{0,60}\b(?:pass|passed|earn|earned|make|made|profit\w*|win|won|funded|payouts?|lose less|more consistent)\b/i, reason: "makes a claim about customers' results" },
  { pattern: /\b\d{1,3} ?(?:percent|%) of (?:our |fill-?book )?(?:users|customers|traders|members)\b/i, reason: "quotes a statistic about customers" },
  { pattern: /\b(?:giveaway|give away|giving away|win a|prize|raffle|sweepstakes|contest|promo code|discount code|coupon|\d{1,2} ?(?:percent|%) off|free (?:eval|account|month|trial|subscription))\b/i, reason: "offers a giveaway, prize or discount" },
  { pattern: /\b(?:what(?:'s| is) your|tell me your|send me your|drop your|share your|type your)\s+(?:real name|full name|age|email|e-mail|phone|number|address|location|account number|account balance|balance|income|salary|login|password|broker login)\b/i, reason: "asks a viewer for personal details" },
];

/** The reason a line carries legal risk, or null. */
export function findLegalRisk(text: string): string | null {
  return LEGAL_RISK_PATTERNS.find(({ pattern }) => pattern.test(text))?.reason ?? null;
}

/** The reason a text reads as a trade call or prediction, or null. */
export function findTradeCall(text: string): string | null {
  return TRADE_CALL_PATTERNS.find(({ pattern }) => pattern.test(text))?.reason ?? null;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const APPROVED_SPOKEN_DOMAIN = "fillbookhq.com";

/** The host of a link-shaped match, lower-cased, without protocol, www, path or port. */
function linkHost(link: string): string {
  return (link.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "").replace(/\.+$/, "");
}
function isFillbookHost(host: string): boolean {
  return host === APPROVED_SPOKEN_DOMAIN || host.endsWith(`.${APPROVED_SPOKEN_DOMAIN}`);
}

export interface SpokenLineContext {
  /**
   * False when the host has mentioned Fillbook too often lately and no viewer asked about it. A line that
   * mentions Fillbook anyway is rejected, which is what keeps the stream from turning into an advert.
   */
  fillbookMentionAllowed: boolean;
  /**
   * False on a TikTok stream: TikTok's LIVE rules list directing viewers off-platform as a violation, so the
   * host points to the link in the bio and never says or spells the website. Defaults to allowed.
   */
  websiteMentionAllowed?: boolean;
  /** The host's previous line, so two lines in a row cannot open on the same filler word. */
  previousLine?: string | null;
}

/** Any way of naming the site or sending people to find it: written, spoken, spelled out, or "google us". */
const WEBSITE_MENTION = /fill-?book ?hq\s*(?:\.|dot|point)[ -]?com|\b(?:dot|point)[ -]?com\b|\bwww\b|\b(?:google|search(?: for)?|look up)\s+(?:us|fill-?book)/i;
/** Openers that mean nothing. One is fine; the same one twice running makes the host sound like a loop. */
const FILLER_OPENER = /^(alright|all right|okay|ok|so|well|now|right|look|listen)\b/i;

/** The filler word a line opens with, lower-cased, or null. */
export function fillerOpener(text: string): string | null {
  const match = FILLER_OPENER.exec(text.trim());
  return match ? match[1]!.toLowerCase().replace("all right", "alright").replace(/^ok$/, "okay") : null;
}

/** True when the text mentions the product by name or domain. */
export function mentionsFillbook(text: string): boolean {
  return /fill-?book/i.test(text);
}

/**
 * The shared reply guardrails (xReplyGuardrails.ts) were written for X replies and read a few honest lines as
 * violations: "I've never traded, I'm a candle", "no guarantees", "a journal won't make you profitable". Those
 * denials are exactly what the host should say, so a denied claim is taken out before the shared check runs.
 */
const DENIAL = /\b(?:no|not|never|nobody|without|isn't|aren't|won't|can't|cannot|doesn't|don't|didn't)\b[^.!?]{0,30}\b(?:guarantee\w*|made|earned|traded|profited|profitable|funded|consistent)\b/gi;

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
  if (PROMO_SPAM.test(line)) return "repeats a promotion or spam phrase";

  const tradeCall = findTradeCall(line);
  if (tradeCall) return tradeCall;
  const legalRisk = findLegalRisk(line);
  if (legalRisk) return legalRisk;

  const withoutDenials = line.replace(DENIAL, " ");
  const unverified = containsUnverifiedClaim(withoutDenials);
  if (unverified) return unverified.reason;
  // "Link in bio" is on the shared banned-phrase list (an X-reply rule). On a TikTok stream it is the required
  // way to point people to the product, so it is not counted here.
  const generic = containsBannedGenericPhrase(line.replace(/\blink (?:is )?in (?:the |my |our )?bio\b/gi, " "));
  if (generic) return generic.reason;
  const dash = dashProblem(line);
  if (dash) return dash.reason;

  if (EMOJI.test(line)) return "contains an emoji, which the voice cannot say";
  if (/#[a-z]\w*/i.test(line)) return "contains a hashtag";

  const badLink = (line.match(linkPattern()) ?? []).find((link) => !isFillbookHost(linkHost(link)));
  if (badLink) return `mentions a link that is not ${APPROVED_SPOKEN_DOMAIN}`;
  for (const match of line.matchAll(SPOKEN_DOMAIN)) {
    if (!/^fill-?book ?hq$/i.test((match[1] ?? "").trim())) return `says a web address that is not ${APPROVED_SPOKEN_DOMAIN}`;
  }

  if (context.websiteMentionAllowed === false && (WEBSITE_MENTION.test(line) || (line.match(linkPattern()) ?? []).length > 0)) {
    return "names the website, which is not allowed on this stream (say the link is in the bio instead)";
  }

  // Heard on the first real stream: three segments running opened "Time for the ...". Two lines in a row may not
  // start with the same two words, whatever they are (a viewer's name followed by a comma does not count).
  const firstTwo = (value: string) => value.trim().toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
  if (context.previousLine && firstTwo(line).split(" ").length === 2 && firstTwo(line) === firstTwo(context.previousLine)) {
    return `starts with "${firstTwo(line)}" again, the same way the previous line started`;
  }

  const opener = fillerOpener(line);
  if (opener && context.previousLine && fillerOpener(context.previousLine) === opener) {
    return `opens with "${opener}" again, the same way the previous line opened`;
  }

  if (!context.fillbookMentionAllowed && mentionsFillbook(line)) {
    return "mentions Fillbook again although it has come up too often lately and nobody asked about it";
  }
  return null;
}
