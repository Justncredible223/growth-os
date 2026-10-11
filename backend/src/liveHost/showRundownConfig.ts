/**
 * The show rundown, as data. Edit this file (no logic here) to change blocks, minutes, topic pools or how pushy the
 * call to action is. Segment ids are the ones in liveHostPersona.ts. A block is a time window of the show; inside it
 * the host picks the least recently used segment of the pool, so a long stream rotates instead of looping.
 *
 * It is a flexible structure, not a script: it only drives unprompted segments while a real audience is present (see
 * AUDIENCE_FOR_RUNDOWN in liveHostHandlers.ts). Questions in chat are always answered first.
 */
export type SceneId =
  | "opening"
  | "market_overview"
  | "chart_analysis"
  | "education"
  | "risk_lesson"
  | "viewer_question"
  | "poll"
  | "product_walkthrough"
  | "challenge"
  | "recap_cta"
  | "fallback";

export interface RundownBlock {
  id: string;
  title: string;
  /** Minutes into the stream the block starts (inclusive) and ends (exclusive). */
  fromMinute: number;
  toMinute: number;
  segmentIds: string[];
  scene: SceneId;
  /** How the call to action is handled in this block: none, only when a viewer asks, or after a demonstration. */
  cta: "none" | "on_request" | "after_demo";
}

export const RUNDOWN: RundownBlock[] = [
  { id: "opening", title: "Opening hook", fromMinute: 0, toMinute: 2, segmentIds: ["cold_open"], scene: "opening", cta: "none" },
  { id: "overview", title: "Session overview and context", fromMinute: 2, toMinute: 12, segmentIds: ["desk_lesson", "myth_or_fact"], scene: "market_overview", cta: "none" },
  { id: "lesson", title: "Trading lesson", fromMinute: 12, toMinute: 22, segmentIds: ["desk_lesson", "trader_translator", "documentary"], scene: "education", cta: "none" },
  { id: "psychology", title: "Psychology and risk management", fromMinute: 22, toMinute: 32, segmentIds: ["famous_last_words", "tilt_o_meter", "eval_graveyard", "rate_my_excuse"], scene: "risk_lesson", cta: "on_request" },
  { id: "demo", title: "Fillbook feature demonstration", fromMinute: 32, toMinute: 40, segmentIds: ["fillbook_spot", "journal_prompt"], scene: "product_walkthrough", cta: "after_demo" },
  { id: "qa", title: "Viewer Q&A and scenarios", fromMinute: 40, toMinute: 55, segmentIds: ["roast_my_trade", "journal_prompt", "awards", "fillbook_spot"], scene: "viewer_question", cta: "on_request" },
  { id: "recap", title: "Recap, challenge and close", fromMinute: 55, toMinute: 60, segmentIds: ["awards", "journal_prompt"], scene: "recap_cta", cta: "after_demo" },
];

/** After the last block ends the show keeps going on fresh topics from this pool rather than replaying the rundown. */
export const OVERRUN_BLOCK: RundownBlock = {
  id: "extended",
  title: "Extended session",
  fromMinute: 60,
  toMinute: Number.POSITIVE_INFINITY,
  segmentIds: ["desk_lesson", "myth_or_fact", "trader_translator", "famous_last_words", "tilt_o_meter", "eval_graveyard", "rate_my_excuse", "documentary", "roast_my_trade", "journal_prompt", "awards", "fillbook_spot"],
  scene: "education",
  cta: "on_request",
};
