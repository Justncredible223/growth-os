import { EXPLAINER_PILOTS, EXPLAINERS_OFFERED } from "./explainers.js";
import { STRATEGIES } from "./strategyVideos.js";
import type { Overlay, ScenarioId, StrategyChartSpec } from "./strategyCharts.js";
import { OFFICIAL_HANDLE, type SceneSpec, type ScenePlan } from "./types.js";

/**
 * "After the trade" (team decision 2026-11-14, Claude + ChatGPT, owner's yes to rework the pipeline): the daily videos stop
 * teaching trading strategies and show what happened to a prop-firm account after the trade instead.
 *
 * Why: on TikTok (organic, Oct 1 to Nov 14) the strategy videos drew about 340 views each against about 124 for the rule
 * videos, but strategy viewers are shopping for setups, not for a rule tracker, there was no evidence they brought sign-ups,
 * and a strategy channel drifts toward "what to trade". So views alone do not decide this.
 *
 * Two kinds of cut, both about 27-32 seconds, both built from the 20 explainers that already have ElevenLabs recordings:
 *
 *   Rule cut (after-NN-<slug>): six of the explainer's nine beats, each reusing its recorded part (no new voice spend):
 *   the demo account's hook, first figure and turn (beats 1-3), "What to check" (beat 7), the Fillbook screen (beat 8) and
 *   the closing question (beat 9). The close card's on-screen line is CLOSE_LINE.
 *
 *   Strategy-hook cut (after-hook-NN-<slug>): the same, but beat 1 is a drawn chart card (the strategy videos' own
 *   illustrations, carrying ILLUSTRATION_TAG, with the "Entry" markers removed) and ONE new sentence that asks about the
 *   account, never about the trade. It names no entry, level, target or direction, and it never says the drawn setup caused
 *   the demo account's figures: those stay the verified demo concept's own. Each hook needs one new recording
 *   (after-hook-NN-<slug>-1.mp3); a hook cut is offered only once `recorded` is true, which a test ties to the file on disk.
 *
 * An explainer gets one cut or the other, never both: the two would share five of six beats, which conceptVariety.ts treats
 * as a near-copy. For the same reason, a cut of an explainer that was already made is hidden while that video exists.
 */

export const AFTER_THE_TRADE_PREFIX = "after";
export const AFTER_THE_TRADE_HOOK_PREFIX = "after-hook";

/** The closing card's line (on screen only; the spoken close is the explainer's recorded question). */
export const CLOSE_LINE = "Review your trades and prop-firm rules with Fillbook.";

/** The explainer beats each cut keeps, by 1-based position: hook, first figure, turn, what to check, product screen, close. */
export const KEPT_BEATS = [1, 2, 3, 7, 8, 9] as const;

/** Words a strategy hook may never use: each would turn a question about the account into a trade instruction. */
export const HOOK_FORBIDDEN_WORDS = /\b(entry|entries|enter|buy|buying|sell|selling|long|short|target|targets|take profit|signal|setup to take|go long|go short)\b/i;

export interface StrategyHook {
  /** The explainer this hook opens (planId of an offered explainer). */
  explainer: string;
  /** Which strategy video's opening chart to draw (its slug in strategyVideos.ts). */
  chartFrom: string;
  /** Up to 7 words and 34 characters. */
  headline: string;
  /** Up to 110 characters. */
  caption: string;
  /** ONE spoken sentence: a question about the account, not the trade. */
  say: string;
  /** True once after-hook-NN-<slug>-1 is in assets/voice (owner-approved ElevenLabs recording). Until then the rule cut is offered. */
  recorded: boolean;
}

/**
 * Seven hooks, each a question a trader asks about the account before or after a common situation. All seven recorded
 * 2026-11-15 on the owner's yes: ElevenLabs, Jessica Anne Bogart, Eleven v4, stability 50%, similarity 89%, MP3 44.1 kHz
 * 192 kbps, one line per file, VWAP typed "vee-wap". Pace 2.5-3.3 words/s against 2.82 for the explainers' teaching lines.
 */
