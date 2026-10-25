import { PILOT_EXPERIMENT_ID } from "./pilots.js";
import { EXPLAINER_SERIES, TEACH_SECONDS } from "./explainers.js";
import type { Overlay, ScenarioId, StrategyChartSpec } from "./strategyCharts.js";
import { OFFICIAL_HANDLE, type SceneSpec, type ScenePlan } from "./types.js";

/**
 * Strategy videos (owner decision, 2026-10-17): ten videos that explain how four common day-trading setups are usually
 * defined, mixed into the daily order every third day. Opening range breakout, VWAP pullback, break and retest, and supply
 * and demand zones.
 *
 * Framing (the owner kept the "never say what to trade" rule and chose this wording): each video describes how traders who use
 * a setup commonly define it, what a trigger looks like, where a stop and a target are commonly placed, and the trap. Then it
 * says how to test the setup in your own journal. Every chart is a drawn illustration (strategyCharts.ts) with ILLUSTRATION_TAG
 * on screen: no market, ticker, date or price. Nothing promises a result or tells the viewer to take a trade.
 *
 * Every spoken line is one sentence, so one ElevenLabs recording per video can be cut at the pauses between lines.
 */

const VARIATION_PREFIX = "strategy";
/**
 * The closing card (on screen only: the narration is already recorded, so this costs no voice credits). 2026-10-24: the strategy
 * videos earned the most followers but never said what Fillbook is. This names one verified view (Reports split results by
 * setup, weekday and time of day, from the trader's imported or synced trades) before the free-trial line. 2026-10-25: the view
 * line is now specific to each video's setup (`view` on each input) instead of one line for all ten. Kept to three lines on
 * the card: at four the last line sat on the box border.
 */
const closingCta = (view: string): string => `${view} Free for 14 days. ${OFFICIAL_HANDLE}`;

export interface StrategyBeat {
  /** The label above the headline ("The setup"); empty on the opening card. */
  step: string;
  /** Up to 7 words and 34 characters. */
  headline: string;
  /** Up to 110 characters. */
  caption: string;
  /** One spoken sentence. */
  say: string;
  take: string;
  /** The chart on this card: how many candles and which overlays. Omitted on a text card. */
  chart?: { show: number; overlays: Overlay[] };
}

export interface StrategyInput {
  slug: string;
  /** One sentence naming what Fillbook shows for THIS setup (2026-10-25); each is a verified view: By setup, By time of day. Up to about 55 characters so the card stays at three lines. */
  view: string;
  title: string;
  topic: string;
  scenario: ScenarioId;
  /** Opening card, then setup, trigger, stop, target, trap (charts), then confirmation and the journal test (text). */
  beats: [StrategyBeat, StrategyBeat, StrategyBeat, StrategyBeat, StrategyBeat, StrategyBeat, StrategyBeat, StrategyBeat];
  /** The closing question (headline and spoken line). */
  close: { headline: string; say: string };
}

function scene(variationId: string, i: number, b: StrategyBeat, scenario: ScenarioId, cta: string | null): SceneSpec {
  const sceneId = `${variationId}-s${i}`;
  const chart: StrategyChartSpec | undefined = b.chart ? { scenario, show: b.chart.show, overlays: b.chart.overlays } : undefined;
  return {
    sceneId,
    narration: b.say,
    takeaway: b.take,
    assetId: null,
    focalRegion: null,
    crop: null,
    aspectRatio: "source",
    layout: "payoff",
    payoff: { theme: "dark", motion: "pop", leadWithWords: true },
    teach: { step: b.step, ...(chart ? { chart } : {}) },
    headline: b.headline,
    captionText: b.caption,
    durationSeconds: TEACH_SECONDS,
    transition: i === 1 ? { type: "cut", durationSeconds: 0 } : { type: "fade", durationSeconds: 0.15 },
    disclosure: null,
    cta,
    platform: "both",
    experimentId: PILOT_EXPERIMENT_ID,
    variationId,
    expectedTopics: ["strategy"],
    claims: cta
      ? [{ id: `${sceneId}-invite`, type: "invitation", text: "Invites the viewer to test the setup on their own account.", evidence: [] }]
      : [{ id: `${sceneId}-c1`, type: "concept", text: `Explains, with a drawn illustration, how a common setup is defined: ${b.take}`, evidence: [] }],
    masks: [],
  };
}

