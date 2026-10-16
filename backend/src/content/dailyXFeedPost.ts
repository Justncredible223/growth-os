import type { CampaignFactory } from "./campaignFactory.js";
import type { ContentScoreRepository } from "./contentScoreRepository.js";
import type { LlmClient, LlmUsage } from "./llmClient.js";
import { runCampaignPipeline, type CampaignRepository, type PipelineOpportunity } from "./campaignPipeline.js";
import { estimateCostUsd } from "../cost/costTracking.js";

/**
 * The canonical asset_type for Today's X Post -- deliberately distinct
 * from "post" (the generic value produced by prospecting-reply/inbound-
 * reply/opportunity-reply campaigns that also happen to land on
 * campaign_assets, platform "x"). Filtering on this value, not just
 * platform="x", is what keeps Home's Today's X Post genuinely separate
 * from replies and video scripts -- see
 * docs/PROGRESS_LEDGER.md's "Today's X Post" root-cause writeup for why
 * platform-only filtering wasn't enough.
 */
export const X_FEED_POST_ASSET_TYPE = "x_feed_post";

/** Hard ceiling on total attempts (first try + retries, automated or owner-triggered "Regenerate") for one operating day. Bounds worst-case spend even if the owner mashes Regenerate. */
export const MAX_ATTEMPTS_PER_DAY = 4;

/** How many attempts one single step invocation will make before returning control (the daily pipeline gets 2 attempts/day for free; further attempts require an explicit owner "Regenerate"). */
export const ATTEMPTS_PER_INVOCATION = 2;

/**
 * Independent monthly budget line from auto-draft's -- this is a
 * separate, smaller, guaranteed-cadence feature (at most ~2 LLM-backed
 * attempts/day between the automated run and owner regenerates land most
 * days at 1) and shouldn't compete with or be silently starved by
 * auto-draft's own opportunistic spend.
 */
export const X_FEED_POST_MONTHLY_BUDGET_USD = 6.0;

export interface EligibilityCheckResult {
  eligible: boolean;
  reason?: string;
}

export function evaluateXFeedPostBudget(monthSpendUsd: number): EligibilityCheckResult {
  if (monthSpendUsd >= X_FEED_POST_MONTHLY_BUDGET_USD) {
    return {
      eligible: false,
      reason: `monthly_budget_reached ($${monthSpendUsd.toFixed(4)} spent, cap is $${X_FEED_POST_MONTHLY_BUDGET_USD.toFixed(2)})`,
    };
  }
  return { eligible: true };
}

/**
 * One concrete, specific angle a daily X feed post can take -- never a
 * generic "motivation" or "good morning" prompt. Grounded in the actual
 * audience this backend targets throughout (futures day traders,
 * prop-firm funded accounts) and the concrete themes the master spec and
 * ContentWriter's own system prompt already call out (drawdown, journal,
 * consistency, risk). `key` is the stable rotation/idempotency identity;
 * `label` is what Home shows as "source/angle context"; `rationale` is
 * what actually reaches the LLM as the opportunity's rationale, giving it
 * a specific point to make rather than an open-ended topic name.
 */
/**
 * Which slice of docs/SEED_DATA_SOURCES.md's content-mix guideline (20%
 * education / 15% psychology / 35% product demo / 10% conversation
 * starter / 20% direct promo-CTA) a topic belongs to. Added because an
 * audit found every original topic landed in education/psychology --
 * structurally guaranteeing 0% product mentions regardless of the
 * documented target, since nothing tracked or nudged the realized mix.
 * See categoryUnderrepresentationBonus for how this now actually pulls
 * selection toward the target over time, not just in a doc comment.
 *
 * Raised product_demo/cta twice on 2026-09-21: first from 20%/5% to
 * 25%/10% ("we are a business looking to expand, not just talk to
 * people"), then to 35%/20% the same day once the owner clarified the
 * actual bar: "both our x post and our video render scripts should be
 * mainly about fillbook... what it does, how it helps and how to use" --
 * product_demo + cta is now the majority share (55%), taken from
 * education (40%->20%) and psychology (25%->15%), not from
 * conversation_starter. Landed alongside a fix to HUMAN_POST_VOICE_RULES's
 * own "never a pitch, a call to action" line, which was silently
 * overriding this target for every product_demo/cta topic before a draft
 * was even written -- see that file's own comment.
 */
export type FeedPostContentCategory = "education" | "psychology" | "product_demo" | "conversation_starter" | "cta";

/** The guideline itself, machine-readable -- mirrors docs/SEED_DATA_SOURCES.md's "Content mix guideline" line exactly. A target, not a hard cap. */
export const FEED_POST_CATEGORY_TARGETS: Record<FeedPostContentCategory, number> = {
  // 2026-10-15 (owner goal: stop losing followers): product_demo + cta lowered from 55% to 35%. A feed where more than half
  // the posts are product pitches is a poor reason to follow a 44-follower account; education/psychology and
  // conversation starters take the difference. Still a target, still self-correcting; tune it from the follower data.
  education: 0.25,
  psychology: 0.25,
  product_demo: 0.25,
  conversation_starter: 0.15,
  cta: 0.1,
};

export interface FeedPostTopic {
  key: string;
  label: string;
  rationale: string;
  /** See FeedPostContentCategory's kdoc. */
  contentCategory: FeedPostContentCategory;
  /**
   * The underlying lesson/hook/conclusion category this topic actually
   * teaches, independent of its `key` -- two different topics (different
   * keys, different wording) can still converge on the same real lesson
   * (e.g. "revenge_trading_pattern" and "position_sizing_after_a_loss" can
   * both land on "sizing creeps up after a loss"). Cross-day repetition
   * tracking compares these tags, not just the topic key or raw text, so a
   * differently-worded repeat of the same underlying point is still
   * caught. Editorial judgment, authored alongside each topic's rationale.
   */
  editorialTags: string[];
  /** 1-5 static editorial scores used to compare candidate angles before drafting -- see selectFeedPostAngle. Not derived from any model call. */
  audienceRelevance: number;
  specificity: number;
  practicalUsefulness: number;
  evidenceStrength: number;
}

