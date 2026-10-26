import { MODEL_HAIKU, type LlmClient } from "../content/llmClient.js";
import { HUMAN_REPLY_VOICE_RULES } from "../content/humanReplyVoice.js";
import { SHOWCASE_IDS, SHOWCASE_REPLY_GUIDANCE, formatShowcaseViews } from "../content/fillbookShowcase.js";
import { formatStyleExamples, type StyleExample } from "./prospectingStyleExamples.js";
import { PROSPECTING_TWO_OPTION_DRAFTS, SHARP_MAX_WORDS, SHARP_MIN_WORDS } from "./prospectingDraftOptions.js";

/**
 * The ONE relevance test every model gate asks (2026-10-25). The discovery screen and the draft-time check (Haiku) and the
 * drafter's own isRelevant (Sonnet) used to word it differently, and the Sonnet prompt was stricter: posts passed both cheap
 * checks, showed up as top cards, and were then turned away by the expensive call on "Draft reply" (e.g. a prop firm's own
 * account asking "why should your drawdown move up"). Same words everywhere means a post the cheap check lets through is one the
 * drafter will also accept, so the expensive rejection becomes rare instead of the usual outcome.
 */
export const PROSPECTING_RELEVANCE_CRITERIA = `Relevant means: a TRADER's own post, genuinely about FUTURES trading (index or commodity futures) in a prop-firm or own-capital
(self-funded) context, including that futures trader's psychology, discipline, risk rules or journaling, that a short, specific
reply could add something to.
NOT relevant: crypto, options (calls, puts, spreads, 0DTE), stocks or ETFs, forex, and general trading talk with no futures angle.
Futures evidence means the word futures, a futures ticker (ES, NQ, MNQ, MES, CL, GC), a futures prop firm (Topstep, Apex, Take Profit Trader, Bulenox, Tradeify), a futures platform (NinjaTrader, Tradovate, Rithmic), or rules only futures prop accounts have (trailing drawdown, consistency rule, trading combine). A mention of a prop firm or a funded account alone is NOT enough, because forex and CFD prop firms exist: if the post shows no futures evidence, answer false.
Announcements, video or stream teasers and brags are not conversations either: false.
A post from a COMPANY account (a prop firm, broker, platform, course, signal service or tool, usually recognisable by the handle or
by talking about "our" rules, accounts, payouts or plans) is marketing, not a trader's conversation, even when it is phrased as a
question: false.
Stories, memes, unrelated news and self-help posts that only borrow a trading word: false.`;

const CHEAP_RELEVANCE_SCHEMA = {
  type: "object",
  properties: {
    isRelevant: {
      type: "boolean",
      description:
        `Apply this test exactly, before anything else:\n${PROSPECTING_RELEVANCE_CRITERIA}`,
    },
  },
  required: ["isRelevant"],
};

/** Two short replies plus four flags; 800 output tokens is far above any valid answer and bounds a runaway one. */
const REPLY_DRAFT_MAX_TOKENS = 800;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    isRelevant: {
      type: "boolean",
      description:
        `Apply this test exactly, before anything else:\n${PROSPECTING_RELEVANCE_CRITERIA}`,
    },
    reply: {
      type: "string",
      description: "The exact reply text, ready to post as-is. Leave this an empty string when isRelevant is false -- it will never be shown or used.",
    },
    mentionsFillbook: { type: "boolean", description: "True only if the reply actually names Fillbook." },
    usesLink: { type: "boolean", description: "True only if the reply includes a Fillbook link placeholder." },
    showcase: {
      type: "string",
      enum: SHOWCASE_IDS,
      description: 'The id of the ONE Fillbook view the reply shows, or "none" when no view fits the post and the reply leaves Fillbook out.',
    },
  },
  required: ["isRelevant", "reply", "mentionsFillbook", "usesLink", "showcase"],
};

