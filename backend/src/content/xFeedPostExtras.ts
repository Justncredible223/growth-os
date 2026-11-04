import type { FeedPostTopic } from "./dailyXFeedPost.js";

/**
 * Extras for Today's X Post (owner-approved 2026-11-03, from the X algorithm playbook review):
 *  - every draft carries a short spec for the topic-custom image the owner rule requires;
 *  - one day a week the draft is a "worth sending to a friend" reference post (image-led, short copy, a clear save-this use,
 *    no link in the body);
 *  - every draft carries the window to post in, so the owner can be around for the first two hours.
 * The post text itself, the owner posting by hand and the claims guardrails are unchanged.
 */

/** 0 = Sunday ... 6 = Saturday, read from the operating date. Wednesday: mid-week, when a saved reference gets used. */
export const REFERENCE_POST_WEEKDAY = 3;

/** True when the operating date (YYYY-MM-DD) is the weekly reference post day. */
export function isReferencePostDay(operatingDate: string): boolean {
  const day = new Date(`${operatingDate}T00:00:00Z`).getUTCDay();
  return day === REFERENCE_POST_WEEKDAY;
}

const REFERENCE_RULES =
  "This is the week's reference post: one image the reader would save or send to a trading friend, with SHORT copy (two or three lines) that says what the picture is and why to save it. " +
  "Put NO link in the post body (the owner adds the link in the first reply). Do not state any dollar amount, percentage or day count as a rule of any firm: say 'check your firm's rulebook' for every firm-specific number. " +
  "No profit promises, no claim that Fillbook monitors an account live, and never say DXtrade auto-syncs. If sync is mentioned at all, it is a Core or Elite feature.";

export interface ReferenceTopic extends FeedPostTopic {
  /** The image brief for this reference post, in full. */
  imageSpec: string;
}

export const REFERENCE_TOPICS: ReferenceTopic[] = [
  {
    key: "reference_drawdown_types",
    label: "Reference: the three kinds of drawdown",
    contentCategory: "education",
    rationale: `Write the caption for a one-picture explainer of how trailing (intraday), end-of-day trailing and static drawdown differ in when the loss line moves. ${REFERENCE_RULES}`,
    editorialTags: ["drawdown-mechanics", "rule-literacy"],
    audienceRelevance: 5,
    specificity: 4,
    practicalUsefulness: 5,
    evidenceStrength: 3,
    imageSpec:
      "A clean three-column diagram on a dark card. Columns: 'Intraday trailing', 'End-of-day trailing', 'Static'. In each, a small line chart of an account balance with the loss line drawn in red: it rises with every new high as it happens (intraday), steps up once at the close (end-of-day), and never moves (static). Numbers on it: none, it is a concept picture. Text on it: the three column titles and a footer 'Check your firm's rulebook for which one you have'. Small Fillbook wordmark bottom-left. No firm logos.",
  },
  {
    key: "reference_payout_numbers",
    label: "Reference: five numbers to check before a payout request",
    contentCategory: "education",
    rationale: `Write the caption for a one-picture checklist of the five numbers to check before requesting a payout: profit target or payout minimum reached, minimum trading days met, the consistency rule share, drawdown buffer left, and the payout threshold. ${REFERENCE_RULES}`,
    editorialTags: ["payout-readiness", "rule-literacy"],
    audienceRelevance: 5,
    specificity: 4,
    practicalUsefulness: 5,
    evidenceStrength: 3,
    imageSpec:
      "A numbered checklist card with five rows, each with an empty checkbox and a blank for the trader to fill in. Rows: 1 'Profit since last payout vs your firm's minimum', 2 'Trading days vs your firm's minimum days', 3 'Biggest day as a share of total profit vs the consistency rule', 4 'Drawdown buffer left', 5 'Payout threshold'. Numbers on it: only the row numbers 1 to 5 (every blank is for the trader's own figure). Text on it: the title 'Before you request a payout' and the row labels. Small Fillbook wordmark bottom-left. No firm logos.",
  },
  {
    key: "reference_pre_trade_numbers",
    label: "Reference: four numbers to know before you enter a trade",
    contentCategory: "education",
    rationale: `Write the caption for a one-picture card of the four numbers to know before entering a trade: the most you can lose today, your size, the stop distance in dollars, and the daily limit left. ${REFERENCE_RULES}`,
    editorialTags: ["risk-per-trade", "pre-trade-routine"],
    audienceRelevance: 5,
    specificity: 4,
    practicalUsefulness: 5,
    evidenceStrength: 3,
    imageSpec:
      "A four-tile card, one number per tile with a blank to fill in: 'Max loss today', 'Contracts', 'Stop distance in dollars', 'Daily limit left'. Between the tiles a simple line reads 'contracts x stop distance = risk on this trade'. Numbers on it: none (the blanks are for the trader). Text on it: the four tile titles, the formula line and the title 'Before you enter a trade'. Small Fillbook wordmark bottom-left. No firm logos.",
  },
];

