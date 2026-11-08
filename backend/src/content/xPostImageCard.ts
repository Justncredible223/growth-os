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
  const shown = [card.title, ...card.numbers, ...card.rows.flatMap((r) => [r.label, r.note ?? ""]), card.footer ?? ""];
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
  const card: XPostImageCard = { version: 1, kind: "post", title: headline, rows: [], numbers, sampleData: numbers.length > 0 };
  return cardNumbersTraceToPost(card, text) ? card : null;
}
