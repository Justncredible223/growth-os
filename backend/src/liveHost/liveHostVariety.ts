/**
 * Keeps a stream from sounding like a loop. A viewer notices by minute three that every reply starts "Name,
 * welcome.", that the market is always closed and he never has hands, and that every segment ends by telling chat
 * to type something. This works out, from his own recent lines, what to steer away from, so it can go into the
 * prompt (and be checked after the draft).
 */

/** Jokes and phrases that come up again and again. A family counts as overused when it shows up in two of the last six lines. */
export const BIT_FAMILIES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "the market being closed", pattern: /\b(?:market(?:'s| is| was)? (?:closed|shut)|closed (?:market|for the weekend)|nothing (?:is )?open|market (?:has )?nothing)\b/i },
  { label: "having no hands", pattern: /\bno hands\b|\bwithout hands\b|\bhave no hands\b/i },
  { label: "it being a weekend or late at night", pattern: /\b(?:saturday|sunday|weekend|midnight|two in the morning|2 ?am|three in the morning|this hour|late at night)\b/i },
  { label: "being paid in nothing", pattern: /\bpaid in nothing\b|\bget paid\b|\bunpaid\b/i },
  { label: "having no account", pattern: /\bno account\b|\bwithout an account\b/i },
  { label: "being a candle with a microphone", pattern: /\bcandle with a (?:microphone|mic)\b|\bgave a candle\b/i },
  { label: "the stop being a suggestion", pattern: /\bsuggestion box\b|\bmore of a suggestion\b|\bguideline\b/i },
];

export const OVERUSED_WINDOW = 6;
export const OVERUSED_THRESHOLD = 2;

/** The labels of the families used at least twice in the last few lines (newest first). */
export function overusedBits(recentTiltLines: string[]): string[] {
  const window = recentTiltLines.slice(0, OVERUSED_WINDOW);
  return BIT_FAMILIES.filter((family) => window.filter((line) => family.pattern.test(line)).length >= OVERUSED_THRESHOLD).map((family) => family.label);
}

/** Which of the given overused families this draft uses again. */
export function reusedBits(draft: string, overused: string[]): string[] {
  return BIT_FAMILIES.filter((family) => overused.includes(family.label) && family.pattern.test(draft)).map((family) => family.label);
}

/**
 * The first few words of a line's first sentence, with a leading "Name," removed and punctuation dropped, for
 * comparing openings. It never reaches into the second sentence, so "Marcus, welcome. Glad you came." and "Dee,
 * welcome. Different words." have the same key.
 */
export function openingKey(text: string, words = 3): string {
  const withoutName = text.trim().replace(/^[^,.!?]{1,30},\s*/, ""); // "Marcus, welcome." -> "welcome."
  const firstSentence = withoutName.split(/[.!?]/)[0] ?? "";
  const cleaned = firstSentence
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return cleaned.slice(0, words).join(" ");
}

/** True when the draft opens the way one of the previous lines did (name aside), which reads as a formula. */
export function repeatsOpening(draft: string, previousTiltLines: string[]): boolean {
  const key = openingKey(draft);
  if (key.length === 0) return false;
  return previousTiltLines.slice(0, 5).some((line) => openingKey(line) === key);
}

const WELCOME_OPENING = /^\s*[^,.!?]{0,30},?\s*(?:welcome|good to see you|glad you(?:'re| are) here|nice to see you)\b/i;

/** "Name, welcome." and its cousins: fine once, a tic by the third time. */
export function opensWithWelcome(text: string): boolean {
  return WELCOME_OPENING.test(text);
}

/** Does a line end by asking chat to type or answer something? */
export function asksChat(text: string): boolean {
  const last = text.trim().split(/(?<=[.!?])\s+/).slice(-2).join(" ");
  return /\bchat\b/i.test(last) && /(?:\?|\btype\b|\btell me\b|\bdrop\b|\bconfess\b|\bguess\b)/i.test(last);
}

const DISCLAIMER = /\bnot (?:financial )?advice\b|\bnot a financial advis/i;

export function saidDisclaimer(text: string): boolean {
  return DISCLAIMER.test(text);
}

/**
 * Claims about what chat did ("chat went quiet", "nobody guessed", "chat is split"). They are only true if someone in
 * chat actually did it, and a model with an empty room will make them up for a laugh.
 */
const CHAT_REACTION_CLAIM = /\bchat (?:went|has gone|is|was|got|stayed|keeps?|just|suddenly|already|clearly|collectively|unanimously)\b[^.!?]{0,30}\b(?:quiet|silent|silence|still|split|divided|agrees?|agreed|laughed|laughing|cheering|booing|spamming|asleep|gone|left|dead|nervous|scared|typed|answered|guessed)\b|\bnobody (?:answered|guessed|replied|typed|responded|said anything|is guessing)\b|\b(?:you|y'all|everyone) (?:all )?(?:went|got|stayed) (?:quiet|silent)\b|\bchat (?:said|guessed|answered|voted|thinks|thought|picked)\b/i;

/** True when the draft says what chat did. Callers only treat it as a problem when no viewer has actually spoken. */
export function claimsChatReaction(text: string): boolean {
  return CHAT_REACTION_CLAIM.test(text);
}

/** Bits that must not open a stream: the opening angle list exists so he does not default to these. */
export const OPENING_DEFAULTS: readonly string[] = ["the market being closed"];

/**
 * The last line of defence for invented chat reactions. Prompting does not hold this one (3 of 3 empty-room trivia
 * answers still said "nobody guessed" or "chat went quiet"), so when nobody has spoken the sentence that makes the
 * claim is dropped. If that would leave nothing, the line is returned untouched.
 */
export function stripChatReactionClaims(text: string): string {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [];
  const kept = sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0 && !CHAT_REACTION_CLAIM.test(sentence));
  return kept.length > 0 && kept.length < sentences.length ? kept.join(" ") : text;
}

export interface VarietyGuidance {
  /** Jokes and phrases to keep out of this line. */
  avoid: string[];
  /** Whether this line may end by asking chat to type something. False when he just did, or when nobody has chatted. */
  askChat: boolean;
  /** The not-financial-advice line was already said recently: do not say it again unless someone asks for advice. */
  disclaimerSaid: boolean;
  /** Recent openings to avoid repeating. */
  recentOpenings: string[];
}

export function varietyGuidance(recentTiltLines: string[], roomEngaged: boolean): VarietyGuidance {
  return {
    avoid: overusedBits(recentTiltLines),
    askChat: roomEngaged && !(recentTiltLines[0] !== undefined && asksChat(recentTiltLines[0])),
    disclaimerSaid: recentTiltLines.slice(0, 8).some(saidDisclaimer),
    recentOpenings: recentTiltLines.slice(0, 4).map((line) => openingKey(line, 4)).filter(Boolean),
  };
}

/** Why a draft should be rewritten for variety, or null. Used as a soft problem: one retry, then it is accepted. */
export function varietyProblem(
  draft: string,
  guidance: VarietyGuidance,
  recentTiltLines: string[],
  context: { isSegment: boolean; isOpening: boolean; viewerAskedForAdvice: boolean; viewerSpoke?: boolean; segmentId?: string | null; tiltLevel?: number | null },
): string | null {
  if (context.viewerSpoke === false && claimsChatReaction(draft)) return "says what chat did, but nobody in chat has said anything: leave chat's reactions out, or make the joke about the question";
  if (context.segmentId === "tilt_o_meter" && context.tiltLevel === null) return "gives no Tilt-o-Meter rating: say the number out of ten (and set tiltLevel) before asking chat for theirs";
  const reused = reusedBits(draft, guidance.avoid);
  if (reused.length > 0) return `leans on ${reused.join(" and ")} again, which it has used a lot lately: find a different angle`;
  if (opensWithWelcome(draft) && recentTiltLines.slice(0, 6).some(opensWithWelcome)) return 'opens with a "name, welcome" greeting again: fold the hello into the answer or skip it';
  if (repeatsOpening(draft, recentTiltLines)) return "opens the way a recent line did: start on something different";
  if (context.isSegment && !guidance.askChat && asksChat(draft)) return "ends by asking chat to type something again: end on the punchline instead";
  if (!context.isOpening && !context.viewerAskedForAdvice && guidance.disclaimerSaid && saidDisclaimer(draft)) return "repeats the not-financial-advice line, which was already said: leave it out";
  return null;
}