export function buildStrategyVideo(n: number, input: StrategyInput): ScenePlan {
  const id = String(n).padStart(2, "0");
  const variationId = `${VARIATION_PREFIX}-${id}`;
  const beats = input.beats.map((b, i) => scene(variationId, i + 1, b, input.scenario, null));
  const close = scene(variationId, 9, { step: "Your turn", headline: input.close.headline, caption: "Test it on your own trades.", say: input.close.say, take: "Test the setup on your own trades." }, input.scenario, closingCta(input.view));
  return {
    planId: `${VARIATION_PREFIX}-${id}-${input.slug}`,
    title: input.title,
    series: EXPLAINER_SERIES,
    topic: input.topic,
    hook: input.beats[0].headline,
    experimentId: PILOT_EXPERIMENT_ID,
    variationId,
    platforms: ["tiktok", "youtube_shorts"],
    voice: "ElevenLabs supplied recording; fallback en-US-AndrewNeural at +8%",
    visualStyle: "chart-card-v1",
    requiredAssets: [],
    voiceover: "narrated",
    scenes: [...beats, close],
  };
}

/** True for a strategy video (its scenes are all drawn cards, no recording). */
export function isStrategyPlan(plan: ScenePlan): boolean {
  return plan.planId.startsWith(`${VARIATION_PREFIX}-`);
}

// Overlay helpers. Prices are on each scenario's own unlabelled scale (strategyCharts.ts).
const band = (from: number, to: number, top: number, bottom: number, label: string, tone: "accent" | "good" | "bad" | "mute"): Overlay => ({ kind: "band", from, to, top, bottom, label, tone });
const line = (price: number, from: number, label: string, tone: "accent" | "good" | "bad" | "mute", dashed = true): Overlay => ({ kind: "line", price, from, label, tone, dashed });
const entry = (index: number, price: number, label = "Entry"): Overlay => ({ kind: "marker", index, price, label, tone: "accent" });
const VWAP: Overlay = { kind: "vwap", label: "VWAP" };

// Opening range breakout (orbBreak / orbFake): range high 56, low 47, middle 51.5, the break closes at candle 7.
const RANGE = band(0, -1, 56, 47, "Opening range", "accent");
// Break and retest (breakRetest / breakFail): the level is 55.5; the break closes at candle 10; the retest holds at candle 13.
const LEVEL = line(55.5, 0, "Level", "mute", false);
// Supply and demand (demandSupply): demand zone 40.5-43.8 under the base, supply zone 60-63 at the top of the rally.
const DEMAND = band(0, -1, 43.8, 40.5, "Demand zone", "good");
const SUPPLY = band(9, -1, 63, 60, "Supply zone", "bad");