/** The two-option schema: `reply` is the sharp option (so every consumer of `reply` keeps working) and `helpfulReply` is the second. */
const TWO_OPTION_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    ...DRAFT_SCHEMA.properties,
    reply: {
      type: "string",
      description: `OPTION A, "sharp": one line, ${SHARP_MIN_WORDS} to ${SHARP_MAX_WORDS} words, reacting to a specific detail in THEIR post. Empty string when isRelevant is false.`,
    },
    helpfulReply: {
      type: "string",
      description: 'OPTION B, "helpful": at most two sentences with one concrete thing (a number, rule or situation) tied to a specific detail in THEIR post. Empty string when isRelevant is false.',
    },
    fillbookReply: {
      type: "string",
      description:
        'OPTION C, "fillbook": ONLY when the user message says option C is ALLOWED and one Fillbook view genuinely fits THEIR post. One useful point about their situation, then one sentence that names Fillbook and what that one view would show them. Two sentences at most, under 280 characters, no link. Empty string when not allowed, when no view fits, or when isRelevant is false.',
    },
    mentionsFillbook: { type: "boolean", description: "True only if an option actually names Fillbook (normally only the Fillbook option, option C). False in every other case." },
    usesLink: { type: "boolean", description: "Always false for a cold reply: no option may contain a link." },
  },
  required: ["isRelevant", "reply", "helpfulReply", "fillbookReply", "mentionsFillbook", "usesLink", "showcase"],
};

/**
 * Prospecting-only style block for the two-option experiment (owner direction 2026-10-16, from the account's own Results:
 * the replies that earned views were short and tied to one detail of the person's post; the tidy mechanic explainers and
 * the ones naming Fillbook reached the fewest people). It is appended AFTER the shared HUMAN_REPLY_VOICE_RULES, which Inbound
 * also uses and which are unchanged, and it overrides only the lines it names. Every hard rule above still applies.
 */
export const PROSPECTING_TWO_OPTION_STYLE_BLOCK = `COLD REPLY STYLE: TWO OPTIONS (this block applies only to this cold reply and overrides the lines it names; every
other rule above still applies to BOTH options: no em or en dashes, no praise openers, no "it's not X, it's Y", no question
tacked onto the end, nothing about "most traders", no invented first-person trading experience or results, no links, no
promise of profit, no ask to follow or like, no giveaway, plan or price unless they asked, proper capitalization, under 280
characters, no emoji or hashtags).
Write TWO different replies to the SAME post in one answer and put them in "reply" and "helpfulReply", plus an optional third in "fillbookReply" (option C, see below):
- OPTION A, "sharp" (the "reply" field): ONE line of ${SHARP_MIN_WORDS} to ${SHARP_MAX_WORDS} words that reacts to a specific detail in THEIR post.
  It is a plain observation, a direct answer to what they asked, or the concrete consequence of their situation, said the way a
  trader would text it to a friend. No mechanic lecture, no explainer, no product. Name something from THEIR post (a number, a
  firm, a day, a size). Do NOT write a slogan: no tidy two-beat line where a short claim is followed by a short punchline ("X
  doesn't care why. It just knows."), and do not give an abstract thing a mind ("the market punishes", "the drawdown doesn't
  care", "the floor just wants"). One uneven, specific sentence beats a balanced one. The right shape (never copy it): "Two
  payouts secured on a Friday, then double size by lunch. That Friday is worth a second look." For option A the "one thing
  a trader can keep" requirement does NOT apply: an accurate reaction to their exact situation is enough.
- OPTION B, "helpful" (the "helpfulReply" field): at most TWO sentences with one concrete thing (a number, a rule, or a
  situation) that is still tied to a specific detail of THEIR post. This is where "one thing a trader can keep" applies. Keep it
  to the one point; no tidy mini-explainer, no list. Where it fits, say how that exact pattern would look in a trade log
  (which column, which trades, what the numbers would be), because that is how a journaling team thinks about it. It is the
  lens, not a product mention: do not name Fillbook, a screen, or a feature, and never say a tool would catch it.
- The two options must differ in substance, not just wording.
- OPTION A and OPTION B never name Fillbook, hint at it, or show a Fillbook view, unless the person's post asked about Fillbook.
  Lines above that ask you to add a Fillbook view or sentence do not apply to A or B.
- OPTION C, "fillbook" (the "fillbookReply" field), is the ONLY option that may market Fillbook, and only when the user message says
  option C is ALLOWED and one of the Fillbook views below genuinely fits THIS post's exact problem. Then: first one specific, useful
  point about their situation (the rule, the number, or what is likely going on), plain and short; then ONE sentence that names
  Fillbook and says concretely what that one view would show them, in the terms of their post ("Fillbook's By setup view would put
  that ORB on its own row with its own win rate and net P&L, so a green month can't hide it" is the shape; "we track that in
  Fillbook" is too vague). Two sentences at most, under 280 characters, no link, no "check it out", no "try it", no discount, no
  ask to follow, no promise or hint of profit or improvement, never an invented number about their account, never real-time
  monitoring or alerts. Read whether they trade a prop firm or their own money and only show a view for that kind of trader; if you
  cannot tell, choose a view for either or leave option C empty. Keep it about the view: no "we built it" and no first person.
  If option C is NOT ALLOWED, or no view fits, set fillbookReply to an empty string, mentionsFillbook=false and showcase="none".
  When you write option C, set mentionsFillbook=true and showcase to that view's id.
  The Fillbook views you may show (the ONLY product capabilities you may describe):
${formatShowcaseViews()}
- usesLink is always false.
- If you cannot write a genuinely specific option A or B for this post, set isRelevant=false rather than padding.`;

