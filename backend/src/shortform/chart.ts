import { extractNumbers, numberIsSupported, claimEvidenceNumbers } from "./claims.js";
import { MOCK_BOXES, boxesOutsideSafeArea, mockFitProblems, mockTexts } from "./mockLayout.js";
import type { ChartGrid, ChartSpec, PlanIssue, SceneSpec, VerifiedAsset } from "./types.js";

/**
 * Chart-card geometry (frame pixels, 1080x1920) and validation. The geometry is pure data so the same numbers drive the
 * renderer (scripts/video-factory/chartCues.ts) and the safe-zone check here. Everything stays left of x=880 (the
 * platforms' button column starts at x=930, y>=740) and above y=1560 (their caption area starts at y=1600).
 */
export const CHART = {
  left: 100,
  right: 880,
  centerX: 490,
  /** Top of the headline block; each line is `lineHeight` below the last. */
  hookTop: 250,
  hookFont: 150,
  hookLineHeight: 150,
  gridTop: 650,
  gridGap: 18,
  gridMaxCell: 100,
  barHeight: 64,
  /** Gap between the grid's bottom and the progress label. */
  barGap: 110,
  pairTop: 760,
  pairRowGap: 170,
  pairBarLength: 640,
  pairBarHeight: 80,
  pairMarkerX: 150,
  /** "outcomes": gap under the grid to the first bar, the pitch between the two bars, and each bar's height. */
  outcomeGap: 90,
  outcomeRowGap: 120,
  outcomeBarHeight: 70,
  /** "bars": where the first row's label sits, the largest bar length, and the bar height. The pitch depends on the row count. */
  barsTop: 640,
  barsBarLength: 640,
  barsBarHeight: 54,
  barsLabelGap: 34,
  /** Pitch between caption lines and between invitation lines, and the gap between the caption block and the invitation. */
  captionPitch: 90,
  ctaPitch: 70,
  ctaGap: 40,
  safeRight: 880,
  safeBottom: 1560,
} as const;

/** Greedy word wrap by character budget, for short captions and the invitation that must stay inside the safe width. */
export function wrapCaption(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Character budgets the renderer wraps the beat caption and the invitation at. */
export const CAPTION_WRAP_CHARS = 32;
export const CTA_WRAP_CHARS = 36;

/** The lowest y a scene's caption block, plus its invitation if it has one, reaches when the caption starts at `captionTop`. */
export function textBlockBottom(scene: { captionText: string; cta: string | null }, captionTop: number): number {
  const captionLines = scene.captionText ? wrapCaption(scene.captionText, CAPTION_WRAP_CHARS).length : 0;
  const captionBottom = captionTop + captionLines * CHART.captionPitch;
  if (!scene.cta) return captionBottom;
  return captionBottom + CHART.ctaGap + wrapCaption(scene.cta, CTA_WRAP_CHARS).length * CHART.ctaPitch;
}

/** The label every illustrative (not account-data) scene must show on screen. */
export const ILLUSTRATIVE_LABEL = "Illustrative example";

export interface GridCell {
  index: number;
  x: number;
  y: number;
  size: number;
  tone: "good" | "bad";
}

export interface BarGeometry {
  x0: number;
  x1: number;
  y: number;
  h: number;
  /** x where the filled part ends and the missing part begins. */
  fillEnd: number;
}

export interface ChartGeometry {
  cells: GridCell[];
  bar: BarGeometry | null;
  /** Pair chart: marker line and the two bars, top to bottom. */
  pairBars: Array<{ x0: number; x1: number; y: number; h: number; label: string }>;
  /** Outcomes chart: the won and lost bars, top to bottom, each sized against the larger. */
  outcomeBars: Array<{ x0: number; x1: number; y: number; h: number }>;
  /** Outcomes chart: vertical centre of the large net figure. */
  netY: number;
  /** Bars chart: each row's bar, top to bottom, sized against the largest. */
  rowBars: Array<{ x0: number; x1: number; y: number; h: number }>;
  /** Top of the beat caption block, below whichever chart is drawn. */
  captionTop: number;
  /** Lowest and rightmost pixel any chart element reaches. */
  maxX: number;
  maxY: number;
}

/** Vertical pitch between rows of a bars chart: tighter as rows are added, so five rows still leave room for the caption and invitation. */
export function barsPitch(rows: number): number {
  return rows <= 3 ? 150 : rows === 4 ? 135 : 118;
}

export function headlineBottom(lines: number): number {
  return CHART.hookTop + lines * CHART.hookLineHeight;
}

function layoutGrid(grid: ChartGrid): { cells: GridCell[]; bottom: number; right: number } {
  const { total, cols, badAt } = grid;
  const width = CHART.right - CHART.left;
  const size = Math.min(CHART.gridMaxCell, Math.floor((width - (cols - 1) * CHART.gridGap) / cols));
  const rows = Math.ceil(total / cols);
  const gridW = cols * size + (cols - 1) * CHART.gridGap;
  const x0 = CHART.left + Math.floor((width - gridW) / 2);
  const cells: GridCell[] = [];
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    cells.push({ index: i, x: x0 + c * (size + CHART.gridGap), y: CHART.gridTop + r * (size + CHART.gridGap), size, tone: badAt.includes(i) ? "bad" : "good" });
  }
  return { cells, bottom: CHART.gridTop + rows * size + (rows - 1) * CHART.gridGap, right: x0 + gridW };
}