export const FEED_POST_TOPICS: FeedPostTopic[] = [
  {
    key: "trailing_drawdown_mechanics",
    label: "Trailing drawdown mechanics",
    contentCategory: "education",
    rationale:
      "Explain a concrete, commonly misunderstood mechanic of trailing drawdown (e.g. whether it locks at end-of-day balance " +
      "or trails intraday, and why that distinction changes how a trader should size into a good day) -- something a funded " +
      "trader could read and immediately check against their own firm's actual rulebook.",
    editorialTags: ["drawdown-mechanics", "rule-literacy"],
    audienceRelevance: 5,
    specificity: 5,
    practicalUsefulness: 4,
    evidenceStrength: 3,
  },
  {
    key: "journaling_habit_that_sticks",
    label: "The journaling habit that actually sticks",
    contentCategory: "psychology",
    rationale:
      "Make one specific, non-obvious point about why most trade journals get abandoned within weeks (not \"lack of " +
      "discipline\" -- a concrete mechanical reason, e.g. journaling only wins/losses instead of process, or journaling after " +
      "the emotional charge has already faded) and what a trader could change about the habit itself.",
    editorialTags: ["habit-formation", "journaling"],
    audienceRelevance: 4,
    specificity: 4,
    practicalUsefulness: 4,
    evidenceStrength: 2,
  },
  {
    key: "revenge_trading_pattern",
    label: "The mechanics of a revenge-trading spiral",
    contentCategory: "psychology",
    rationale:
      "Describe the specific behavioral/mechanical sequence that turns one bad trade into an account-blowing string of them " +
      "(e.g. the exact moment sizing quietly increases, or the exact rationalization that shows up right before the next " +
      "entry) -- concrete enough that a trader recognizes it from their own history, not a generic warning about emotions.",
    editorialTags: ["loss-triggered-behavior", "sizing-discipline"],
    audienceRelevance: 5,
    specificity: 4,
    practicalUsefulness: 3,
    evidenceStrength: 2,
  },
  {
    key: "consistency_rule_reality",
    label: "What a prop-firm consistency rule actually enforces",
    contentCategory: "education",
    rationale:
      "Clarify a specific, frequently-misunderstood mechanic of prop-firm consistency rules (e.g. what counts toward the " +
      "cap, and a realistic way a genuinely good trading day can still trip it) -- the kind of detail that only becomes " +
      "obvious after reading a firm's actual rulebook closely.",
    editorialTags: ["rule-literacy", "prop-firm-mechanics"],
    audienceRelevance: 5,
    specificity: 5,
    practicalUsefulness: 4,
    evidenceStrength: 3,
  },
  {
    key: "trade_review_vs_pnl_check",
    label: "Trade review is not the same thing as checking P&L",
    contentCategory: "education",
    rationale:
      "Make a specific, concrete distinction between glancing at daily P&L and actually reviewing a trade (e.g. what " +
      "information P&L alone can never tell you about whether the process was good), grounded in a real mechanical example, " +
      "not a vague appeal to \"process over outcome.\"",
    editorialTags: ["process-over-outcome", "journaling"],
    audienceRelevance: 4,
    specificity: 4,
    practicalUsefulness: 4,
    evidenceStrength: 2,
  },
  {
    key: "position_sizing_after_a_loss",
    label: "Position sizing in the hour after a loss",
    contentCategory: "psychology",
    rationale:
      "Make one concrete, specific point about how sizing decisions right after a loss differ from sizing decisions on a " +
      "clean slate, and what a trader could mechanically check about their own sizing pattern to catch it happening.",
    editorialTags: ["loss-triggered-behavior", "sizing-discipline"],
    audienceRelevance: 5,
    specificity: 3,
    practicalUsefulness: 4,
    evidenceStrength: 2,
  },
  {
    key: "funded_account_breach_reality",
    label: "What actually breaches a funded account, mechanically",
    contentCategory: "education",
    rationale:
      "Explain one specific, concrete mechanical way funded accounts get breached that isn't the obvious \"traded too big\" " +
      "story (e.g. an overnight/weekend rule interaction, or a max-loss calculation that resets differently than a trader " +
      "assumes) -- without stating unverified breach-cause statistics as fact.",
    editorialTags: ["prop-firm-mechanics", "rule-literacy"],
    audienceRelevance: 5,
    specificity: 5,
    practicalUsefulness: 3,
    evidenceStrength: 2,
  },
  {
    key: "same_setup_different_context",
    label: "The same setup, in a different market context",
    contentCategory: "education",
    rationale:
      "Make a specific, concrete point about how a genuinely identical chart setup can be a good trade in one market context " +
      "and a bad one in another (e.g. session, volatility regime, or news proximity), the kind of distinction that only " +
      "shows up when a trader reviews the same setup across many instances.",
    editorialTags: ["process-over-outcome", "context-dependence"],
    audienceRelevance: 3,
    specificity: 4,
    practicalUsefulness: 3,
    evidenceStrength: 2,
  },
  {
    key: "discipline_is_a_system_not_willpower",
    label: "Discipline as a system, not a willpower problem",
    contentCategory: "psychology",
    rationale:
      "Make a concrete, specific point about ONE mechanical guardrail (not a vague call to \"have more discipline\") that " +
      "removes a real decision point in the moment it's hardest to make well -- grounded in an actual trading scenario, not " +
      "generic self-improvement language.",
    editorialTags: ["habit-formation", "sizing-discipline"],
    audienceRelevance: 4,
    specificity: 3,
    practicalUsefulness: 4,
    evidenceStrength: 2,
  },
  {
    key: "reading_your_own_equity_curve",
    label: "What your own equity curve is actually telling you",
    contentCategory: "education",
    rationale:
      "Make one specific, concrete point about a pattern in an equity curve that's easy to misread (e.g. a flat stretch that " +
      "looks like stagnation but is actually a controlled drawdown, or a spike that looks like skill but is actually " +
      "variance) -- something a trader could check against their own curve today.",
    editorialTags: ["process-over-outcome", "context-dependence"],
    audienceRelevance: 3,
    specificity: 4,
    practicalUsefulness: 3,
    evidenceStrength: 2,
  },
  {
    key: "drawdown_rule_tracking_in_practice",
    label: "What Fillbook's drawdown/rule tracking actually catches",
    contentCategory: "product_demo",
    rationale:
      "Walk through ONE concrete, specific moment where Fillbook's prop-firm drawdown/rule tracking would flag a real rule " +
      "interaction as it happens (e.g. an overnight hold that changes a max-loss calculation) -- the product must read as " +
      "evidence of the mechanism just explained, never a feature list or generic pitch. Ground every claim about Fillbook " +
      "ONLY in the verified knowledge you're given; if it doesn't support a specific enough claim, make the mechanic's point " +
      "without naming the product rather than vaguely gesturing at a feature.",
    editorialTags: ["rule-literacy", "prop-firm-mechanics"],
    audienceRelevance: 5,
    specificity: 4,
    practicalUsefulness: 4,
    evidenceStrength: 3,
  },
  {
    key: "broker_agnostic_import_in_practice",
    label: "What broker-agnostic import actually solves",
    contentCategory: "product_demo",
    rationale:
      "Walk through ONE concrete, specific annoyance that broker/platform-agnostic import solves for a futures trader running " +
      "more than one funded account (e.g. reconciling P&L across platforms after switching or adding a firm) -- the product " +
      "must read as evidence of that specific mechanism, never a feature list. Ground every claim ONLY in verified knowledge.",
    editorialTags: ["prop-firm-mechanics"],
    audienceRelevance: 4,
    specificity: 4,
    practicalUsefulness: 4,
    evidenceStrength: 3,
  },
  {
    key: "ai_coach_in_practice",
    label: "What Fillbook's AI coach would actually flag",
    contentCategory: "product_demo",
    rationale:
      "Walk through ONE concrete, specific example of what Fillbook's AI coach would flag in a real trade-review scenario, " +
      "tied to a genuine behavioral pattern (e.g. sizing creep after a loss, or a revenge-trade sequence) -- a specific " +
      "worked example, not a generic \"get an AI coach\" pitch. Ground every claim about the coach ONLY in verified " +
      "knowledge; if it can't support a specific enough example, make the behavioral point without the product claim.",
    editorialTags: ["loss-triggered-behavior", "sizing-discipline"],
    audienceRelevance: 4,
    specificity: 3,
    practicalUsefulness: 4,
    evidenceStrength: 2,
  },
  {
    key: "ask_your_closest_rule_call",
    label: "A real question inviting traders to share their closest rule call",
    contentCategory: "conversation_starter",
    rationale:
      "Ask one genuine, narrow, specific question inviting real funded-account traders to share their own closest call with " +
      "a drawdown or consistency rule (e.g. \"what's the closest you've come to tripping a rule you didn't fully " +
      "understand?\") -- a real conversation starter meant to surface replies worth reading, not generic engagement bait " +
      "(\"thoughts?\", \"agree or disagree?\").",
    editorialTags: ["rule-literacy"],
    audienceRelevance: 4,
    specificity: 3,
    practicalUsefulness: 2,
    evidenceStrength: 1,
  },
  {
    key: "direct_cta_funded_traders",
    label: "A direct, earned invitation for funded-account traders to try Fillbook",
    contentCategory: "cta",
    rationale:
      "Write a short, direct, proportionate call-to-action inviting a futures day trader or prop-firm funded trader to try " +
      "Fillbook, naming ONE specific, verified capability as the reason (not a feature list) -- this must read as an earned " +
      "next step, never a bare advertisement; keep it concrete and short, one clear action, no urgency/hype language.",
    editorialTags: [],
    audienceRelevance: 4,
    specificity: 3,
    practicalUsefulness: 3,
    evidenceStrength: 2,
  },
  {
    key: "behavior_flags_in_practice",
    label: "What Fillbook actually flags on a trade, and why",
    contentCategory: "product_demo",
    rationale:
      "Walk through ONE concrete, specific moment where Fillbook's trade-log flags (e.g. tagging a trade Revenge trade or " +
      "Oversized) would catch a real behavioral pattern as it happens, tied to a genuine sequence (e.g. a losing trade " +
      "immediately followed by a much larger one) -- the product must read as evidence of that specific mechanism, never a " +
      "feature list, and the flag must be framed as a review prompt, never a diagnosis of intent. Ground every claim about " +
      "Fillbook ONLY in the verified knowledge you're given; if it doesn't support a specific enough claim, make the " +
      "behavioral point without the product claim.",
    editorialTags: ["loss-triggered-behavior", "sizing-discipline"],
    audienceRelevance: 5,
    specificity: 4,
    practicalUsefulness: 4,
    evidenceStrength: 3,
  },
  {
    key: "setup_breakdown_in_practice",
    label: "What breaking your month down by setup actually shows",
    contentCategory: "product_demo",
    rationale:
      "Walk through ONE concrete, specific moment where Fillbook's by-setup breakdown reveals a losing or underperforming " +
      "setup hiding inside an otherwise positive month -- the product must read as evidence of that specific mechanism (a " +
      "real trade count and result for one setup), never a feature list. Ground every claim about Fillbook ONLY in the " +
      "verified knowledge you're given; if it doesn't support a specific enough claim, make the point about breaking totals " +
      "down by setup without the product claim.",
    editorialTags: ["process-over-outcome", "rule-literacy"],
    audienceRelevance: 4,
    specificity: 4,
    practicalUsefulness: 4,
    evidenceStrength: 3,
  },
  {
    key: "direct_cta_multi_account_traders",
    label: "A direct, earned invitation for traders running more than one funded account",
    contentCategory: "cta",
    rationale:
      "Write a short, direct, proportionate call-to-action inviting a futures trader who runs more than one prop-firm " +
      "account to try Fillbook, naming broker-agnostic import as the ONE specific, verified reason (reconciling P&L across " +
      "platforms/firms without manual work) -- this must read as an earned next step, never a bare advertisement; keep it " +
      "concrete and short, one clear action, no urgency/hype language.",
    editorialTags: ["prop-firm-mechanics"],
    audienceRelevance: 4,
    specificity: 3,
    practicalUsefulness: 3,
    evidenceStrength: 2,
  },
  {
    key: "how_to_set_up_drawdown_tracking",
    label: "How to actually set up drawdown and daily-loss tracking in Fillbook",
    contentCategory: "product_demo",
    rationale:
      "Write a short, concrete HOW-TO: the specific steps a trader takes to enter their prop firm's trailing drawdown and " +
      "daily loss limit into Fillbook so it tracks both automatically -- this is a walkthrough of using the product, not a " +
      "hook about a mistake. Ground every step ONLY in the verified knowledge you're given; if it doesn't support a specific " +
      "enough step-by-step claim, narrow the how-to to what it does support rather than inventing UI details. The only " +
      "setup steps that exist are on the \"Prop firm rules\" page: click \"Add account\", pick the firm and account size " +
      "(or \"Custom\" and type the account size, daily loss limit, drawdown and profit target from the firm's rules), and " +
      "choose trailing or static drawdown for that account. Never name any other page, button, toggle or step (a post " +
      "once invented \"Accounts page, click your account, scroll to Rules, toggle on Trailing Drawdown\" and it was wrong).",
    editorialTags: ["rule-literacy", "prop-firm-mechanics"],
    audienceRelevance: 4,
    specificity: 4,
    practicalUsefulness: 5,
    evidenceStrength: 3,
  },
];

