/**
 * Drawn candlestick illustrations for the strategy videos (strategyVideos.ts, owner decision 2026-10-17).
 *
 * Every chart here is an ILLUSTRATION: hand-written candle shapes on an unlabelled price axis, never a real market, ticker,
 * date or price. They show how a setup is commonly defined (the range, the level, the zone), what a trigger looks like, and
 * where a stop and a target are commonly placed. Each chart carries ILLUSTRATION_TAG on screen. Nothing here says what to trade.
 *
 * Pure: the same spec always gives the same SVG, so a chart is unit-testable and part of the scene plan's hash.
 */

export const ILLUSTRATION_TAG = "Illustration · not a recommendation";

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

export type ChartTone = "accent" | "good" | "bad" | "mute";

export type Overlay =
  /** A shaded band between two prices from candle `from` to `to` (an opening range, a supply or demand zone). */
  | { kind: "band"; from: number; to: number; top: number; bottom: number; label: string; tone: ChartTone }
  /** A horizontal line from candle `from` to the right edge (a level, a stop, a target). */
  | { kind: "line"; price: number; from: number; label: string; tone: ChartTone; dashed?: boolean }
  /** VWAP: the running volume-weighted average, drawn from the visible candles (equal volume assumed: it is an illustration). */
  | { kind: "vwap"; label: string }
  /** A marked point (an entry) with a label. */
  | { kind: "marker"; index: number; price: number; label: string; tone: ChartTone };

export interface StrategyChartSpec {
  /** Which illustration (SCENARIOS). */
  scenario: ScenarioId;
  /** How many candles are drawn (the chart builds up beat by beat). */
  show: number;
  overlays: Overlay[];
}

/** Candles from a list of closes: each opens at the previous close, with small fixed wicks. Deterministic. */
export function candlesFromCloses(first: number, closes: number[], wicks: number[] = []): Candle[] {
  const out: Candle[] = [];
  let open = first;
  closes.forEach((c, i) => {
    const w = wicks[i] ?? 0.6 + (i % 3) * 0.35;
    out.push({ o: open, c, h: Math.max(open, c) + w, l: Math.min(open, c) - w });
    open = c;
  });
  return out;
}

/** A candle with a long lower wick (a hold or a rejection from below). */
const hammer = (o: number, c: number, low: number): Candle => ({ o, c, h: Math.max(o, c) + 0.5, l: low });
/** A candle with a long upper wick (a rejection from above). */
const shooter = (o: number, c: number, high: number): Candle => ({ o, c, h: high, l: Math.min(o, c) - 0.5 });

