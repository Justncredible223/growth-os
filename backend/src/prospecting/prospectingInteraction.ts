/**
 * The suggested interaction for a Prospecting candidate (2026-10-28): what to DO with the post (reply, quote or just engage) and the
 * angle to take, shown on the card next to the score breakdown. It is a suggestion only; the owner still chooses, and replying stays
 * the one thing the app drafts. The angle's kind is stored with the candidate so the weekly review can compare how replies of each kind
 * reached people (weeklyDigest.ts).
 */
export type InteractionAction = "reply" | "quote" | "engage";
export type AngleKind = "answer" | "loss" | "math" | "detail" | "like";

export interface InteractionInput {
  postText: string;
  followers: number | null;
  replyCount: number;
  impressionCount: number;
}

export interface InteractionSuggestion {
  action: InteractionAction;
  angleKind: AngleKind;
  angle: string;
}

/** A thread with this many replies already buries a new one. */
export const BURIED_AT_REPLIES = 40;
/** A quote only makes sense for a post that is clearly travelling: this many views and 10x the author's followers. */
export const QUOTE_MIN_IMPRESSIONS = 1_000;
const QUOTE_BREAKOUT_RATIO = 10;

const LOSS = /\b(blew|blown|breach(ed)?|violat(ed|ion)|failed (the )?(eval|combine|challenge)|lost (my|the) (funded )?account|liquidat|got (stopped|wiped)|daily loss|drawdown hit)\b/i;
const NUMBERS = /\$\s?\d|\b\d{2,}\s?(%|contracts?|points?|pts|ticks?)\b|\b\d+\s?(mnq|nq|mes|es)\b/i;

export function suggestInteraction(input: InteractionInput): InteractionSuggestion {
  const text = input.postText.trim();
  const hasQuestion = text.includes("?");
  const followers = input.followers ?? 0;

  if (text.length < 40 || input.replyCount >= BURIED_AT_REPLIES) {
    return {
      action: "engage",
      angleKind: "like",
      angle: input.replyCount >= BURIED_AT_REPLIES ? "Like it and follow them. A reply under this many would be buried." : "Too little context for a useful reply. Like it and follow them.",
    };
  }
  const breakout = input.impressionCount >= QUOTE_MIN_IMPRESSIONS && followers > 0 && input.impressionCount >= followers * QUOTE_BREAKOUT_RATIO;
  if (breakout && !hasQuestion && NUMBERS.test(text)) {
    return { action: "quote", angleKind: "math", angle: "This post is travelling. Quote it with the one rule consequence they left out, on your own timeline." };
  }
  if (hasQuestion) return { action: "reply", angleKind: "answer", angle: "Answer the question with one rule or number you actually know." };
  if (LOSS.test(text)) return { action: "reply", angleKind: "loss", angle: "Acknowledge it in one line, then the specific rule detail that applies. No advice list." };
  if (NUMBERS.test(text)) return { action: "reply", angleKind: "math", angle: "Check their math and add the consequence they did not mention." };
  return { action: "reply", angleKind: "detail", angle: "Add one concrete detail from the rules or real numbers. Do not restate their post." };
}
