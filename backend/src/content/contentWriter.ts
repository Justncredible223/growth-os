import type { LlmClient } from "./llmClient.js";
import { HUMAN_POST_VOICE_RULES, HUMAN_REPLY_VOICE_RULES } from "./humanReplyVoice.js";
import { capitalizationProblem } from "./xReplyGuardrails.js";

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", description: "The full text of the single platform-native post." },
  },
  required: ["body"],
};

const SYSTEM_PROMPT = `You are Fillbook's platform-native copywriter. Fillbook is a trading
journal for futures day traders and prop-firm funded accounts (broker-agnostic import,
futures-native P&L, prop-firm drawdown/rule tracking, AI coach) -- positioned against
TradeZella/TradesViz (broker-agnostic/stock-first).

Voice: concise, intelligent, relatable, trader-aware, slightly sharp when appropriate,
useful. No corporate SaaS language, no excessive em dashes, no generic motivation, no AI
clichés, no engagement bait, no forced controversy.

${HUMAN_POST_VOICE_RULES}

Write exactly ONE platform-native post responding to the given opportunity. Ground every
factual claim about Fillbook ONLY in the "Verified knowledge" section you're given --
never invent a feature, statistic, or capability that isn't there. Do not mention
"Fillbook" as if it personally trades or has personal results -- it is a product, not a
trader.

Every post must implicitly position why a trader needs a tool like Fillbook -- either by
naming it directly (when verified knowledge supports a specific claim) or by framing the
insight as a concrete problem that structured tracking, journaling, or rule-monitoring
solves. A post that educates with no implicit "you need a system for this" angle is not
good enough -- the reader should finish it thinking they need to change something about how
they track or review their trading. This is not a call to hard-sell on every post; it is a
requirement that every post has a point of view that makes Fillbook's existence make sense.

Never state an unverified quantitative or comparative claim as flat fact -- e.g. "X causes
more breaches than Y", "most traders do X", "X is the #1 reason for Y". Nobody has that
data (no prop firm publishes breach-reason statistics), and stating it as fact is exactly
what a skeptical trader would call out. If you want to make that kind of point, either
hedge it explicitly ("in my experience", "it's easy to underestimate how often...") or
drop the comparison and make a narrower, defensible observation instead.

Submit your result via the submit_draft tool. For X/Twitter, keep it under 280 characters
and do not write a thread (one post only).

Layout for an X/Twitter post (owner request 2026-10-04): never a single block of text. Put each
part on its own short paragraph, separated by one blank line: the hook on its own line first,
then the explanation or example, then the Fillbook line last if the post mentions Fillbook at all.
Two to four short paragraphs; no bullet characters, no emojis, no hashtags.

If the user message tells you this is a PARTNERSHIP PITCH: this is a private, one-recipient
cold-outreach message, not a public post -- ignore the platform-native/public-post framing
above (character limits still apply for an X DM). You MUST reference something concrete and
specific from the "Evidence about them" text (quote or closely paraphrase an actual detail --
what they actually said, teach, or focus on), not a generic industry statement. A pitch that
could be sent to any recipient in the same category with only the name swapped is a failure,
not a stylistic choice. Present the proposed collaboration as something to discuss, never as
an already-agreed term, discount, or commission. End with exactly ONE clear, proportionate
next step (e.g. "open to a quick call?").`;

/**
 * Generates one candidate post for a given opportunity. This is the one
 * place text is invented rather than reviewed -- everything downstream
 * (ContentQualityGate, the nine deep-review agents) exists to catch this
 * step's mistakes, not to replace grounding it should already have done.
 */
export async function draftContent(
  client: LlmClient,
  platform: string,
  opportunity: { title: string; rationale: string },
  brandRulesSummary: string,
  verifiedKnowledgeSummary: string,
  /**
   * Present only when the opportunity traces to a real X mention (see
   * Opportunity.sourceUrl's kdoc) -- tells the writer to draft an actual
   * reply to that person, not a standalone post. Without this, the model
   * inconsistently guessed at the format on its own (sometimes a reply,
   * sometimes a generic post for the same kind of opportunity), which is
   * what made hook_specialist's standalone-hook bar a coin flip instead
   * of a consistent judgment.
   */
  replyTo?: { authorHandle: string | null },
  /**
   * Present only for partnership pitches (see partnershipsHandlers.ts's
   * generateDraftForPartnership). evidenceExcerpts must be the
   * recipient's OWN real words (post text, bio, notes) -- never a
   * description of how they were found -- or the writer has nothing
   * concrete to personalize with, which is exactly the gap a real
   * production pitch failed 5 of 9 reviewers for.
   */
  pitchContext?: {
    recipientOrganization: string;
    channel: "email" | "x";
    evidenceExcerpts: string[];
    proposedCollaboration: string;
    /** Set on a bounded revision attempt (see generateDraftForPartnership) -- the prior draft's own review-gate feedback, so the rewrite targets the ACTUAL problems instead of guessing again from scratch. */
    priorFeedback?: string;
  },
): Promise<string> {
  const userMessage = [
    `Platform: ${platform}`,
    replyTo
      ? [
          "Content format: REPLY, not a standalone post.",
          `This replies to a real X user${replyTo.authorHandle ? ` (@${replyTo.authorHandle})` : ""} who mentioned Fillbook.`,
          "Write ONLY the reply text, addressed naturally to them, continuing the conversation.",
          "Do not write standalone-post hook copy -- this is read with their original post as context, not mid-scroll on its own.",
          "",
          HUMAN_REPLY_VOICE_RULES,
        ].join("\n")
      : null,
    pitchContext
      ? [
          "Content format: PARTNERSHIP PITCH -- a private, one-recipient business proposition, not public content.",
          `Recipient: ${pitchContext.recipientOrganization}`,
          `Channel this will actually be sent through: ${pitchContext.channel === "email" ? "email" : "X DM"}`,
          "Evidence about them (their own real words -- you must use this for specificity):",
          ...pitchContext.evidenceExcerpts.map((e) => `- "${e}"`),
          `Proposed collaboration to raise as a discussion point: ${pitchContext.proposedCollaboration}`,
          pitchContext.priorFeedback
            ? `A prior draft was rejected for these specific reasons -- do not repeat them:\n${pitchContext.priorFeedback}`
            : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : null,
    pitchContext ? null : `Opportunity: ${opportunity.title}`,
    pitchContext ? null : `Rationale: ${opportunity.rationale}`,
    "",
    "Brand rules:",
    brandRulesSummary,
    "",
    "Verified knowledge (use ONLY these facts about Fillbook -- do not invent anything else):",
    verifiedKnowledgeSummary,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const call = (message: string) => client.callTool<{ body: string }>(SYSTEM_PROMPT, message, "submit_draft", DRAFT_SCHEMA);
  let result = await call(userMessage);

  // Owner rule (2026-09-20): proper capitalization and grammar. The prompt asks for it; a draft that still
  // comes back lowercase gets one rewrite with the reason named. If that is still wrong the draft is
  // returned anyway -- the daily post has one shot a day, so a hard failure could mean no post at all.
  const problem = capitalizationProblem(result.body);
  if (problem) {
    result = await call(
      [
        userMessage,
        "",
        `Your previous draft ${problem.reason}.`,
        `Previous draft: ${result.body}`,
        "Rewrite it with the same content and length, but with proper capitalization and grammar: every sentence starts with a capital letter, \"I\" is capitalized, and punctuation is correct.",
      ].join("\n"),
    );
  }
  return result.body;
}
