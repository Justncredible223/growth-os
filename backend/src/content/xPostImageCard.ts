import { REFERENCE_TOPICS, numbersInPost } from "./xFeedPostExtras.js";

/**
 * The picture for Today's X Post (owner direction 2026-11-08: the owner's standing rule is that every X post carries a custom image,
 * and his own X history shows posts with an image beat plain text, but the app only wrote a text brief). ChatGPT and Gemini, asked
 * separately, both agreed to build it with these safeguards:
 *  - the card is DETERMINISTIC: no model writes any word or number on it;
 *  - every number on a post card is copied verbatim from the post text, and a card whose numbers cannot be traced back is dropped;
 *  - illustrative numbers carry a SAMPLE DATA label;
 *  - the owner previews the picture in the app, can discard it, and attaches it by hand; nothing is ever posted for him;
 *  - one kill switch (X_POST_IMAGE_CARD=off) removes the card and leaves the text draft untouched.
 *
 * This file builds the CONTENT of the card (what it says). The phone app draws the pixels, so the words and numbers are unit-tested
 * here and the drawing code never decides what the card says.
 */
/**
 * The small illustration the phone draws beside the headline (theme "Risk Blueprint", chosen by ChatGPT + Gemini 2026-11-08). It is a
 * picture of the TOPIC, built from simple shapes with no words and no numbers, so it can never state anything the post does not.
 * Chosen by rule from the post text, never by a model; "target" is the fallback when the topic is unclear.
 */
export type CardMotif = "drawdown" | "loss_limit" | "payout" | "consistency" | "sizing" | "edge_score" | "journal" | "target";

export const CARD_MOTIFS: readonly CardMotif[] = ["drawdown", "loss_limit", "payout", "consistency", "sizing", "edge_score", "journal", "target"];

const MOTIF_RULES: Array<[CardMotif, RegExp]> = [
  ["edge_score", /\bedge score\b/i],
  ["drawdown", /\b(?:drawdown|trailing|floor|buffer)\b/i],
  ["loss_limit", /\b(?:daily (?:loss|limit)|loss limit|max(?:imum)? loss|dll)\b/i],
  ["payout", /\b(?:payout|withdraw\w*|threshold)\b/i],
  ["consistency", /\b(?:consisten\w*|best day|biggest day)\b/i],
  ["sizing", /\b(?:contracts?|position siz\w*|lot size|sizing)\b/i],
  ["journal", /\b(?:journal\w*|log(?:ged|ging)?|notes?|review)\b/i],
];

/** True when the post sets intraday trailing against end-of-day trailing (it names both). */
export function isTrailingComparison(text: string): boolean {
  return /\bintraday\b/i.test(text) && /\b(?:end[- ]of[- ]day|eod)\b/i.test(text);
}

/** Sentences that are disclaimers, not ideas: kept in the post, never used as the picture's line. */
const DISCLAIMER = /\b(?:not (?:financial|investment|trading) advice|educational purposes|past (?:performance|results)|no guarantee|nfa)\b/i;

export const HOOK_MIN = 12;
export const HOOK_MAX = 48;

/**
 * A short sentence copied from the post, shown on the picture instead of the post's own first sentence (which the feed already shows right
 * above the picture). The shortest of the first five sentences that is 12 to 48 characters; null when none is.
 */
export function shortHook(text: string): string | null {
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.trim().split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5);
  // A disclaimer is never the picture's line (seen on the Fold 2026-11-15: "Not financial advice." beside a real screen).
  const fits = sentences.filter((s) => s.length >= HOOK_MIN && s.length <= HOOK_MAX && !DISCLAIMER.test(s));
  if (fits.length === 0) return null;
  return fits.reduce((a, b) => (b.length < a.length ? b : a));
}

