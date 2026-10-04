import { listMotionConcepts } from "../../scripts/video-factory/motionCatalog.js";
import type { MotionConceptSummary } from "../../scripts/video-factory/motionCatalog.js";
import { manualMotionConceptTitle } from "../opportunities/manualMotionConcept.js";
import { MOTION_SCENE_PLANS, dailyPosition, isOfferedPlan } from "../shortform/motionPlans.js";
import { renderBar } from "../shortform/storyScore.js";
import { distinctConcepts } from "../shortform/conceptVariety.js";
import type { ScenePlan } from "../shortform/types.js";

/**
 * The daily chart-card refill: keeps a few chart cards waiting in Approvals so there is always something fresh to
 * approve, without the owner requesting each one. It only REQUESTS (queues a draft); approving, and so rendering,
 * stays the owner's action in the app. It is bounded four ways: one request per calendar day in total (owner rule,
 * 2026-10-03, shared with the app's Motion render button), never more than MAX_CHART_CARDS_WAITING waiting at once (so a few days of not approving never piles up drafts or review spend), only concepts that are offered and clear
 * the render bar, and each concept only once (a used-up concept is never requested again).
 */
export const MAX_CHART_CARDS_WAITING = 1;
/** When fewer than this many unused chart concepts remain, the step report says so, so the supply is topped up in time. */
export const LOW_SUPPLY_AT = 4;

export type ConceptState = "made" | "waiting" | "rejected";

export interface DailyChartCardDeps {
  isPaused(): Promise<boolean>;
  /** Used-up and in-flight concepts, keyed by their opportunity title (see motionConceptStates in api/run-campaign.ts). */
  states(): Promise<Map<string, ConceptState>>;
  /** The title of the concept already requested today (by this refill or by hand), or null when today's one request is still free. */
  requestedToday(): Promise<string | null>;
  request(conceptId: string): Promise<{ campaignRunRequestId: string; opportunityId: string }>;
}

/**
 * The concepts the app offers, in the order they are requested: the 30 daily concepts, day 1 first (dailyConcepts.ts).
 * The order is fixed, not rotated, so the voice-script sheet the owner records from lists them in exactly the order
 * they will be drafted.
 */
export function offeredChartConcepts(): MotionConceptSummary[] {
  const byId = new Map(MOTION_SCENE_PLANS.map((p) => [p.planId, p] as const));
  return listMotionConcepts()
    .filter((c) => {
      const plan = byId.get(c.id);
      return plan !== undefined && isOfferedPlan(plan) && renderBar(plan).ok;
    })
    .sort((a, b) => dailyPosition(a.id) - dailyPosition(b.id));
}

export async function runDailyChartCardRequests(deps: DailyChartCardDeps): Promise<string> {
  if (await deps.isPaused()) return "skipped -- the system is paused";
  const alreadyToday = await deps.requestedToday();
  if (alreadyToday) return `skipped -- one video a day: "${alreadyToday}" was already requested today`;
  const states = await deps.states();
  const concepts = offeredChartConcepts();
  const stateOf = (c: MotionConceptSummary) => states.get(manualMotionConceptTitle(c));
  const waiting = concepts.filter((c) => stateOf(c) === "waiting").length;
  // Never request a concept that is a near-copy of one already made or waiting, or of another one in this batch: the
  // owner would be approving the same video twice. (A rejected concept does not count as made.)
  const planOf = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id);
  const used = concepts.filter((c) => stateOf(c) === "made" || stateOf(c) === "waiting").map((c) => c.id);
  const unused = distinctConcepts(concepts.filter((c) => stateOf(c) === undefined), used, planOf);

  if (unused.length === 0) return "no unused chart concepts left -- add more";
  const room = MAX_CHART_CARDS_WAITING - waiting;
  if (room <= 0) return `skipped -- ${waiting} chart cards already waiting (limit ${MAX_CHART_CARDS_WAITING})`;

  const requested: string[] = [];
  const failed: string[] = [];
  for (const concept of unused.slice(0, Math.min(room, 1))) {
    try {
      await deps.request(concept.id);
      requested.push(concept.id);
    } catch (err) {
      failed.push(`${concept.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (requested.length === 0 && failed.length > 0) throw new Error(`could not request any chart card -- ${failed.join("; ")}`);

  const left = unused.length - requested.length;
  const parts = [`requested ${requested.length} (${requested.join(", ")})`, `${waiting + requested.length} waiting`, `${left} unused left`];
  if (failed.length > 0) parts.push(`failed: ${failed.join("; ")}`);
  if (left < LOW_SUPPLY_AT) parts.push(`LOW SUPPLY: only ${left} unused chart concepts left -- add more`);
  return parts.join("; ");
}