/** Configurable recent-history lookback for cross-day editorial-tag repetition checks. ~2x the 10-topic rotation length by default, so a lesson used near the end of one rotation cycle is still remembered at the start of the next. */
export const RECENT_EDITORIAL_HISTORY_DAYS = Number(process.env.X_FEED_POST_EDITORIAL_HISTORY_DAYS) || 21;

export interface CandidateAngleScore {
  topic: FeedPostTopic;
  audienceRelevance: number;
  specificity: number;
  practicalUsefulness: number;
  evidenceStrength: number;
  /** Count of already-collected signals (last 7 days) matching this topic's editorialTags -- a bonus, never a requirement. 0 when no fresh signal exists or the lookup itself failed. */
  freshnessSignalCount: number;
  /** 0-1: fraction of this topic's editorialTags that appeared in the last RECENT_EDITORIAL_HISTORY_DAYS days of runs (including owner-posted text where available). Higher = more likely to repeat a recent lesson/hook/conclusion even with different wording. */
  recentTagOverlapPenalty: number;
  /** How far this topic's contentCategory is BELOW its FEED_POST_CATEGORY_TARGETS share of recent history -- see categoryUnderrepresentationBonus. 0 when on-target or over-represented. */
  categoryUnderrepresentationBonus: number;
  totalScore: number;
}

/**
 * How much this topic's category is currently under-represented relative
 * to its documented target share (FEED_POST_CATEGORY_TARGETS), scaled
 * into the same rough points range as the static editorial scores above
 * so it can actually move the winner, not just exist as a footnote.
 *
 * This is the fix for the real gap an audit found: every original topic
 * was "education"/"psychology", the writer is explicitly allowed to skip
 * a product mention entirely, and nothing tracked or nudged the realized
 * mix toward the documented 20% product-demo / 5% CTA target -- so it
 * structurally never happened. This makes the target self-correcting:
 * the longer product_demo/cta/conversation_starter topics go unpicked,
 * the more their score rises, until they win a rotation slot on their
 * own editorial merits plus this pull. An already-on-target or
 * over-represented category gets a bonus of 0, never a penalty --
 * this only ever pulls up underrepresented categories, it never pushes
 * education/psychology down below their own considerable merits.
 */
export function categoryUnderrepresentationBonus(
  category: FeedPostContentCategory,
  recentCategories: readonly FeedPostContentCategory[],
): number {
  if (recentCategories.length === 0) return 0; // no history yet -- nothing to correct against.
  const target = FEED_POST_CATEGORY_TARGETS[category];
  const actual = recentCategories.filter((c) => c === category).length / recentCategories.length;
  const shortfall = Math.max(0, target - actual);
  // Scaled so a category sitting at 0% actual against a 20% target (the
  // product_demo case an audit actually found) contributes a bonus on
  // the same order as the static editorial scores (which run roughly
  // 1-5 each, summing ~15-20) -- strong enough to win close comparisons,
  // not so strong it overrides a genuinely weak candidate every time.
  return shortfall * 20;
}

export interface AngleSelection {
  selected: FeedPostTopic;
  candidatesConsidered: CandidateAngleScore[];
  reason: string;
}

/** How many distinct candidate angles to assemble and compare before drafting -- a small, bounded set, not every FEED_POST_TOPICS entry and never multiple full drafts. */
const CANDIDATE_SET_SIZE = 3;

