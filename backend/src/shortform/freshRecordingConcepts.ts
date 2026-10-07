import { FRESH_PILOTS } from "./freshConcepts.js";
import { PILOT_EXPERIMENT_ID } from "./pilots.js";
import { RECORDING, computeRecordingLayout } from "./recordingLayout.js";
import { OFFICIAL_HANDLE, type Claim, type Rect, type SceneSpec, type ScenePlan } from "./types.js";

/**
 * Screen-recording alternatives of three fresh concepts (owner, 2026-10-07: "the look is the same as every previous video").
 * Every fresh concept (freshConcepts.ts) renders as the same dark drawn product-mock card. These three show the REAL demo-account
 * screen recording instead, cropped to the proof, under the hook in large type from the first frame, with the figure being spoken
 * about ringed. The hook, the five spoken lines, the takeaways and the per-beat captions are READ FROM the card version, so a
 * recording version can never say anything its card version does not.
 *
 *   fresh-02b  "Plan said 3. But the trade was 5."      rec.p3-trades-orb-size.v2          (trade card, then the trading plan page)
 *   fresh-04b  "One setup: 8 trades. Lost $422."        rec.p1-reports-setup-breakdown.v2  (By setup, then the Overview grid)
 *   fresh-06b  "5 possible revenge trades. ..."         rec.b3-insights-behavior.v1        (Behavior patterns)
 *
 * They were chosen because the figure each hook is about is plain, large text on the recording at phone size (a contract count, a
 * setup row, five flagged lines), where most of the other six concepts' proof is a small number inside a busy dashboard.
 *
 * Why a beat's headline is not always the hook: a scene may only show numbers its cited facts contain, and each fact is on screen
 * only in its own window of the recording (the "64% win" overview and the "By setup" table are 5 s apart in one clip). So the first
 * beat carries the hook and every later beat's headline is the card version's short caption for that beat.
 *
 * Time ranges: each recording holds still while a figure is on screen (the manifest's fact windows), so a scene may reuse any part
 * of a hold; ranges here are at least 4.2 s so a real narration of up to about 3.8 s still has footage plus its crossfade.
 */
const SIZE = "rec.p3-trades-orb-size.v2";
const SETUPS = "rec.p1-reports-setup-breakdown.v2";
const INSIGHTS = "rec.b3-insights-behavior.v1";
const CTA = `Try it free on your own account for 14 days. ${OFFICIAL_HANDLE}`;

interface RecBeat {
  /** Where the beat's headline breaks into lines (the first beat's are the hook's). Joined with spaces they are the scene headline. */
  headline: string[];
  /** Under the card: where in Fillbook this is. */
  caption: string;
  crop: Rect;
  /** Clean cut rows of the page the crop is taken from. */
  cuts: Cuts;
  clip: [number, number];
  highlights: Rect[];
  facts: string[];
}

interface RecConfig {
  /** The card version this is an alternative of. */
  cardId: string;
  suffix: string;
  slug: string;
  assetId: string;
  expectedTopic: string;
  also?: string[];
  beats: [RecBeat, RecBeat, RecBeat, RecBeat, RecBeat];
}

