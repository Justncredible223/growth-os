/**
 * Which model writes a line. Measured on 2026-10-10 against the real API with the production knowledge seed
 * (8.8k-token system prompt, cached): a warm Sonnet line costs about $0.0077, a warm Haiku line about $0.0025, and
 * a cold cache costs $0.038 / $0.0128. Volume is what adds up (an engaged room is roughly one line every 40
 * seconds), so the routine, joke-and-hook lines go to the fast model and the lines where a wrong fact would be
 * embarrassing stay on the stronger one.
 */

/**
 * quality (default): the stronger model for every line except welcomes and duo replies.
 * balanced: routine joke-and-hook segments on the fast model (about 40 percent cheaper; wordier and flatter).
 * low: chat answers too, fact segments excepted.
 * Whatever the mode, the host drops to the fast model as the daily budget is used (see the thresholds below).
 */
export type CostMode = "quality" | "balanced" | "low";

/** Segments that teach or state facts: kept on the stronger model unless the budget is nearly gone. */
export const FACT_SEGMENTS: ReadonlySet<string> = new Set(["desk_lesson", "rule_trivia", "trivia_answer", "myth_or_fact", "fillbook_spot"]);

/** Share of the daily budget after which everything that is not a fact segment goes to the cheap model. */
export const ECONOMY_FROM_SPEND_FRACTION = 0.6;
/** Share after which even fact segments do. Better a plainer line than a silent stream. */
export const ECONOMY_ALL_FROM_SPEND_FRACTION = 0.85;

export function parseCostMode(value: unknown): CostMode {
  return value === "quality" || value === "low" || value === "balanced" ? value : "quality";
}

export interface ModelChoiceInput {
  mode: CostMode;
  /** The segment being run, or null for a reply to chat or the co-host. */
  segmentId: string | null;
  /** A join welcome: a greeting that arrives late is a greeting to someone who left, so always the fast model. */
  joinWelcome: boolean;
  /** Duo mode and a typed or spoken prompt to answer: the back and forth has to be quick. */
  duoReply: boolean;
  /** Today's spend as a share of the daily budget (0 when unknown). */
  spendFraction: number;
}

/** True when the cheap model should write the line. */
export function useFastModel(input: ModelChoiceInput): boolean {
  if (input.joinWelcome || input.duoReply) return true;
  const fact = input.segmentId !== null && FACT_SEGMENTS.has(input.segmentId);
  if (input.spendFraction >= ECONOMY_ALL_FROM_SPEND_FRACTION) return true;
  if (input.spendFraction >= ECONOMY_FROM_SPEND_FRACTION && !fact) return true;
  if (input.mode === "quality") return false;
  if (input.mode === "low") return !fact;
  // balanced: the routine segments, not chat answers and not fact segments
  return input.segmentId !== null && !fact;
}
