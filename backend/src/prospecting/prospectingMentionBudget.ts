import type { ProspectingCandidate } from "./types.js";

/**
 * Mention budget for cold replies. The 2026-09-25 showcase direction (fillbookShowcase.ts) makes the Fillbook
 * sentence "the point of the reply" whenever a view fits, and nothing limited how often that happened: the share of
 * posted cold replies naming Fillbook went from 0-9% a day (Sep 17-24) to 40-100% (Sep 25-30), several of them the
 * same pitch twice. A brand account that pitches in nearly every reply reads as spam and, with X already limiting the
 * account's replies, risks more suppression.
 *
 * The showcase rule is unchanged for the replies that do get a Fillbook sentence. This only decides, from what was
 * actually posted recently, whether the next draft is allowed one: once more than MAX_MENTION_SHARE of the last
 * MENTION_WINDOW posted replies named Fillbook, the next draft must leave it out, same mechanism as recovery mode.
 *
 * 2026-10-15: lowered from 1/3 to 1/5 (the owner's account keeps losing followers and a feed of replies that is a third
 * product talk is a poor reason to follow). Over the last 12 replies that allows 2 naming Fillbook; a third is held back
 * until one ages out. Follower numbers are now recorded daily (src/posting/followerSnapshots.ts) so this can be tuned
 * against what actually happened instead of a guess.
 */
export const MAX_MENTION_SHARE = 1 / 5;
export const MENTION_WINDOW = 12;
/** Too few posted replies to call a rate -- don't suppress on a tiny sample. */
export const MENTION_MIN_SAMPLE = 5;

export interface MentionBudget {
  /** True when recent replies already name Fillbook too often, so the next draft must not. */
  exhausted: boolean;
  /** Share of the sampled replies that named Fillbook, or null when the sample is too small. */
  share: number | null;
  sampled: number;
}

/** Share of the most recent posted replies that name Fillbook. `rows` should be replied candidates; order is not assumed. */
export function computeMentionBudget(rows: ProspectingCandidate[]): MentionBudget {
  const recent = rows
    .filter((r) => r.repliedAt !== null && (r.finalReply ?? r.draftReply))
    .sort((a, b) => (b.repliedAt ?? "").localeCompare(a.repliedAt ?? ""))
    .slice(0, MENTION_WINDOW);
  if (recent.length < MENTION_MIN_SAMPLE) return { exhausted: false, share: null, sampled: recent.length };
  const named = recent.filter((r) => /\bfillbook/i.test(r.finalReply ?? r.draftReply ?? "")).length;
  const share = named / recent.length;
  return { exhausted: share > MAX_MENTION_SHARE, share, sampled: recent.length };
}

/** The note added to a reply draft's prompt while the mention budget is exhausted. */
export const MENTION_BUDGET_DRAFT_NOTE = `MENTION BUDGET REACHED: too many of this account's recent replies already name Fillbook. For this reply, do NOT
name or hint at Fillbook -- no product, no view, no "we built", no "we track". Set showcase to "none". Answer their
post well on its own terms.`;
