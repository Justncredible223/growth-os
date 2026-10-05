import { CANVAS, safeRect } from "./layout.js";
import type { MockSpec, Rect } from "./types.js";

/**
 * Fixed geometry for the "mock" chart kind: a product-mock slide (a source window, a Fillbook step, a Fillbook result
 * window) laid out in HTML and rendered to a 1080x1920 still (scripts/video-factory/mockCard.ts).
 *
 * Nothing on it may sit under what TikTok and YouTube Shorts draw over the video, so every box is checked against the
 * STRICTEST of every rule the pipeline already has:
 *   - SAFE_INSETS for tiktok (top 150, bottom 380, right 120) and youtube_shorts (top 120, bottom 300, right 120), both
 *     applied (layout.ts);
 *   - the owner's measured overlay zones (2026-09-25): the button column from x=930, and the caption/username block from
 *     y=1600 (render.ts PLATFORM_OVERLAY_ZONES);
 *   - the chart cards' own right edge, x=880 (CHART.safeRight), so a mock sits exactly where a chart card does.
 * The geometry is static data, so the check is pure, runs in CI, and a test proves every box clears it. The renderer
 * also measures the real rendered boxes in the browser as a second guard.
 */
const LEFT_MARGIN = 100;
/** The chart cards' right edge (CHART.safeRight in chart.ts, which a test keeps equal; chart.ts imports this file, so it cannot be imported back). */
export const MOCK_RIGHT_LIMIT = 880;
/**
 * Everything on a mock ends above this. A guest view of a normal post only covers the frame from about y 1520, but TikTok's
 * "Suggested promotion" ad preview (and a promoted post) stacks a promotion tag, a longer caption and a Learn More button
 * from about y 1250 (measured 2026-10-05), which hid the caption and the lower half of the slide. Ending above y 1220
 * keeps the whole slide visible in both.
 */
export const MOCK_BOTTOM_LIMIT = 1220;
const TOP_MARGIN = 170; // 20px past TikTok's 150px top inset, which is the stricter of the two platforms

export const MOCK_SAFE: Rect = (() => {
  const tiktok = safeRect("tiktok");
  const shorts = safeRect("youtube_shorts");
  const left = Math.max(tiktok.x, shorts.x, LEFT_MARGIN);
  const top = Math.max(tiktok.y, shorts.y, TOP_MARGIN);
  const right = Math.min(tiktok.x + tiktok.w, shorts.x + shorts.w, MOCK_RIGHT_LIMIT);
  const bottom = Math.min(tiktok.y + tiktok.h, shorts.y + shorts.h, MOCK_BOTTOM_LIMIT);
  return { x: left, y: top, w: right - left, h: bottom - top };
})();

export const MOCK_CANVAS = { width: CANVAS.width, height: CANVAS.height } as const;

/**
 * Where every element of the mock sits. Windows have a fixed height (rows share it), so text that is too long is a
 * validation error, not a reflow. `window` is the one box beats 2-4 draw their window in; beat 1 draws its window in
 * `window` under one hero figure, or in `windowLow` under two.
 */
export const MOCK_BOXES = {
  logo: { x: MOCK_SAFE.x, y: 170, w: 220, h: 58 },
  label: { x: MOCK_SAFE.x, y: 236, w: MOCK_SAFE.w, h: 46 },
  hero: { x: MOCK_SAFE.x, y: 280, w: MOCK_SAFE.w, h: 240 },
  pill: { x: MOCK_SAFE.x, y: 526, w: MOCK_SAFE.w, h: 42 },
  label2: { x: MOCK_SAFE.x, y: 526, w: MOCK_SAFE.w, h: 46 },
  hero2: { x: MOCK_SAFE.x, y: 570, w: MOCK_SAFE.w, h: 240 },
  window: { x: MOCK_SAFE.x, y: 572, w: MOCK_SAFE.w, h: 568 },
  windowLow: { x: MOCK_SAFE.x, y: 820, w: MOCK_SAFE.w, h: 320 },
  big: { x: MOCK_SAFE.x, y: 262, w: MOCK_SAFE.w, h: 320 },
  cta: { x: MOCK_SAFE.x, y: 640, w: MOCK_SAFE.w, h: 300 },
  caption: { x: MOCK_SAFE.x, y: 1146, w: MOCK_SAFE.w, h: 66 },
} as const satisfies Record<string, Rect>;