/** Up to two words right before each figure's first appearance in the post, within the same sentence, verbatim. */
export function figureNotesFor(text: string, numbers: string[]): string[] {
  return numbers.map((n) => {
    const at = text.indexOf(n);
    if (at <= 0) return "";
    const before = text.slice(0, at);
    const sentence = before.split(/[.!?\n]/).pop() ?? "";
    const words = sentence.trim().split(/\s+/).filter((w) => /^[A-Za-z'-]+$/.test(w));
    return words.slice(-2).join(" ").slice(0, 16);
  });
}

/**
 * The sizing picture shows a planned stack against a bigger reactive one crossing the plan line (ChatGPT 2026-11-15), so it is used only
 * when the post is about size going past the plan: after a loss, revenge, bigger, doubling, too many. A neutral sizing post gets the fallback.
 */
const SIZING_DEVIATION = /\b(?:loss(?:es)?|revenge|bigger|larger|doubl\w*|increas\w*|size up|sizing up|fewer|too (?:many|big|large)|over-?siz\w*|add(?:ed|ing)? (?:a )?contracts?)\b/i;

/** The motif for a post: the first rule that matches wins; "target" when none do. */
export function motifForPost(text: string): CardMotif {
  const hit = MOTIF_RULES.find(([, re]) => re.test(text));
  if (hit && hit[0] === "sizing" && !SIZING_DEVIATION.test(text)) return "target";
  return hit ? hit[0] : "target";
}

/**
 * Picture style test (ChatGPT + App, 2026-11-15, owner said "do all that"): real Fillbook screens may sell better than a drawn shape, but that
 * is a hypothesis, so the two styles ALTERNATE and are compared on attributed trials per 1,000 X impressions before either becomes the default.
 *  - "screen" shows a real Fillbook card captured from the public /sample page (made-up trades only; never a customer's or the owner's data),
 *    bundled in the phone app (android/app/src/main/assets/xscreens, retaken with backend/scripts/x-screens/capture.mjs when the UI changes).
 *  - A screen carries its own made-up figures, so it is used only when the post has NO figure of its own: the picture can never contradict the post.
 *  - Which style a post gets is a pure function of the post text (a hash), so the test can be re-scored later from the posted text alone.
 *  - Kill switch X_POST_SCREEN_CARDS=off puts every post back on the drawn card.
 */
export type CardStyle = "drawn" | "screen";
/** One idea per screen so its text stays readable at X feed size (ChatGPT 2026-11-15): a single dashboard tile or the top of one card. */
export type ScreenKey = "buffer" | "lossroom" | "maxsize" | "edge" | "leaks" | "health";
export const SCREEN_FOR_MOTIF: Partial<Record<CardMotif, ScreenKey>> = {
  drawdown: "buffer",
  loss_limit: "lossroom",
  sizing: "maxsize",
  edge_score: "edge",
  journal: "leaks",
  target: "health",
};

/** The test arm a post falls in: FNV-1a hash of the lower-cased, space-collapsed text, even = screen, odd = drawn. */
export function styleArmForText(text: string): CardStyle {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "screen" : "drawn";
}

export function screenCardsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.X_POST_SCREEN_CARDS !== "off";
}

/** The style a post card is drawn in, and the screen when it is "screen". Drawn whenever a screen is not safe or not available. */
export function cardStyleFor(
  text: string,
  motif: CardMotif,
  postHasFigures: boolean,
  compare: boolean,
  env: Record<string, string | undefined> = process.env,
): { style: CardStyle; screen?: ScreenKey } {
  const screen = SCREEN_FOR_MOTIF[motif];
  if (!screenCardsEnabled(env) || postHasFigures || compare || !screen) return { style: "drawn" };
  return styleArmForText(text) === "screen" ? { style: "screen", screen } : { style: "drawn" };
}

export interface XPostImageCard {
  version: 1;
  /** "post" = a headline card built from the day's draft; "reference" = a fixed card for a Wednesday reference post. */
  kind: "post" | "reference";
  title: string;
  /** Reference cards: fixed rows, each a label and an optional one-line note. Post cards: none. */
  rows: Array<{ label: string; note?: string }>;
  /** Post cards: up to three figures copied verbatim from the post, shown large. */
  numbers: string[];
  /** True when the card shows numbers that are illustrative: it then carries a SAMPLE DATA label. */
  sampleData: boolean;
  footer?: string;
  /** Post cards: the topic illustration the phone draws (see CardMotif). Absent on older cards; the phone then draws the fallback. */
  motif?: CardMotif;
  /** Drawdown posts that set intraday against end-of-day trailing: the phone draws the two side by side (owner 2026-11-08). */
  compare?: boolean;
  /** A short sentence copied verbatim from the post (12-48 characters) shown as the card's line, so the picture does not repeat the post's first sentence, which sits right above it in the feed. */
  hook?: string;
  /** For each figure in `numbers`, the up to two words that come right before it in the post (verbatim), so a figure is never shown bare. */
  figureNotes?: string[];
  /** Picture style test arm (see CardStyle). Absent on older cards = drawn. */
  style?: CardStyle;
  /** Which bundled real Fillbook screen the phone draws when style is "screen". */
  screen?: ScreenKey;
}

/** Off switch. Anything other than the exact value "off" leaves the card on. */
export function xPostImageCardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.X_POST_IMAGE_CARD !== "off";
}