export const STRATEGY_HOOKS: readonly StrategyHook[] = [
  {
    explainer: "explain-06-drawdown-vs-loss-limit",
    chartFrom: "orb-range-trigger",
    headline: "2 limits, not 1. Which to watch?",
    caption: "A prop account can have two limits at once. Check which one is closer today.",
    say: "Your account has two limits, not one, so which one is closer to being hit today?",
    recorded: true,
  },
  {
    explainer: "explain-03-moving-stops",
    chartFrom: "orb-stop-placement",
    headline: "1 stop moved later. What changed?",
    caption: "Your journal records when a stop was moved. See what that changed.",
    say: "Your stop was set before the trade, but what did moving it later change?",
    recorded: true,
  },
  {
    explainer: "explain-12-losing-setup",
    chartFrom: "break-and-retest",
    headline: "1 setup name. Not 1 result.",
    caption: "A setup's name says nothing about what your own trades with it made.",
    say: "A setup has one name, but your own trades with it can still lose, so what do they add up to?",
    recorded: true,
  },
  {
    explainer: "explain-02-consistency-rule",
    chartFrom: "demand-zone",
    headline: "1 big profit day. Payout at risk?",
    caption: "Some firms cap how much profit one day can hold. Check yours.",
    say: "One big profit day can look great, but does it affect your payout eligibility under your firm's rule?",
    recorded: true,
  },
  {
    explainer: "explain-09-normal-trade-count",
    chartFrom: "vwap-chop",
    headline: "8 VWAP crosses. Not 8 trades.",
    caption: "On a choppy day it is easy to trade far past your normal pace.",
    say: "Price can cross VWAP 8 times on a choppy day, but how many trades did you take against your normal?",
    recorded: true,
  },
  {
    explainer: "explain-04-time-of-day",
    chartFrom: "orb-fake-breakout",
    headline: "First 15 minutes. What costs you?",
    caption: "Compare your own trades at the open with your trades later in the day.",
    say: "The first 15 minutes move fast, but which time of day actually costs you?",
    recorded: true,
  },
  {
    explainer: "explain-07-one-day-carries-month",
    chartFrom: "vwap-pullback",
    headline: "Only 1 day carrying your month?",
    caption: "One strong day can hide what the rest of the month made.",
    say: "One trend day can carry a whole month, but what did the rest of your days add up to?",
    recorded: true,
  },
];

const EXPLAINERS_BY_ID = new Map(EXPLAINER_PILOTS.map((p) => [p.planId, p] as const));
const STRATEGY_BY_SLUG = new Map(STRATEGIES.map((s) => [s.slug, s] as const));

function slugOf(explainerId: string): string {
  return explainerId.replace(/^explain-\d+-/, "");
}

function retag(scene: SceneSpec, variationId: string, sceneId: string): SceneSpec {
  return {
    ...scene,
    sceneId,
    variationId,
    claims: scene.claims.map((c) => ({ ...c, id: `${sceneId}-${c.id.split("-").pop()}` })),
  };
}

/**
 * Planned beat length. A short product-mock beat is planned at about 2 s, but each kept beat carries a recorded ElevenLabs
 * line: the six kept parts measured 20.9-25.4 s in total (about 3.5-4.2 s a beat, 2026-11-14), and the real lengths replace
 * these at render time (applyRealDurations). Planning at least this long keeps the planned total close to the real one.
 */
export const MIN_PLANNED_BEAT_SECONDS = 3.5;

/** A plan title's limit (validateScenePlan's title_too_long). */
const TITLE_MAX = 70;

function withClose(scene: SceneSpec): SceneSpec {
  return { ...scene, cta: `${CLOSE_LINE} ${OFFICIAL_HANDLE}` };
}

/** The hook's drawn chart: the strategy video's opening chart, without "Entry" markers (they read as an instruction). */
export function hookChart(hook: StrategyHook): StrategyChartSpec {
  const strategy = STRATEGY_BY_SLUG.get(hook.chartFrom);
  const chart = strategy?.beats[0].chart;
  if (!strategy || !chart) throw new Error(`Strategy hook for "${hook.explainer}": no opening chart in strategy "${hook.chartFrom}".`);
  const overlays: Overlay[] = chart.overlays.filter((o) => o.kind !== "marker");
  return { scenario: strategy.scenario as ScenarioId, show: chart.show, overlays };
}

function hookScene(hook: StrategyHook, template: SceneSpec, variationId: string, sceneId: string): SceneSpec {
  return {
    ...template,
    sceneId,
    variationId,
    narration: hook.say,
    takeaway: hook.headline,
    assetId: null,
    focalRegion: null,
    crop: null,
    aspectRatio: "source",
    layout: "payoff",
    payoff: { theme: "dark", motion: "pop", leadWithWords: true },
    teach: { step: "", chart: hookChart(hook) },
    headline: hook.headline,
    captionText: hook.caption,
    transition: { type: "cut", durationSeconds: 0 },
    disclosure: null,
    cta: null,
    claims: [{ id: `${sceneId}-c1`, type: "concept", text: "Asks the viewer a question about their own account over a drawn illustration; no trade instruction.", evidence: [] }],
    masks: [],
  };
}