/**
 * Replaces the platform's no-pitch guidance in two-option mode: cold replies almost never name Fillbook (the account's own data
 * shows the ones that do reach the fewest people).
 */
export const PROSPECTING_COLD_NO_PITCH_GUIDANCE = `For this cold reply, options A and B leave Fillbook out entirely. Option C (the Fillbook option) may name Fillbook only when the
user message says it is ALLOWED and a vetted view fits the post (see the option C rules). The existing mention cap and recovery-mode
rule (when stated in the notes below) always mean option C is NOT ALLOWED.`;

/**
 * Everything about a reply that legitimately differs by platform: what
 * the thing we're replying to is called, how long/what shape a good
 * reply takes there, and the one trackable link that's allowed if a link
 * is ever earned. The no-pitch principle, voice, and fact-check
 * discipline below are platform-independent and come from
 * fillbookhq/docs/social/MASTER_SOCIAL_STRATEGY.md.
 */
export interface ProspectingPlatformProfile {
  /** Human name used in the prompt ("X"). */
  displayName: string;
  /** What we are replying to, in the platform's own vocabulary. */
  postNoun: string;
  /** The ONLY link the model may ever use on this platform. */
  trackableLink: string;
  /** Platform-specific shape/etiquette rules, appended to the shared prompt. */
  styleRules: string;
  /** Platform-specific link etiquette -- when (if ever) a link is acceptable and how it must be presented. */
  linkPolicy: string;
  /**
   * How aggressively (or not) a mention of Fillbook is ever appropriate --
   * genuinely different per platform, not just a style tweak. X's version
   * (2026-09-05 refresh) replaces a purely "almost never mention it"
   * default with a structure for when a mention is actually earned, per
   * owner direction that replies read as pure advice with no path to
   * awareness. Any other/unrecognized platform falls back to the original,
   * more conservative "90%+ no mention" rule verbatim.
   */
  noPitchGuidance: string;
}

/**
 * X-specific (2026-09-25): when the post describes a problem Fillbook answers, the reply shows what
 * Fillbook would show them about it (see fillbookShowcase.ts). Replaces the 2026-09-05 "earned mention
 * as an aside" structure, which the owner found too conversational to make anyone want to try it.
 */
const X_REPLY_NO_PITCH_GUIDANCE = SHOWCASE_REPLY_GUIDANCE;

/** The original, unchanged conservative guidance -- see this constant's own docstring above on why this stays conservative while X gets more structure. Used as the fallback for any platform other than X. */
const CONSERVATIVE_NO_PITCH_GUIDANCE = `90%+ of good replies here mention Fillbook NOT AT ALL. Your default assumption should be
mentionsFillbook=false and usesLink=false. Only set them true when the conversation is
SPECIFICALLY about trade journaling/tracking/analytics tools and a mention would feel earned, not
forced. Never write "we built Fillbook for this, check it out" or any variant -- that pattern is
explicitly banned. If you're unsure, leave Fillbook out entirely.

Before finalizing, apply this test: "Would this still be worth saying if Fillbook had nothing to
sell?" If the answer is no, the reply needs a genuine value component added, not a softer sales pitch.`;