/**
 * Assembles a small set of distinct, non-excluded candidate angles and
 * scores them on audience relevance, specificity, practical usefulness,
 * evidence strength, freshness (from already-collected signals only, never
 * a new paid lookup), and similarity to recently used editorial tags --
 * then selects the strongest-scoring one and records a concrete,
 * comparative reason. This replaces the previous "first non-excluded
 * topic in rotation order wins" selection, which never actually compared
 * anything.
 *
 * Deliberately does NOT draft or deep-review multiple candidates to
 * compare them -- the comparison is entirely over static editorial
 * metadata and already-collected signal/history data, so it costs zero
 * additional LLM calls.
 */
export function selectFeedPostAngle(
  operatingDate: string,
  excludeKeys: readonly string[],
  recentEditorialTags: string[][],
  freshnessSignalCountByTopicKey: Record<string, number>,
  /** contentCategory of each recent run (most recent RECENT_EDITORIAL_HISTORY_DAYS), used ONLY to compute categoryUnderrepresentationBonus. Optional/defaulted so every existing call site (and every existing test) keeps working unchanged -- an empty history just means the bonus is 0 for everything, i.e. today's pure editorial-merit selection, same as before this parameter existed. */
  recentCategories: readonly FeedPostContentCategory[] = [],
): AngleSelection {
  const baseIndex = ((dayIndex(operatingDate) % FEED_POST_TOPICS.length) + FEED_POST_TOPICS.length) % FEED_POST_TOPICS.length;
  const excluded = new Set(excludeKeys);
  const candidates: FeedPostTopic[] = [];
  for (let offset = 0; offset < FEED_POST_TOPICS.length && candidates.length < CANDIDATE_SET_SIZE; offset++) {
    const candidate = FEED_POST_TOPICS[(baseIndex + offset) % FEED_POST_TOPICS.length]!;
    if (!excluded.has(candidate.key)) candidates.push(candidate);
  }
  if (candidates.length === 0) candidates.push(FEED_POST_TOPICS[baseIndex]!); // every topic excluded (shouldn't happen within MAX_ATTEMPTS_PER_DAY) -- a repeated angle still beats no post.

  const recentTagCounts = new Map<string, number>();
  for (const tags of recentEditorialTags) for (const t of tags) recentTagCounts.set(t, (recentTagCounts.get(t) ?? 0) + 1);

  const scored: CandidateAngleScore[] = candidates.map((topic) => {
    const overlapping = topic.editorialTags.filter((t) => recentTagCounts.has(t)).length;
    const recentTagOverlapPenalty = topic.editorialTags.length === 0 ? 0 : overlapping / topic.editorialTags.length;
    const freshnessSignalCount = freshnessSignalCountByTopicKey[topic.key] ?? 0;
    const categoryBonus = categoryUnderrepresentationBonus(topic.contentCategory, recentCategories);
    const totalScore =
      topic.audienceRelevance +
      topic.specificity +
      topic.practicalUsefulness +
      topic.evidenceStrength +
      Math.min(freshnessSignalCount, 3) * 0.5 -
      recentTagOverlapPenalty * 4 +
      categoryBonus;
    return {
      topic,
      audienceRelevance: topic.audienceRelevance,
      specificity: topic.specificity,
      practicalUsefulness: topic.practicalUsefulness,
      evidenceStrength: topic.evidenceStrength,
      freshnessSignalCount,
      recentTagOverlapPenalty,
      categoryUnderrepresentationBonus: categoryBonus,
      totalScore,
    };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore);

  const winner = scored[0]!;
  const runnerUp = scored[1];
  const reason = runnerUp
    ? `Selected "${winner.topic.label}" (score ${winner.totalScore.toFixed(1)}) over ${scored.length - 1} other candidate${scored.length > 2 ? "s" : ""} considered, incl. "${runnerUp.topic.label}" (${runnerUp.totalScore.toFixed(1)}): ` +
      (winner.categoryUnderrepresentationBonus > runnerUp.categoryUnderrepresentationBonus
        ? `its "${winner.topic.contentCategory}" category is under-represented in recent history relative to its target share.`
        : winner.recentTagOverlapPenalty < runnerUp.recentTagOverlapPenalty
          ? "less overlap with recently used lessons/conclusions."
          : winner.freshnessSignalCount > runnerUp.freshnessSignalCount
            ? "a live already-collected signal the other candidate lacked."
            : "a stronger relevance/specificity/usefulness/evidence profile among comparable recency.") +
      " This is the strongest of the candidates actually compared here, not a claim that no better post exists."
    : `Only one eligible candidate ("${winner.topic.label}") remained after excluding today's already-tried topics.`;

  return { selected: winner.topic, candidatesConsidered: scored, reason };
}

/** Deterministic day-index so the same operating date always maps to the same starting topic absent a forced retry -- not a hash, just a stable ordinal so behavior is easy to reason about and test. */
function dayIndex(operatingDate: string): number {
  const [year, month, day] = operatingDate.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!) / (24 * 60 * 60 * 1000);
}

/**
 * Picks the next topic for `operatingDate`, skipping anything in
 * `excludeKeys` (already tried today, whether it failed a gate or was
 * already shown to the owner via a prior Regenerate). Rotation is a
 * simple day-indexed walk through FEED_POST_TOPICS -- if every topic has
 * been excluded (should only happen if MAX_ATTEMPTS_PER_DAY somehow
 * exceeded the topic count), falls back to the day's base topic rather
 * than throwing, since a repeated angle is still better than no post.
 */
export function selectFeedPostTopic(operatingDate: string, excludeKeys: readonly string[] = []): FeedPostTopic {
  const baseIndex = ((dayIndex(operatingDate) % FEED_POST_TOPICS.length) + FEED_POST_TOPICS.length) % FEED_POST_TOPICS.length;
  const excluded = new Set(excludeKeys);
  for (let offset = 0; offset < FEED_POST_TOPICS.length; offset++) {
    const candidate = FEED_POST_TOPICS[(baseIndex + offset) % FEED_POST_TOPICS.length]!;
    if (!excluded.has(candidate.key)) return candidate;
  }
  return FEED_POST_TOPICS[baseIndex]!;
}

export type XFeedPostRunStatus = "running" | "ready" | "failed";

export interface XFeedPostRun {
  id: string;
  operatingDate: string;
  status: XFeedPostRunStatus;
  campaignAssetId: string | null;
  topicKey: string | null;
  triedTopicKeys: string[];
  attempts: number;
  aiCalls: number;
  costUsd: number;
  error: string | null;
  postedAt: string | null;
  /** ISO timestamp of this row's last write -- the optimistic-concurrency token every claim below is conditioned on, so two invocations reading the same row can never both "win" a claim. */
  updatedAt: string;
  /** The winning topic's editorialTags at selection time -- what cross-day repetition checks compare against, independent of topicKey. */
  editorialTags: string[];
  /** Recorded, human-readable reason the winning angle was selected over the other candidates compared -- see selectFeedPostAngle. Null for a run created before this field existed. */
  selectionReason: string | null;
  /** The owner's final confirmed text at Mark-posted time (may differ from the original AI draft after an edit) -- null until posted. */
  postedText: string | null;
  /** True once the asset's own campaign was retired (owner dismissed it via the existing reject/decideApproval path) -- read from campaigns.status alongside the run row, not stored on it. */
  dismissed?: boolean;
}