export const SCENARIOS = {
  /** Opening range, then a clean break and close above it. Range high 56, low 47; the break closes at 59. */
  orbBreak: [
    { o: 50, h: 55.5, l: 47, c: 54 },
    { o: 54, h: 56, l: 49.5, c: 50.5 },
    { o: 50.5, h: 54, l: 48.5, c: 53 },
    ...candlesFromCloses(53, [51.5, 54, 52.5, 54.5]),
    { o: 54.5, h: 59.6, l: 54, c: 59 },
    ...candlesFromCloses(59, [61, 60.2, 62.5, 64, 63.2, 65.5]),
  ],
  /** The same range, a close above it, then the next candle closes back inside and price falls through the low. */
  orbFake: [
    { o: 50, h: 55.5, l: 47, c: 54 },
    { o: 54, h: 56, l: 49.5, c: 50.5 },
    { o: 50.5, h: 54, l: 48.5, c: 53 },
    ...candlesFromCloses(53, [51.5, 54, 52.5, 54.5]),
    { o: 54.5, h: 57.8, l: 54, c: 57.3 },
    { o: 57.3, h: 57.6, l: 52.4, c: 52.8 },
    ...candlesFromCloses(52.8, [50.5, 48.2, 46.4, 45, 45.8]),
  ],
  /** A trend day: price stays above VWAP, pulls back to it, holds with a long lower wick, and continues. */
  vwapPullback: [
    ...candlesFromCloses(40, [42, 41.5, 44, 46, 45.2, 48, 50, 49.4, 52, 53.5]),
    ...candlesFromCloses(53.5, [51.5, 50, 48.6]),
    hammer(48.6, 50.2, 46.2),
    ...candlesFromCloses(50.2, [52.5, 54.2, 56, 55.4, 58]),
  ],
  /** A range day: VWAP goes flat and price crosses it again and again. */
  vwapChop: candlesFromCloses(50, [52.5, 50.5, 48, 50.8, 53, 51, 48.5, 47.6, 50.4, 52.6, 51.2, 48.4, 49.6, 52.2, 53.2, 50.6, 48.2, 49.8, 51.6]),
  /** A level that held twice, then a break and close above it, a retest from above that holds, and a move to the next level. */
  breakRetest: [
    ...candlesFromCloses(48, [50, 52.5, 54.2]),
    shooter(54.2, 53, 55.6),
    ...candlesFromCloses(53, [51, 50.2, 52.4, 54.4]),
    shooter(54.4, 53.6, 55.5),
    ...candlesFromCloses(53.6, [54.8]),
    { o: 54.8, h: 58.6, l: 54.5, c: 58.2 },
    ...candlesFromCloses(58.2, [57.4, 56.4]),
    hammer(56.4, 57.6, 55.1),
    ...candlesFromCloses(57.6, [59.4, 61, 60.4, 62.6, 63.8]),
  ],
  /** The same break, but the retest closes back below the level and the move fails. */
  breakFail: [
    ...candlesFromCloses(48, [50, 52.5, 54.2]),
    shooter(54.2, 53, 55.6),
    ...candlesFromCloses(53, [51, 50.2, 52.4, 54.4]),
    shooter(54.4, 53.6, 55.5),
    ...candlesFromCloses(53.6, [54.8]),
    { o: 54.8, h: 58.6, l: 54.5, c: 58.2 },
    ...candlesFromCloses(58.2, [57, 55.8]),
    { o: 55.8, h: 56.2, l: 52.6, c: 53 },
    ...candlesFromCloses(53, [51.4, 50.2, 50.8, 49]),
  ],
  /** A base (demand zone 40-43), a sharp move up into a supply area (60-63), a return to the zone, a bullish engulfing candle, and the move back up. */
  demandSupply: [
    ...candlesFromCloses(44, [42.5, 41.4, 42.6, 41.8]),
    ...candlesFromCloses(41.8, [45.5, 49, 53, 57.5, 61]),
    shooter(61, 60, 63),
    ...candlesFromCloses(60, [57, 54, 51, 48, 45.2, 43]),
    { o: 43, h: 43.4, l: 40.8, c: 42 },
    { o: 41.8, h: 47.2, l: 41.4, c: 46.8 },
    ...candlesFromCloses(46.8, [49.5, 52, 51.2, 54.6, 57.8]),
  ],
} satisfies Record<string, Candle[]>;

export type ScenarioId = keyof typeof SCENARIOS;

/** The running average of each candle's typical price (high + low + close) / 3: VWAP with every candle given the same volume. */
export function vwapOf(candles: Candle[]): number[] {
  let sum = 0;
  return candles.map((k, i) => {
    sum += (k.h + k.l + k.c) / 3;
    return sum / (i + 1);
  });
}

export const CHART_SIZE = { w: 780, h: 520 } as const;
const PAD = { left: 16, right: 186, top: 24, bottom: 24 };

const TONE: Record<ChartTone, string> = { accent: "var(--cyan)", good: "var(--good)", bad: "var(--bad)", mute: "var(--mute)" };
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The chart as an SVG string sized CHART_SIZE, coloured through the slide's CSS variables (so it takes the video's look).
 * Labels sit in the right-hand gutter, one per overlay, nudged apart so they never overlap.
 */
