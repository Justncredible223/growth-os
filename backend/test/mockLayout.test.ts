import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHART, validateChartScene } from "../src/shortform/chart";
import { MOCK_BOXES, MOCK_RIGHT_LIMIT, MOCK_SAFE, boxesOutsideSafeArea, cursorPath, heroFontSize, mockFitProblems, windowGeometry } from "../src/shortform/mockLayout";
import { PLATFORM_OVERLAY_ZONES, buildFfmpegArgs } from "../scripts/video-factory/render";
import { BARS_PILOTS, barsConvictionPlan, barsSizedUpPlan } from "../src/shortform/chartBarsConcepts";
import { MOCK_CARD_PILOTS } from "../src/shortform/chartMockConcepts";
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts";
import { FRESH_PILOTS } from "../src/shortform/freshConcepts";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";
import { MOCK_ENTRANCE, buildMockHtml, chromiumAvailable, createMockRenderer, measuredProblems } from "../scripts/video-factory/mockCard";
import type { SceneSpec } from "../src/shortform/types";

const manifest = loadManifest();
const chromium = await chromiumAvailable();
const plan = barsSizedUpPlan();
const frame = (s: SceneSpec) => ({ chart: s.chart!, headline: s.headline, captionText: s.captionText, cta: s.cta });