/**
 * A 'running' row older than this is treated as abandoned (a crashed or
 * timed-out invocation, never one still genuinely in flight) and becomes
 * reclaimable. Vercel kills this endpoint's own invocation at 60s (see
 * vercel.json's maxDuration for api/daily-pipeline.ts) and this step
 * never spans more than one invocation, so nothing legitimate is ever
 * still "running" this long after its last write -- the multiple of the
 * function ceiling is deliberate slack for clock skew and the final
 * write's own network latency, not a guess.
 */
export const STALE_RUNNING_MS = 3 * 60 * 1000;

export interface XFeedPostRunRepository {
  getRun(operatingDate: string): Promise<XFeedPostRun | null>;
  /** Durable claim for a BRAND NEW day via a unique constraint on operating_date -- returns the new run's id, or null if another invocation already claimed this date (caller should re-read via getRun and proceed from there). */
  claimRun(operatingDate: string): Promise<string | null>;
  /**
   * Atomically transitions an EXISTING row from `expectedStatus` to
   * 'running', conditioned on `expectedUpdatedAt` (and, when given,
   * `expectedCampaignAssetId`) still matching -- a compare-and-swap, not
   * a read-then-write. Returns true only if this call's write is the one
   * that actually changed the row; false means another invocation
   * claimed it first (concurrently, or because the caller's own view of
   * the row was already stale) and the caller must re-read before doing
   * anything else. This is the ONLY path by which a 'failed' row is
   * retried, a stale 'running' row is reclaimed, or a dismissed 'ready'
   * row is replaced -- so at most one attempt-sequence can ever be in
   * flight for a given operating_date at a time.
   */
  tryClaimForAttempt(
    operatingDate: string,
    expected: { status: XFeedPostRunStatus; updatedAt: string; campaignAssetId?: string | null },
  ): Promise<boolean>;
  /**
   * Conditionally records in-flight progress for the attempt-sequence this
   * invocation currently owns -- topic choice, tried-topic list, and/or an
   * incremental aiCalls/costUsd delta from an attempt that just returned
   * (success or failure). Conditioned on `expectedUpdatedAt` so a
   * straggling invocation whose claim was superseded by a stale-reclaim
   * (see tryClaimForAttempt) can never silently overwrite the reclaimer's
   * fresher state -- `ok:false` means exactly that happened, and the
   * caller must stop and re-read rather than continue. Called promptly
   * after EVERY attempt (not just at the very end of the invocation) so a
   * mid-invocation timeout never erases real, already-incurred cost.
   * Returns the row's new updatedAt on success so the caller can chain the
   * next conditional write without a redundant re-read.
   */
  recordAttemptProgress(
    id: string,
    expectedUpdatedAt: string,
    patch: { topicKey?: string; triedTopicKeys?: string[]; editorialTags?: string[]; selectionReason?: string; aiCallsDelta?: number; costUsdDelta?: number },
  ): Promise<{ ok: true; updatedAt: string } | { ok: false }>;
  /**
   * Conditional finalize -- the real production path for transitioning to
   * 'ready' or 'failed', gated the same way as recordAttemptProgress.
   * `completeRun` (below) remains as an unconditional write used only for
   * test/seed setup and cases with no meaningful prior updatedAt to
   * condition on.
   */
  finalizeAttempt(
    id: string,
    expectedUpdatedAt: string,
    outcome: {
      status: XFeedPostRunStatus;
      campaignAssetId?: string | null;
      topicKey?: string | null;
      triedTopicKeys: string[];
      attempts: number;
      aiCalls: number;
      costUsd: number;
      error?: string | null;
    },
  ): Promise<boolean>;
  completeRun(
    id: string,
    outcome: {
      status: XFeedPostRunStatus;
      campaignAssetId?: string | null;
      topicKey?: string | null;
      triedTopicKeys: string[];
      attempts: number;
      aiCalls: number;
      costUsd: number;
      error?: string | null;
    },
  ): Promise<void>;
  /** Sum of cost_usd across every run row (any status) in the given calendar month (YYYY-MM). */
  getMonthSpendUsd(yearMonth: string): Promise<number>;
  /**
   * Every run row with operating_date >= sinceOperatingDate, most recent
   * first -- backs both cross-day editorial-tag repetition checks (see
   * selectFeedPostAngle) and the Previous drafts / history surface (a
   * ready-but-unposted prior day's run is a recoverable draft, not just a
   * repetition-avoidance input).
   */
  listRecentRuns(sinceOperatingDate: string): Promise<XFeedPostRun[]>;
  /** Records the owner's final confirmed text alongside marking posted, so future originality/tag checks compare against what was ACTUALLY posted (which may differ from the original candidate after an owner edit), not the pre-edit draft. */
  markPosted(operatingDate: string, postedAt: string, postedText: string): Promise<void>;
}

export interface XFeedPostStepDeps {
  llmClient: LlmClient;
  factory: CampaignFactory;
  scoreRepo: ContentScoreRepository;
  campaignRepo: CampaignRepository;
  runRepo: XFeedPostRunRepository;
  brandRulesSummary: string;
  verifiedKnowledgeSummary: string;
  /** Recent X feed post bodies (this asset_type only, not the generic recent-content list) -- scopes the originality/duplicate check to what actually matters for this feature. */
  recentFeedPostTexts: string[];
  usageLog: LlmUsage[];
  isPaused: () => Promise<boolean>;
  /** True if the campaign behind an existing 'ready' run has since been retired (owner explicitly dismissed it) -- lets an explicit Regenerate replace a dismissed post the same day. */
  isDismissed: (campaignAssetId: string) => Promise<boolean>;
  /**
   * campaigns.opportunity_id is a real foreign key into opportunities(id)
   * -- runCampaignPipeline (shared, unmodified, with every real
   * signal-derived opportunity) always needs one to exist. This creates
   * a real opportunities row for the topic (immediately actioned, so it
   * never appears as an open Radar item and can never be picked up by
   * auto-draft's own eligibility scan) and returns its id.
   */
  createOpportunityForTopic: (topic: FeedPostTopic) => Promise<string>;
  /**
   * Freshness signal count (last 7 days, by editorialTags) for each given
   * topic, keyed by topic.key -- built ONLY from signals already
   * collected by existing adapters (X search, Search Console), never a
   * new paid lookup. Advisory only: a lookup failure or empty
   * result must resolve to 0 for that topic, never block or fail
   * selection. See buildXFeedPostStepDeps's implementation.
   */
  getTopicFreshnessSignals: (topics: FeedPostTopic[]) => Promise<Record<string, number>>;
}

export type XFeedPostStepStatus =
  | "ready" // a passing post exists for this date, freshly generated or reused
  | "skipped" // system_paused / budget / already-attempted-today without force
  | "failed"; // this invocation's attempt(s) did not produce a passing post

export interface XFeedPostStepResult {
  status: XFeedPostStepStatus;
  skipReason?: string;
  campaignAssetId?: string;
  topicKey?: string;
  attempts: number;
  aiCalls: number;
  costUsd: number;
  error?: string;
}

/**
 * The dedicated daily X feed-post step: guarantees Home has a genuine,
 * reviewed, ready-for-owner X post to show for `operatingDate`, or an
 * honest, reasoned "no quality post available" -- never silent
 * emptiness caused by no signal-derived opportunity happening to clear
 * auto-draft's score threshold that day (see auto_draft's own
 * `no_qualifying_opportunity` skip reason, which this step doesn't
 * depend on at all).
 *
 * `force` distinguishes the automated daily-pipeline invocation (false)
 * from an explicit owner "Regenerate" tap (true): unforced calls are the
 * idempotent, cheap common case (already ready today -> return
 * immediately, no LLM calls, no new attempts); forced calls are allowed
 * to spend a bounded further attempt even after a prior failure, or to
 * replace a post the owner has explicitly dismissed (retired) today --
 * but NEVER to replace one still genuinely ready/handed_off/posted,
 * which is the actual duplicate-prevention guarantee.
 */