export const PROSPECTING_TRACKABLE_LINK = "fillbookhq.com/go/prospecting";

export const PROSPECTING_PLATFORM_PROFILES: Record<string, ProspectingPlatformProfile> = {
  x: {
    displayName: "X",
    postNoun: "public X post",
    trackableLink: PROSPECTING_TRACKABLE_LINK,
    styleRules:
      "A real X reply is usually one or two sentences. No hashtags, no thread-length essays, no @-mentioning " +
      "other accounts to pull them in. It reads like a person typing a quick, sharp reply under someone's post.",
    linkPolicy:
      "If -- and only if -- a link genuinely belongs, use exactly this trackable link and no other: " +
      `${PROSPECTING_TRACKABLE_LINK}. Put it at the end of the reply, never as the reply's main point.`,
    noPitchGuidance: X_REPLY_NO_PITCH_GUIDANCE,
  },
};

function genericProfile(platform: string): ProspectingPlatformProfile {
  return {
    displayName: platform,
    postNoun: `public ${platform} post`,
    trackableLink: PROSPECTING_TRACKABLE_LINK,
    styleRules: "Keep the reply short, plain, and specific to their post.",
    linkPolicy:
      "If -- and only if -- a link genuinely belongs, use exactly this trackable link and no other: " +
      `${PROSPECTING_TRACKABLE_LINK}.`,
    // An unrecognized platform gets the conservative default, not X's more
    // structured one -- an unknown platform should never accidentally
    // inherit X's more permissive mention guidance.
    noPitchGuidance: CONSERVATIVE_NO_PITCH_GUIDANCE,
  };
}

/** Case-insensitive lookup with a conservative generic fallback -- an unknown platform never crashes drafting, but also never gets X-specific language by accident. */
export function prospectingPlatformProfile(platform: string): ProspectingPlatformProfile {
  return PROSPECTING_PLATFORM_PROFILES[platform.toLowerCase()] ?? genericProfile(platform);
}

/**
 * Cold-outreach reply drafting -- distinct from inboundResponseWriter.ts,
 * which is written for "someone replied TO us." This is for joining a
 * stranger's unrelated public post, so the framing, defaults, and quality
 * bar are different: no relationship context to lean on, and the default
 * is to add value with NO Fillbook mention at all.
 *
 * Every rule below is transcribed from fillbookhq/docs/social/
 * MASTER_SOCIAL_STRATEGY.md (the "No-pitch principle & reply quality" and
 * "Fillbook voice" sections) rather than invented here -- that's the
 * standing, human-authored growth policy this feature implements. The
 * platform-specific parts (what a reply looks like, when a link is ever
 * acceptable) come from the profile above.
 */
export function buildProspectingSystemPrompt(profile: ProspectingPlatformProfile, twoOptions = false): string {
  return `You are considering ONE reply from the Fillbook account to someone else's ${profile.postNoun} on ${profile.displayName}. This
person did NOT mention or reply to us -- their post matched an automated search for a trading-related
topic, but that match can be imprecise (a search word used in an unrelated sense, a post that only
superficially resembles trading content, etc.). Fillbook is a trading journal/analytics platform for
futures day traders: prop-firm funded accounts and self-funded (own-money) futures accounts.

FIRST, judge isRelevant honestly with this test (the same one the earlier screens used):
${PROSPECTING_RELEVANCE_CRITERIA}
If it is NOT relevant, set isRelevant=false, leave every reply field an empty string, and do not attempt to force a
connection to trading. A confident "this isn't relevant" is the correct, expected outcome for many candidates; it is never a failure.
Only if isRelevant is true, continue below.

${twoOptions ? PROSPECTING_COLD_NO_PITCH_GUIDANCE : profile.noPitchGuidance}

Link policy for ${profile.displayName}: ${profile.linkPolicy}

A good reply does ONE of: answers their question, explains a rule (drawdown/consistency/payout
mechanics), clarifies a misconception, gives a useful number or calculation, shares a practical
trading-journal or trade-review insight, offers a genuine observation, empathizes without sounding
fake, or asks a real follow-up question. Never engagement-bait ("Great post!", "Facts.", "100%",
"This."). When a Fillbook view fits, the useful point sets up the view; it never replaces it.

Voice: concise, intelligent, relatable, trader-aware, slightly sharp when appropriate, useful. No
corporate SaaS language, no generic motivation, no AI clichés, no forced controversy. Fillbook is a
product/company and must never speak or be shown as if it personally trades -- no "I" statements about
trades, no fabricated personal trading history.

${HUMAN_REPLY_VOICE_RULES}${twoOptions ? `

${PROSPECTING_TWO_OPTION_STYLE_BLOCK}` : ""}

Shape for ${profile.displayName}: ${profile.styleRules}

Fact-check discipline: classify any factual claim you're relying on internally as VERIFIED FACT,
EVIDENCE-SUPPORTED OBSERVATION, REASONABLE HYPOTHESIS, or OPINION -- never state a hypothesis or
opinion as if it were a verified fact. Ground any Fillbook product claim ONLY in the verified knowledge
given below -- never invent a feature.

Submit your result via the submit_reply tool, and set isRelevant/mentionsFillbook/usesLink accurately
based on your own honest judgment and what you actually wrote -- these are checked, not just
descriptive.`;
}

