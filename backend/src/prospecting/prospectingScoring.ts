import type { ProspectingTopic } from "./prospectingTopics.js";
import { invitesReplies } from "./prospectingRelevance.js";

// Real evidence this run's own results turned up (2026-09-03 live search):
// a competitor prop-firm discount ad and a hashtag-stuffed forex-bot account
// both scored high enough to reach the queue -- SPAM_PATTERNS below only
// caught explicit signal-selling phrasing, not promotional listicle/ad
// formatting. isListicleOrAdFormatted() below closes that gap.

export interface ProspectingScoreInput {
  topic: ProspectingTopic;
  postText: string;
  postCreatedAt: Date | null;
  publicMetrics: Record<string, number> | null;
  authorFollowerCount: number | null;
  authorVerified: boolean | null;
  /** From prospecting_outreach -- true if we've already replied to this author before via Prospecting. */
  previouslyEngaged: boolean;
  /** True when the post came from the creator watchlist (an author already vetted as on topic). */
  fromWatchlist?: boolean;
  now: Date;
}

export interface ProspectingScoreResult {
  score: number; // 0-100
  breakdown: Record<string, string>;
  /** Hard-excluded candidates (spam patterns) never reach the queue at all -- not just low-scored. */
  excluded: boolean;
  exclusionReason: string | null;
}

// Class A (direct fit) weighted highest, Class C (relationship fit, no
// Fillbook mention required) lowest but still meaningfully scored -- a
// credible futures trader talking process/psychology is a real
// opportunity per the "REACH + RELATIONSHIPS + REPUTATION" operating goal,
// just a lower-priority one than a direct journaling/prop-firm-rules post.
const CLASS_WEIGHT: Record<ProspectingTopic["replyClass"], number> = {
  A: 20,
  B: 15,
  C: 10,
};

const HOUR_MS = 60 * 60 * 1000;

/** Step curve, most weight on the first hours: <1h 25, <3h 20, <6h 15, <12h 10, <24h 6, <72h 3, older 1. Exported for tests. */
export function recencyPointsForAge(ageMs: number): number {
  const hours = Math.max(0, ageMs) / HOUR_MS;
  if (hours < 1) return 25;
  if (hours < 3) return 20;
  if (hours < 6) return 15;
  if (hours < 12) return 10;
  if (hours < 24) return 6;
  if (hours < 72) return 3;
  return 1;
}

// Phrases that show up almost exclusively in signal-selling/spam/bot posts
// -- excluded outright rather than merely down-ranked, since a reply under
// one of these actively damages the "recognizable, useful account" goal
// from MASTER_SOCIAL_STRATEGY.md rather than just wasting a reply slot.
const SPAM_PATTERNS = [
  /dm (me|for) (signals|access|mentorship)/i,
  /guaranteed (profit|return)/i,
  /100% win rate/i,
  /click (the )?link in (my )?bio/i,
  /free (signals|mentorship|course)/i,
  /crypto airdrop/i,
  /\$\$\$+/,
  /follow.{0,15}back/i,
  /\d+%\s*(off|discount)/i,
  /(promo|discount) code/i,
  /trader-?friendly conditions/i,
  /\$\d+k?\s+(nano|micro)\s+account/i,
];

/**
 * Catches promotional/hashtag-listicle formatting that SPAM_PATTERNS'
 * phrase matching misses -- e.g. a prop-firm ad's "profit target / max
 * daily loss / ..." bullet list, or a bot account's repeated "forex
 * trading X" tag lines. Heuristic: 4+ short lines (<=40 chars) with no
 * terminal sentence punctuation is how X ad copy and hashtag-stuffing
 * both actually look, versus a real conversational multi-line post whose
 * lines end in periods/questions or run longer.
 */
function isListicleOrAdFormatted(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 4) return false;
  const shortUnpunctuatedLines = lines.filter((l) => l.length <= 40 && !/[.!?]$/.test(l));
  return shortUnpunctuatedLines.length >= 4;
}