/** The reference topic for an operating date, rotating by week and skipping any key already tried; null when all have been tried. */
export function pickReferenceTopic(operatingDate: string, excludeKeys: readonly string[] = []): ReferenceTopic | null {
  const weekIndex = Math.floor(new Date(`${operatingDate}T00:00:00Z`).getTime() / (7 * 86_400_000));
  const n = REFERENCE_TOPICS.length;
  for (let offset = 0; offset < n; offset++) {
    const candidate = REFERENCE_TOPICS[(((weekIndex + offset) % n) + n) % n]!;
    if (!excludeKeys.includes(candidate.key)) return candidate;
  }
  return null;
}

export function isReferenceTopic(key: string | null | undefined): boolean {
  return REFERENCE_TOPICS.some((t) => t.key === key);
}

/** Posting window advice. Eastern time because the audience trades the US session; two windows, away from the 9:30 ET open. */
export const POSTING_WINDOW_NOTE =
  "Post after the 9:30 ET open settles (about 10:30 ET) or after the 4:00 ET close (about 4:30 ET), and stay around for the first 2 hours to answer replies.";

const NUMBER_PATTERN = /\$\s?\d[\d,]*(?:\.\d+)?[kKmM]?|\d[\d,]*(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:R|x|ticks?|points?|contracts?|trades?|days?)\b/g;

/** The numbers a post states (dollar amounts, percentages, counts with a unit), in order, without repeats. Never invents one. */
export function numbersInPost(text: string): string[] {
  return [...new Set((text.match(NUMBER_PATTERN) ?? []).map((n) => n.replace(/\s+/g, " ").trim()))].slice(0, 4);
}

/** First sentence or line of the post, shortened to fit a headline. */
export function headlineFromPost(text: string): string {
  const first = (text.split(/\n/).find((l) => l.trim().length > 0) ?? "").trim();
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return sentence.length > 70 ? `${sentence.slice(0, 67).trimEnd()}...` : sentence;
}

/** The image brief for a day's draft: the fixed brief for a reference topic, otherwise built from the draft itself. */
export function buildImageSpec(topic: { key: string; label: string }, draftText: string): string {
  const reference = REFERENCE_TOPICS.find((t) => t.key === topic.key);
  if (reference) return reference.imageSpec;
  const numbers = numbersInPost(draftText);
  return (
    `One clean card on a dark background, topic: ${topic.label}. ` +
    `Headline in large text: "${headlineFromPost(draftText)}". ` +
    (numbers.length > 0 ? `Show these numbers from the post, large: ${numbers.join(", ")}. ` : "The post states no number, so use a simple labeled diagram, not a number. ") +
    "Small Fillbook wordmark bottom-left. No firm logos and no screenshots of a real account."
  );
}

/** The owner-facing note stored on the run: why the angle was picked, then the image brief and the posting window. */
export function composeOwnerNote(selectionReason: string, topic: { key: string; label: string }, draftText: string): string {
  const lead = isReferenceTopic(topic.key) ? "Weekly reference post: the picture is the post. " : "";
  return `${lead}${selectionReason}\n\nImage: ${buildImageSpec(topic, draftText)}\n\nWhen: ${POSTING_WINDOW_NOTE}`;
}