export function strategyChartSvg(spec: StrategyChartSpec): string {
  const all = SCENARIOS[spec.scenario];
  const candles = all.slice(0, Math.max(1, Math.min(spec.show, all.length)));
  const vwap = vwapOf(candles);
  const prices = [...candles.flatMap((k) => [k.h, k.l])];
  for (const o of spec.overlays) {
    if (o.kind === "band") prices.push(o.top, o.bottom);
    if (o.kind === "line" || o.kind === "marker") prices.push(o.price);
  }
  if (spec.overlays.some((o) => o.kind === "vwap")) prices.push(...vwap);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = Math.max(hi - lo, 1);
  const plotW = CHART_SIZE.w - PAD.left - PAD.right;
  const plotH = CHART_SIZE.h - PAD.top - PAD.bottom;
  const step = plotW / all.length;
  const body = Math.max(6, Math.min(18, step * 0.62));
  const x = (i: number): number => PAD.left + step * (i + 0.5);
  const y = (p: number): number => PAD.top + ((hi + span * 0.04 - p) / (span * 1.08)) * plotH;
  const right = PAD.left + plotW;
  const parts: string[] = [];
  const labels: Array<{ y: number; text: string; tone: ChartTone }> = [];

  for (const o of spec.overlays) {
    if (o.kind === "band") {
      const x0 = x(o.from) - step / 2;
      const x1 = o.to < 0 ? right : x(Math.min(o.to, all.length - 1)) + step / 2;
      parts.push(`<rect x="${x0.toFixed(1)}" y="${y(o.top).toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y(o.bottom) - y(o.top)).toFixed(1)}" rx="6" fill="${TONE[o.tone]}" fill-opacity=".13" stroke="${TONE[o.tone]}" stroke-opacity=".55" stroke-width="2"/>`);
      labels.push({ y: (y(o.top) + y(o.bottom)) / 2, text: o.label, tone: o.tone });
    }
  }
  if (spec.overlays.some((o) => o.kind === "vwap")) {
    const pts = vwap.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="var(--cyan)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`);
    const label = spec.overlays.find((o) => o.kind === "vwap")!.label;
    labels.push({ y: y(vwap[vwap.length - 1]!), text: label, tone: "accent" });
  }
  candles.forEach((k, i) => {
    const up = k.c >= k.o;
    const color = up ? "var(--good)" : "var(--bad)";
    const top = y(Math.max(k.o, k.c));
    const h = Math.max(2, y(Math.min(k.o, k.c)) - top);
    parts.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(k.h).toFixed(1)}" y2="${y(k.l).toFixed(1)}" stroke="${color}" stroke-width="2.5"/>`);
    parts.push(`<rect x="${(x(i) - body / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${body.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"/>`);
  });
  for (const o of spec.overlays) {
    if (o.kind === "line") {
      parts.push(`<line x1="${(x(o.from) - step / 2).toFixed(1)}" x2="${right.toFixed(1)}" y1="${y(o.price).toFixed(1)}" y2="${y(o.price).toFixed(1)}" stroke="${TONE[o.tone]}" stroke-width="3"${o.dashed ? ` stroke-dasharray="12 9"` : ""}/>`);
      labels.push({ y: y(o.price), text: o.label, tone: o.tone });
    } else if (o.kind === "marker") {
      parts.push(`<circle cx="${x(o.index).toFixed(1)}" cy="${y(o.price).toFixed(1)}" r="13" fill="none" stroke="${TONE[o.tone]}" stroke-width="5"/>`);
      labels.push({ y: y(o.price), text: o.label, tone: o.tone });
    }
  }
  // Labels in the gutter, top to bottom, at least 44px apart.
  labels.sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const l of labels) {
    const ly = Math.min(Math.max(l.y, last + 44, 24), CHART_SIZE.h - 24);
    last = ly;
    parts.push(`<g transform="translate(${right + 14},${ly.toFixed(1)})"><rect x="0" y="-19" width="${PAD.right - 18}" height="38" rx="19" fill="var(--bg1)" stroke="${TONE[l.tone]}" stroke-width="2"/><text x="${(PAD.right - 18) / 2}" y="8" text-anchor="middle" font-family="MR" font-weight="700" font-size="21" fill="${TONE[l.tone]}">${esc(l.text)}</text></g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_SIZE.w}" height="${CHART_SIZE.h}" viewBox="0 0 ${CHART_SIZE.w} ${CHART_SIZE.h}">${parts.join("")}</svg>`;
}
