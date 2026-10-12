import {
  checkReplyGuardrails,
  checkReplySoftStyle,
  containsOwnPostImpersonationClaim,
  impliesContactOrLinkRequest,
  type DraftAssessment,
} from "../content/xReplyGuardrails.js";
import { INBOUND_APPROVED_LINK_DOMAINS } from "./inboundResponseWriter.js";

/** The one page that carries the real giveaway entry form and the official rules. */
export const INBOUND_GIVEAWAY_LINK = "fillbookhq.com/giveaway";

/** True when the person's message is about the giveaway / a free-year-of-Elite prize / a contest. */
export function asksAboutGiveaway(messageText: string): boolean {
  return /\bgive-?\s?aways?\b|\braffle\b|\bsweepstakes?\b|\bfree year\b|\bwin (?:a|an|the)\b|\bcontest\b|\bprize\b/i.test(messageText);
}

/** True when they are questioning whether it is real ("is this giveaway real/legit/a scam?"). */
export function asksIfGiveawayIsReal(messageText: string): boolean {
  return asksAboutGiveaway(messageText) && /\b(?:real|legit|legitimate|fake|scam|scammy|true|genuine|rigged|actually|trust|safe)\b/i.test(messageText);
}

export function replyLinksToGiveawayPage(reply: string): boolean {
  return reply.toLowerCase().includes(INBOUND_GIVEAWAY_LINK);
}

export interface InboundDraftPolicyContext {
  /** The original inbound message text. */
  messageText: string;
  /** True when the item's author is our own account. Such an item is never drafted at all; this is defence in depth. */
  authorIsOwnAccount?: boolean;
}

/**
 * Deterministic hard/soft assessment of an Inbound draft, shared by the draft handler and tests.
 * Hard problems are regenerated with the reason fed back and never shown.
 */
export function assessInboundDraft(candidate: { reply: string; usesLink: boolean }, ctx: InboundDraftPolicyContext): DraftAssessment {
  const aboutGiveaway = asksAboutGiveaway(ctx.messageText);
  const linksGiveaway = replyLinksToGiveawayPage(candidate.reply);
  // A link is earned when the message asked for contact info/a link, or is about the giveaway (then the
  // giveaway page is the one extra link allowed). Domain allowlist still applies below.
  const linkEarned = impliesContactOrLinkRequest(ctx.messageText) || aboutGiveaway;
  let hard: string | null = null;

  if (ctx.authorIsOwnAccount) {
    hard = "is a draft reply to a post from Fillbook's own account, which must never be replied to";
  } else if (candidate.usesLink && !linkEarned) {
    hard = "includes a link, but the original message never asked for contact info or a link";
  } else {
    const expectsLink = candidate.usesLink || (aboutGiveaway && linksGiveaway);
    hard = checkReplyGuardrails(candidate.reply, expectsLink, { approvedLinkDomains: INBOUND_APPROVED_LINK_DOMAINS })?.reason ?? null;
  }

  if (!hard && ctx.authorIsOwnAccount) {
    hard = containsOwnPostImpersonationClaim(candidate.reply)?.reason ?? null;
  }
  if (!hard && asksIfGiveawayIsReal(ctx.messageText) && !linksGiveaway) {
    hard = `does not point to ${INBOUND_GIVEAWAY_LINK} and the official rules, which a question about whether the giveaway is real must do`;
  }

  return { hard, soft: checkReplySoftStyle(candidate.reply)?.reason ?? null };
}