export type MockBoxName = keyof typeof MOCK_BOXES;

/** Font sizes (px) the template draws with. A hero figure shrinks to fit its box (see heroFontSize). */
export const MOCK_FONT = { hero: 210, heroLabel: 38, big: 94, bigLine: 104, caption: 46, rowLabel: 44, rowSub: 26, rowValue: 46 } as const;

/** The size a hero figure is drawn at: 210px, or smaller so a long value ("-$1,201") still fits the box. Space Grotesk digits and the dollar sign run up to about 0.56em wide. */
export function heroFontSize(value: string): number {
  return Math.min(MOCK_FONT.hero, Math.floor(MOCK_SAFE.w / (Math.max(value.length, 1) * 0.56)));
}

/** Most characters each text may have so it fits its fixed box (Space Grotesk / Manrope / JetBrains Mono at the sizes above). */
export const MOCK_LIMITS = {
  heroLabel: 26,
  heroValue: 9,
  openingHeroes: 2,
  windowTitle: 26,
  windows: 2,
  rowsMin: 2,
  rowsMax: 5,
  rowLabel: 16,
  rowSub: 26,
  rowValue: 10,
  tag: 12,
  via: 24,
  detailRowsMin: 3,
  detailRowsMax: 5,
  detailLabel: 24,
  detailValue: 12,
  footer: 30,
  caption: 30,
  cta: 80,
} as const;

/** Names of the boxes that stick out of the safe rectangle (an empty list means the layout is clear of every platform overlay). */
export function boxesOutsideSafeArea(): MockBoxName[] {
  const out: MockBoxName[] = [];
  for (const [name, b] of Object.entries(MOCK_BOXES) as Array<[MockBoxName, Rect]>) {
    if (b.x < MOCK_SAFE.x || b.y < MOCK_SAFE.y || b.x + b.w > MOCK_SAFE.x + MOCK_SAFE.w || b.y + b.h > MOCK_SAFE.y + MOCK_SAFE.h) out.push(name);
  }
  return out;
}

/** Every text in a mock spec, with a label for error messages. The numbers in these must all come from the facts a scene cites. */
export function mockTexts(spec: MockSpec, _headlineLines: string[], caption: string, cta: string | null): Array<[string, string]> {
  const t: Array<[string, string]> = [["tag", spec.tag]];
  const hero = (what: string, h: { label: string; value: string }) => t.push([`${what} label`, h.label], [`${what} value`, h.value]);
  spec.opening.forEach((h, i) => hero(`opening figure ${i + 1}`, h));
  spec.focus.forEach((f, i) => hero(`beat ${i + 2} figure`, f.hero));
  spec.windows.forEach((w, wi) => {
    t.push([`window ${wi + 1} title`, w.title]);
    w.rows.forEach((r, i) => {
      t.push([`window ${wi + 1} row ${i + 1} label`, r.label], [`window ${wi + 1} row ${i + 1} value`, r.value]);
      if (r.sub) t.push([`window ${wi + 1} row ${i + 1} line`, r.sub]);
    });
  });
  if (spec.details) {
    t.push(["detail title", spec.details.title], ["detail footer", spec.details.footer]);
    spec.details.rows.forEach((r, i) => t.push([`detail row ${i + 1} label`, r.label], [`detail row ${i + 1} value`, r.value]));
  }
  if (spec.via) t.push(["via pill", spec.via]);
  t.push(["caption", caption]);
  if (cta) t.push(["invitation", cta]);
  return t;
}