function stillReadyResult(run: XFeedPostRun): XFeedPostStepResult {
  return {
    status: "ready",
    campaignAssetId: run.campaignAssetId ?? undefined,
    topicKey: run.topicKey ?? undefined,
    attempts: run.attempts,
    aiCalls: run.aiCalls,
    costUsd: run.costUsd,
  };
}

function isStaleRunning(run: XFeedPostRun, now: Date): boolean {
  return run.status === "running" && now.getTime() - new Date(run.updatedAt).getTime() > STALE_RUNNING_MS;
}

/** The message a run shows when the day's attempts are used up (Home reads it back from the run's error). */
export function maxAttemptsMessage(attempts: number): string {
  return `max_attempts_reached (${attempts}/${MAX_ATTEMPTS_PER_DAY}): no attempts left today, the next post is generated tomorrow`;
}

/**
 * Conservative worst-case wall time for ONE attempt: the draft call is
 * sequential, then the 9 review agents run concurrently via Promise.all
 * (see runDeepReview) -- so real worst case is roughly TWO round trips,
 * each bounded by LlmClient's own per-call timeout (default 20s), plus
 * slack for the DB writes around it. Used only to decide whether there's
 * enough time left to safely START another attempt, never to bound the
 * attempt itself (that bound is the per-call timeout).
 *
 * Tuned from real runs (x_feed_post_runs, 2026-09-05..20): a whole attempt
 * takes 8-20s in practice. The earlier 45s estimate against the pipeline's
 * 52s deadline meant a second attempt only started if the first finished
 * within 7s, so a first draft rejected in review ended the day as "failed:
 * insufficient time remaining" instead of retrying (13 and 16 Sep). 30s
 * leaves room for a retry after a normal first attempt and still stops a
 * genuinely slow one; a mid-attempt kill is recovered by the stale-run
 * reclaim.
 */
export const ESTIMATED_ATTEMPT_DURATION_MS = 30_000;