export function chartGeometry(chart: ChartSpec): ChartGeometry {
  let cells: GridCell[] = [];
  let bar: BarGeometry | null = null;
  const pairBars: ChartGeometry["pairBars"] = [];
  const outcomeBars: ChartGeometry["outcomeBars"] = [];
  const rowBars: ChartGeometry["rowBars"] = [];
  let netY = 0;
  let maxX: number = CHART.left;
  let maxY: number = headlineBottom(chart.lines.length);
  let captionTop: number = CHART.gridTop;

  if ((chart.kind === "grid_progress" || chart.kind === "outcomes") && chart.grid) {
    const laid = layoutGrid(chart.grid);
    cells = laid.cells;
    maxX = Math.max(maxX, laid.right);
    maxY = Math.max(maxY, laid.bottom);
    captionTop = laid.bottom + CHART.barGap;
    if (chart.kind === "grid_progress" && chart.progress) {
      const y = laid.bottom + CHART.barGap;
      const fillEnd = CHART.left + Math.round((CHART.right - CHART.left) * (chart.progress.value / chart.progress.target));
      bar = { x0: CHART.left, x1: CHART.right, y, h: CHART.barHeight, fillEnd };
      maxX = Math.max(maxX, CHART.right);
      maxY = Math.max(maxY, y + CHART.barHeight + 90);
      captionTop = y + CHART.barHeight + 110;
    }
    if (chart.kind === "outcomes" && chart.bars) {
      const largest = Math.max(...chart.bars.map((b) => b.amount), 1);
      const y0 = laid.bottom + CHART.outcomeGap;
      chart.bars.forEach((b, i) => {
        const len = Math.max(24, Math.round((CHART.right - CHART.left) * (b.amount / largest)));
        const y = y0 + i * CHART.outcomeRowGap;
        outcomeBars.push({ x0: CHART.left, x1: CHART.left + len, y, h: CHART.outcomeBarHeight });
        maxX = Math.max(maxX, CHART.left + len);
        maxY = Math.max(maxY, y + CHART.outcomeBarHeight);
      });
      netY = y0 + 2 * CHART.outcomeRowGap + 50;
      maxY = Math.max(maxY, netY + 70);
      captionTop = netY + 110;
    }
  }
  if (chart.kind === "pair" && chart.pair) {
    [chart.pair.aLabel, chart.pair.bLabel].forEach((label, i) => {
      const y = CHART.pairTop + i * CHART.pairRowGap;
      pairBars.push({ x0: CHART.pairMarkerX, x1: CHART.pairMarkerX + CHART.pairBarLength, y: y + 46, h: CHART.pairBarHeight, label });
      maxX = Math.max(maxX, CHART.pairMarkerX + CHART.pairBarLength);
      maxY = Math.max(maxY, y + 46 + CHART.pairBarHeight);
    });
    captionTop = CHART.pairTop + 2 * CHART.pairRowGap + 40;
  }
  if (chart.kind === "bars" && chart.rows) {
    const largest = Math.max(...chart.rows.map((r) => r.amount), 1);
    const pitch = barsPitch(chart.rows.length);
    chart.rows.forEach((r, i) => {
      const y = CHART.barsTop + i * pitch + CHART.barsLabelGap + 20;
      const len = Math.max(24, Math.round(CHART.barsBarLength * (r.amount / largest)));
      rowBars.push({ x0: CHART.left, x1: CHART.left + len, y, h: CHART.barsBarHeight });
      // The figure sits to the right of the bar (or inside it when the bar is long), so allow for its width.
      maxX = Math.max(maxX, CHART.left + len);
      maxY = Math.max(maxY, y + CHART.barsBarHeight);
    });
    captionTop = CHART.barsTop + chart.rows.length * pitch + 50;
  }
  if (chart.kind === "mock") {
    // A mock is drawn by the HTML renderer inside fixed boxes (mockLayout.ts): report their extent so the generic safe-area check covers it.
    for (const b of Object.values(MOCK_BOXES)) {
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    captionTop = MOCK_BOXES.caption.y;
  }
  return { cells, bar, pairBars, outcomeBars, rowBars, netY, captionTop, maxX, maxY };
}

/** The dollar gap a progress bar draws and labels: target - value, rounded down to whole dollars. */
export function progressGapDollars(value: number, target: number): number {
  return Math.floor(target - value + 1e-9);
}

const fmt = (n: number): string => String(n);

/**
 * Checks one chart scene: its structure, that every number it draws is supported by a fact the scene's claims cite
 * (the same rule every spoken or shown number is held to), that a progress bar's gap really is target - value, and that
 * nothing it draws runs under a platform overlay.
 */
export function validateChartScene(scene: SceneSpec, asset: VerifiedAsset): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (code: string, message: string) => issues.push({ severity: "error", code, sceneId: scene.sceneId, message });
  const chart = scene.chart;
  if (!chart) {
    add("chart_missing", "A scene with the chart layout must carry a chart spec.");
    return issues;
  }
  if (scene.crop || scene.clipTimeRangeSeconds) add("chart_has_crop", "A chart scene shows no part of the recording, so it has no crop or clip range.");
  if (!(chart.stage >= 1)) add("chart_bad_stage", "A chart's stage starts at 1.");
  if (chart.lines.length === 0 || chart.lines.join(" ").trim() !== scene.headline.trim()) {
    add("chart_lines_mismatch", `The chart's headline lines ("${chart.lines.join(" ")}") must join back to the scene headline ("${scene.headline}").`);
  }
  if (chart.kind === "outcomes") add("chart_outcomes_needs_illustration", "An outcomes chart is illustrative arithmetic, not account data: it must not cite a recording.");

  const supported = claimEvidenceNumbers(scene, asset);
  const needsFact = (what: string, token: string) => {
    if (!numberIsSupported(token, supported)) add("chart_unsupported_number", `The chart draws ${what} "${token}", which does not appear in any fact this scene cites.`);
  };

  if (chart.kind === "grid_progress") {
    const g = chart.grid;
    if (!g) {
      add("chart_missing_grid", "A grid_progress chart needs a grid.");
    } else {
      const bad = g.total - g.good;
      if (!(g.total >= 1) || g.good < 0 || g.good > g.total || !(g.cols >= 1)) add("chart_bad_grid", "The grid's counts are inconsistent.");
      else if (new Set(g.badAt).size !== g.badAt.length || g.badAt.length !== bad || g.badAt.some((i) => i < 0 || i >= g.total)) {
        add("chart_bad_grid", `The grid has ${bad} bad cell(s) but lists ${g.badAt.length} valid position(s).`);
      }
      needsFact("a cell count", fmt(g.total));
      needsFact("a cell count", fmt(g.good));
    }
    const p = chart.progress;
    if (p) {
      if (!(p.target > 0) || p.value < 0 || p.value > p.target) add("chart_bad_progress", "A progress bar's value must be between 0 and its target.");
      else {
        needsFact("the amount reached", fmt(p.value));
        needsFact("the target", fmt(p.target));
        for (const token of extractNumbers(p.label)) needsFact("a label figure", token);
        const gap = progressGapDollars(p.value, p.target);
        const shown = extractNumbers(p.gapLabel).map((t) => Number(t.replace(/[$,]/g, "")));
        if (shown.length !== 1 || shown[0] !== gap) add("chart_gap_mismatch", `The bar's gap label says "${p.gapLabel}", but target - value is $${gap}.`);
      }
    }
  } else if (chart.kind === "pair") {
    const pr = chart.pair;
    if (!pr) add("chart_missing_pair", "A pair chart needs its pair.");
    else needsFact("the bars' figure", pr.value);
  } else if (chart.kind === "bars") {
    const rows = chart.rows;
    if (!rows || rows.length < 2 || rows.length > 5) {
      add("chart_bad_rows", "A bars chart needs 2 to 5 rows.");
    } else {
      rows.forEach((r, i) => {
        const shown = extractNumbers(r.display).map((t) => Number(t.replace(/[$,%x+-]/g, "")));
        if (shown.length !== 1 || shown[0] !== r.amount) add("chart_row_display_mismatch", `Row ${i + 1} shows "${r.display}", but its amount is ${r.amount}.`);
        if (!(r.amount > 0)) add("chart_row_bad_amount", `Row ${i + 1}'s amount must be positive; a loss is a bad-toned row, not a negative one.`);
        if (r.display.trim().startsWith("-") && r.tone !== "bad") add("chart_row_tone", `Row ${i + 1} shows a negative figure, so its bar must be bad-toned.`);
        for (const token of extractNumbers(`${r.label} ${r.display}`)) needsFact(`row ${i + 1}'s figure`, token);
      });
      if (chart.highlight !== undefined && (!Number.isInteger(chart.highlight) || chart.highlight < 0 || chart.highlight >= rows.length)) {
        add("chart_bad_highlight", "The highlighted row must be one of the rows.");
      }
    }
  } else if (chart.kind === "mock") {
    const m = chart.mock;
    if (!m) {
      add("chart_missing_mock", "A mock chart needs its mock spec.");
    } else {
      for (const problem of mockFitProblems(m, chart.lines, scene.captionText, scene.cta)) add("chart_mock_text_too_long", problem);
      // Every number on the slide, in any text, must be a number in a fact this scene cites.
      // The closing invitation is the fixed approved line ("14 days"), not a figure the recording shows, so it is not checked here.
      for (const [field, text] of mockTexts(m, chart.lines, scene.captionText, null)) {
        for (const token of extractNumbers(text)) needsFact(`a figure in the ${field}`, token);
      }
      // "Your average" on the meter is 1 / the multiple the row shows, so a bar cannot imply a different ratio than its number.
      for (const [wi, w] of m.windows.entries()) {
        for (const [i, row] of w.rows.entries()) {
          if (!row.meter) continue;
          const multiple = Number(`${row.value}`.replace(/x$/i, ""));
          if (!/x$/i.test(row.value) || !(multiple > 1)) add("chart_mock_meter_unit", `Row ${i + 1} of window ${wi + 1} has a meter, so its value must be a multiple above 1 such as "2.5x".`);
          else if (Math.abs(row.meter.markAt - 1 / multiple) > 0.01) add("chart_mock_meter_mismatch", `Row ${i + 1} of window ${wi + 1}'s average mark is at ${row.meter.markAt}, but 1 / ${multiple} is ${(1 / multiple).toFixed(3)}.`);
        }
      }
      if (!/demo data/i.test(m.tag) && /demo data/i.test(scene.disclosure ?? "")) add("chart_mock_missing_demo_tag", 'The slide must say "Demo data" on itself.');
      for (const box of boxesOutsideSafeArea()) add("chart_mock_outside_safe_area", `The mock's ${box} box sits outside the area TikTok and YouTube Shorts leave clear.`);
    }
  }

  const geo = chartGeometry(chart);
  if (geo.maxX > CHART.safeRight || geo.maxY > CHART.safeBottom) {
    add("chart_under_overlay", `The chart reaches x=${geo.maxX}, y=${geo.maxY}; it must stay within x<=${CHART.safeRight} and y<=${CHART.safeBottom}.`);
  }
  // A mock draws its caption and invitation inside its own fixed boxes (checked above), not in the flowing text block below the chart.
  if (chart.kind !== "mock") {
    const textBottom = textBlockBottom(scene, geo.captionTop);
    if (textBottom > CHART.safeBottom) add("chart_text_under_overlay", `The caption and invitation block reaches y=${textBottom}; it must stay above y=${CHART.safeBottom}.`);
  }
  return issues;
}

