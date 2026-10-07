import type { ScenePlan } from "./types.js";
import { PILOTS } from "./pilots.js";
import { PAYOFF_PILOTS } from "./payoffPilots.js";
import { STORY_PILOTS } from "./storyPilots.js";
import { MORE_STORY_PILOTS } from "./storyPilotsMore.js";
import { PILOT7_STORY_PILOTS } from "./storyPilots7.js";
import { MOCK_CARD_PILOTS } from "./chartMockConcepts.js";
import { OUTCOMES_PILOTS } from "./chartConcepts.js";
import { BARS_PILOTS } from "./chartBarsConcepts.js";
import { DAILY_PILOTS } from "./dailyConcepts.js";
import { FRESH_PILOTS } from "./freshConcepts.js";
import { FRESH2_PILOTS } from "./freshConcepts2.js";
import { RECORDING_PILOTS } from "./freshRecordingConcepts.js";

/**
 * Every verified ScenePlan a motion concept can be requested for: the original pilots plus the payoff redesign
 * variants. This is the single list both the catalog (scripts/video-factory/motionCatalog.ts, which the app's
 * "Create Fillbook Video" list and the render worker use) and the campaign pipeline (which drafts the script)
 * resolve a concept id against, so they can never disagree about what exists.
 */
export const MOTION_SCENE_PLANS: ScenePlan[] = [...PILOTS, ...PAYOFF_PILOTS, ...STORY_PILOTS, ...MORE_STORY_PILOTS, ...PILOT7_STORY_PILOTS, ...MOCK_CARD_PILOTS, ...BARS_PILOTS, ...OUTCOMES_PILOTS, ...DAILY_PILOTS, ...FRESH_PILOTS, ...FRESH2_PILOTS, ...RECORDING_PILOTS];

/**
 * True when this plan is a chart card (the "chart" layout). Since 2026-10-01 these are the only concepts the app offers
 * for a new video; every older concept stays resolvable so a script already drafted or approved still renders.
 */
export function isChartPlan(plan: ScenePlan): boolean {
  return plan.scenes.some((s) => s.layout === "chart");
}

/** True when this plan is a screen-recording alternative of a fresh concept (every scene a real recording, "recording" layout). */
export function isRecordingPlan(plan: ScenePlan): boolean {
  return plan.scenes.length > 0 && plan.scenes.every((s) => s.layout === "recording");
}

/** True when this plan is a product mock (every scene a chart drawn as a Fillbook screen), whether or not it is still offered. */
export function isMockPlan(plan: ScenePlan): boolean {
  return plan.scenes.length > 0 && plan.scenes.every((s) => s.layout === "chart" && s.chart?.kind === "mock");
}

/**
 * The concepts the app offers, in request order (owner decision, 2026-10-07: the old pool is cleared and replaced): the nine hook-first
 * concepts of freshConcepts.ts plus the twenty-one of freshConcepts2.ts, each of which opens on a pain or a striking number, ordered as the
 * 30-day plan documented at the top of freshConcepts2.ts (strongest hooks first, never more than two of one lane in a row, never the same
 * recording twice in a row). The 30 daily concepts (dailyConcepts.ts) and every other older concept stay in MOTION_SCENE_PLANS so a script
 * already drafted or approved from one still renders, but none is offered again.
 *
 * ONE ordered array on purpose: the screen-recording alternatives (freshRecordingConcepts.ts) stand in place of fresh-02-plan-said-3 (day 2), fresh-04-setup-lost-422 (day 21) and
 * fresh-06-five-revenge (day 1) as fresh-02b, fresh-04b and fresh-06b, so the pool is 30 distinct days; the three card versions follow the 30 as hidden fallbacks (a recording alternative and its card version are near-copies, so only one is ever offered).
 */
