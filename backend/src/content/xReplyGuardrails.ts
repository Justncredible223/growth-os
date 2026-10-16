/**
 * Deterministic, $0 safety net for reply drafts (Prospecting's cold
 * outreach, Inbound's replies-to-engagement) -- catches the WORST,
 * objectively-bannable patterns (generic marketing phrases, an
 * unexplained link, an unverifiable performance/customer claim)
 * mechanically, so they never depend on an LLM reviewer noticing. This is
 * deliberately narrow: it does not and cannot judge whether a reply
 * "sounds natural" or is "too generic" -- those are genuine judgment
 * calls this project leaves to the writer prompt and human review, not
 * something a keyword check can honestly claim to verify. Same
 * phrase-based house style as discoveryScoring.ts's
 * hasConcretePartnershipBasis -- not an LLM classification, so this adds
 * no cost and every match is traceable to an exact phrase.
 */

const BANNED_GENERIC_PHRASES = [
  "check out our platform",
  "check out our product",
  "learn more",
  "dm me",
  "dm us",
  "sign up today",
  "click here",
  "link in bio",
  // Pushy-sales phrasing (owner direction 2026-09-19: draw people in without
  // being aggressive). Already banned in the prompts; enforced here too.
  "check it out",
  "check us out",
  "give it a try",
  "try it out",
  "free trial",
  "sign up now",
  "use code",
  // Engagement-bait closers (owner-flagged 2026-09-10, from a real Inbound
  // draft reading as a reply-farming tactic rather than a genuine
  // response): content-free lines whose only job is soliciting another
  // reply, not adding anything to what the person actually said.
  "let's keep the conversation going",
  "keep the conversation going",
  "let's continue the conversation",
  "would love to hear more",
  "let me know your thoughts",
  "what are your thoughts",
];

export interface GuardrailViolation {
  reason: string;
}

/** True if the reply uses one of the generic marketing phrases this project's brand voice explicitly bans, regardless of platform. */
export function containsBannedGenericPhrase(reply: string): GuardrailViolation | null {
  const lower = reply.toLowerCase();
  const matched = BANNED_GENERIC_PHRASES.find((phrase) => lower.includes(phrase));
  return matched ? { reason: `uses the banned generic phrase "${matched}"` } : null;
}

/** Matches a real URL, or a bare-domain mention (e.g. "fillbookhq.com") -- a link doesn't need "http://" to read as a link/CTA in a tweet. */
const LINK_PATTERN = /https?:\/\/\S+|\b[a-z0-9-]+\.(com|io|co|app|net)\b/i;
/** Same pattern, global -- used to enumerate every link-shaped match (not just the first) so each one's domain can be checked. */
const LINK_PATTERN_GLOBAL = /https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|io|co|app|net)\b/gi;

/** True if the reply text contains anything link-shaped. Callers decide whether that's expected (usesLink=true, on a platform/context where a link is allowed) or a violation (a link slipped in by default). */
export function containsLink(reply: string): boolean {
  return LINK_PATTERN.test(reply);
}

