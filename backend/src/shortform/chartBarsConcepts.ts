import { PILOT_EXPERIMENT_ID } from "./pilots.js";
import { OFFICIAL_HANDLE, type ChartRow, type Claim, type MockSpec, type SceneSpec, type ScenePlan } from "./types.js";

/**
 * Bar-chart concepts (see chart.ts, the "bars" kind): one labelled bar chart per concept, each drawn from a single
 * verified recording of a DIFFERENT part of the product. The first chart cards were all about payouts and the
 * win-rate paradox, so the daily queue kept serving one theme; these cover what else Fillbook reports on:
 *
 *   chart-bars-day-of-week     Reports, by day of the week
 *   chart-bars-time-of-day     Reports, by time of day
 *   chart-bars-habit-cost      Insights, tagged habits and what each cost
 *   chart-bars-conviction      Reports, "would you take it again?"
 *   chart-bars-plan-window     Plan vs reality, inside vs outside the planned session
 *   chart-bars-sized-up        Insights, flagged trades sized up after a loss
 *   chart-bars-edge-map        Edge Score and what it is made of
 *   chart-bars-win-drift       Progress, win rate baseline vs recent
 *   chart-bars-consistency     Account health, one day vs the firm's consistency cap
 *
 * Same rules as every chart card: every number on screen or in a caption is a number on the recording's facts (chart.ts
 * checks it), the scene says "Demo data", and nothing promises an outcome or says what to trade. A bar is a fact the
 * product shows, never advice.
 */
const VISUAL_STYLE = "chart-card-v1";
const VOICE_NONE = "none (on-screen text and music only)";
const VOICE_NARRATED = "en-US-AndrewNeural at +8%";
const CTA = `Try it free on your own account for 14 days. ${OFFICIAL_HANDLE}`;

interface BeatInput {
  stage: number;
  narration: string;
  takeaway: string;
  caption: string;
  seconds: number;
  /** Fact keys this beat's narration and caption draw on. */
  facts: string[];
  closing?: boolean;
  /** The recording this beat shows, when it differs from the concept's (a concept that compares two accounts). Its facts then replace the concept-wide set. */
  assetId?: string;
  /** The beat says what a Fillbook screen does, rather than quoting a figure from it. */
  capability?: boolean;
}

export interface BarsConfig {
  planId: string;
  title: string;
  topic: string;
  variationId: string;
  assetId: string;
  /** The topic of the facts the beats cite (must also be one of the recording's topics). */
  expectedTopic: string;
  lines: string[];
  accent: "good" | "bad";
  rows?: ChartRow[];
  highlight?: number;
  /** When set, the plan is drawn as an HTML product mock (chart kind "mock") instead of bars; lines may then be 1-3 short lines. */
  mock?: MockSpec;
  beats: BeatInput[];
}

/** A fact key, or "<assetId>/<factKey>" for a fact on another recording (a concept that compares two accounts). */
const evidenceRef = (defaultAssetId: string) => (ref: string) => {
  const slash = ref.indexOf("/");
  return slash < 0 ? { assetId: defaultAssetId, factKey: ref } : { assetId: ref.slice(0, slash), factKey: ref.slice(slash + 1) };
};