export interface ProspectingDraftContext {
  /** The candidate's platform as stored on the row ("x") -- selects the prompt profile. */
  platform: string;
  authorHandle: string | null;
  postText: string;
  discoveryQuery: string;
  /** Recent owner edits, shown as tone examples. Optional and best-effort, see prospectingStyleExamples.ts. */
  styleExamples?: StyleExample[];
  /** Set on a retry: why the previous draft was rejected, so the model fixes it. See xReplyGuardrails.ts's buildRetryFeedback. */
  retryFeedback?: string;
  /** Set while recovery mode is on (prospectingRecovery.ts). In the user message, so the cached system prompt stays identical. */
  recoveryNote?: string;
  /** Set when the owner chose to reply to a post the relevance screen turned away. In the user message, so the cached system prompt stays identical. */
  ownerOverrideNote?: string;
  /** Whether option C (the Fillbook option) may be written for this post. False under recovery mode or an exhausted mention budget. In the user message, so the cached system prompt stays identical. */
  fillbookOption?: boolean;
}

export interface ProspectingDraftResult {
  isRelevant: boolean;
  reply: string;
  mentionsFillbook: boolean;
  usesLink: boolean;
  /** The Fillbook view the reply shows (a fillbookShowcase.ts id), or "none". Absent from older drafts. */
  showcase?: string;
  /** Option B ("helpful") of the two-option experiment; `reply` is then option A ("sharp"). Absent in single-style drafts. */
  helpfulReply?: string;
  /** Option C ("fillbook"): one point plus one sentence naming Fillbook and one vetted view. Empty or absent when not offered. */
  fillbookReply?: string;
}

/**
 * Drafts exactly one reply for a human to review, edit, and post themselves
 * -- same no-send guarantee as inboundResponseWriter.ts (this module only
 * ever calls the LLM; ExternalWriteFirewall blocks any x.reply/x.post_tweet
 * write action class unconditionally as a second, independent guarantee).
 * The draft is returned to the caller, not auto-persisted -- the API
 * route decides whether/how to store it against the prospecting_candidates
 * row.
 *
 * A real, confirmed bug this also closes: the model previously had no way
 * to say "this doesn't actually fit" except by writing that admission
 * into the reply text itself (e.g. "this event isn't futures related"),
 * which then got shown to the owner as if it were a usable draft.
 * isRelevant is the model's own structured escape hatch -- the caller
 * (prospectingHandlers.ts's draftProspectingCandidateReply) checks it and
 * never persists/returns a draft when it's false. This is a SECOND,
 * independent layer behind prospectingRelevance.ts's mechanical
 * pre-filter (which runs before this function is ever called) -- content
 * that slips past the keyword-based filter can still be caught here.
 */