/** Character-budget and structure problems with a mock spec, as plain messages. Pure, so it runs wherever plans are validated. */
export function mockFitProblems(spec: MockSpec, _headlineLines: string[], caption: string, cta: string | null): string[] {
  const L = MOCK_LIMITS;
  const p: string[] = [];
  const over = (what: string, text: string, max: number) => {
    if (text.length > max) p.push(`${what} "${text}" is ${text.length} characters; the most that fits its box is ${max}.`);
  };
  const hero = (what: string, h: { label: string; value: string }) => {
    over(`${what} label`, h.label, L.heroLabel);
    over(`${what} value`, h.value, L.heroValue);
  };
  over("tag", spec.tag, L.tag);
  if (spec.via) {
    over("via pill", spec.via, L.via);
    if (/\d/.test(spec.via)) p.push(`The via pill "${spec.via}" has a digit; it names where the figure came from and carries no number.`);
  }
  if (spec.opening.length < 1 || spec.opening.length > L.openingHeroes) p.push(`The opening beat shows 1 to ${L.openingHeroes} figures, not ${spec.opening.length}.`);
  spec.opening.forEach((h, i) => hero(`opening figure ${i + 1}`, h));
  if (spec.windows.length < 1 || spec.windows.length > L.windows) p.push(`A mock has 1 to ${L.windows} windows, not ${spec.windows.length}.`);
  if (spec.opening.length === 2 && (spec.windows[0]?.rows.length ?? 0) > 2) p.push("With two opening figures the first window holds 2 rows, because it sits lower on the slide.");
  spec.windows.forEach((w, wi) => {
    over(`window ${wi + 1} title`, w.title, L.windowTitle);
    if (w.rows.length < L.rowsMin || w.rows.length > L.rowsMax) p.push(`Window ${wi + 1} holds ${L.rowsMin} to ${L.rowsMax} rows, not ${w.rows.length}.`);
    w.rows.forEach((r, i) => {
      over(`window ${wi + 1} row ${i + 1} label`, r.label, L.rowLabel);
      if (r.sub) over(`window ${wi + 1} row ${i + 1} line`, r.sub, L.rowSub);
      over(`window ${wi + 1} row ${i + 1} value`, r.value, L.rowValue);
    });
  });
  spec.focus.forEach((f, i) => {
    hero(`beat ${i + 2} figure`, f.hero);
    const w = spec.windows[f.window];
    if (!w) p.push(`Beat ${i + 2} points at window ${f.window + 1}, which does not exist.`);
    else if (!Number.isInteger(f.row) || f.row < 0 || f.row >= w.rows.length) p.push(`Beat ${i + 2} rings row ${f.row + 1} of window ${f.window + 1}, which does not exist.`);
  });
  if (spec.details) {
    const d = spec.details;
    over("detail title", d.title, L.windowTitle);
    over("detail footer", d.footer, L.footer);
    if (d.rows.length < L.detailRowsMin || d.rows.length > L.detailRowsMax) p.push(`The detail card holds ${L.detailRowsMin} to ${L.detailRowsMax} rows, not ${d.rows.length}.`);
    d.rows.forEach((r, i) => {
      over(`detail row ${i + 1} label`, r.label, L.detailLabel);
      over(`detail row ${i + 1} value`, r.value, L.detailValue);
    });
  }
  over("caption", caption, L.caption);
  if (cta) over("invitation", cta, L.cta);
  return p;
}

/** Height of a window's title bar (px). */
export const WINDOW_BAR = 64;
/** Height of the detail card's footer line (px). */
export const DETAIL_FOOTER = 56;

export interface WindowGeometry {
  top: number;
  height: number;
  rowH: number;
}

/**
 * Where a window with `rowCount` equal rows sits: rows share the box's height (at most 190px each), and the window is
 * centred in the `window` box, or starts at the top of `windowLow` under two hero figures. `detail` windows keep a footer line.
 */
export function windowGeometry(rowCount: number, kind: "window" | "windowLow", detail = false): WindowGeometry {
  const box = MOCK_BOXES[kind];
  const footer = detail ? DETAIL_FOOTER : 0;
  const rowH = Math.min(detail ? 90 : 190, Math.floor((box.h - WINDOW_BAR - footer) / Math.max(rowCount, 1)));
  const height = WINDOW_BAR + rowCount * rowH + footer;
  return { top: kind === "windowLow" ? box.y : box.y + Math.floor((box.h - height) / 2), height, rowH };
}

/** Where the cursor's tip rests on a row of a window, and where it comes from (below and to the right of it, still on the slide). */
export function cursorPath(rowCount: number, row: number, kind: "window" | "windowLow"): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const g = windowGeometry(rowCount, kind);
  const to = { x: MOCK_SAFE.x + 470, y: g.top + WINDOW_BAR + Math.round(g.rowH * (row + 0.5)) };
  return { from: { x: MOCK_SAFE.x + MOCK_SAFE.w - 40, y: Math.min(MOCK_BOXES.caption.y - 40, to.y + 260) }, to };
}