export function buildBarsPlan(cfg: BarsConfig): ScenePlan {
  const headline = cfg.lines.join(" ");
  const allFacts = [...new Set(cfg.beats.flatMap((b) => b.facts))];
  const scenes: SceneSpec[] = cfg.beats.map((b, i) => {
    const claim: Claim = {
      id: `${cfg.variationId}-c${i + 1}`,
      type: b.capability ? ("product_capability" as const) : ("data_point" as const),
      text: b.narration,
      // A mock draws every window on every beat, so each beat must stand behind all the figures on the slide.
      evidence: (cfg.mock && !b.assetId ? allFacts : b.facts).map(evidenceRef(b.assetId ?? cfg.assetId)),
    };
    return {
      sceneId: `${cfg.variationId}-s${i + 1}`,
      narration: b.narration,
      takeaway: b.takeaway,
      assetId: b.assetId ?? cfg.assetId,
      focalRegion: null,
      crop: null,
      aspectRatio: "source" as const,
      layout: "chart" as const,
      headline,
      captionText: b.caption,
      durationSeconds: b.seconds,
      transition: i === 0 ? { type: "cut" as const, durationSeconds: 0 } : { type: "fade" as const, durationSeconds: 0.15 },
      disclosure: "Demo data",
      cta: b.closing ? CTA : null,
      platform: "both" as const,
      experimentId: PILOT_EXPERIMENT_ID,
      variationId: cfg.variationId,
      expectedTopics: [cfg.expectedTopic],
      claims: b.closing ? [claim, { id: `${cfg.variationId}-invite`, type: "invitation" as const, text: "Invites the viewer to try it on their own account.", evidence: [] }] : [claim],
      masks: [],
      chart: cfg.mock
        ? { kind: "mock" as const, lines: [...cfg.lines], accent: cfg.accent, mock: cfg.mock, stage: b.stage, ...(b.closing ? { dim: true } : {}) }
        : { kind: "bars" as const, lines: [...cfg.lines], accent: cfg.accent, rows: cfg.rows!, highlight: cfg.highlight, stage: b.stage, ...(b.closing ? { dim: true } : {}) },
    };
  });
  return {
    planId: cfg.planId,
    title: cfg.title,
    series: "What Your Journal Shows",
    topic: cfg.topic,
    hook: headline,
    experimentId: PILOT_EXPERIMENT_ID,
    variationId: cfg.variationId,
    platforms: ["tiktok", "youtube_shorts"],
    voice: cfg.mock ? VOICE_NARRATED : VOICE_NONE,
    visualStyle: VISUAL_STYLE,
    requiredAssets: [],
    // A product mock is narrated (one number per sentence); the older drawn bar charts stay silent.
    voiceover: cfg.mock ? "narrated" : "none",
    scenes,
  };
}