const REFERENCE_CARDS: Record<string, Omit<XPostImageCard, "version" | "kind" | "numbers" | "sampleData">> = {
  reference_drawdown_types: {
    title: "Three kinds of drawdown",
    rows: [
      { label: "Trailing (intraday)", note: "The loss line can move at any moment in the day." },
      { label: "End-of-day trailing", note: "The loss line only moves when the day closes." },
      { label: "Static", note: "The loss line stays where it started." },
    ],
    footer: "Check your firm's rulebook for which one you have.",
  },
  reference_payout_numbers: {
    title: "Five numbers before a payout request",
    rows: [
      { label: "1  Profit since your last payout", note: "against your firm's minimum" },
      { label: "2  Trading days", note: "against your firm's minimum days" },
      { label: "3  Biggest day as a share of profit", note: "against the consistency rule" },
      { label: "4  Drawdown buffer left" },
      { label: "5  Payout threshold" },
    ],
    footer: "Fill in your own numbers. Check your firm's rulebook.",
  },
  reference_pre_trade_numbers: {
    title: "Before you enter a trade",
    rows: [
      { label: "Max loss today" },
      { label: "Contracts" },
      { label: "Stop distance in dollars" },
      { label: "Daily limit left" },
    ],
    footer: "contracts x stop distance = risk on this trade",
  },
};

/** A headline longer than this is cut at a word boundary (the phone app wraps and shrinks anything up to it onto the card). */
export const CARD_HEADLINE_MAX = 150;

/**
 * The card headline: the post's first sentence, whole when it fits. headlineFromPost cut at 70 characters, which on a card read as a
 * sentence chopped mid-clause ("...give it all back, a..."). Never reworded; if it must be cut it ends at a word with an ellipsis.
 */