export const OFFERED_DAILY_CONCEPT_IDS: readonly string[] = [
  "fresh-06b-five-revenge-recording", // day 1
  "fresh-02b-plan-said-3-recording", // day 2
  "fresh-07-take-it-again", // day 3
  "fresh-01-two-limits", // day 4
  "fresh-12-one-red-day", // day 5
  "fresh-19-biggest-leak", // day 6
  "fresh-10-eight-contracts", // day 7
  "fresh-14-won-then-lost", // day 8
  "fresh-08-nobody-fines", // day 9
  "fresh-11-two-accounts-one-trade", // day 10
  "fresh-03-one-day-46", // day 11
  "fresh-20-moved-stop", // day 12
  "fresh-15-open-vs-late-morning", // day 13
  "fresh-09-win-rate-fell", // day 14
  "fresh-17-690-left", // day 15
  "fresh-18-one-day-1788", // day 16
  "fresh-21-edge-score-67", // day 17
  "fresh-16-six-vs-norm", // day 18
  "fresh-28-weak-hour", // day 19
  "fresh-22-only-monday-lost", // day 20
  "fresh-04b-setup-lost-422-recording", // day 21
  "fresh-30-84-percent", // day 22
  "fresh-29-24-wins-14-losses", // day 23
  "fresh-23-52-vs-13", // day 24
  "fresh-13-129-days", // day 25
  "fresh-24-92-on-plan", // day 26
  "fresh-26-98-percent", // day 27
  "fresh-05-below-the-floor", // day 28
  "fresh-25-overtrading-days-17", // day 29
  "fresh-27-48-trades-88", // day 30
  // Fallbacks, never requested while their recording version is made, waiting or on offer (conceptVariety.ts hides a near-copy): if the owner
  // rejects a recording version, the card version of the same idea is offered in its place.
  "fresh-02-plan-said-3",
  "fresh-04-setup-lost-422",
  "fresh-06-five-revenge",
];

/**
 * Concepts offered in addition to the daily pool. Empty since 2026-10-07 (the conviction video, offered by hand from 2026-10-05, is
 * cleared with the rest; "chart-bars-conviction" still resolves). An id added here must still be a product mock that clears the
 * render bar and is not a near-copy of another offered concept; the narration rules in test/narratedMocks.test.ts apply to it too.
 */
export const EXTRA_OFFERED_CONCEPT_IDS: readonly string[] = [];

/**
 * True when the app offers this plan for a new video: one of OFFERED_DAILY_CONCEPT_IDS or EXTRA_OFFERED_CONCEPT_IDS. Every older
 * concept, including the first twelve product mocks and the 30 earlier daily ones, stays resolvable but is never offered.
 */
export function isOfferedPlan(plan: ScenePlan): boolean {
  return (isMockPlan(plan) || isRecordingPlan(plan)) && (OFFERED_DAILY_CONCEPT_IDS.includes(plan.planId) || EXTRA_OFFERED_CONCEPT_IDS.includes(plan.planId));
}

/** The offered concepts' position in the order (0 = day 1; the extras follow the daily pool), or -1 for a plan that is not offered. */
export function dailyPosition(planId: string): number {
  const daily = OFFERED_DAILY_CONCEPT_IDS.indexOf(planId);
  if (daily >= 0) return daily;
  const extra = EXTRA_OFFERED_CONCEPT_IDS.indexOf(planId);
  return extra >= 0 ? OFFERED_DAILY_CONCEPT_IDS.length + extra : -1;
}

/** Spoken pace for a narrated product mock: the project voice (en-US-AndrewNeural) at +8%, brisk but not rushed. */
export const MOCK_SPEECH_RATE = "+8%";
/** A narrated mock beat holds at least this long: the 1 s entrance animation plus half a second to read the figure. */
export const MOCK_MIN_BEAT_SECONDS = 1.5;

/** The narration settings of a narrated mock: the project voice and pace, silence trimmed off every line, and a floor on each beat. */
export const MOCK_NARRATION = { rate: MOCK_SPEECH_RATE, minSceneSeconds: MOCK_MIN_BEAT_SECONDS, trimSilence: true } as const;

/** True when this is an offered product-mock plan that is narrated (not the silent music-only form). */
export function isNarratedMockPlan(plan: ScenePlan): boolean {
  return (isMockPlan(plan) || isRecordingPlan(plan)) && plan.voiceover !== "none";
}

/** True when this plan uses the payoff layout and therefore needs the payoff render settings (voice rate, crossfade). */
export function isPayoffPlan(plan: ScenePlan): boolean {
  return plan.scenes.some((s) => s.layout === "payoff" || s.layout === "chart" || s.layout === "recording");
}