function cutOf(explainer: ScenePlan, planId: string, variationId: string, hook: StrategyHook | null): ScenePlan {
  const sid = (i: number) => `${variationId}-s${i}`;
  const kept = KEPT_BEATS.map((n) => explainer.scenes[n - 1]!);
  const scenes = kept.map((source, i) => {
    const scene = { ...source, durationSeconds: Math.max(source.durationSeconds, MIN_PLANNED_BEAT_SECONDS) };
    const re = retag(scene, variationId, sid(i + 1));
    // The hook card is built on the explainer's first plain teaching card (beat 4), so it carries no product mock or recording.
    if (i === 0 && hook) return hookScene(hook, explainer.scenes[3]!, variationId, sid(1));
    if (i === 0) return { ...re, transition: { type: "cut" as const, durationSeconds: 0 } };
    return i === kept.length - 1 ? withClose(re) : re;
  });
  const voiceParts = KEPT_BEATS.map((n, i) => (i === 0 && hook ? `${planId}-1` : `${explainer.planId}-${n}`));
  // A title of its own: the app treats a concept as made when its title exists, so a cut never shares its explainer's title.
  // At most TITLE_MAX characters (validateScenePlan): when the explainer's title makes it too long, the opening line stands in.
  const prefix = hook ? "Before and after the trade" : "After the trade";
  const lowered = explainer.title.charAt(0).toLowerCase() + explainer.title.slice(1);
  const long = `${prefix}: ${lowered}`;
  const title = long.length <= TITLE_MAX ? long : `${prefix}: ${(hook ? hook.headline : explainer.hook).replace(/[.!?]+$/, "")}`;
  return {
    ...explainer,
    planId,
    variationId,
    title,
    hook: hook ? hook.headline : explainer.hook,
    scenes,
    voiceParts,
  };
}

/** Rule cuts keep their explainer's number (after-06 is explain-06); hook cuts are numbered in STRATEGY_HOOKS order. */
function numbered(prefix: string, n: number, explainerId: string): { planId: string; variationId: string } {
  const id = prefix === AFTER_THE_TRADE_PREFIX ? explainerId.match(/^explain-(\d+)-/)![1]! : String(n).padStart(2, "0");
  return { planId: `${prefix}-${id}-${slugOf(explainerId)}`, variationId: `${prefix}-${id}` };
}

const explainerFor = (id: string): ScenePlan => {
  const plan = EXPLAINERS_BY_ID.get(id);
  if (!plan) throw new Error(`After the trade: "${id}" is not an explainer.`);
  return plan;
};

/** The 20 rule cuts, one per offered explainer, in the explainers' day order. */
export const RULE_CUTS: ScenePlan[] = EXPLAINERS_OFFERED.map((id, i) => {
  const { planId, variationId } = numbered(AFTER_THE_TRADE_PREFIX, i + 1, id);
  return cutOf(explainerFor(id), planId, variationId, null);
});

/** The strategy-hook cuts, recorded or not (all resolvable; only recorded ones are offered). */
export const HOOK_CUTS: ScenePlan[] = STRATEGY_HOOKS.map((h, i) => {
  const { planId, variationId } = numbered(AFTER_THE_TRADE_HOOK_PREFIX, i + 1, h.explainer);
  return cutOf(explainerFor(h.explainer), planId, variationId, h);
});

export const AFTER_THE_TRADE_PILOTS: ScenePlan[] = [...RULE_CUTS, ...HOOK_CUTS];

const ruleCutFor = (explainerId: string): string => RULE_CUTS[EXPLAINERS_OFFERED.indexOf(explainerId)]!.planId;

/**
 * The offered order. Each explainer appears once: as its hook cut when that hook is recorded, otherwise as its rule cut.
 * Rule cuts keep the explainers' day order; recorded hook cuts take every third place (two rule cuts, then one hook cut)
 * while any are left, and remaining cuts follow in order. With no hook recorded this is simply the 20 rule cuts.
 */
export function afterTheTradeOrder(hooks: readonly StrategyHook[] = STRATEGY_HOOKS): string[] {
  const recorded = hooks.map((h, i) => ({ h, i })).filter(({ h }) => h.recorded);
  const hooked = new Set(recorded.map(({ h }) => h.explainer));
  const rules = EXPLAINERS_OFFERED.filter((id) => !hooked.has(id)).map(ruleCutFor);
  const hookIds = recorded.map(({ i }) => HOOK_CUTS[i]!.planId);
  const out: string[] = [];
  let r = 0;
  let k = 0;
  while (r < rules.length || k < hookIds.length) {
    if ((out.length + 1) % 3 === 0 && k < hookIds.length) out.push(hookIds[k++]!);
    else if (r < rules.length) out.push(rules[r++]!);
    else out.push(hookIds[k++]!);
  }
  return out;
}

export const AFTER_THE_TRADE_ORDER: readonly string[] = afterTheTradeOrder();

/** True for any "After the trade" cut. */
export function isAfterTheTradePlan(plan: ScenePlan): boolean {
  return plan.planId.startsWith(`${AFTER_THE_TRADE_PREFIX}-`);
}

/** True for a strategy-hook cut (its first beat is a drawn chart). */
export function isStrategyHookCut(plan: ScenePlan): boolean {
  return plan.planId.startsWith(`${AFTER_THE_TRADE_HOOK_PREFIX}-`);
}