describe("mock slide layout keeps clear of TikTok and YouTube Shorts overlays", () => {
  it("every box sits inside the safe rectangle, which stops at the chart cards' own right edge", () => {
    expect(MOCK_RIGHT_LIMIT).toBe(CHART.safeRight);
    expect(boxesOutsideSafeArea()).toEqual([]);
    for (const [name, b] of Object.entries(MOCK_BOXES)) {
      expect(b.x + b.w, name).toBeLessThanOrEqual(880);
      expect(b.y + b.h, name).toBeLessThanOrEqual(1220);
      expect(b.y, name).toBeGreaterThanOrEqual(150);
    }
  });

  it("clears the measured platform overlay zones (button column from x=930 down from y=740, caption block from y=1600; the ad preview from y=1250 is covered by the 1220 limit below)", () => {
    const { rightColumn, captionTop } = PLATFORM_OVERLAY_ZONES;
    for (const [name, b] of Object.entries(MOCK_BOXES)) {
      expect(b.x + b.w, name).toBeLessThanOrEqual(rightColumn.x);
      expect(b.y + b.h, name).toBeLessThanOrEqual(captionTop);
      // Clear of the ad preview's promotion tag, which starts near y 1250.
      expect(b.y + b.h, name).toBeLessThanOrEqual(1220);
    }
  });

  it("the sized-up concept is a valid mock plan that clears the render bar", () => {
    expect(plan.scenes.every((s) => s.chart?.kind === "mock")).toBe(true);
    const v = validateScenePlan(plan, manifest, { checkFiles: true });
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(renderBar(plan).ok).toBe(true);
  });

  it("refuses text too long for its box, a number the facts do not support, and a wrong meter mark", () => {
    const s = plan.scenes[1]!;
    const run = (patch: object, extra: Partial<SceneSpec> = {}) =>
      validateChartScene({ ...s, ...extra, chart: { ...s.chart!, mock: { ...s.chart!.mock!, ...patch } } }, manifest.assets.find((a) => a.id === s.assetId)!).map((i) => i.code);
    const m = s.chart!.mock!;
    expect(run({ opening: [{ label: "A VERY LONG LABEL FOR A FIGURE", value: "$127", tone: "bad" }] })).toContain("chart_mock_text_too_long");
    expect(run({ opening: [{ label: "Lost", value: "$99,999", tone: "bad" }] })).toContain("chart_unsupported_number");
    const w = m.windows[1]!;
    const meterRow = w.rows.findIndex((r) => r.meter);
    expect(meterRow).toBeGreaterThanOrEqual(0);
    const rows = w.rows.map((r, i) => (i === meterRow ? { ...r, meter: { markAt: 0.9 } } : r));
    expect(run({ windows: [m.windows[0], { ...w, rows }] })).toContain("chart_mock_meter_mismatch");
    expect(run({ tag: "Sample" })).toContain("chart_mock_missing_demo_tag");
    expect(run({ focus: [{ ...m.focus[0], row: 9 }, m.focus[1]] })).toContain("chart_mock_text_too_long");
  });

  it("measured boxes past the right limit or the bottom are reported", () => {
    const ok = { box: "x", x: 100, y: 200, w: 500, h: 100, overflowX: 0, overflowY: 0, fit: true };
    expect(measuredProblems([ok])).toEqual([]);
    expect(measuredProblems([{ ...ok, w: 800 }]).join()).toMatch(/outside the clear area/);
    expect(measuredProblems([{ ...ok, y: 1500, h: 120 }]).join()).toMatch(/outside the clear area/);
    expect(measuredProblems([{ ...ok, overflowY: 12 }]).join()).toMatch(/overflows/);
  });

  it("the HTML rings a row and moves the cursor only on the beats that focus one", () => {
    const [b1, b2, b3, b4, b5] = plan.scenes.map((s) => buildMockHtml(frame(s)));
    expect(b1).not.toMatch(/class="ring/);
    expect(b1).not.toMatch(/data-cur=/);
    expect(b2).toMatch(/class="ring/);
    expect(b2).toMatch(/data-cur="/);
    expect(b3).toMatch(/class="ring/);
    expect(b4).not.toMatch(/data-cur=/);
    expect(b5).not.toMatch(/data-cur=/);
  });

  it("frame one already shows the payoff figure (no count up from zero), and every beat animates what it reveals", () => {
    const [b1, b2, b3, b4, b5] = plan.scenes.map((s) => buildMockHtml(frame(s)));
    expect(b1).toMatch(/class="hero [^"]*"[^>]*data-a="settle"[^>]*>\$127</);
    expect(b1).not.toMatch(/data-count/);
    expect(b1).toMatch(/data-a="slideup"/);
    expect(b2).toMatch(/data-a="dimrow"/);
    expect(b3).toMatch(/data-a="ring"/);
    expect(b4).toMatch(/class="win det"[^>]*data-a="slideup"/);
    expect(b5).toMatch(/class="cta"[^>]*data-a="pop"/);
  });

  it("beat 3's cursor starts where beat 2 left it when both ring rows of the same window", () => {
    const dow = BARS_PILOTS.find((p) => p.planId === "chart-bars-day-of-week")!;
    const [, b2, b3] = dow.scenes.map((s) => buildMockHtml(frame(s))) as [string, string, string];
    const cur = (html: string) => html.match(/data-cur="(\d+),(\d+),(\d+),(\d+)"/)!.slice(1).map(Number) as [number, number, number, number];
    const [, , x2, y2] = cur(b2);
    const [x3, y3, , y3b] = cur(b3);
    expect([x3, y3]).toEqual([x2, y2]);
    expect(y3b).toBeGreaterThan(y2!); // moves down to the second row
  });

  it("the via pill appears between the figure and the window on beats 2 and 3 only, and only when the concept sets one", () => {
    const conv = barsConvictionPlan();
    const [b1, b2, b3, b4, b5] = conv.scenes.map((s) => buildMockHtml(frame(s)));
    expect(b1).not.toMatch(/class="pill"/);
    expect(b2).toMatch(/class="pill"[^>]*>\s*<span>FILLBOOK REPORTS/);
    expect(b3).toMatch(/class="pill"/);
    expect(b4).not.toMatch(/class="pill"/);
    expect(b5).not.toMatch(/class="pill"/);
    const [, plain] = plan.scenes.map((s) => buildMockHtml(frame(s)));
    expect(plain).not.toMatch(/class="pill"/);
    expect(MOCK_BOXES.pill.y).toBeGreaterThanOrEqual(MOCK_BOXES.hero.y + MOCK_BOXES.hero.h);
    expect(MOCK_BOXES.pill.y + MOCK_BOXES.pill.h).toBeLessThanOrEqual(MOCK_BOXES.window.y);
  });

  it("refuses a via pill that is too long or carries a number", () => {
    const m = barsConvictionPlan().scenes[1]!.chart!.mock!;
    expect(mockFitProblems({ ...m, via: "Fillbook Reports" }, [], "x", null)).toEqual([]);
    expect(mockFitProblems({ ...m, via: "Fillbook Reports and Insights page" }, [], "x", null).join()).toMatch(/via pill/);
    expect(mockFitProblems({ ...m, via: "Reports 2" }, [], "x", null).join()).toMatch(/digit/);
  });

  it("hero figures shrink to fit the box", () => {
    expect(heroFontSize("$57")).toBe(210);
    expect(heroFontSize("-$1,201") * 7 * 0.56).toBeLessThanOrEqual(MOCK_SAFE.w);
    expect(heroFontSize("17 of 18")).toBeLessThan(210);
  });

  it("windows and the cursor stay inside the clear area", () => {
    for (const n of [2, 3, 4, 5]) {
      for (const kind of ["window", "windowLow"] as const) {
        if (kind === "windowLow" && n > 2) continue;
        const g = windowGeometry(n, kind);
        expect(g.top, `${kind} ${n}`).toBeGreaterThanOrEqual(MOCK_BOXES[kind].y);
        expect(g.top + g.height, `${kind} ${n}`).toBeLessThanOrEqual(MOCK_BOXES[kind].y + MOCK_BOXES[kind].h);
        for (let row = 0; row < n; row++) {
          const { from, to } = cursorPath(n, row, kind);
          for (const pt of [from, to]) {
            expect(pt.x).toBeLessThanOrEqual(MOCK_SAFE.x + MOCK_SAFE.w);
            expect(pt.y).toBeLessThanOrEqual(1220);
          }
        }
      }
    }
    const d = windowGeometry(5, "window", true);
    expect(d.top + d.height).toBeLessThanOrEqual(MOCK_BOXES.window.y + MOCK_BOXES.window.h);
  });

  it("a scene with entrance frames is read as an image sequence and held on its last frame", () => {
    const scene = (i: number) => ({ kind: "explanation" as const, label: "", durationSeconds: 3, backgroundColor: "0x05070a", narration: "", card: { backgroundPath: `/x/mock-${i}.png`, frames: { pattern: `mock-${i}-%03d.png`, count: 30 } } });
    const args = buildFfmpegArgs({ scenes: [scene(0), scene(1)], totalDurationSeconds: 6, voiceoverPath: "/x/v.mp3", assPath: "/x/c.ass", outputPath: "/x/o.mp4", silencePadSeconds: 0.3 }).join(" ");
    expect(args).toContain("mock-0-%03d.png");
    expect(args).not.toContain("-loop 1 -framerate 30 -t 3.000 -i mock-0");
    expect(args).toMatch(/tpad=stop_mode=clone/);
  });

  it.skipIf(!chromium)("renders every beat of every concept in the brand fonts with all boxes measured clear of the overlays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-"));
    const r = await createMockRenderer(dir);
    try {
      for (const p of [...BARS_PILOTS, ...MOCK_CARD_PILOTS, ...DAILY_PILOTS, ...FRESH_PILOTS]) {
        for (const [i, s] of p.scenes.entries()) expect(existsSync(await r.render(frame(s), join(dir, `${p.planId}-${i}.png`))), `${p.planId} beat ${i + 1}`).toBe(true);
      }
    } finally {
      await r.close();
    }
  }, 300_000);

  it.skipIf(!chromium)("writes an entrance sequence that ends on the finished slide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-seq-"));
    const r = await createMockRenderer(dir);
    try {
      const beat = await r.renderBeat(frame(plan.scenes[0]!), dir, "b0");
      expect(beat.count).toBe(Math.round(MOCK_ENTRANCE.seconds * MOCK_ENTRANCE.fps));
      expect(existsSync(join(dir, "b0-000.png"))).toBe(true);
      expect(existsSync(join(dir, `b0-${String(beat.count - 1).padStart(3, "0")}.png`))).toBe(true);
      expect(existsSync(beat.stillPath)).toBe(true);
    } finally {
      await r.close();
    }
  }, 60_000);
});