export async function runDailyXFeedPostStep(
  deps: XFeedPostStepDeps,
  operatingDate: string,
  force = false,
  now: Date = new Date(),
  /**
   * Absolute wall-clock deadline (real Date.now()-comparable ms, NOT
   * relative to the possibly-fake `now` param above) this invocation must
   * stop starting new work before. Deliberately anchored to real Date.now()
   * -- `now` controls operating-date/staleness semantics and can be a
   * fixed test value, but the deadline check inside the attempt loop below
   * always measures real elapsed time (fetch calls take real time
   * regardless of what `now` a test passes), so the default must be too.
   * Defaults to "effectively unbounded" so existing callers/tests that
   * don't pass one keep prior behavior; api/daily-pipeline.ts and
   * api/summary.ts's Regenerate handler pass a real deadline derived from
   * their own invocation start + Vercel's maxDuration minus a safety
   * margin.
   */
  invocationDeadlineMs: number = Date.now() + ATTEMPTS_PER_INVOCATION * ESTIMATED_ATTEMPT_DURATION_MS + 60_000,
): Promise<XFeedPostStepResult> {
  async function checkGates(): Promise<{ eligible: true } | { eligible: false; reason: string }> {
    if (await deps.isPaused()) return { eligible: false, reason: "system_paused" };
    const monthSpend = await deps.runRepo.getMonthSpendUsd(operatingDate.slice(0, 7));
    const budgetCheck = evaluateXFeedPostBudget(monthSpend);
    if (!budgetCheck.eligible) return { eligible: false, reason: budgetCheck.reason! };
    return { eligible: true };
  }

  const upfrontGate = await checkGates();
  if (!upfrontGate.eligible) {
    return { status: "skipped", skipReason: upfrontGate.reason, attempts: 0, aiCalls: 0, costUsd: 0 };
  }

  let run = await deps.runRepo.getRun(operatingDate);
  let runId: string;

  const maxAttemptsSkipped = (r: XFeedPostRun): XFeedPostStepResult => ({
    status: "skipped",
    skipReason: `max_attempts_reached (${r.attempts}/${MAX_ATTEMPTS_PER_DAY})`,
    attempts: r.attempts,
    aiCalls: r.aiCalls,
    costUsd: r.costUsd,
    error: r.error ?? undefined,
  });

  if (run === null) {
    const claimedId = await deps.runRepo.claimRun(operatingDate);
    if (claimedId === null) {
      // Lost a race with a concurrent invocation that claimed this date
      // first -- re-read rather than proceeding blind, and never attempt
      // in this call; the winner of the race owns this attempt-sequence.
      run = await deps.runRepo.getRun(operatingDate);
      if (run === null) {
        return { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
      }
      return { status: "skipped", skipReason: "already_in_progress", attempts: run.attempts, aiCalls: run.aiCalls, costUsd: run.costUsd };
    }
    runId = claimedId;
    run = {
      id: claimedId,
      operatingDate,
      status: "running",
      campaignAssetId: null,
      topicKey: null,
      triedTopicKeys: [],
      attempts: 0,
      aiCalls: 0,
      costUsd: 0,
      error: null,
      postedAt: null,
      updatedAt: now.toISOString(),
      editorialTags: [],
      selectionReason: null,
      postedText: null,
    };
  } else {
    runId = run.id;

    // Posted is a hard terminal state -- never replaced by anything,
    // forced or not, dismissed campaign or not. This is the only
    // guarantee that matters for "posted content cannot be silently
    // replaced": everything else (ready/failed/running) is reachable
    // through some path, posted is not.
    if (run.status === "ready" && run.postedAt) {
      return stillReadyResult(run);
    }

    if (run.status === "ready") {
      const dismissed = run.campaignAssetId ? await deps.isDismissed(run.campaignAssetId) : false;
      if (!dismissed || !force) {
        // Either genuinely still ready (never regenerate over a good
        // post, forced or not), or dismissed but the caller didn't ask
        // to replace it -- either way, nothing new to do.
        return stillReadyResult(run);
      }
      // No attempts left: never claim. A claim flips the row to 'running', and with nothing left to attempt nothing would
      // ever finish it, so the card sat on "Generating..." and every tap re-locked it.
      if (run.attempts >= MAX_ATTEMPTS_PER_DAY) return maxAttemptsSkipped(run);
      // Dismissed + force: claim atomically before touching anything else.
      // A lost claim means someone else is already replacing (or already
      // replaced) this exact post -- re-read and report whatever is
      // actually true now rather than racing a second generation.
      const claimed = await deps.runRepo.tryClaimForAttempt(operatingDate, {
        status: "ready",
        updatedAt: run.updatedAt,
        campaignAssetId: run.campaignAssetId,
      });
      if (!claimed) {
        const fresh = await deps.runRepo.getRun(operatingDate);
        return fresh ? stillReadyResult(fresh) : { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
      }
    } else if (run.status === "failed") {
      if (!force) {
        return {
          status: "skipped",
          skipReason: `already_attempted_failed: ${run.error ?? "unknown"}`,
          attempts: run.attempts,
          aiCalls: run.aiCalls,
          costUsd: run.costUsd,
          error: run.error ?? undefined,
        };
      }
      if (run.attempts >= MAX_ATTEMPTS_PER_DAY) return maxAttemptsSkipped(run);
      const claimed = await deps.runRepo.tryClaimForAttempt(operatingDate, { status: "failed", updatedAt: run.updatedAt });
      if (!claimed) {
        const fresh = await deps.runRepo.getRun(operatingDate);
        if (!fresh) return { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
        return fresh.status === "ready"
          ? stillReadyResult(fresh)
          : { status: "skipped", skipReason: "already_in_progress", attempts: fresh.attempts, aiCalls: fresh.aiCalls, costUsd: fresh.costUsd };
      }
    } else if (run.status === "running") {
      if (!isStaleRunning(run, now)) {
        // Genuinely in flight (or written moments ago) -- never race it.
        return { status: "skipped", skipReason: "already_in_progress", attempts: run.attempts, aiCalls: run.aiCalls, costUsd: run.costUsd };
      }
      if (run.attempts >= MAX_ATTEMPTS_PER_DAY) {
        // Wedged by an earlier Regenerate that claimed the row and then found no attempts left. There is nothing to reclaim
        // it FOR: close it as failed with the real reason so Home stops saying it ran out of time.
        await deps.runRepo.finalizeAttempt(run.id, run.updatedAt, {
          status: "failed",
          topicKey: run.topicKey,
          triedTopicKeys: run.triedTopicKeys,
          attempts: run.attempts,
          aiCalls: run.aiCalls,
          costUsd: run.costUsd,
          error: maxAttemptsMessage(run.attempts),
        });
        return maxAttemptsSkipped(run);
      }
      // Abandoned by a crashed/timed-out invocation -- reclaim rather
      // than leaving the operating date permanently locked. Same
      // compare-and-swap guarantee: only one reclaimer can win even if
      // several invocations notice the staleness at once.
      const claimed = await deps.runRepo.tryClaimForAttempt(operatingDate, { status: "running", updatedAt: run.updatedAt });
      if (!claimed) {
        const fresh = await deps.runRepo.getRun(operatingDate);
        if (!fresh) return { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
        if (fresh.status === "ready") return stillReadyResult(fresh);
        return { status: "skipped", skipReason: "already_in_progress", attempts: fresh.attempts, aiCalls: fresh.aiCalls, costUsd: fresh.costUsd };
      }
    }
  }

  if (!run) {
    // Unreachable in practice (every branch above either returns or
    // leaves `run` set) -- guards TypeScript's narrowing across the
    // nested `supersededResult` closure below rather than asserting.
    return { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
  }

  if (run.attempts >= MAX_ATTEMPTS_PER_DAY) {
    return {
      status: "skipped",
      skipReason: `max_attempts_reached (${run.attempts}/${MAX_ATTEMPTS_PER_DAY})`,
      attempts: run.attempts,
      aiCalls: run.aiCalls,
      costUsd: run.costUsd,
      error: run.error ?? undefined,
    };
  }

  // Re-read to get the DB's own authoritative updatedAt for the row this
  // invocation now owns (whichever branch above got us here) -- every
  // subsequent write below is conditioned on this value, chained forward,
  // so a straggling invocation that lost ownership (superseded by a
  // stale-reclaim, or by another owner entirely) can never silently
  // clobber fresher state written by whoever actually owns the row now.
  const owned = await deps.runRepo.getRun(operatingDate);
  if (!owned) return { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
  run = owned;
  let currentUpdatedAt = owned.updatedAt;

  function supersededResult(fresh: XFeedPostRun | null): XFeedPostStepResult {
    if (!fresh) return { status: "skipped", skipReason: "concurrent_claim_conflict", attempts: 0, aiCalls: 0, costUsd: 0 };
    if (fresh.status === "ready") return stillReadyResult(fresh);
    return { status: "skipped", skipReason: "superseded_by_another_worker", attempts: fresh.attempts, aiCalls: fresh.aiCalls, costUsd: fresh.costUsd };
  }

  const attemptBudget = Math.min(ATTEMPTS_PER_INVOCATION, MAX_ATTEMPTS_PER_DAY - run.attempts);
  let attempts = run.attempts;
  let triedTopicKeys = [...run.triedTopicKeys];
  let totalAiCalls = run.aiCalls;
  let totalCostUsd = run.costUsd;
  let lastError: string | undefined;

  // Recent editorial-tag history and freshness signals are fetched ONCE
  // per invocation (not per attempt) -- they describe the shared state
  // every candidate in every attempt this invocation makes is compared
  // against, and re-fetching per attempt would just add latency without
  // changing the answer within one invocation's short lifetime.
  const historySince = new Date(new Date(operatingDate + "T00:00:00Z").getTime() - RECENT_EDITORIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentRuns = await deps.runRepo.listRecentRuns(historySince);
  const recentEditorialTags = recentRuns.filter((r) => r.operatingDate < operatingDate).map((r) => r.editorialTags);
  const freshnessSignalCountByTopicKey = await deps.getTopicFreshnessSignals(FEED_POST_TOPICS);
  // Resolves each recent run's topicKey back to its contentCategory (a
  // run whose topic was later removed from FEED_POST_TOPICS, or that
  // never got a topicKey at all, is simply excluded rather than guessed
  // at) -- feeds categoryUnderrepresentationBonus above.
  const recentCategories = recentRuns
    .filter((r) => r.operatingDate < operatingDate && r.topicKey)
    .map((r) => FEED_POST_TOPICS.find((t) => t.key === r.topicKey)?.contentCategory)
    .filter((c): c is FeedPostContentCategory => c !== undefined);

  for (let i = 0; i < attemptBudget; i++) {
    // Re-checked before every attempt AFTER the first -- the upfront gate
    // check just above already covers attempt 0 (nothing async has
    // happened yet to change pause/budget state in between), so
    // re-checking it again here would be redundant, not more correct.
    // From attempt 1 onward, real time and real spend (the previous
    // attempt's own LLM calls) have elapsed, which is exactly when a
    // pause flip or a budget crossed by concurrent spend elsewhere must
    // be able to stop the NEXT attempt.
    if (i > 0) {
      const gate = await checkGates();
      if (!gate.eligible) {
        lastError = `stopped mid-run: ${gate.reason}`;
        break;
      }
    }

    // Stop STARTING new work once there isn't enough real time left to
    // safely finish another attempt within the invocation's own deadline
    // -- an unmeasured "it probably fits" was exactly the gap here before.
    if (Date.now() + ESTIMATED_ATTEMPT_DURATION_MS > invocationDeadlineMs) {
      lastError = "stopped: insufficient time remaining before invocation deadline";
      break;
    }

    const { selected: topic, reason: selectionReason } = selectFeedPostAngle(operatingDate, triedTopicKeys, recentEditorialTags, freshnessSignalCountByTopicKey, recentCategories);
    attempts++;
    triedTopicKeys = [...triedTopicKeys, topic.key];

    // Persisted BEFORE the (slow, expensive) pipeline call -- if this
    // invocation is killed mid-attempt, the next invocation/reclaim at
    // least knows which topic was being attempted and won't need to
    // re-derive it, and (more importantly) this is the CAS checkpoint that
    // detects a stale-reclaim that has already taken over.
    const preAttempt = await deps.runRepo.recordAttemptProgress(runId, currentUpdatedAt, {
      topicKey: topic.key,
      triedTopicKeys,
      editorialTags: topic.editorialTags,
      selectionReason,
    });
    if (!preAttempt.ok) return supersededResult(await deps.runRepo.getRun(operatingDate));
    currentUpdatedAt = preAttempt.updatedAt;

    const usageBefore = deps.usageLog.length;
    let result;
    try {
      const opportunityId = await deps.createOpportunityForTopic(topic);
      const opportunity: PipelineOpportunity = {
        id: opportunityId,
        title: topic.label,
        rationale: topic.rationale,
        recommendedChannels: ["x"],
      };
      result = await runCampaignPipeline(deps.llmClient, deps.factory, deps.scoreRepo, deps.campaignRepo, opportunity, {
        brandRulesSummary: deps.brandRulesSummary,
        verifiedKnowledgeSummary: deps.verifiedKnowledgeSummary,
        recentTextsForSameTopic: deps.recentFeedPostTexts,
        assetTypeOverride: X_FEED_POST_ASSET_TYPE,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const newUsage = deps.usageLog.slice(usageBefore);
      const aiCallsDelta = newUsage.length;
      const costUsdDelta = newUsage.reduce((sum, u) => sum + estimateCostUsd(u), 0);
      totalAiCalls += aiCallsDelta;
      totalCostUsd += costUsdDelta;
      // Persisted immediately -- real cost already incurred by this failed
      // attempt must survive even if the invocation is killed before the
      // loop's next iteration or the final finalizeAttempt call.
      const progress = await deps.runRepo.recordAttemptProgress(runId, currentUpdatedAt, { aiCallsDelta, costUsdDelta });
      if (!progress.ok) return supersededResult(await deps.runRepo.getRun(operatingDate));
      currentUpdatedAt = progress.updatedAt;
      continue;
    }

    const newUsage = deps.usageLog.slice(usageBefore);
    const aiCallsDelta = newUsage.length;
    const costUsdDelta = newUsage.reduce((sum, u) => sum + estimateCostUsd(u), 0);
    totalAiCalls += aiCallsDelta;
    totalCostUsd += costUsdDelta;
    const progress = await deps.runRepo.recordAttemptProgress(runId, currentUpdatedAt, { aiCallsDelta, costUsdDelta });
    if (!progress.ok) return supersededResult(await deps.runRepo.getRun(operatingDate));
    currentUpdatedAt = progress.updatedAt;

    if (result.finalStage === "ready_for_owner") {
      const finalized = await deps.runRepo.finalizeAttempt(runId, currentUpdatedAt, {
        status: "ready",
        campaignAssetId: result.campaignAssetId,
        topicKey: topic.key,
        triedTopicKeys,
        attempts,
        aiCalls: totalAiCalls,
        costUsd: totalCostUsd,
        error: null,
      });
      // A lost finalize race here means another worker's attempt-sequence
      // (almost certainly a stale-reclaimer that took over while this one
      // was mid-pipeline) already finalized this operating_date first --
      // this invocation's own freshly-produced campaign_asset is simply
      // discarded rather than silently overwriting whatever the row now
      // says. Extremely rare (requires two full pipeline runs to complete
      // concurrently) and strictly safer than the alternative.
      if (!finalized) return supersededResult(await deps.runRepo.getRun(operatingDate));
      return { status: "ready", campaignAssetId: result.campaignAssetId, topicKey: topic.key, attempts, aiCalls: totalAiCalls, costUsd: totalCostUsd };
    }

    lastError = result.mechanicalBlockReasons.length > 0 ? `quality gate: ${result.mechanicalBlockReasons.join("; ")}` : `review gate: ${result.deepReview?.blockReasons.join("; ") ?? "unknown"}`;
  }

  const finalized = await deps.runRepo.finalizeAttempt(runId, currentUpdatedAt, {
    status: "failed",
    campaignAssetId: null,
    topicKey: null,
    triedTopicKeys,
    attempts,
    aiCalls: totalAiCalls,
    costUsd: totalCostUsd,
    error: lastError ?? "unknown failure",
  });
  if (!finalized) return supersededResult(await deps.runRepo.getRun(operatingDate));
  return { status: "failed", attempts, aiCalls: totalAiCalls, costUsd: totalCostUsd, error: lastError };
}

/** Human label for a topic key, e.g. for Home's "source/angle context" -- null for an unrecognized/legacy key rather than throwing. */
export function feedPostTopicLabel(topicKey: string | null): string | null {
  if (!topicKey) return null;
  return FEED_POST_TOPICS.find((t) => t.key === topicKey)?.label ?? null;
}

export type TodayXPostState = "empty" | "running" | "ready" | "handed_off" | "posted" | "failed";

export interface TodayXPostView {
  state: TodayXPostState;
  campaignAssetId?: string;
  previewText?: string;
  topicLabel?: string;
  reason?: string;
  /** Why this angle was selected over the other candidates compared -- see selectFeedPostAngle. Undefined for a run created before this field existed. */
  selectionReason?: string;
  /** True when a Regenerate action should be offered (a failed attempt, or a post the owner explicitly dismissed today). */
  canRegenerate: boolean;
}

/**
 * The single pure mapping from a day's run row (plus its campaign
 * asset's real stage and whether the owner has retired it) to what Home
 * should show. Kept separate from the Supabase wiring in api/summary.ts
 * so this decision -- ready vs handed_off vs posted vs failed vs empty,
 * and when Regenerate is offered -- is fully unit-testable without a
 * database.
 */
export function deriveTodayXPostView(
  run: XFeedPostRun | null,
  assetStage: string | null,
  dismissed: boolean,
  previewText: string | null,
  /** When given, a 'running' run not updated for STALE_RUNNING_MS is shown as failed with Regenerate offered. Omitted = no staleness check. */
  now?: Date,
): TodayXPostView {
  if (run === null) {
    return { state: "empty", canRegenerate: false };
  }

  // Genuinely (or apparently) in flight -- distinct from "empty" so the
  // owner can tell "nothing has started" from "something is working on
  // it right now" rather than the two looking identical, as they did
  // before this state existed.
  if (run.status === "running") {
    // A run whose invocation was killed mid-attempt (the function has a hard time limit) stays 'running' in the database
    // until something reclaims it. Showing "Generating..." with no button for it left the owner stuck for hours, so once it
    // is past the staleness bar (the same one a reclaim uses) it reads as failed and Regenerate, which does reclaim it, is offered.
    if (now && isStaleRunning(run, now)) {
      // With no attempts left a Regenerate cannot start another (and used to wedge the row like this), so say that instead.
      if (run.attempts >= MAX_ATTEMPTS_PER_DAY) {
        return { state: "failed", reason: maxAttemptsMessage(run.attempts), selectionReason: run.selectionReason ?? undefined, canRegenerate: false };
      }
      return {
        state: "failed",
        reason: "The last attempt didn't finish (it ran out of time). Tap Regenerate to try again.",
        selectionReason: run.selectionReason ?? undefined,
        canRegenerate: true,
      };
    }
    return { state: "running", canRegenerate: false };
  }

  if (run.status === "failed") {
    // Used-up attempts: Regenerate would do nothing, so don't offer it.
    return { state: "failed", reason: run.error ?? undefined, selectionReason: run.selectionReason ?? undefined, canRegenerate: run.attempts < MAX_ATTEMPTS_PER_DAY };
  }

  // run.status === "ready" from here on.
  if (dismissed) {
    return { state: "empty", canRegenerate: true };
  }

  const topicLabel = feedPostTopicLabel(run.topicKey) ?? undefined;

  if (assetStage === "handed_off") {
    return run.postedAt
      ? { state: "posted", campaignAssetId: run.campaignAssetId ?? undefined, topicLabel, canRegenerate: false }
      : {
          state: "handed_off",
          campaignAssetId: run.campaignAssetId ?? undefined,
          // The text actually copied to X at handoff -- Mark posted needs
          // this as the postedText it records, since HANDED_OFF shows no
          // editable field the owner could have changed it in (see
          // HomeScreen.kt's markXPostPosted call site).
          previewText: previewText ?? undefined,
          topicLabel,
          canRegenerate: false,
        };
  }

  return {
    state: "ready",
    campaignAssetId: run.campaignAssetId ?? undefined,
    previewText: previewText ?? undefined,
    topicLabel,
    selectionReason: run.selectionReason ?? undefined,
    canRegenerate: false,
  };
}
