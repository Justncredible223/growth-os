import { listMotionConcepts } from "../../scripts/video-factory/motionCatalog.js";
import type { MotionConceptSummary } from "../../scripts/video-factory/motionCatalog.js";
import { manualMotionConceptTitle } from "../opportunities/manualMotionConcept.js";
import { MOTION_SCENE_PLANS, dailyPosition, isOfferedPlan } from "../shortform/motionPlans.js";
import { renderBar } from "../shortform/storyScore.js";
import { distinctConcepts } from "../shortform/conceptVariety.js";
import type { ScenePlan } from "../shortform/types.js";
import { ONE_PER_DAY_ZONE } from "./dailyLimit.js";

/**
 * The daily chart-card refill: keeps a few chart cards waiting in Approvals so there is always something fresh to
 * approve, without the owner requesting each one. It only REQUESTS (queues a draft); approving, and so rendering,
 * stays the owner's action in the app. It is bounded five ways: only on VIDEO_REQUEST_WEEKDAYS (two a week, owner 2026-10-24), one request per calendar day in total (owner rule,
 * 2026-10-03, shared with the app's Motion render button), never more than MAX_CHART_CARDS_WAITING waiting at once (so a few days of not approving never piles up drafts or review spend), only concepts that are offered and clear
 * the render bar, and each concept only once (a used-up concept is never requested again).
 */
export const MAX_CHART_CARDS_WAITING = 1;
/** When fewer than this many unused chart concepts remain, the step report says so, so the supply is topped up in time. */
export const LOW_SUPPLY_AT = 4;

/**
 * Owner decision 2026-10-24: two new videos a week, not one a day. The refill only requests a concept on these weekdays
 * (0 = Sunday ... 6 = Saturday), read in the one-a-day zone (America/Phoenix), so approving -- and so rendering -- happens at
 * most twice a week. Tuesday and Friday. The app's own Motion render button is not gated: a by-hand request stays the
 * owner's call (and is still held to one a day by dailyLimit.ts). To change the cadence, edit this list.
 */
export const VIDEO_REQUEST_WEEKDAYS: readonly number[] = [2, 5];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The weekday (0 = Sunday) of `now` in the given zone. */
export function weekdayInZone(now: Date, zone: string = ONE_PER_DAY_ZONE): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
  return WEEKDAY_NAMES.indexOf(name as (typeof WEEKDAY_NAMES)[number]);
}

/** True when the refill may request a concept on the zone's calendar day containing `now`. */
export function isVideoRequestDay(now: Date, days: readonly number[] = VIDEO_REQUEST_WEEKDAYS, zone: string = ONE_PER_DAY_ZONE): boolean {
  return days.includes(weekdayInZone(now, zone));
}

/**
 * Owner decision 2026-10-25: strategy-chart videos first. They earned the follower gain on TikTok (the opening-range and VWAP
 * videos, Oct 19-24) where the demo-data explainers did not, so unused strategy concepts are requested ahead of explainers,
 * with one explainer in every four requests so the product message keeps going out. The rule is stateless: it counts the
 * strategy and explainer concepts already made or waiting, minus how many there were when it started (3 strategy, 6 explainer),
 * so an explainer is due once the strategy videos since then reach three per explainer since then. Fixed day numbers and voice
 * sheets are untouched; only the order of requests changes. To go back to day order, return `unused` unchanged below.
 */
export const STRATEGY_FIRST_BASELINE = { strategy: 3, explainer: 6 } as const;
export const STRATEGY_PER_EXPLAINER = 3;

const isStrategyConcept = (id: string): boolean => id.startsWith("strategy-");

/** `unused` (already in day order) reordered for requesting: strategy first, an explainer when one is due or no strategy concept is left. */
export function requestOrder<T extends { id: string }>(unused: readonly T[], usedIds: readonly string[]): T[] {
  const strategyUsed = usedIds.filter(isStrategyConcept).length;
  const explainerUsed = usedIds.length - strategyUsed;
  const strategySince = Math.max(0, strategyUsed - STRATEGY_FIRST_BASELINE.strategy);
  const explainerSince = Math.max(0, explainerUsed - STRATEGY_FIRST_BASELINE.explainer);
  const explainerDue = strategySince >= STRATEGY_PER_EXPLAINER * (explainerSince + 1);
  const strategy = unused.filter((c) => isStrategyConcept(c.id));
  const others = unused.filter((c) => !isStrategyConcept(c.id));
  return explainerDue || strategy.length === 0 ? [...others, ...strategy] : [...strategy, ...others];
}

export type ConceptState = "made" | "waiting" | "rejected";

export interface DailyChartCardDeps {
  isPaused(): Promise<boolean>;
  /** Used-up and in-flight concepts, keyed by their opportunity title (see motionConceptStates in api/run-campaign.ts). */
  states(): Promise<Map<string, ConceptState>>;
  /** The title of the concept already requested today (by this refill or by hand), or null when today's one request is still free. */
  requestedToday(): Promise<string | null>;
  request(conceptId: string): Promise<{ campaignRunRequestId: string; opportunityId: string }>;
  /** The run's clock, for the weekday gate. Defaults to the real time. */
  now?: () => Date;
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
  const today = weekdayInZone((deps.now ?? (() => new Date()))());
  if (!VIDEO_REQUEST_WEEKDAYS.includes(today)) {
    const days = VIDEO_REQUEST_WEEKDAYS.map((d) => WEEKDAY_NAMES[d]).join(" and ");
    return `skipped -- two videos a week: requests go out on ${days} only (today is ${WEEKDAY_NAMES[today] ?? "unknown"})`;
  }
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

  const ordered = requestOrder(unused, used);
  if (unused.length === 0) return "no unused chart concepts left -- add more";
  const room = MAX_CHART_CARDS_WAITING - waiting;
  if (room <= 0) return `skipped -- ${waiting} chart cards already waiting (limit ${MAX_CHART_CARDS_WAITING})`;

  const requested: string[] = [];
  const failed: string[] = [];
  for (const concept of ordered.slice(0, Math.min(room, 1))) {
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