export function cardHeadline(text: string): string {
  const first = (text.split(/\n/).find((l) => l.trim().length > 0) ?? "").trim();
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  if (sentence.length <= CARD_HEADLINE_MAX) return sentence;
  const cut = sentence.slice(0, CARD_HEADLINE_MAX - 3);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd().replace(/[,;:]$/, "")}...`;
}

/** Every digit run in a string, as written ("$1,500" gives "1,500"). */
function digitRuns(text: string): string[] {
  return text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
}

/** True when every figure on a post card appears in the post text exactly as written. A card that fails this is never shown. */
export function cardNumbersTraceToPost(card: XPostImageCard, draftText: string): boolean {
  if (card.kind !== "post") return true;
  const shown = [card.title, card.hook ?? "", ...card.numbers, ...card.rows.flatMap((r) => [r.label, r.note ?? ""]), card.footer ?? ""];
  return shown.every((s) => digitRuns(s).every((run) => draftText.includes(run)));
}

/**
 * The card for a day's post, or null when there is nothing safe to show (kill switch on, empty text, or a figure that cannot be
 * traced to the post). Reference topics use their fixed card; any other post gets a headline card.
 */
export function buildXPostImageCard(
  topicKey: string | null | undefined,
  draftText: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): XPostImageCard | null {
  if (!xPostImageCardEnabled(env)) return null;
  const text = (draftText ?? "").trim();
  if (!text) return null;

  const referenceIndex = REFERENCE_TOPICS.findIndex((t) => t.key === topicKey);
  const fixed = topicKey ? REFERENCE_CARDS[topicKey] : undefined;
  if (referenceIndex >= 0 && fixed) {
    return { version: 1, kind: "reference", ...fixed, numbers: [], sampleData: false };
  }

  const headline = cardHeadline(text);
  if (!headline) return null;
  const numbers = numbersInPost(text).slice(0, 3);
  const motif = motifForPost(text);
  const hook = shortHook(text);
  const compare = motif === "drawdown" && isTrailingComparison(text);
  const look = cardStyleFor(text, motif, numbers.length > 0, compare, env);
  const card: XPostImageCard = {
    version: 1,
    kind: "post",
    title: headline,
    rows: [],
    numbers,
    // A real screen shows made-up figures, so it is always labelled sample data.
    sampleData: numbers.length > 0 || look.style === "screen",
    motif,
    ...(compare ? { compare: true } : {}),
    ...(hook ? { hook } : {}),
    ...(numbers.length > 0 ? { figureNotes: figureNotesFor(text, numbers) } : {}),
    style: look.style,
    ...(look.screen ? { screen: look.screen } : {}),
  };
  return cardNumbersTraceToPost(card, text) ? card : null;
}

/** First operating date of the picture style test; posts before it were all drawn and are left out of the tally. */
export const PICTURE_TEST_START = "2026-11-16";

export type PictureArm = CardStyle | "not_eligible";

/** The arm a post was in, from its text alone: "not_eligible" when it could only ever get the drawn card (figures, comparison, no screen). */
export function pictureArmForPost(text: string): PictureArm {
  const t = text.trim();
  if (!t) return "not_eligible";
  const motif = motifForPost(t);
  const compare = motif === "drawdown" && isTrailingComparison(t);
  if (numbersInPost(t).length > 0 || compare || !SCREEN_FOR_MOTIF[motif]) return "not_eligible";
  return styleArmForText(t);
}

export interface PictureTestRow {
  motif: CardMotif;
  screen: number;
  drawn: number;
  notEligible: number;
}

/**
 * Posts per topic and arm (ChatGPT 2026-11-15: a hash split is reproducible but not guaranteed balanced, so check the real split per topic
 * before reading any result). Only eligible posts count toward the comparison; a topic whose two arms differ by more than half of the smaller
 * one plus two is flagged unbalanced.
 */
export function pictureTestTally(postedTexts: string[]): { rows: PictureTestRow[]; screen: number; drawn: number; unbalancedTopics: CardMotif[] } {
  const rows = new Map<CardMotif, PictureTestRow>();
  for (const text of postedTexts) {
    const motif = motifForPost(text);
    const row = rows.get(motif) ?? { motif, screen: 0, drawn: 0, notEligible: 0 };
    const arm = pictureArmForPost(text);
    if (arm === "screen") row.screen++;
    else if (arm === "drawn") row.drawn++;
    else row.notEligible++;
    rows.set(motif, row);
  }
  const list = CARD_MOTIFS.map((m) => rows.get(m)).filter((r): r is PictureTestRow => r !== undefined);
  const unbalancedTopics = list.filter((r) => Math.abs(r.screen - r.drawn) > Math.min(r.screen, r.drawn) / 2 + 2).map((r) => r.motif);
  return { rows: list, screen: list.reduce((n, r) => n + r.screen, 0), drawn: list.reduce((n, r) => n + r.drawn, 0), unbalancedTopics };
}