/** Every figure an illustrative outcomes chart may show, computed from its four inputs alone. */
export function illustrationFigures(i: { trades: number; wins: number; avgWin: number; avgLoss: number }) {
  const losses = i.trades - i.wins;
  const totalWins = i.wins * i.avgWin;
  const totalLosses = losses * i.avgLoss;
  const net = totalWins - totalLosses;
  // Integer arithmetic first: (wins / trades) * 100 gives 55.00000000000001 for 11 of 20.
  const winRate = (i.wins * 100) / i.trades;
  return { losses, totalWins, totalLosses, net, winRate, netAbs: Math.abs(net) };
}

/**
 * Validation for an illustrative scene (a chart scene with no recording behind it): the arithmetic is the evidence. It
 * must carry the "Illustrative example" label, its win rate must be a whole percent, the bars and the net must be the
 * products and difference of the four inputs, and every number in any text the viewer sees must be one of the figures
 * those inputs produce. A card therefore cannot show a number the arithmetic doesn't.
 */
export function validateIllustrativeChart(scene: SceneSpec): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (code: string, message: string) => issues.push({ severity: "error", code, sceneId: scene.sceneId, message });
  const chart = scene.chart;
  if (!chart) {
    add("chart_missing", "A scene with the chart layout must carry a chart spec.");
    return issues;
  }
  if (scene.crop || scene.clipTimeRangeSeconds) add("chart_has_crop", "A chart scene shows no part of a recording, so it has no crop or clip range.");
  if (!(scene.disclosure ?? "").toLowerCase().includes(ILLUSTRATIVE_LABEL.toLowerCase())) {
    add("missing_illustrative_label", `A scene with no recording behind it is arithmetic, not account data: it must show "${ILLUSTRATIVE_LABEL}" on screen.`);
  }
  if (!(chart.stage >= 1)) add("chart_bad_stage", "A chart's stage starts at 1.");
  if (chart.lines.length === 0 || chart.lines.join(" ").trim() !== scene.headline.trim()) {
    add("chart_lines_mismatch", `The chart's headline lines ("${chart.lines.join(" ")}") must join back to the scene headline ("${scene.headline}").`);
  }
  if (chart.kind !== "outcomes" || !chart.illustration || !chart.grid || !chart.bars || !chart.net) {
    add("chart_illustration_incomplete", "An illustrative scene must be an outcomes chart with its illustration, grid, two bars and net.");
    return issues;
  }

  const i = chart.illustration;
  if (!(i.trades >= 2) || i.wins < 1 || i.wins >= i.trades || !(i.avgWin > 0) || !(i.avgLoss > 0)) {
    add("chart_bad_illustration", "The illustration needs at least one win and one loss, and positive average sizes.");
    return issues;
  }
  const f = illustrationFigures(i);
  if (!Number.isInteger(f.winRate)) add("chart_win_rate_not_whole", `${i.wins} of ${i.trades} is ${f.winRate}%, which is not a whole percent; pick counts that give one.`);
  if (f.net === 0) add("chart_no_paradox", "The net result is zero, so there is nothing to show.");

  const g = chart.grid;
  if (g.total !== i.trades || g.good !== i.wins || new Set(g.badAt).size !== g.badAt.length || g.badAt.length !== f.losses || g.badAt.some((x) => x < 0 || x >= g.total)) {
    add("chart_bad_grid", `The grid must have ${i.trades} cells, ${i.wins} good, and ${f.losses} bad cells at distinct positions.`);
  }
  const [won, lost] = chart.bars;
  if (won.amount !== f.totalWins || won.tone !== "good") add("chart_bar_mismatch", `The won bar must be ${f.totalWins} (${i.wins} x ${i.avgWin}) and good.`);
  if (lost.amount !== f.totalLosses || lost.tone !== "bad") add("chart_bar_mismatch", `The lost bar must be ${f.totalLosses} (${f.losses} x ${i.avgLoss}) and bad.`);
  for (const b of chart.bars) {
    const shown = extractNumbers(b.display).map((t) => Number(t.replace(/[$,+-]/g, "")));
    if (shown.length !== 1 || shown[0] !== b.amount) add("chart_bar_display_mismatch", `A bar shows "${b.display}", but its amount is ${b.amount}.`);
  }
  const netShown = extractNumbers(chart.net.display).map((t) => Number(t.replace(/[$,+-]/g, "")));
  if (netShown.length !== 1 || netShown[0] !== f.netAbs) add("chart_net_mismatch", `The net shows "${chart.net.display}", but the net is ${f.net}.`);
  if (chart.net.tone !== (f.net < 0 ? "bad" : "good")) add("chart_net_tone", "The net's colour must be bad for a loss and good for a profit.");
  if (chart.net.display.startsWith("-") !== f.net < 0) add("chart_net_sign", "The net's sign must match the arithmetic.");

  // Every number the viewer reads or hears must be one of the figures the four inputs produce.
  const allowed = [i.trades, i.wins, f.losses, f.winRate, i.avgWin, i.avgLoss, f.totalWins, f.totalLosses, f.netAbs].map(String);
  const texts: Array<[string, string]> = [
    ["headline", scene.headline],
    ["caption", scene.captionText],
    ["narration", scene.narration],
    ["takeaway", scene.takeaway],
    ["bar label", chart.bars.map((b) => `${b.label} ${b.display}`).join(" ")],
    ["net", chart.net.display],
  ];
  for (const [field, text] of texts) {
    for (const token of extractNumbers(text)) {
      if (!numberIsSupported(token, allowed)) add("chart_unsupported_number", `The ${field} shows "${token}", which the illustration's arithmetic does not produce.`);
    }
  }

  const geo = chartGeometry(chart);
  if (geo.maxX > CHART.safeRight || geo.maxY > CHART.safeBottom) {
    add("chart_under_overlay", `The chart reaches x=${geo.maxX}, y=${geo.maxY}; it must stay within x<=${CHART.safeRight} and y<=${CHART.safeBottom}.`);
  }
  const textBottom = textBlockBottom(scene, geo.captionTop);
  if (textBottom > CHART.safeBottom) add("chart_text_under_overlay", `The caption and invitation block reaches y=${textBottom}; it must stay above y=${CHART.safeBottom}.`);
  return issues;
}