export function barsDayOfWeekPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-day-of-week",
    title: "Tuesday made $157, Monday lost $57",
    topic: "A sample account's profit by day of the week, and the one weekday that lost money",
    variationId: "bars-dow",
    assetId: "rec.p8-day-of-week.v1",
    expectedTopic: "day_of_week",
    lines: ["Tuesday $157.", "Monday lost", "$57."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Daily P&L",
        columns: ["DAY", "TRADES", "P&L"],
        rows: [
          { when: "Tuesday", symbol: "5", value: "$157", tone: "good" },
          { when: "Monday", symbol: "5", value: "-$57", tone: "bad" },
        ],
      },
      details: {
        title: "Reports · by weekday",
        rows: [
          { label: "Wednesday · 4 trades", value: "$60.60", tone: "good" },
          { label: "Thursday · 4 trades", value: "$104.60", tone: "good" },
          { label: "Friday · 4 trades", value: "$122.08", tone: "good" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK REPORTS",
      result: {
        title: "Profit by weekday",
        tag: "Demo data",
        stats: [
          { label: "BEST DAY: TUESDAY", value: "$157" },
          { label: "ONLY RED DAY: MONDAY", value: "-$57" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["dow.all"], narration: "Fillbook Reports show profit by day of the week.", takeaway: "Reports split profit by weekday.", caption: "Reports: profit by weekday." },
      { stage: 2, seconds: 3.2, facts: ["dow.all"], narration: "Tuesday made $157.12. Friday made $122.08.", takeaway: "The two best days.", caption: "Tuesday: $157.12." },
      { stage: 3, seconds: 3.4, facts: ["dow.all", "dow.monday"], narration: "But Monday is the only red day: -$57.32.", takeaway: "Monday is the only losing day.", caption: "Only Monday is red." },
      { stage: 4, seconds: 4.6, facts: ["dow.all"], capability: true, narration: "Fillbook Reports list each weekday's profit, from your synced trades.", takeaway: "Reports show each weekday.", caption: "Every weekday, side by side." },
      { stage: 5, seconds: 3.2, facts: ["dow.all"], closing: true, narration: "Tuesday made $157. Monday lost $57. Fillbook shows yours by weekday.", takeaway: "Look at your own weekdays.", caption: "Check your own weekdays." },
    ],
  });
}

export function barsTimeOfDayPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-time-of-day",
    title: "71% win at the open, 24% later",
    topic: "A sample account's win rate in the opening hour against late morning",
    variationId: "bars-tod",
    assetId: "rec.b3-reports-timing-conviction.v1",
    expectedTopic: "time_of_day",
    lines: ["71% at open.", "Only 24%", "after 10:30."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Trade history",
        columns: ["TIME (ET)", "TRADES", "WIN RATE"],
        rows: [
          { when: "9:30-10:30am", symbol: "106", value: "71% win", tone: "good" },
          { when: "10:30am-12pm", symbol: "25", value: "24% win", tone: "bad" },
        ],
      },
      details: {
        title: "Reports · by time of day",
        rows: [
          { label: "Open · win rate", value: "71%", tone: "good" },
          { label: "Open · profit", value: "$2,967.96", tone: "good" },
          { label: "Late morning · profit", value: "-$1,406.00", tone: "bad" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK REPORTS",
      result: {
        title: "Win rate by time",
        tag: "Demo data",
        stats: [
          { label: "THE OPEN", value: "71%", note: "106 trades" },
          { label: "LATE MORNING", value: "24%", note: "25 trades" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["timing.buckets"], narration: "Fillbook Reports break win rate down by time of day.", takeaway: "Reports split win rate by time window.", caption: "Reports: win rate by time." },
      { stage: 2, seconds: 3.2, facts: ["timing.buckets"], narration: "The open wins 71% of its trades.", takeaway: "The opening hour.", caption: "Open: 71% win." },
      { stage: 3, seconds: 3.4, facts: ["timing.buckets"], narration: "But late morning wins only 24%.", takeaway: "Late morning is far weaker.", caption: "Late morning: 24% win." },
      { stage: 4, seconds: 4.6, facts: ["timing.buckets"], capability: true, narration: "Fillbook Reports show each time window's win rate, from your synced trades.", takeaway: "Reports show each time window.", caption: "Win rate + profit per window." },
      { stage: 5, seconds: 3.2, facts: ["timing.buckets"], closing: true, narration: "71% win at the open. Only 24% after 10:30. Fillbook shows your own hours.", takeaway: "Find your own strong hour.", caption: "Find your strong hour." },
    ],
  });
}

export function barsHabitCostPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-habit-cost",
    title: "Moved stops cost $656, discipline made $828",
    topic: "A sample account's tagged habits, and what the trades under each tag added up to",
    variationId: "bars-habit",
    assetId: "rec.b3-insights-behavior.v1",
    expectedTopic: "mistake_tags",
    lines: ["Moved stops", "cost $656."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Tagged trades",
        columns: ["TAG", "TRADES", "RESULT"],
        rows: [
          { when: "Moved stop", symbol: "4", value: "-$656", tone: "bad" },
          { when: "Discipline", symbol: "12", value: "$828", tone: "good" },
        ],
      },
      details: {
        title: "Insights · tagged habits",
        rows: [
          { label: "Chased price · 10 trades", value: "-$629.60", tone: "bad" },
          { label: "Revenge trade · 5 trades", value: "-$605.08", tone: "bad" },
          { label: "Oversized · 5 trades", value: "-$605.08", tone: "bad" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK INSIGHTS",
      result: {
        title: "Net result by tag",
        tag: "Demo data",
        stats: [
          { label: "MOVED STOP", value: "-$656", note: "4 trades" },
          { label: "GOOD DISCIPLINE", value: "$828", note: "12 trades" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["tags.all"], narration: "Tag each trade, and Fillbook Insights adds up every tag.", takeaway: "Insights total each tag.", caption: "Insights: net result by tag." },
      { stage: 2, seconds: 3.2, facts: ["tags.all"], narration: "4 trades tagged Moved stop lost $655.84.", takeaway: "What Moved stop cost.", caption: "Moved stop: -$655.84." },
      { stage: 3, seconds: 3.4, facts: ["tags.all"], narration: "But 12 trades tagged Good discipline made $828.48.", takeaway: "What discipline made.", caption: "Discipline: $828.48." },
      { stage: 4, seconds: 4.6, facts: ["tags.all"], capability: true, narration: "Fillbook Insights ranks each tagged habit by its net result.", takeaway: "Insights rank your tagged habits.", caption: "Habits ranked, worst first." },
      { stage: 5, seconds: 3.2, facts: ["tags.all"], closing: true, narration: "Moved stops cost $656. Discipline made $828. Fillbook adds up your own tags.", takeaway: "Tag your own trades and see.", caption: "Add up your own tags." },
    ],
  });
}

export function barsConvictionPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-conviction",
    title: "Trades you'd retake made $3,822, the rest lost $2,576",
    topic: "A sample account's results split by whether the trader would take the trade again",
    variationId: "bars-conv",
    assetId: "rec.b3-reports-timing-conviction.v1",
    expectedTopic: "conviction",
    lines: ["Yes: made", "$3,822. No:", "lost $2,576."],
    accent: "bad",
    mock: {
      eyebrow: "WOULD YOU TAKE IT AGAIN?",
      accentFrom: 1,
      source: {
        title: "Trade review",
        columns: ["ANSWER", "TRADES", "RESULT"],
        rows: [
          { when: "Yes, again", symbol: "75", value: "$3,822", tone: "good" },
          { when: "No, not again", symbol: "34", value: "-$2,576", tone: "bad" },
        ],
      },
      details: {
        title: "Reports · by conviction",
        rows: [
          { label: "Would take again", value: "84% win", tone: "good" },
          { label: "Wouldn't take again", value: "18% win", tone: "bad" },
          { label: "Unsure · 22 trades", value: "$315.92", tone: "good" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK REPORTS",
      result: {
        title: "Results by conviction",
        tag: "Demo data",
        stats: [
          { label: "WOULD TAKE AGAIN", value: "75", note: "made $3,822" },
          { label: "WOULDN'T TAKE AGAIN", value: "34", note: "lost $2,576" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["conviction.all"], narration: "In Fillbook, answer one question per trade: would you take it again?", takeaway: "Answer once per trade; Reports compare.", caption: "Reports: by conviction." },
      { stage: 2, seconds: 3.2, facts: ["conviction.all"], narration: "75 trades you would take again made $3,822.00.", takeaway: "The trades you'd retake.", caption: "Would retake: $3,822." },
      { stage: 3, seconds: 3.4, facts: ["conviction.all"], narration: "But 34 you wouldn't take again lost $2,575.96.", takeaway: "The trades you wouldn't.", caption: "Not again: -$2,575.96." },
      { stage: 4, seconds: 4.6, facts: ["conviction.all"], capability: true, narration: "Fillbook Reports split results by your own answers.", takeaway: "Reports compare your answers.", caption: "Win rate for each answer." },
      { stage: 5, seconds: 3.2, facts: ["conviction.all"], closing: true, narration: "Would take again: made $3,822. Would not: lost $2,576. Fillbook splits yours the same way.", takeaway: "Rate your own trades.", caption: "Rate your own trades." },
    ],
  });
}

export function barsPlanWindowPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-plan-window",
    title: "Inside the plan $21 a trade, outside it -$39",
    topic: "A sample account's average result per trade inside and outside its planned trading window",
    variationId: "bars-plan",
    assetId: "rec.b3-plan-vs-reality.v1",
    expectedTopic: "plan_adherence",
    lines: ["In plan: $21", "Outside it:", "lost $39."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Trade history",
        columns: ["WHERE", "TRADES", "AVG TRADE"],
        rows: [
          { when: "Inside plan", symbol: "\u2013", value: "$21", tone: "good" },
          { when: "Outside plan", symbol: "20", value: "-$39", tone: "bad" },
        ],
      },
      details: {
        title: "Plan vs reality",
        rows: [
          { label: "Overall adherence", value: "92%", tone: "good" },
          { label: "Trading window", value: "85%", tone: "bad" },
          { label: "Max trades per day", value: "90%", tone: "good" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK PLAN VS REALITY",
      result: {
        title: "Plan vs reality",
        tag: "Demo data",
        stats: [
          { label: "INSIDE 09:30-11:30", value: "$21", note: "average per trade" },
          { label: "OUTSIDE IT", value: "-$39", note: "average per trade" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["plan.focus"], narration: "Set your trading window in your Fillbook plan, then compare it with what happened.", takeaway: "Fillbook compares the plan with what happened.", caption: "Plan vs what happened." },
      { stage: 2, seconds: 3.2, facts: ["plan.focus"], narration: "Inside 09:30-11:30, trades average $21.13.", takeaway: "Results inside the window.", caption: "Inside the window: $21.13." },
      { stage: 3, seconds: 3.4, facts: ["plan.focus"], narration: "But 20 trades outside it average -$39.16 each.", takeaway: "Results outside the window.", caption: "Outside it: -$39.16." },
      { stage: 4, seconds: 4.6, facts: ["plan.adherence"], capability: true, narration: "Fillbook scores how closely your trades followed your own plan.", takeaway: "Fillbook scores plan adherence.", caption: "Adherence to your own plan." },
      { stage: 5, seconds: 3.2, facts: ["plan.focus"], closing: true, narration: "In the plan: $21. Outside it: lost $39. Fillbook compares yours the same way.", takeaway: "Check your own plan.", caption: "Check your own plan." },
    ],
  });
}

export function barsSizedUpPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-sized-up",
    title: "Lost $127, then sized up 2.5x",
    topic: "Five flagged trades a sample account opened soon after a loss, each larger than its average size",
    variationId: "bars-sized",
    assetId: "rec.b3-insights-behavior.v1",
    expectedTopic: "revenge_trading",
    lines: ["Lost $127.", "Then sized", "up 2.5x."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Trade history",
        columns: ["WHEN", "SYMBOL", "RESULT"],
        rows: [
          { when: "Loss", symbol: "MNQ", value: "-$127", tone: "bad" },
          { when: "3 min later", symbol: "MNQ", value: "2.5x size", tone: "bad" },
        ],
      },
      details: {
        title: "Insights · flagged trades",
        rows: [
          { label: "4 min after a $107 loss", value: "2.4x size", tone: "bad" },
          { label: "12 min after a $63 loss", value: "2.0x size", tone: "bad" },
          { label: "7 min after a $75 loss", value: "1.9x size", tone: "bad" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK INSIGHTS",
      result: {
        title: "Behavior patterns",
        tag: "Demo data",
        stats: [
          { label: "POSSIBLE REVENGE TRADES", value: "5" },
          { label: "SIZE VS YOUR AVERAGE", value: "2.5x", meter: { markAt: 0.4 } },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["behavior.revenge"], narration: "Fillbook Insights flagged 5 possible revenge trades.", takeaway: "Insights flag five trades for review.", caption: "5 possible revenge trades." },
      { stage: 2, seconds: 3.2, facts: ["behavior.revenge"], narration: "Each opened minutes after a loss, bigger than your average size.", takeaway: "Each came soon after a loss, at a larger size.", caption: "Flagged: bigger after a loss." },
      { stage: 3, seconds: 3.4, facts: ["behavior.revenge"], narration: "The largest was 2.5x your average size. It came 3 minutes after losing $127.", takeaway: "The largest flagged trade.", caption: "Flagged: 2.5x size." },
      { stage: 4, seconds: 4.6, facts: ["behavior.revenge"], capability: true, narration: "Fillbook Insights lists each flagged trade, for you to review.", takeaway: "Insights list each flagged trade.", caption: "Each flagged trade, listed." },
      { stage: 5, seconds: 3.2, facts: ["behavior.revenge"], closing: true, narration: "Lost $127. Then sized up 2.5x. Fillbook flags trades like these for your review.", takeaway: "Review your own flagged trades.", caption: "Review your flagged trades." },
    ],
  });
}

export function barsEdgeMapPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-edge-map",
    title: "An Edge Score of 67, and what it's made of",
    topic: "A sample account's Edge Score and the four parts it blends",
    variationId: "bars-edge",
    assetId: "rec.p6-edge-score.v1",
    expectedTopic: "edge_score",
    lines: ["Score: 67.", "Still", "developing."],
    accent: "good",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Score parts",
        columns: ["PART", "SCORE", "NOTE"],
        rows: [
          { when: "Rule adherence", symbol: "87", value: "strongest", tone: "good" },
          { when: "Profitability", symbol: "59", value: "lowest", tone: "bad" },
        ],
      },
      details: {
        title: "Edge Score · the parts",
        rows: [
          { label: "Consistency", value: "63", tone: "good" },
          { label: "Risk control", value: "69", tone: "good" },
          { label: "Rule adherence", value: "87", tone: "good" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK EDGE SCORE",
      result: {
        title: "Edge Score",
        tag: "Demo data",
        stats: [
          { label: "EDGE SCORE", value: "67", note: "Still developing" },
          { label: "PROFITABILITY", value: "59", note: "the lowest part" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["edge.score", "edge.map"], narration: "Fillbook gives one score for how you trade: Edge Score 67.", takeaway: "One score, built from several parts.", caption: "Edge Score: 67." },
      { stage: 2, seconds: 3.2, facts: ["edge.score", "edge.map"], narration: "Rule adherence is 87. Risk control is 69.", takeaway: "The strongest parts.", caption: "Rule adherence: 87." },
      { stage: 3, seconds: 3.4, facts: ["edge.score", "edge.map"], narration: "But profitability is only 59, the lowest part.", takeaway: "The weakest part.", caption: "Profitability: only 59." },
      { stage: 4, seconds: 4.6, facts: ["edge.score", "edge.map"], capability: true, narration: "Edge Score blends profitability, risk control and rule adherence.", takeaway: "Five parts make one score.", caption: "Five parts, one score." },
      { stage: 5, seconds: 3.2, facts: ["edge.score", "edge.map"], closing: true, narration: "Edge Score 67. Profitability 59. Fillbook shows what yours is made of.", takeaway: "See your own score.", caption: "See your own score." },
    ],
  });
}

export function barsWinDriftPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-win-drift",
    title: "Win rate 76%, then 55%",
    topic: "A sample account's win rate against its own baseline, and how far recent trades have drifted",
    variationId: "bars-drift",
    assetId: "rec.b3-progress.v1",
    expectedTopic: "progress",
    lines: ["Win rate 76%.", "Now only 55%."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Win rate",
        columns: ["PERIOD", "TRADES", "WIN RATE"],
        rows: [
          { when: "Baseline", symbol: "\u2013", value: "76%", tone: "good" },
          { when: "Recent", symbol: "\u2013", value: "55%", tone: "bad" },
        ],
      },
      details: {
        title: "Progress · vs baseline",
        rows: [
          { label: "Win rate", value: "76% to 55%", tone: "bad" },
          { label: "Revenge-trade rate", value: "0% to 6%", tone: "bad" },
          { label: "Overtrading days", value: "0% to 17%", tone: "bad" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK PROGRESS",
      result: {
        title: "Progress",
        tag: "Demo data",
        stats: [
          { label: "BASELINE", value: "76%", note: "your own baseline" },
          { label: "RECENT", value: "55%", note: "down 21%" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["progress.win_rate"], narration: "Fillbook's Progress page compares your win rate now with your own baseline.", takeaway: "Progress compares recent with baseline.", caption: "Progress: recent vs baseline." },
      { stage: 2, seconds: 3.2, facts: ["progress.win_rate"], narration: "The baseline is 76%.", takeaway: "The baseline.", caption: "Baseline: 76%." },
      { stage: 3, seconds: 3.4, facts: ["progress.win_rate"], narration: "But recent trades win 55%, down 21%.", takeaway: "Recent trades have slipped.", caption: "Recent: 55%, down 21%." },
      { stage: 4, seconds: 4.6, facts: ["progress.win_rate", "progress.behavior"], capability: true, narration: "Fillbook Progress compares your habits with your own baseline.", takeaway: "Progress tracks your habits.", caption: "Your habits vs your baseline." },
      { stage: 5, seconds: 3.2, facts: ["progress.win_rate"], closing: true, narration: "Win rate 76%. Lately only 55%. Fillbook tracks yours against your own baseline.", takeaway: "Check your own drift.", caption: "Check your own drift." },
    ],
  });
}

export function barsConsistencyPlan(): ScenePlan {
  return buildBarsPlan({
    planId: "chart-bars-consistency",
    title: "One day made 46% of the profit; the cap is 40%",
    topic: "A sample account where one day accounts for more of the total profit than the firm's consistency cap",
    variationId: "bars-cons",
    assetId: "rec.p4-account-health-consistency.v1",
    expectedTopic: "consistency",
    lines: ["One day made", "46%. The cap:", "only 40%."],
    accent: "bad",
    mock: {
      eyebrow: "SAMPLE ACCOUNT",
      accentFrom: 1,
      source: {
        title: "Daily P&L",
        columns: ["ITEM", "BASIS", "SHARE"],
        rows: [
          { when: "Firm cap", symbol: "profit", value: "40% of total", tone: "good" },
          { when: "Biggest day", symbol: "profit", value: "46% of total", tone: "bad" },
        ],
      },
      details: {
        title: "Account health",
        rows: [
          { label: "One day's share", value: "46%", tone: "bad" },
          { label: "Consistency cap", value: "40%", tone: "good" },
          { label: "Top action", value: "over the cap", tone: "bad" },
        ],
        footer: "From your synced trades.",
      },
      step: "FILLBOOK ACCOUNT HEALTH",
      result: {
        title: "Account health",
        tag: "Demo data",
        stats: [
          { label: "FIRM CAP", value: "40%", note: "of total profit" },
          { label: "BIGGEST DAY", value: "46%", note: "of total profit" },
        ],
      },
    },
    beats: [
      { stage: 1, seconds: 3.0, facts: ["health.consistency_action"], narration: "Fillbook's Account health shows one day made 46% of your total profit.", takeaway: "Account health shows one day's share of profit.", caption: "One day: 46% of profit." },
      { stage: 2, seconds: 3.2, facts: ["health.consistency_action"], narration: "A consistency cap limits any one day to 40% of your total profit.", takeaway: "What the cap limits.", caption: "The cap: 40% of profit." },
      { stage: 3, seconds: 3.4, facts: ["health.consistency_action"], narration: "But 46% is over the firm's cap.", takeaway: "That day is over the cap.", caption: "46% is over the cap." },
      { stage: 4, seconds: 4.6, facts: ["health.consistency_action"], capability: true, narration: "Fillbook Account health names your top action, such as a day over the cap.", takeaway: "Account health names one action.", caption: "Health score + top action." },
      { stage: 5, seconds: 3.2, facts: ["health.consistency_action"], closing: true, narration: "One day made 46%. The cap is 40%. Fillbook shows your own biggest day's share.", takeaway: "Check your biggest day.", caption: "Check your biggest day." },
    ],
  });
}

export const BARS_PILOTS: ScenePlan[] = [
  barsDayOfWeekPlan(),
  barsTimeOfDayPlan(),
  barsHabitCostPlan(),
  barsConvictionPlan(),
  barsPlanWindowPlan(),
  barsSizedUpPlan(),
  barsEdgeMapPlan(),
  barsWinDriftPlan(),
  barsConsistencyPlan(),
];