const union = (rects: Rect[]): Rect => {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Space kept clear above the safe bottom, in frame pixels. */
const FILL_MARGIN = 24;

/**
 * Source rows (in the recording's pixels) where the app's own content has a clean gap, so a crop that starts or ends there never
 * slices a card or a line of text in half. `tops` are candidate top edges, `bottoms` candidate bottom edges, for one page.
 */
interface Cuts {
  tops: number[];
  bottoms: number[];
}

/**
 * `base` is the smallest crop that contains the proof (every cited fact's region and every ring). A card that short leaves the lower
 * half of the frame empty, so the crop grows up and down, over the app's own content around the proof, to the tallest pair of clean
 * cuts that still lets the card, the caption and (on the closing beat) the invitation fit above the safe bottom. Width and the proof
 * stay exactly as given; with no cut that is taller than `base` and still fits, `base` is used as is.
 */
function fillCrop(base: Rect, cuts: Cuts, text: { headline: string; lines: string[]; captionText: string; cta: string | null; hook: boolean }): Rect {
  const layout = computeRecordingLayout(base, text, text.lines);
  const below = RECORDING.captionGap + layout.captionLines.length * RECORDING.captionPitch + (layout.ctaLines.length > 0 ? RECORDING.ctaGap + layout.ctaLines.length * RECORDING.ctaPitch : 0);
  const targetCardHeight = RECORDING.safeBottom - FILL_MARGIN - layout.card.y - below;
  const maxHeight = Math.floor(targetCardHeight / layout.card.scale);
  let best = base;
  for (const top of cuts.tops) {
    if (top > base.y) continue;
    for (const bottom of cuts.bottoms) {
      if (bottom < base.y + base.h) continue;
      const h = bottom - top;
      if (h <= maxHeight && h > best.h) best = { x: base.x, y: top, w: base.w, h };
    }
  }
  return best;
}

function buildRecordingPlan(cfg: RecConfig): ScenePlan {
  const card = FRESH_PILOTS.find((p) => p.planId.startsWith(cfg.cardId));
  if (!card) throw new Error(`freshRecordingConcepts: no card concept "${cfg.cardId}"`);
  const num = card.variationId.replace(/^fresh-/, "");
  const variationId = `fresh-${num}${cfg.suffix}`;
  const accent = card.scenes[0]!.chart?.accent ?? "bad";
  const scenes: SceneSpec[] = card.scenes.map((cardScene, i) => {
    const b = cfg.beats[i]!;
    const closing = i === card.scenes.length - 1;
    const headline = b.headline.join(" ");
    const cta = closing ? CTA : null;
    const crop = fillCrop(b.crop, b.cuts, { headline, lines: b.headline, captionText: b.caption, cta, hook: i === 0 });
    const claim: Claim = {
      id: `${variationId}-c${i + 1}`,
      type: i === 3 ? "product_capability" : "data_point",
      text: cardScene.narration,
      evidence: b.facts.map((factKey) => ({ assetId: cfg.assetId, factKey })),
    };
    return {
      sceneId: `${variationId}-s${i + 1}`,
      narration: cardScene.narration,
      takeaway: cardScene.takeaway,
      assetId: cfg.assetId,
      focalRegion: union(b.highlights),
      crop,
      aspectRatio: "source" as const,
      layout: "recording" as const,
      headline,
      captionText: b.caption,
      durationSeconds: cardScene.durationSeconds,
      transition: i === 0 ? { type: "cut" as const, durationSeconds: 0 } : { type: "fade" as const, durationSeconds: 0.15 },
      disclosure: "Demo data",
      cta,
      platform: "both" as const,
      experimentId: PILOT_EXPERIMENT_ID,
      variationId,
      expectedTopics: [cfg.expectedTopic, ...(cfg.also ?? [])],
      claims: closing ? [claim, { id: `${variationId}-invite`, type: "invitation" as const, text: "Invites the viewer to try it on their own account.", evidence: [] }] : [claim],
      masks: [],
      clipTimeRangeSeconds: { start: b.clip[0], end: b.clip[1] },
      recording: { highlights: b.highlights, accent, lines: b.headline, hook: i === 0 },
    };
  });
  return {
    planId: `${card.planId.replace(/^(fresh-\d+)/, `$1${cfg.suffix}`)}-recording`,
    // A different title from the card version: the app treats a concept as already requested when its title exists, so the two must not share one.
    title: `${card.title} (screen recording)`,
    series: card.series,
    topic: `${card.topic} (shown on the real screen recording)`,
    hook: card.hook,
    experimentId: PILOT_EXPERIMENT_ID,
    variationId,
    platforms: card.platforms,
    voice: card.voice,
    visualStyle: "recording-card-v1",
    requiredAssets: [],
    voiceover: "narrated",
    scenes,
  };
}

/* ---- fresh-02b: the trade card (5 contracts), then the plan's own limit (3) ---------------------------------------- */
/** The 2026-09-21 Opening Range Break trade card after the swipe settles (held 1.8-10.3 s), and the plan's "Max contracts per trade" field (held 12.1-20.6 s). */
const TRADE_CARD: Rect = { x: 40, y: 840, w: 1000, h: 363 };
const PLAN_FIELD: Rect = { x: 60, y: 920, w: 960, h: 185 };
/** Gaps between the trade cards, and between the plan page's fields. */
const TRADES_CUTS: Cuts = { tops: [480, 840], bottoms: [1203, 1553] };
const PLAN_CUTS: Cuts = { tops: [735, 920], bottoms: [1105, 1285, 1470, 1655] };
const QTY_5: Rect = { x: 394, y: 930, w: 26, h: 34 };
const SETUP_NAME: Rect = { x: 170, y: 1002, w: 302, h: 44 };
const RESULT: Rect = { x: 858, y: 886, w: 152, h: 42 };
const PLAN_LABEL: Rect = { x: 145, y: 940, w: 338, h: 42 };
const PLAN_VALUE: Rect = { x: 112, y: 1010, w: 40, h: 56 };

/* ---- fresh-04b: By setup (Opening Range Break row), then the Overview's win rate ----------------------------------- */
/** The By setup card (held 5.73-17.73 s) and the Overview grid (held 0.03-4.53 s). */
const SETUP_CARD: Rect = { x: 40, y: 830, w: 1000, h: 470 };
const OVERVIEW: Rect = { x: 40, y: 625, w: 1000, h: 795 };
const SETUP_CUTS: Cuts = { tops: [425, 830], bottoms: [1300, 1600] };
const OVERVIEW_CUTS: Cuts = { tops: [365, 520, 625], bottoms: [1420, 1600] };
const ORB_ROW: Rect = { x: 60, y: 1196, w: 960, h: 62 };
const ORB_WIN: Rect = { x: 726, y: 1206, w: 115, h: 44 };
const SETUP_SUBTITLE: Rect = { x: 80, y: 940, w: 620, h: 42 };
const WIN_RATE_CARD: Rect = { x: 556, y: 640, w: 484, h: 218 };

/* ---- fresh-06b: Insights, Behavior patterns --------------------------------------------------------------------------- */
/** The Behavior patterns card top to the fifth flagged line (held 1.7-17.7 s). */
const BEHAVIOR: Rect = { x: 38, y: 200, w: 1004, h: 788 };
const BEHAVIOR_CUTS: Cuts = { tops: [200], bottoms: [988, 1105, 1222, 1340, 1455] };
const LINE_CENTERS = [446, 564, 681, 799, 916];
const FIVE_FLAGS: Rect = { x: 70, y: 418, w: 930, h: 565 };
const OPENED = LINE_CENTERS.map((y): Rect => ({ x: 548, y: y - 17, w: 412, h: 34 }));
const SIZED = LINE_CENTERS.map((y): Rect => ({ x: 120, y: y + 32, w: 336, h: 34 }));
const LABELS = LINE_CENTERS.map((y): Rect => ({ x: 122, y: y - 17, w: 322, h: 34 }));

const CONFIGS: RecConfig[] = [
  {
    cardId: "fresh-02", suffix: "b", slug: "plan-said-3", assetId: SIZE, expectedTopic: "trade_size",
    beats: [
      { headline: ["Plan said 3.", "But the trade", "was 5."], caption: "Fillbook · Trade log", crop: TRADE_CARD, cuts: TRADES_CUTS, clip: [2.0, 6.4], highlights: [QTY_5], facts: ["trade.orb_qty5_most_recent"] },
      { headline: ["This trade: 5 contracts."], caption: "Fillbook · Trade log", crop: TRADE_CARD, cuts: TRADES_CUTS, clip: [4.0, 8.4], highlights: [QTY_5, SETUP_NAME], facts: ["trade.orb_qty5_most_recent"] },
      { headline: ["The plan's limit: 3."], caption: "Fillbook · Trading plan", crop: PLAN_FIELD, cuts: PLAN_CUTS, clip: [12.4, 16.8], highlights: [PLAN_LABEL, PLAN_VALUE], facts: ["plan.max_contracts"] },
      { headline: ["The log shows the result."], caption: "Fillbook · Trade log", crop: TRADE_CARD, cuts: TRADES_CUTS, clip: [6.0, 10.2], highlights: [RESULT], facts: ["trade.orb_qty5_most_recent"] },
      { headline: ["Does size match your plan?"], caption: "Fillbook · Trading plan", crop: PLAN_FIELD, cuts: PLAN_CUTS, clip: [16.2, 20.5], highlights: [PLAN_LABEL, PLAN_VALUE], facts: ["plan.max_contracts"] },
    ],
  },
  {
    cardId: "fresh-04", suffix: "b", slug: "setup-lost-422", assetId: SETUPS, expectedTopic: "setup_breakdown", also: ["month_total"],
    beats: [
      { headline: ["One setup: 8 trades.", "Lost $422."], caption: "Fillbook · Reports", crop: SETUP_CARD, cuts: SETUP_CUTS, clip: [6.4, 10.8], highlights: [ORB_ROW], facts: ["setup.opening_range_break_result"] },
      { headline: ["Opening Range: 25% win."], caption: "Fillbook · Reports", crop: SETUP_CARD, cuts: SETUP_CUTS, clip: [8.0, 12.4], highlights: [ORB_WIN], facts: ["setup.opening_range_break_result"] },
      { headline: ["All trades: 64% win."], caption: "Fillbook · Reports", crop: OVERVIEW, cuts: OVERVIEW_CUTS, clip: [0.2, 4.4], highlights: [WIN_RATE_CARD], facts: ["month.net_pnl"] },
      { headline: ["Reports rank setups."], caption: "Fillbook · Reports", crop: SETUP_CARD, cuts: SETUP_CUTS, clip: [11.0, 15.4], highlights: [SETUP_SUBTITLE], facts: ["setup.opening_range_break_result"] },
      { headline: ["Which setup costs you most?"], caption: "Fillbook · Reports", crop: SETUP_CARD, cuts: SETUP_CUTS, clip: [13.0, 17.4], highlights: [ORB_ROW], facts: ["setup.opening_range_break_result"] },
    ],
  },
  {
    cardId: "fresh-06", suffix: "b", slug: "five-revenge", assetId: INSIGHTS, expectedTopic: "revenge_trading",
    beats: [
      { headline: ["5 possible revenge trades.", "Each followed a loss."], caption: "Fillbook · Insights", crop: BEHAVIOR, cuts: BEHAVIOR_CUTS, clip: [2.0, 6.4], highlights: [FIVE_FLAGS], facts: ["behavior.revenge"] },
      { headline: ["Opened minutes after a loss."], caption: "Fillbook · Insights", crop: BEHAVIOR, cuts: BEHAVIOR_CUTS, clip: [5.0, 9.4], highlights: OPENED, facts: ["behavior.revenge"] },
      { headline: ["Sized 1.5x to 2.5x."], caption: "Fillbook · Insights", crop: BEHAVIOR, cuts: BEHAVIOR_CUTS, clip: [8.0, 12.4], highlights: SIZED, facts: ["behavior.revenge"] },
      { headline: ["Insights flag them."], caption: "Fillbook · Insights", crop: BEHAVIOR, cuts: BEHAVIOR_CUTS, clip: [11.0, 15.4], highlights: LABELS, facts: ["behavior.revenge"] },
      { headline: ["Trade right after a loss?"], caption: "Fillbook · Insights", crop: BEHAVIOR, cuts: BEHAVIOR_CUTS, clip: [13.0, 17.4], highlights: [FIVE_FLAGS], facts: ["behavior.revenge"] },
    ],
  },
];

/**
 * The recording alternatives, in the order of the card concepts they stand in for. Each is a near-copy of its card version by
 * construction (same spoken lines), so the variety check (conceptVariety.ts) keeps ONE of the two on offer at a time.
 */
export const RECORDING_PILOTS: ScenePlan[] = CONFIGS.map(buildRecordingPlan);
export const RECORDING_CONCEPT_ORDER: string[] = RECORDING_PILOTS.map((p) => p.planId);

/** The id of the card concept a recording alternative stands in for (by its number), or undefined when `planId` is not one. */
export function cardVersionOf(planId: string): string | undefined {
  const m = /^fresh-(\d+)b-/.exec(planId);
  return m ? FRESH_PILOTS.find((p) => p.planId.startsWith(`fresh-${m[1]}-`))?.planId : undefined;
}
