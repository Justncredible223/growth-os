import { ILLUSTRATION_TAG, SCENARIOS, type StrategyChartSpec } from "./strategyCharts.js";
import type { ChartTone, ScenePlan } from "./types.js";

/**
 * What goes on a video's cover (owner request 2026-10-17: the generated thumbnails were plain dark cards that all looked alike).
 *
 * On the profile grid every tile was the same dark card with a line of small white text, so nothing stood out; the one cover with
 * a big headline over a real product screen (the pinned video) got 9.5K views against about 100 for the rest. A cover now carries:
 *   - a big, number-led headline (the video's own hook, figures picked out in colour),
 *   - the proof under it: the app's own figure tiles for a product video, or the drawn chart for a strategy video,
 *   - a small tag (EXPLAINED / STRATEGY) so the series reads at a glance, and the same fine print the video carries.
 * Everything sits inside the 3:4 centre of the 9:16 frame, because that is the part the profile grid shows.
 *
 * Pure: no rendering here, so what each cover says and shows is unit-tested without a browser.
 */
export interface ThumbnailTile {
  label: string;
  value: string;
  tone: ChartTone;
}

export type ThumbnailVisual = { kind: "tiles"; tiles: ThumbnailTile[] } | { kind: "chart"; chart: StrategyChartSpec } | null;

export interface ThumbnailSpec {
  /** The small pill above the headline. */
  tag: string;
  /** The video's hook, shown large. */
  headline: string;
  /** The colour the headline's figures take. */
  accent: "good" | "bad" | "cyan";
  visual: ThumbnailVisual;
  /** The disclosure line, the same one the video shows. */
  fine: string;
}

/** The part of the 1080x1920 frame a 3:4 profile-grid tile shows (240 px is trimmed off the top and the bottom). */
export const THUMB_SAFE = { x: 60, y: 240, w: 960, h: 1440 } as const;
export const THUMB_CANVAS = { w: 1080, h: 1920 } as const;

/** A headline past this many characters stops reading at thumbnail size. */
export const THUMB_HEADLINE_MAX = 64;

const clean = (t: string): string => t.replace(/\s*\((?:shown on the real )?screen recording\)/gi, "").replace(/\s+/g, " ").trim();

/** The strategy chart with the most on it (the stop and target beat), drawn in full. */
function strategyChartOf(plan: ScenePlan): StrategyChartSpec | null {
  let best: StrategyChartSpec | null = null;
  for (const s of plan.scenes) {
    const c = s.teach?.chart;
    if (c && (!best || c.overlays.length > best.overlays.length)) best = c;
  }
  if (!best) return null;
  return { ...best, show: SCENARIOS[best.scenario].length };
}

export function thumbnailSpecFor(plan: ScenePlan): ThumbnailSpec {
  const headline = clean(plan.hook);
  const isStrategy = plan.planId.startsWith("strategy-");
  const mock = plan.scenes.find((s) => s.chart?.kind === "mock")?.chart;
  const tag = isStrategy ? "STRATEGY" : plan.series === "Explained" ? "EXPLAINED" : "FILLBOOK";
  const accent: ThumbnailSpec["accent"] = isStrategy ? "cyan" : mock?.accent === "bad" ? "bad" : mock?.accent === "good" ? "good" : "cyan";

  if (isStrategy) {
    const chart = strategyChartOf(plan);
    return { tag, headline, accent, visual: chart ? { kind: "chart", chart } : null, fine: ILLUSTRATION_TAG };
  }
  const tiles = (mock?.mock?.opening ?? []).slice(0, 2).map((h) => ({ label: h.label, value: h.value, tone: h.tone }));
  return {
    tag,
    headline,
    accent,
    visual: tiles.length > 0 ? { kind: "tiles", tiles } : null,
    fine: mock?.mock?.tag ?? "Demo data",
  };
}

/** The headline split into plain and figure pieces (a figure is a number, a dollar amount, a percentage or "2.5x"), for colouring. */
export function headlinePieces(headline: string): Array<{ text: string; figure: boolean }> {
  const out: Array<{ text: string; figure: boolean }> = [];
  const re = /-?\$?\d[\d,.]*(?:%|x|K)?/g;
  let last = 0;
  for (const m of headline.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: headline.slice(last, at), figure: false });
    out.push({ text: m[0].replace(/[.,]$/, ""), figure: true });
    last = at + m[0].replace(/[.,]$/, "").length;
  }
  if (last < headline.length) out.push({ text: headline.slice(last), figure: false });
  return out;
}
