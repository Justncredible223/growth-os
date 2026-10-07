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
import { FRESH_PILOTS, FRESH_CONCEPT_ORDER } from "./freshConcepts.js";

/**
 * Every verified ScenePlan a motion concept can be requested for: the original pilots plus the payoff redesign
 * variants. This is the single list both the catalog (scripts/video-factory/motionCatalog.ts, which the app's
 * "Create Fillbook Video" list and the render worker use) and the campaign pipeline (which drafts the script)
 * resolve a concept id against, so they can never disagree about what exists.
 */
export const MOTION_SCENE_PLANS: ScenePlan[] = [...PILOTS, ...PAYOFF_PILOTS, ...STORY_PILOTS, ...MORE_STORY_PILOTS, ...PILOT7_STORY_PILOTS, ...MOCK_CARD_PILOTS, ...BARS_PILOTS, ...OUTCOMES_PILOTS, ...DAILY_PILOTS, ...FRESH_PILOTS];

/**
 * True when this plan is a chart card (the "chart" layout). Since 2026-10-01 these are the only concepts the app offers
 * for a new video; every older concept stays resolvable so a script already drafted or approved still renders.
 */
export function isChartPlan(plan: ScenePlan): boolean {
  return plan.scenes.some((s) => s.layout === "chart");
}

/** True when this plan is a product mock (every scene a chart drawn as a Fillbook screen), whether or not it is still offered. */
export function isMockPlan(plan: ScenePlan): boolean {
  return plan.scenes.length > 0 && plan.scenes.every((s) => s.layout === "chart" && s.chart?.kind === "mock");
}

/**
 * The concepts the app offers, in request order (owner decision, 2026-10-07: the old pool is cleared and replaced). Only the
 * nine hook-first concepts of freshConcepts.ts, each of which opens on a pain or a striking number. The 30 daily concepts
 * (dailyConcepts.ts) and every other older concept stay in MOTION_SCENE_PLANS so a script already drafted or approved from
 * one still renders, but none is offered again.
 */
export const OFFERED_DAILY_CONCEPT_IDS: readonly string[] = FRESH_CONCEPT_ORDER;

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
  return isMockPlan(plan) && (OFFERED_DAILY_CONCEPT_IDS.includes(plan.planId) || EXTRA_OFFERED_CONCEPT_IDS.includes(plan.planId));
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
  return isMockPlan(plan) && plan.voiceover !== "none";
}

/** True when this plan uses the payoff layout and therefore needs the payoff render settings (voice rate, crossfade). */
export function isPayoffPlan(plan: ScenePlan): boolean {
  return plan.scenes.some((s) => s.layout === "payoff" || s.layout === "chart");
}