export const STRATEGIES: readonly StrategyInput[] = [
  {
    slug: "orb-range-trigger",
    view: "Fillbook shows your ORB win rate and net P&L.",
    title: "Opening range breakout explained: the range and the trigger",
    topic: "How the opening range breakout is commonly defined: the first 15 minutes' high and low, and a close outside them",
    scenario: "orbBreak",
    beats: [
      { step: "", headline: "15 minutes set the line. Then?", caption: "How the opening range breakout is usually defined, drawn step by step.", say: "The first 15 minutes set a line on the chart, so what happens when price leaves it?", take: "The open sets a range.", chart: { show: 14, overlays: [RANGE, entry(7, 59)] } },
      { step: "The setup", headline: "Mark the opening range", caption: "The high and the low of the first 15 minutes, marked before any trade.", say: "The opening range is the high and the low of the first 15 minutes of the session.", take: "The range is the first 15 minutes' high and low.", chart: { show: 3, overlays: [RANGE] } },
      { step: "The trigger", headline: "A close outside, not a wick", caption: "A full candle closing above or below the range, not just a poke through it.", say: "A common trigger is a candle that closes outside the range, not just a wick that pokes through it.", take: "The trigger is a close outside the range.", chart: { show: 8, overlays: [RANGE, entry(7, 59)] } },
      { step: "The stop", headline: "Past the middle, or the far side", caption: "A tighter stop sits at the middle of the range, a wider one past the other side.", say: "One common stop goes at the middle of the range, and a wider one goes past the other side.", take: "Stops go at the middle or the far side.", chart: { show: 8, overlays: [RANGE, entry(7, 59), line(51.5, 7, "Stop", "bad")] } },
      { step: "The target", headline: "Measured in risk", caption: "A common target is one times the distance from entry to stop, then two.", say: "A common target is one or two times the risk, measured from the entry to the stop.", take: "Targets are measured in risk.", chart: { show: 14, overlays: [RANGE, entry(7, 59), line(51.5, 7, "Stop", "bad"), line(66.5, 7, "Target 1R", "good")] } },
      { step: "The trap", headline: "Chasing the third candle", caption: "Entering late, far from the range, makes the same stop a much bigger risk.", say: "The trap is chasing a late entry far from the range, which turns the same stop into a much bigger risk.", take: "Late entries carry bigger risk.", chart: { show: 12, overlays: [RANGE, entry(11, 63.2, "Late entry"), line(51.5, 7, "Stop", "bad")] } },
      { step: "What confirms it", headline: "Volume and a clean close", caption: "Some traders also want volume above average on the breakout candle.", say: "Some traders also want volume above average on the breakout candle before they count it.", take: "Volume can confirm a break." },
      { step: "Test it yourself", headline: "Twenty tagged trades", caption: "Tag every opening range trade. After twenty, your numbers show if it works.", say: "Tag every opening range trade, and after twenty of them your own numbers show whether it works for you.", take: "Your journal tests the setup." },
    ],
    close: { headline: "Do you trade the first 15 minutes?", say: "Do you trade the first 15 minutes of the session?" },
  },
  {
    slug: "orb-fake-breakout",
    view: "Fillbook shows what your breakouts net after fakes.",
    title: "Opening range breakout: spotting the fake breakout",
    topic: "An opening range breakout that closes back inside the range, and how traders who use the setup handle it",
    scenario: "orbFake",
    beats: [
      { step: "", headline: "It broke out. 1 candle later, not.", caption: "The fake breakout, drawn on an opening range.", say: "Price broke out of the opening range, and 1 candle later it was back inside.", take: "Breakouts can fail.", chart: { show: 14, overlays: [RANGE] } },
      { step: "The setup", headline: "The same opening range", caption: "The first 15 minutes' high and low, marked before the break.", say: "The setup starts the same way, with the high and the low of the first 15 minutes.", take: "Same range, same start.", chart: { show: 7, overlays: [RANGE] } },
      { step: "The trigger", headline: "A close above the range", caption: "The candle closes above the high: the usual trigger for a long.", say: "A candle closes above the range high, which is the usual trigger.", take: "The trigger fires.", chart: { show: 8, overlays: [RANGE, entry(7, 57.3)] } },
      { step: "The turn", headline: "Back inside one candle later", caption: "The next candle closes back inside the range. The break did not hold.", say: "The very next candle closes back inside the range, so the break did not hold.", take: "A close back inside is the warning.", chart: { show: 9, overlays: [RANGE, entry(7, 57.3)] } },
      { step: "The stop", headline: "Why the stop is set first", caption: "A stop decided before the entry ends the trade here, before the range low.", say: "A stop decided before the entry ends this trade early, before price reaches the other side.", take: "A planned stop limits a failed break.", chart: { show: 14, overlays: [RANGE, entry(7, 57.3), line(51.5, 7, "Stop", "bad")] } },
      { step: "The trap", headline: "Hoping it breaks again", caption: "Holding past the stop on hope turns a small loss into a big one.", say: "The trap is holding past the stop because it might break out again, which turns a small loss into a big one.", take: "Hope is not a plan.", chart: { show: 14, overlays: [RANGE, entry(7, 57.3), line(51.5, 7, "Stop", "bad")] } },
      { step: "What confirms it", headline: "Two closes, or a retest", caption: "Some wait for a second close outside, or a retest, before entering.", say: "Some traders wait for a second close outside the range, or a retest of its edge, before they enter.", take: "Waiting filters some fakes." },
      { step: "Test it yourself", headline: "Tag the failed breaks", caption: "Tag the breakouts that failed. Your own count shows how often it happens to you.", say: "Tag the breakouts that failed, and your own count shows how often it happens to you.", take: "Count your failed breaks." },
    ],
    close: { headline: "1 candle later, does yours hold?", say: "1 candle later, does your breakout still hold?" },
  },
  {
    slug: "orb-stop-placement",
    view: "Fillbook shows if your ORB stops hold, by setup.",
    title: "Opening range breakout: where the stop goes",
    topic: "Two common stop placements for an opening range breakout, and how each changes the risk",
    scenario: "orbBreak",
    beats: [
      { step: "", headline: "Same entry. But 7.5 or 12 risk?", caption: "Where the stop goes on an opening range breakout, drawn.", say: "One entry, two stops, and one risks 7.5 points while the other risks 12.", take: "Stop placement sets the risk.", chart: { show: 8, overlays: [RANGE, entry(7, 59), line(51.5, 7, "Tight stop", "bad"), line(47, 7, "Wide stop", "bad")] } },
      { step: "The entry", headline: "The close above the range", caption: "The entry is the candle that closes above the opening range high.", say: "The entry is the candle that closes above the opening range high.", take: "The entry is the breakout close.", chart: { show: 8, overlays: [RANGE, entry(7, 59)] } },
      { step: "Tight stop", headline: "The middle of the range", caption: "Smaller risk, but normal back-and-forth can reach it.", say: "A tight stop at the middle of the range means a smaller risk, but normal back and forth can reach it.", take: "Tight stops get hit more often.", chart: { show: 8, overlays: [RANGE, entry(7, 59), line(51.5, 7, "Tight stop", "bad")] } },
      { step: "Wide stop", headline: "Past the other side", caption: "More room, but the same size now risks much more money.", say: "A wide stop past the other side gives more room, but the same size now risks much more money.", take: "Wide stops cost more per trade.", chart: { show: 8, overlays: [RANGE, entry(7, 59), line(47, 7, "Wide stop", "bad")] } },
      { step: "The size", headline: "Size follows the stop", caption: "Pick the stop first, then the size that keeps the risk the same.", say: "The stop comes first, and the size follows, so the money at risk stays the same either way.", take: "Set size from the stop.", chart: { show: 14, overlays: [RANGE, entry(7, 59), line(51.5, 7, "Tight stop", "bad"), line(47, 7, "Wide stop", "bad")] } },
      { step: "The trap", headline: "Same size, wider stop", caption: "Widening the stop without cutting size quietly makes the loss much bigger.", say: "The trap is widening the stop and keeping the same size, which quietly makes the loss much bigger.", take: "Wider stop, smaller size.", chart: { show: 8, overlays: [RANGE, entry(7, 59), line(47, 7, "Wide stop", "bad")] } },
      { step: "What decides it", headline: "Your plan's dollar risk", caption: "Your plan's risk per trade decides the size for whichever stop you use.", say: "Your plan's dollar risk per trade decides the size for whichever stop you choose.", take: "The plan sets the dollar risk." },
      { step: "Test it yourself", headline: "Log the stop with the trade", caption: "Log each trade's stop, then compare tight and wide stops after a month.", say: "Log where the stop was on every trade, then compare tight and wide after a month.", take: "Compare stops in your journal." },
    ],
    close: { headline: "Is your risk 7.5 or 12?", say: "Is your risk closer to 7.5 or to 12?" },
  },
  {
    slug: "vwap-pullback",
    view: "Fillbook puts your VWAP pullbacks on their own row.",
    title: "VWAP pullback strategy explained",
    topic: "How a VWAP pullback is commonly defined on a trend day: the pullback to VWAP, the hold, the stop and the target",
    scenario: "vwapPullback",
    beats: [
      { step: "", headline: "1 pullback to VWAP. Then it held.", caption: "The VWAP pullback, drawn on a trend day.", say: "On a trend day price pulled back to VWAP, then held.", take: "VWAP can act as support on a trend day.", chart: { show: 19, overlays: [VWAP, entry(13, 50.2)] } },
      { step: "The setup", headline: "A trend above VWAP", caption: "VWAP is the day's average price. On a trend day, price stays on one side of it.", say: "VWAP is the average price of the day, and on a trend day price stays on one side of it.", take: "Trend days stay on one side of VWAP.", chart: { show: 10, overlays: [VWAP] } },
      { step: "The pullback", headline: "Back to the average", caption: "Price pulls back down toward VWAP instead of running away from it.", say: "Then price pulls back toward VWAP instead of running away from it.", take: "The pullback comes to VWAP.", chart: { show: 13, overlays: [VWAP] } },
      { step: "The trigger", headline: "A hold, not a touch", caption: "A candle that dips through and closes back above, with a long lower wick.", say: "A common trigger is a candle that dips through VWAP and closes back above it.", take: "The trigger is a close back above.", chart: { show: 14, overlays: [VWAP, entry(13, 50.2)] } },
      { step: "Stop and target", headline: "Below the low, up to the high", caption: "Stop under the pullback's low. First target: the high before it.", say: "The stop commonly goes under the pullback's low, and the first target is the high before the pullback.", take: "Stop under the low, target the prior high.", chart: { show: 19, overlays: [VWAP, entry(13, 50.2), line(45.8, 13, "Stop", "bad"), line(54.1, 9, "Prior high", "good")] } },
      { step: "The trap", headline: "Buying every touch", caption: "On a day without a trend, VWAP is crossed again and again.", say: "The trap is buying every touch, when on a day without a trend VWAP gets crossed again and again.", take: "No trend, no pullback setup.", chart: { show: 19, overlays: [VWAP, entry(13, 50.2), line(45.8, 13, "Stop", "bad")] } },
      { step: "What confirms it", headline: "A rising VWAP", caption: "Some traders only take it when VWAP itself is sloping in the trend's direction.", say: "Some traders only take it when VWAP itself is sloping in the direction of the trend.", take: "A sloping VWAP confirms the trend." },
      { step: "Test it yourself", headline: "Tag trend days apart", caption: "Tag VWAP trades on trend days and range days. They tell different stories.", say: "Tag VWAP trades on trend days and range days separately, and the two groups tell different stories.", take: "Separate trend and range days." },
    ],
    close: { headline: "Do you trade the 1st pullback?", say: "Do you trade the first pullback to VWAP?" },
  },
  {
    slug: "vwap-chop",
    view: "Fillbook shows the hour your VWAP trades stop paying.",
    title: "When the VWAP pullback stops working",
    topic: "A range day where VWAP goes flat and price crosses it again and again, against a trend day",
    scenario: "vwapChop",
    beats: [
      { step: "", headline: "8 crosses of VWAP. Not one trend.", caption: "Why the VWAP pullback struggles on a range day, drawn.", say: "Price crossed VWAP 8 times, and there was not one trend to follow.", take: "Range days chop around VWAP.", chart: { show: 19, overlays: [VWAP] } },
      { step: "The difference", headline: "Flat VWAP, no side", caption: "On a range day VWAP goes flat, and price has no side to stay on.", say: "On a range day VWAP goes flat, and price has no side to stay on.", take: "Flat VWAP means no trend.", chart: { show: 10, overlays: [VWAP] } },
      { step: "What it looks like", headline: "Every touch looks like a setup", caption: "Each cross can look like a pullback that is about to hold.", say: "Each cross can look like a pullback about to hold, which is why it is easy to keep trying.", take: "Every touch looks tempting.", chart: { show: 14, overlays: [VWAP] } },
      { step: "The cost", headline: "Small losses, again and again", caption: "Each failed hold is a small stop. Together they add up.", say: "Each failed hold is a small stop, and together they add up over the day.", take: "Small stops add up.", chart: { show: 19, overlays: [VWAP] } },
      { step: "The tell", headline: "Look at the slope first", caption: "Before the first trade, check whether VWAP is sloping or flat.", say: "Before the first trade, check whether VWAP is sloping or flat.", take: "Check the slope first.", chart: { show: 19, overlays: [VWAP] } },
      { step: "The trap", headline: "Trading the setup, not the day", caption: "The same pattern behaves differently on a trend day and a range day.", say: "The trap is trading the pattern without looking at the day, because it behaves differently on each.", take: "Read the day before the setup." },
      { step: "What some traders do", headline: "Fewer trades on flat days", caption: "Some traders cap their trades on days when VWAP stays flat.", say: "Some traders cap their number of trades on days when VWAP stays flat.", take: "Flat days, fewer trades." },
      { step: "Test it yourself", headline: "Tag the day type", caption: "Tag each day as trend or range. Results by day type show where it works.", say: "Tag each day as trend or range, and your results by day type show where the setup works.", take: "Tag the day type." },
    ],
    close: { headline: "8 crosses today, or a trend?", say: "Is today 8 crosses of VWAP, or a trend?" },
  },
  {
    slug: "break-and-retest",
    view: "Fillbook puts your retests on their own row.",
    title: "Break and retest strategy explained",
    topic: "How a break and retest is commonly defined: a level, a close through it, a retest that holds, and the entry",
    scenario: "breakRetest",
    beats: [
      { step: "", headline: "2 rejections. Then a break. Then?", caption: "The break and retest, drawn step by step.", say: "A level rejected price 2 times, then broke, then got tested from the other side.", take: "A broken level gets retested.", chart: { show: 19, overlays: [LEVEL, entry(13, 57.6)] } },
      { step: "The setup", headline: "A level that held twice", caption: "A price that turned the market back more than once is a level traders watch.", say: "The setup starts with a level that turned price back more than once.", take: "Two rejections make a level.", chart: { show: 9, overlays: [LEVEL] } },
      { step: "The break", headline: "A close through it", caption: "A full candle closing above the level, not just a wick.", say: "Then a full candle closes above the level, not just a wick through it.", take: "The break is a close through.", chart: { show: 11, overlays: [LEVEL] } },
      { step: "The retest", headline: "Back to the level, and a hold", caption: "Price returns to the level from above and closes back above it.", say: "Price comes back to the level from above and closes back above it, which is the retest.", take: "The retest holds from above.", chart: { show: 14, overlays: [LEVEL, entry(13, 57.6)] } },
      { step: "Stop and target", headline: "Under the level, to the next", caption: "The stop goes under the level. The target is the next level above.", say: "The stop commonly goes just under the level, and the target is the next level above.", take: "Stop under the level, target the next.", chart: { show: 19, overlays: [LEVEL, entry(13, 57.6), line(54.6, 13, "Stop", "bad"), line(63.8, 13, "Next level", "good")] } },
      { step: "The trap", headline: "Entering on the break itself", caption: "Buying the breakout candle means no retest to measure the stop from.", say: "The trap is entering on the break itself, with no retest to measure the stop from.", take: "The retest defines the risk.", chart: { show: 11, overlays: [LEVEL, entry(10, 58.2, "Early entry")] } },
      { step: "What confirms it", headline: "A rejection wick at the level", caption: "Some traders want a long wick off the level on the retest candle.", say: "Some traders want a long wick off the level on the retest candle before they count it.", take: "A wick off the level confirms it." },
      { step: "Test it yourself", headline: "Compare break and retest entries", caption: "Tag entries on the break and on the retest. Compare the two after a month.", say: "Tag the entries you take on the break and on the retest, and compare them after a month.", take: "Compare entry types." },
    ],
    close: { headline: "After 2 rejections, do you wait?", say: "After 2 rejections and a break, do you wait for the retest?" },
  },
  {
    slug: "retest-stop-target",
    view: "Fillbook shows your retest win rate and net P&L.",
    title: "Break and retest: where the stop and target go",
    topic: "Stop and target placement on a break and retest, and how the distance between them sets the trade's reward",
    scenario: "breakRetest",
    beats: [
      { step: "", headline: "Risk only 3 points. Target 6?", caption: "How the stop and target are placed on a break and retest.", say: "Risk only 3 points, with 6 points to the target, on one break and retest.", take: "Stop and target set the reward.", chart: { show: 19, overlays: [LEVEL, entry(13, 57.6), line(54.6, 13, "Stop", "bad"), line(63.8, 13, "Target", "good")] } },
      { step: "The level", headline: "The line everything hangs on", caption: "The broken level is where the stop and the idea both live.", say: "The broken level is where both the stop and the idea of the trade live.", take: "The level anchors the trade.", chart: { show: 11, overlays: [LEVEL] } },
      { step: "The stop", headline: "Just under the level", caption: "If price closes back under the level, the retest has failed.", say: "The stop commonly goes just under the level, because a close back under it means the retest failed.", take: "Under the level, the idea is wrong.", chart: { show: 14, overlays: [LEVEL, entry(13, 57.6), line(54.6, 13, "Stop", "bad")] } },
      { step: "The target", headline: "The next level up", caption: "The first target is the next place price turned before.", say: "The first target is the next place where price turned before.", take: "Target the next level.", chart: { show: 19, overlays: [LEVEL, entry(13, 57.6), line(54.6, 13, "Stop", "bad"), line(63.8, 13, "Target", "good")] } },
      { step: "The math", headline: "Reward against risk", caption: "Distance to the target divided by distance to the stop: here about two to one.", say: "Divide the distance to the target by the distance to the stop, and here it is about two to one.", take: "Reward over risk.", chart: { show: 19, overlays: [LEVEL, entry(13, 57.6), line(54.6, 13, "Stop", "bad"), line(63.8, 13, "Target", "good")] } },
      { step: "The trap", headline: "A target past the next level", caption: "Aiming far beyond the next level makes the ratio look good and rarely fill.", say: "The trap is a target far past the next level, which makes the ratio look good and rarely gets reached.", take: "Realistic targets beat big ratios." },
      { step: "What some traders do", headline: "Take part at the first target", caption: "Some traders close part of the trade at the first level and move the stop.", say: "Some traders close part of the trade at the first level and move the stop on the rest.", take: "Partial exits are an option." },
      { step: "Test it yourself", headline: "Log planned and actual exits", caption: "Log the planned target and where you really exited. The gap is worth reviewing.", say: "Log the planned target and where you really exited, because the gap between them is worth reviewing.", take: "Compare planned and actual exits." },
    ],
    close: { headline: "Is your target 2x your risk?", say: "Is your target about 2 times your risk?" },
  },
  {
    slug: "failed-retest",
    view: "Fillbook shows what failed retests cost you.",
    title: "Break and retest: when the retest fails",
    topic: "A break and retest where the retest closes back below the level, and how a planned stop handles it",
    scenario: "breakFail",
    beats: [
      { step: "", headline: "Retest failed. Then 7 points down.", caption: "A failed retest, drawn: what it looks like and what limits it.", say: "The retest failed, and price fell about 7 points back through the level.", take: "Retests can fail.", chart: { show: 18, overlays: [LEVEL] } },
      { step: "The setup", headline: "A level, then a break", caption: "Same as before: a level that held twice, then a close above it.", say: "It starts the same way, with a level that held twice and then a close above it.", take: "Same start.", chart: { show: 11, overlays: [LEVEL] } },
      { step: "The retest", headline: "Back to the level", caption: "Price comes back to the level, as it does on a good retest.", say: "Price comes back to the level, just as it does on a good retest.", take: "The retest begins normally.", chart: { show: 13, overlays: [LEVEL] } },
      { step: "The fail", headline: "A close back under", caption: "This time the candle closes back below the level. The retest did not hold.", say: "This time the candle closes back below the level, so the retest did not hold.", take: "A close under is the fail.", chart: { show: 14, overlays: [LEVEL] } },
      { step: "The stop", headline: "Where the plan ends the trade", caption: "A stop under the level, set in advance, ends the trade at the fail.", say: "A stop under the level, set in advance, ends the trade right at the fail.", take: "The planned stop limits the loss.", chart: { show: 18, overlays: [LEVEL, entry(12, 55.8), line(54.6, 12, "Stop", "bad")] } },
      { step: "The trap", headline: "Calling it a deeper retest", caption: "Renaming a fail as a deeper retest is how a small loss grows.", say: "The trap is calling it a deeper retest, which is how a small loss quietly grows.", take: "A fail is a fail." },
      { step: "What confirms the fail", headline: "A close, not a dip", caption: "Some traders only count the fail on a full close under the level.", say: "Some traders only count it as failed on a full close under the level, not a quick dip.", take: "A close confirms the fail." },
      { step: "Test it yourself", headline: "Tag the fails", caption: "Tag every failed retest. Your fail rate shows how the setup behaves for you.", say: "Tag every failed retest, and your own fail rate tells you how the setup behaves for you.", take: "Know your fail rate." },
    ],
    close: { headline: "7 points down. Where's your stop?", say: "If it fell 7 points, where was your stop?" },
  },
  {
    slug: "demand-zone",
    view: "Fillbook shows if your zone trades pay, by setup.",
    title: "Supply and demand zones explained: the demand zone",
    topic: "How a demand zone is commonly marked from a base before a sharp move, and what a confirmation candle looks like",
    scenario: "demandSupply",
    beats: [
      { step: "", headline: "Back to the zone. Then +16?", caption: "Supply and demand zones, drawn: the demand zone and the reaction.", say: "Price came back to the zone where the move started, then rose about 16 points.", take: "Price returns to zones.", chart: { show: 24, overlays: [DEMAND, SUPPLY] } },
      { step: "The setup", headline: "A base before a sharp move", caption: "A few tight candles, then a strong move away. The base is the zone.", say: "A demand zone is commonly marked at the base of tight candles just before a sharp move up.", take: "The base becomes the zone.", chart: { show: 10, overlays: [DEMAND] } },
      { step: "The return", headline: "Back into the zone", caption: "Later, price returns into the area where the move started.", say: "Later, price returns into the area where that move started.", take: "Price comes back to the zone.", chart: { show: 18, overlays: [DEMAND] } },
      { step: "The trigger", headline: "A candle that takes it all back", caption: "A bullish candle that covers the whole previous candle: an engulfing candle.", say: "A common trigger is a bullish candle that covers the whole previous candle, called an engulfing candle.", take: "An engulfing candle is the trigger.", chart: { show: 19, overlays: [DEMAND, entry(18, 46.8)] } },
      { step: "Stop and target", headline: "Under the zone, to supply", caption: "The stop goes under the zone. The target is the supply zone above.", say: "The stop commonly goes under the zone, and the target is the supply zone above.", take: "Stop under, target the supply zone.", chart: { show: 24, overlays: [DEMAND, SUPPLY, entry(18, 46.8), line(40.2, 18, "Stop", "bad")] } },
      { step: "The trap", headline: "Zones drawn too wide", caption: "A zone wide enough to catch everything gives a stop too far to size.", say: "The trap is drawing the zone so wide that the stop ends up too far away to size sensibly.", take: "Tight zones, sizable stops.", chart: { show: 10, overlays: [band(0, -1, 47, 39, "Too wide", "bad")] } },
      { step: "What confirms it", headline: "A first return, not a fifth", caption: "Some traders only trade the first return to a zone, not later ones.", say: "Some traders only trade the first return to a zone, not the fourth or fifth.", take: "First returns are cleaner." },
      { step: "Test it yourself", headline: "Tag first and later returns", caption: "Tag whether each zone trade was a first or later return, and compare.", say: "Tag whether each zone trade was a first return or a later one, and compare the results.", take: "Compare first and later returns." },
    ],
    close: { headline: "Back at the zone: buy it?", say: "Back at the zone, do you trade the first return?" },
  },
  {
    slug: "supply-zone-target",
    view: "Fillbook shows win rate and net P&L per zone setup.",
    title: "Supply and demand: why the target is the next zone",
    topic: "How supply and demand zones set a trade's stop and target, and the distance between them",
    scenario: "demandSupply",
    beats: [
      { step: "", headline: "Only 13 points to supply. Enough?", caption: "How two zones frame one trade, drawn.", say: "Only about 13 points from demand up to supply, so is that enough room?", take: "Two zones frame a trade.", chart: { show: 24, overlays: [DEMAND, SUPPLY, entry(18, 46.8)] } },
      { step: "Supply", headline: "Where the last rally stopped", caption: "A supply zone is marked where a sharp move up stalled and turned down.", say: "A supply zone is commonly marked where a sharp move up stalled and turned back down.", take: "Supply is where rallies stall.", chart: { show: 12, overlays: [SUPPLY] } },
      { step: "Demand", headline: "Where the move began", caption: "The demand zone is the base the rally started from.", say: "The demand zone is the base that the rally started from.", take: "Demand is where moves begin.", chart: { show: 12, overlays: [DEMAND, SUPPLY] } },
      { step: "The trade", headline: "Entry near demand", caption: "The entry is the confirmation candle back at the demand zone.", say: "The entry is the confirmation candle back at the demand zone.", take: "Enter at demand on confirmation.", chart: { show: 19, overlays: [DEMAND, SUPPLY, entry(18, 46.8)] } },
      { step: "Stop and target", headline: "Under demand, before supply", caption: "Stop under demand. Target just before supply, where selling may return.", say: "The stop sits under the demand zone, and the target sits just before supply, where selling may come back.", take: "Target just before the next zone.", chart: { show: 24, overlays: [DEMAND, SUPPLY, entry(18, 46.8), line(40.2, 18, "Stop", "bad"), line(59.6, 18, "Target", "good")] } },
      { step: "The trap", headline: "Holding through the supply zone", caption: "Expecting price to run through supply first try often gives profits back.", say: "The trap is expecting price to run straight through supply, which often gives the profit back.", take: "Respect the next zone.", chart: { show: 24, overlays: [DEMAND, SUPPLY, entry(18, 46.8), line(59.6, 18, "Target", "good")] } },
      { step: "The math", headline: "The room between zones", caption: "If the room to supply is small next to the stop, the trade is often skipped.", say: "When the room up to supply is small next to the stop, some traders skip the trade.", take: "Room between zones decides it." },
      { step: "Test it yourself", headline: "Log the room before entry", caption: "Log the distance to the stop and to the next zone before every trade, then review.", say: "Log the distance to the stop and to the next zone before every trade, then review them.", take: "Log the room first." },
    ],
    close: { headline: "13 points to supply: take it?", say: "With 13 points up to supply, do you take it?" },
  },
];

export const STRATEGY_PILOTS: ScenePlan[] = STRATEGIES.map((s, i) => buildStrategyVideo(i + 1, s));
export const STRATEGY_ORDER: string[] = STRATEGY_PILOTS.map((p) => p.planId);

/** The order the strategy videos go out in (every third day): the four setups rotated, so no setup runs twice in a row. */
export const STRATEGY_DAY_ORDER: readonly string[] = [1, 4, 6, 9, 2, 5, 7, 10, 3, 8].map((n) => STRATEGY_ORDER[n - 1]!);