export async function draftProspectingReply(
  client: LlmClient,
  context: ProspectingDraftContext,
  brandRulesSummary: string,
  verifiedKnowledgeSummary: string,
): Promise<ProspectingDraftResult> {
  const profile = prospectingPlatformProfile(context.platform);
  const authorPrefix = "@";
  const userMessage = [
    `Platform: ${profile.displayName}`,
    `From: ${authorPrefix}${context.authorHandle ?? "unknown"}`,
    `Why this post surfaced: matched the "${context.discoveryQuery}" topic.`,
    "",
    "Their post:",
    context.postText,
    "",
    "Brand rules:",
    brandRulesSummary,
    "",
    "Verified knowledge (use ONLY these facts about Fillbook -- do not invent anything else):",
    verifiedKnowledgeSummary,
    formatStyleExamples(context.styleExamples) ? "" : null,
    formatStyleExamples(context.styleExamples) || null,
    context.recoveryNote ? "" : null,
    context.recoveryNote ?? null,
    context.ownerOverrideNote ? "" : null,
    context.ownerOverrideNote ?? null,
    context.fillbookOption === undefined ? null : "",
    context.fillbookOption === undefined ? null : `Option C (the Fillbook option) is ${context.fillbookOption ? "ALLOWED" : "NOT ALLOWED"} for this post.`,
    context.retryFeedback ? "" : null,
    context.retryFeedback ?? null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  // The ~3k-token system prompt is identical on every draft, and drafts come in bursts (about two
  // thirds land within 5 minutes of the previous one, retries included), so cache it: a cache read
  // costs 10% of a normal input token. Undefined args keep the default timeout, token cap and model.
  return client.callTool<ProspectingDraftResult>(
    buildProspectingSystemPrompt(profile, PROSPECTING_TWO_OPTION_DRAFTS),
    userMessage,
    "submit_reply",
    PROSPECTING_TWO_OPTION_DRAFTS ? TWO_OPTION_DRAFT_SCHEMA : DRAFT_SCHEMA,
    undefined,
    REPLY_DRAFT_MAX_TOKENS,
    undefined,
    true,
  );
}

const CHEAP_RELEVANCE_SYSTEM_PROMPT = `You are a fast relevance filter for a trading-journal company's outreach queue. A post matched an
automated search for a trading-related topic (or came from a watched creator), but that match can be imprecise.

Judge ONE thing with this test:
${PROSPECTING_RELEVANCE_CRITERIA}

Answer honestly and quickly -- you are not writing a reply, only screening. A confident "not relevant" is the correct, expected
answer for most posts that reach this check.`;

/**
 * Cheap ($0.80/mTok in, MODEL_HAIKU) relevance precheck -- runs AFTER the
 * free regex pre-filter (prospectingRelevance.ts) but BEFORE the expensive
 * full drafting call (draftProspectingReply, MODEL_SONNET). Closes a real,
 * confirmed cost bug: candidates that clear the mechanical regex filter
 * but that the model later judges irrelevant (draft.isRelevant === false)
 * previously paid for a full drafting call -- system prompt, brand rules,
 * verified knowledge, and a drafted reply -- for content that was never
 * going to be used. This asks the same relevance question alone, with a
 * short prompt and a tiny max_tokens, on the cheaper model, so a rejection
 * here costs a small fraction of a full draft. Only isRelevant=true from
 * this check proceeds to draftProspectingReply; isRelevant=false is
 * treated exactly like the regex pre-filter and the drafter's own
 * isRelevant=false -- the candidate is moved to 'not_relevant' and no
 * expensive call is made.
 */
export async function checkRelevanceCheap(client: LlmClient, context: ProspectingDraftContext): Promise<boolean> {
  // The author handle matters: the drafter sees it, and a company account (a prop firm posting about its own rules) is the most
  // common post the cheap check let through and the drafter then turned away.
  const userMessage = [`Platform: ${context.platform}`, `From: @${context.authorHandle ?? "unknown"}`, `Why this post surfaced: matched the "${context.discoveryQuery}" topic.`, "", "Their post:", context.postText].join("\n");

  const { isRelevant } = await client.callTool<{ isRelevant: boolean }>(
    CHEAP_RELEVANCE_SYSTEM_PROMPT,
    userMessage,
    "submit_relevance",
    CHEAP_RELEVANCE_SCHEMA,
    undefined,
    128,
    MODEL_HAIKU,
  );
  return isRelevant;
}