/** Strips a matched link down to its bare host (no protocol, path, query, or trailing punctuation), lowercased, so it can be compared against an approved-domain allowlist. */
function extractLinkDomains(reply: string): string[] {
  const matches = reply.match(LINK_PATTERN_GLOBAL) ?? [];
  return matches.map((match) => {
    const withoutProtocol = match.replace(/^https?:\/\//i, "");
    const host = withoutProtocol.split(/[/?#]/)[0] ?? withoutProtocol;
    return host.toLowerCase().replace(/[.,!?;:)]+$/, "");
  });
}

/** True if `domain` is (or is a subdomain of) one of `approvedDomains`. */
function isApprovedDomain(domain: string, approvedDomains: string[]): boolean {
  return approvedDomains.some((approved) => domain === approved || domain.endsWith(`.${approved}`));
}

/**
 * Phrase-based, deterministic detector for "this message is clearly asking
 * us for contact info or a link" -- e.g. "how do I contact you", "what's
 * your website", "where can I sign up". Deliberately narrow (same
 * house-style tradeoff as the rest of this file): a false negative here
 * just means a legitimate contact reply can't include a link this time
 * (safe -- Inbound already defaults to no link), while a false positive
 * would let an arbitrary reply attach a link it was never actually asked
 * for, which is the exact hole this function exists to close.
 */
const CONTACT_OR_LINK_REQUEST_PATTERN =
  /\bhow (?:do|can|would) i (?:contact|reach|get in touch with|find|follow) you\b|\bwhere can i (?:contact|reach|find) you\b|\bwhat(?:'s| is) your (?:website|site|link|url)\b|\bhow do i (?:sign up|get started|join)\b|\bwhere do i (?:sign up|get started|join)\b|\bdo you have a (?:link|website|site)\b|\bcan (?:you|i get) (?:a|the) link\b|\bsend me a link\b/i;

/** True if the original inbound message clearly requests contact info or a link -- see the pattern's own docstring for why this stays deliberately narrow. */
export function impliesContactOrLinkRequest(messageText: string): boolean {
  return CONTACT_OR_LINK_REQUEST_PATTERN.test(messageText);
}

/**
 * Fillbook runs a real, live Elite giveaway (fillbookhq.com/giveaway; free to enter, asks entrants to follow
 * @FillbookHQ on X and enter an email + X username there; we use /go/* short links on our own domain). A draft must
 * never deny any of that, and must never call a post from our own account an impersonation (2026-10-12: an auto-draft
 * told the public that our own giveaway was an impersonation account). Deliberately literal patterns.
 */
const FALSE_GIVEAWAY_CLAIM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:does(?:n't| not)|do(?:n't| not)|never|won't|will not|isn't|is not|aren't|are not|no longer)\b[^.!?]{0,40}\b(?:run|runs|running|host|hosts|hosting|hold|holds|offer|offers|have|has|do|does|giv\w+)\b[^.!?]{0,30}\bgiveaways?\b/i,
    reason: "falsely says Fillbook does not run giveaways (the Elite giveaway at fillbookhq.com/giveaway is real)",
  },
  {
    pattern: /\b(?:there(?:'s| is) no|no such|not (?:a|an) (?:real|official|legit\w*)|fake|bogus|phony|fraudulent) (?:\w+ )?giveaways?\b|\bgiveaway\b[^.!?]{0,20}\b(?:is|was|looks|seems)\b[^.!?]{0,15}\b(?:fake|a scam|scam\w*|bogus|phony|not real|not legit\w*)/i,
    reason: "calls the real Fillbook giveaway fake or a scam",
  },
  {
    pattern: /\b(?:does(?:n't| not)|do(?:n't| not)|never|won't|will not)\b[^.!?]{0,30}\b(?:ask|asks|require|requires|tell|tells)\b[^.!?]{0,30}\b(?:follow\w*|enter (?:a |the |any |our )?(?:giveaway|contest|draw|link|email|at)|sign ?up (?:for|to) (?:a |the |any |our )?giveaway)/i,
    reason: "falsely says Fillbook never asks anyone to follow or enter (the giveaway does ask entrants to follow @FillbookHQ and enter at fillbookhq.com/giveaway)",
  },
  {
    pattern: /\b(?:does(?:n't| not)|do(?:n't| not)|never|won't|will not)\b[^.!?]{0,30}\buse\b[^.!?]{0,30}\b(?:shorten\w*|short ?links?|shorteners?|bit\.ly|tinyurl)/i,
    reason: "falsely says Fillbook does not use short links (our own /go/ links on fillbookhq.com are real)",
  },
];

/** True (with a reason) if the reply denies something true about the real Elite giveaway. Null for a clean reply. */
export function containsFalseGiveawayClaim(reply: string): GuardrailViolation | null {
  const match = FALSE_GIVEAWAY_CLAIM_PATTERNS.find(({ pattern }) => pattern.test(reply));
  return match ? { reason: match.reason } : null;
}

/** For a post authored by our OWN account: any "impersonation / fake account / not us" framing is wrong by definition. */
const IMPERSONATION_FRAMING_PATTERN = /\bimpersonat\w*|\b(?:fake|spoof\w*|clone|knock-?off|copycat|phishing)\s+(?:account|profile|page)\b|\b(?:is|are|looks?|seems?)\s+(?:a\s+)?(?:scam|fake)\b|\bnot (?:us|affiliated|official|from us|ours)\b|\bdoes(?:n't| not) (?:come from|belong to) us\b/i;

/** True (with a reason) if a reply frames a post by our own account as an impersonation/scam/not official. */
export function containsOwnPostImpersonationClaim(reply: string): GuardrailViolation | null {
  return IMPERSONATION_FRAMING_PATTERN.test(reply) ? { reason: "calls a post from Fillbook's own account an impersonation, scam or not official" } : null;
}

/**
 * Patterns for the two things this project's brand rules explicitly ban:
 * Fillbook (a company) speaking as if it personally trades, and any
 * customer/performance claim not grounded in verified knowledge. Kept
 * intentionally narrow and literal (not a general sentiment classifier)
 * so a false positive here is rare and a match is always defensible.
 */
const UNVERIFIED_CLAIM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bour (customers|users|members|traders)\b[^.!?]{0,60}\b(saved|improved|increased|reduced|grew|made|earned)\b/i, reason: "claims a customer/user result not grounded in verified knowledge" },
  { pattern: /\b\d{1,3}\s*%\s*(more|less|better|faster|improvement|increase|reduction)\b/i, reason: "cites an unverified performance statistic" },
  { pattern: /\bi(?:'ve| have)\b[^.!?]{0,40}\b(made|earned|traded|profited)\b/i, reason: "speaks in first person about personally trading, which Fillbook (a product) must never do" },
  { pattern: /\bguarantee(d|s)?\b/i, reason: "makes a guarantee, which is never verifiable" },
  { pattern: /\bproven to\b/i, reason: "claims something is \"proven\" without grounding" },
  { pattern: /\b(?:make|makes|making|turn|turns)\s+you\s+(?:a\s+)?(?:profitable|funded|consistent)\b|\bwill become profitable\b|\bbecome profitable\b/i, reason: "promises or implies the trader will become profitable" },
];

/** True (with a reason) if the reply makes an unverified personal-trading, customer-result, or guarantee-style claim. Returns null for a clean reply. */
export function containsUnverifiedClaim(reply: string): GuardrailViolation | null {
  const match = UNVERIFIED_CLAIM_PATTERNS.find(({ pattern }) => pattern.test(reply));
  return match ? { reason: match.reason } : null;
}

/**
 * High-precision "reads like a bot" tells (owner feedback 2026-09-19: X users
 * were calling the replies out as AI). Deliberately limited to patterns that
 * are near-always machine-shaped in a one-to-two sentence reply; softer style
 * guidance lives in humanReplyVoice.ts where the model can weigh it.
 */
const AI_TELL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /[–—]|\s--\s|\w--\w/, reason: "uses an em/en dash (or a -- stand-in for one), a strong AI tell in a short reply" },
  {
    pattern:
      /^\s*(?:(?:great|good|nice|excellent|solid|fair|valid|interesting)\s+(?:point|take|question|insight|observation|breakdown)|love\s+(?:this|that|it)\b|spot on|well said|so true|absolutely\b|this!|100%)/i,
    reason: "opens with praise/agreement filler instead of substance",
  },
  { pattern: /\b(?:it|that|this)(?:'s| is) not (?:just |merely |only )?[^.!?\n]{1,60}[,;:]\s*(?:it|that|this)(?:'s| is)\b/i, reason: 'uses the "it\'s not X, it\'s Y" construction' },
  { pattern: /\bnot (?:just|merely|only) [^.!?\n]{1,50},\s*but\b/i, reason: 'uses the "not just X, but Y" construction' },
  { pattern: /\bless about [^.!?\n]{1,40},?\s*more about\b/i, reason: 'uses the "less about X, more about Y" construction' },
  {
    pattern:
      /\b(?:delve|tapestry|landscape|at its core|here'?s the thing|let that sink in|deep dive|unpack|leverage|resonates?|mindset shift|the real question is|the key is|the truth is)\b/i,
    reason: "uses stock AI vocabulary",
  },
  { pattern: /(?:\bthoughts\?|\bwhat do you think\?|\bdoes that (?:make sense|resonate)\?)\s*$/i, reason: "ends on a generic solicitation question" },
  // Owner review 2026-09-20: after the dash and filler fixes, the drafts still
  // read as machine-written because they lean on the same few framings.
  { pattern: /\p{Extended_Pictographic}/u, reason: "contains an emoji" },
  { pattern: /#\w+/, reason: "contains a hashtag" },
  { pattern: /!.*!/s, reason: "uses multiple exclamation marks" },
];

/** X's own reply limit. Over this the reply cannot be posted as written, so it is a hard rejection. */
const MAX_REPLY_CHARS = 280;
/** A real X reply is one or two sentences; more than three reads like an essay (a soft signal, see checkReplySoftStyle). */
const MAX_REPLY_SENTENCES = 3;

function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
}

/** True (with a reason) if the reply matches one of the high-precision AI-tell patterns. Returns null for a reply that passes. */
export function containsAiTell(reply: string): GuardrailViolation | null {
  const match = AI_TELL_PATTERNS.find(({ pattern }) => pattern.test(reply));
  if (match) return { reason: match.reason };

  if (reply.length > MAX_REPLY_CHARS) {
    return { reason: `is too long to post on X (${reply.length} characters, the limit is ${MAX_REPLY_CHARS})` };
  }
  return capitalizationProblem(reply);
}

/** Abbreviations whose trailing period does not end a sentence, so a lowercase word after them is fine. */
const NON_TERMINAL_ABBREVIATION = /(?:\be\.g|\bi\.e|\bvs|\betc|\bapprox|\bno|\bmr|\bmrs|\bdr|\bst)\.$/i;

/**
 * Owner rule (2026-09-20): replies and posts use proper capitalization and grammar -- no all-lowercase
 * "casual" drafts. Deliberately narrow so it stays high-precision: the first word, the start of each
 * later sentence, and a bare pronoun "i". An ellipsis or an abbreviation like "e.g." does not count as
 * ending a sentence.
 */
export function capitalizationProblem(reply: string): GuardrailViolation | null {
  const text = reply.trim();

  const first = /^[^\p{L}\p{N}]*(\p{L})/u.exec(text);
  if (first && first[1] !== first[1]!.toUpperCase()) {
    return { reason: "starts with a lowercase letter -- use proper capitalization and grammar" };
  }

  const sentenceStart = /([.!?]+)["')\]]*\s+(\p{Ll})/gu;
  for (const match of text.matchAll(sentenceStart)) {
    if (match[1]!.length > 1 && match[1]!.startsWith(".")) continue; // ellipsis
    const before = text.slice(0, match.index! + match[1]!.length);
    if (NON_TERMINAL_ABBREVIATION.test(before)) continue;
    return { reason: "starts a sentence with a lowercase letter -- use proper capitalization and grammar" };
  }

  if (/(^|[^\p{L}\p{N}'’_@#/.-])i(?=\s|,|!|\?|;|:|'|’|$)/u.test(text)) {
    return { reason: 'writes the pronoun "I" in lowercase -- use proper capitalization and grammar' };
  }
  return null;
}

/**
 * Style tells that make a reply read as machine-written but are judgment calls, not objective
 * errors (owner review 2026-09-20). Run against 323 saved Prospecting drafts these matched about
 * 70% of what the model naturally writes, so treating them as hard rejections made drafting fail
 * or retry constantly. They steer ONE retry (see draftWithRetries) and the best attempt is then
 * shown to the owner, who edits every reply before posting anyway.
 */
const SOFT_STYLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bmost (?:traders|people|funded traders|retail traders|prop traders)\b/i, reason: 'generalizes about "most traders", a stock AI framing' },
  { pattern: /^\s*(?:the gap between|the second you|the hard part|the difference between|what separates)\b/i, reason: "opens with a stock AI framing instead of a specific point" },
  { pattern: /\bthat'?s the (?:gap|difference) between\b/i, reason: 'closes with a tidy "that\'s the gap between" takeaway line' },
];

/** True (with a reason) if the reply has a soft style tell. Never a reason to refuse to show a draft. */
export function checkReplySoftStyle(reply: string): GuardrailViolation | null {
  const match = SOFT_STYLE_PATTERNS.find(({ pattern }) => pattern.test(reply));
  if (match) return { reason: match.reason };

  const sentences = sentenceCount(reply);
  if (sentences > MAX_REPLY_SENTENCES) {
    return { reason: `runs ${sentences} sentences, more than a quick X reply` };
  }
  // A question is fine as the whole reply or mid-reply; tacked onto the end of a statement it is the
  // "engagement question" shape the voice rules ask the writer to avoid.
  if (sentences >= 2 && reply.trimEnd().endsWith("?")) {
    return { reason: "ends a multi-sentence reply with a question" };
  }
  return null;
}

/**
 * Owner direction (2026-09-25): a reply whose post fits a Fillbook view should actually show that view.
 * The model declares the view it picked; a reply that picked one but never names Fillbook is back to
 * plain conversation, and a reply that picked none but names Fillbook anyway is a vague mention tied to no
 * real screen. A soft check (one retry), since the owner still edits every reply.
 */
export function checkShowcaseShown(reply: string, showcase: string | undefined): GuardrailViolation | null {
  if (!showcase) return null;
  const namesFillbook = /\bfillbook/i.test(reply);
  if (showcase === "none") {
    return namesFillbook
      ? { reason: "names Fillbook without picking one of its views: pick the view that fits and say what it would show them, or leave Fillbook out" }
      : null;
  }
  if (namesFillbook) return null;
  return { reason: `picked the Fillbook "${showcase}" view but never shows it: name Fillbook and say what that view would show them` };
}

/**
 * Copy rules the video scripts share with replies (owner direction 2026-09-21). The dash rule already
 * applied to replies through AI_TELL_PATTERNS; this standalone check lets the video script writer apply the
 * same rule to its titles, descriptions, captions and script without pulling in the reply-only rules
 * (a TikTok caption legitimately says "link in bio").
 */
const DASH_PATTERN = /[–—]|\s--\s|\w--\w/;
export function dashProblem(text: string): GuardrailViolation | null {
  return DASH_PATTERN.test(text) ? { reason: 'uses an em or en dash (or a "--" stand-in for one)' } : null;
}

export interface ReplyGuardrailOptions {
  /**
   * When given, a link is only accepted if EVERY link-shaped match in the
   * reply resolves to one of these domains (or a subdomain of one) --
   * closes the gap where `expectsLink=true` alone would let any arbitrary
   * or promotional domain through unchecked. Omitted entirely (as
   * Prospecting's existing call site does) preserves the original,
   * unchanged behavior: `expectsLink=true` trusts the caller's own
   * declaration with no domain check.
   */
  approvedLinkDomains?: string[];
}

/**
 * Runs every mechanical check and returns the first violation found, or
 * null for a clean reply. `expectsLink` should be true only when the
 * caller's own context says a link is deliberately present and allowed
 * (e.g. usesLink=true on a platform where that's earned) -- otherwise any
 * link-shaped text is treated as a violation of "never include a link by
 * default".
 */
export function checkReplyGuardrails(reply: string, expectsLink: boolean, options?: ReplyGuardrailOptions): GuardrailViolation | null {
  const genericPhrase = containsBannedGenericPhrase(reply);
  if (genericPhrase) return genericPhrase;

  const unverifiedClaim = containsUnverifiedClaim(reply);
  if (unverifiedClaim) return unverifiedClaim;

  const giveawayClaim = containsFalseGiveawayClaim(reply);
  if (giveawayClaim) return giveawayClaim;

  const aiTell = containsAiTell(reply);
  if (aiTell) return aiTell;

  if (!expectsLink && containsLink(reply)) {
    return { reason: "includes a link that wasn't declared as intentional (usesLink was false or absent)" };
  }

  if (expectsLink && options?.approvedLinkDomains) {
    const disallowed = extractLinkDomains(reply).find((domain) => !isApprovedDomain(domain, options.approvedLinkDomains!));
    if (disallowed) {
      return { reason: `includes a link on a domain that isn't an approved Fillbook link ("${disallowed}")` };
    }
  }

  return null;
}

/** How many times a draft that trips a mechanical guardrail is regenerated (with the reason fed back) before the owner sees an error. */
export const MAX_DRAFT_ATTEMPTS = 3;

/** The note appended to the next attempt's prompt so the model fixes the specific problem instead of rolling the dice again. */
export function buildRetryFeedback(rejectedReply: string, reason: string): string {
  return `Your previous draft was rejected because it ${reason}.
Rejected draft: "${rejectedReply}"
Write a NEW reply that fixes exactly that. Keep it to one or two short sentences.`;
}

/** A draft that only has soft style tells gets this many attempts in total (one retry) before it is shown as-is. */
export const MAX_SOFT_ATTEMPTS = 2;

export interface DraftAssessment {
  /** A real problem: the draft must never be shown. */
  hard: string | null;
  /** A style tell: worth one retry, never a reason to refuse. */
  soft: string | null;
  /** The exact text the reason is about, when it is not draft.reply (e.g. one of two reply options). */
  rejectedText?: string;
}

/**
 * Generates a reply, regenerating with the reason fed back when a check trips. A hard problem is
 * retried up to MAX_DRAFT_ATTEMPTS times; a draft with only soft style tells is retried once
 * (MAX_SOFT_ATTEMPTS) and then accepted. If a later attempt is worse than an earlier acceptable
 * one, the earlier one wins. Returns null draft + the hard reason only when no attempt was
 * acceptable. `assess` may throw to abort (e.g. the model judged the post irrelevant).
 */
export async function draftWithRetries<T extends { reply: string }>(options: {
  generate: (retryFeedback?: string) => Promise<T>;
  assess: (draft: T) => DraftAssessment;
}): Promise<{ draft: T | null; hardReason: string | null }> {
  let feedback: string | undefined;
  let acceptable: T | null = null;
  let hardReason: string | null = null;
  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    const draft = await options.generate(feedback);
    const assessment = options.assess(draft);
    const { hard, soft } = assessment;
    if (!hard) {
      if (!soft) return { draft, hardReason: null };
      acceptable = draft;
      if (attempt >= MAX_SOFT_ATTEMPTS) return { draft: acceptable, hardReason: null };
    } else {
      hardReason = hard;
    }
    feedback = buildRetryFeedback(assessment.rejectedText ?? draft.reply, (hard ?? soft) as string);
  }
  return { draft: acceptable, hardReason: acceptable ? null : hardReason };
}