/**
 * Pure scoring function -- multi-factor. Author reach's weight was raised
 * 2026-09-16 per explicit owner direction: replies on small/random
 * accounts get seen by almost nobody, while a reply on a larger account is
 * what actually gets Fillbook noticed and checked out -- "it's more likely
 * people will see our replies and check us out." This still isn't a bare
 * follower-count ranking (log-scaled and capped, same shape as before,
 * just a higher ceiling and steeper slope) -- a small account with a
 * genuinely strong, relevant post can still clear the daily-set bar, per
 * the owner's own "I know they are becoming our followers too" -- reach
 * is weighted harder, not used to exclude anyone.
 */
export function scoreProspectingCandidate(input: ProspectingScoreInput): ProspectingScoreResult {
  const spamMatch = SPAM_PATTERNS.find((pattern) => pattern.test(input.postText));
  if (spamMatch) {
    return {
      score: 0,
      breakdown: { spam: `matched spam pattern ${spamMatch.source} -> excluded` },
      excluded: true,
      exclusionReason: "Looks like signal-selling/spam, not a real trader conversation.",
    };
  }
  if (isListicleOrAdFormatted(input.postText)) {
    return {
      score: 0,
      breakdown: { spam: "hashtag-stuffed or ad-listicle formatting -> excluded" },
      excluded: true,
      exclusionReason: "Reads as promotional/hashtag-listicle formatting, not a real trader conversation.",
    };
  }

  const breakdown: Record<string, string> = {};

  // Topic/class relevance -- see CLASS_WEIGHT doc comment above.
  const topicPoints = CLASS_WEIGHT[input.topic.replyClass];
  breakdown.topicRelevance = `"${input.topic.label}" (Class ${input.topic.replyClass}) -> +${topicPoints}`;

  // Active discussion -- replies/quotes matter more than raw likes for
  // "other people are actively discussing this post."
  const metrics = input.publicMetrics ?? {};
  const replyCount = metrics.reply_count ?? 0;
  const quoteCount = metrics.quote_count ?? 0;
  const likeCount = metrics.like_count ?? 0;
  const discussionRaw = replyCount * 3 + quoteCount * 2 + likeCount * 0.5;
  const discussionPoints = Math.min(Math.log10(discussionRaw + 1) * 8, 20);
  breakdown.activeDiscussion = `${replyCount} replies, ${quoteCount} quotes, ${likeCount} likes -> +${discussionPoints.toFixed(1)}`;

  // Author reach -- log-scaled (never a bare follower-count ranking), but
  // weighted harder than before -- see this function's own doc comment.
  const followers = input.authorFollowerCount ?? 0;
  const reachPoints = Math.min(Math.log10(followers + 1) * 6, 35);
  breakdown.authorReach = `${followers} followers -> +${reachPoints.toFixed(1)} (capped at 35)`;
  // Mid-sized accounts (1k-30k) are the ones likely to read and answer a reply from a small account, which is where a
  // follow comes from; a bare reach ranking sends every reply under accounts that will never notice it.
  const midSizedBonus = followers >= 1_000 && followers <= 30_000 ? 6 : 0;
  if (midSizedBonus > 0) breakdown.midSizedAccount = `${followers} followers is a size that tends to notice replies -> +${midSizedBonus}`;

  // Thread traffic (2026-10-24 reply review: the last 20 replies got a median of 9 views). A reply is seen by about as many
  // people as see the post it sits under, so a post that already has real impressions is worth more than a quiet one from the
  // same-sized account. Log-scaled and capped at +10; a post with no impression count reported gets nothing, never a penalty.
  const impressionCount = metrics.impression_count ?? 0;
  const trafficPoints = impressionCount > 0 ? Math.min(Math.log10(impressionCount + 1) * 3, 10) : 0;
  if (trafficPoints > 0) breakdown.threadTraffic = `${impressionCount} impressions on the post -> +${trafficPoints.toFixed(1)} (capped at 10)`;
  // Breakout thread (owner, 2026-10-27): a ~30-follower account tagged a big account, the thread blew up, and a reply under it got 10k views
  // and ~70 new followers overnight. A post seen by far more people than follow its author is where a reply travels, so it earns +12.
  const breakoutPoints = impressionCount >= 500 && impressionCount >= followers * 10 ? 12 : 0;
  if (breakoutPoints > 0) breakdown.breakoutThread = `${impressionCount} impressions on a ${followers}-follower account (10x or more) -> +${breakoutPoints}`;

  // Recency -- hour-scale, not a 7-day slope (2026-09-21 reach review): on X
  // a reply lands near the top of a thread only if it is among the first
  // few, so a 1-hour-old post is worth far more than a 20-hour-old one, a
  // difference the old 7-day linear decay (about 0.09 points/hour) all but
  // erased. Unknown post time keeps its old neutral credit.
  let recencyPoints = 5;
  if (input.postCreatedAt) {
    const ageMs = input.now.getTime() - input.postCreatedAt.getTime();
    recencyPoints = recencyPointsForAge(ageMs);
    breakdown.recency = `posted ${(ageMs / 3_600_000).toFixed(1)}h ago -> +${recencyPoints}`;
  } else {
    breakdown.recency = `unknown post time -> +${recencyPoints}`;
  }

  // Crowded thread -- a reply under a post that already has hundreds of
  // replies is buried no matter how large the author is. Only the reply
  // count matters here; a big account with a fresh, quiet post is still
  // the best case (see the reach revision above).
  // 2026-10-15 (growth audit): the penalty started at 100 replies, so a top-reach account with 90 replies still scored
  // well and our reply sat far below the fold. It now starts at 25 and steps up, so a fresh, quiet thread wins.
  let crowdedPenalty = 0;
  if (replyCount > 300) crowdedPenalty = 25;
  else if (replyCount > 100) crowdedPenalty = 18;
  else if (replyCount > 50) crowdedPenalty = 10;
  else if (replyCount > 25) crowdedPenalty = 5;
  if (crowdedPenalty > 0) breakdown.crowdedThread = `${replyCount} replies already -> -${crowdedPenalty} (a reply would be buried)`;

  // Authenticity -- verified is a mild positive signal; nothing here can
  // ever prove "real person," only nudge toward it, per X visibility
  // discipline in MASTER_SOCIAL_STRATEGY.md (no unverifiable claims).
  const authenticityPoints = input.authorVerified ? 5 : 0;
  breakdown.authenticity = input.authorVerified ? "verified account -> +5" : "not verified -> +0";

  // Natural value-add opportunity -- a real question invites a real
  // answer; very short posts rarely have enough context for a useful reply.
  const hasQuestion = input.postText.includes("?");
  const longEnough = input.postText.trim().length >= 40;
  // Reply-style experiment (2026-10-16): a post that invites replies ("what do you", "anyone else", "thoughts on") gets a
  // small extra boost, since a reply to an open question is the shape that earns a response.
  const invites = invitesReplies(input.postText);
  const opportunityPoints = (hasQuestion ? 8 : 0) + (longEnough ? 7 : 0) + (invites ? 4 : 0);
  breakdown.valueOpportunity = `${hasQuestion ? "asks a question" : "no question"}, ${longEnough ? "enough context" : "too short for context"}${invites ? ", invites replies" : ""} -> +${opportunityPoints}`;

  // A creator we already vetted as on topic (watchlist, 2026-10-25): a small bonus, never enough to lift a weak post past the bar alone.
  const watchlistPoints = input.fromWatchlist ? 6 : 0;
  if (watchlistPoints > 0) breakdown.watchedCreator = "a creator already vetted as on topic -> +6";

  // Existing relationship -- a natural second touch beats a cold first one.
  const relationshipPoints = input.previouslyEngaged ? 10 : 0;
  breakdown.priorRelationship = input.previouslyEngaged
    ? "already replied to this author before -> +10"
    : "no prior Prospecting contact -> +0";

  const total = topicPoints + discussionPoints + reachPoints + midSizedBonus + trafficPoints + breakoutPoints + recencyPoints + authenticityPoints + opportunityPoints + relationshipPoints + watchlistPoints - crowdedPenalty;
  const score = Math.round(Math.max(0, Math.min(100, total)) * 100) / 100;

  return { score, breakdown, excluded: false, exclusionReason: null };
}
