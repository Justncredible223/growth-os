import { describe, it, expect } from "vitest";
import { CHART, barsPitch, chartGeometry, validateChartScene } from "../src/shortform/chart";
import { BARS_PILOTS, buildBarsPlan } from "../src/shortform/chartBarsConcepts";
import { DAILY_CONCEPT_ORDER } from "../src/shortform/dailyConcepts";
import { EXTRA_OFFERED_CONCEPT_IDS, MOTION_SCENE_PLANS, isChartPlan } from "../src/shortform/motionPlans";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";
import { findRepeatedHook } from "../src/content/videoHookVariety";
import { OriginalityEngine } from "../src/content/originalityEngine";
import { offeredChartConcepts } from "../src/video/dailyChartCardRequests";
import { buildChartCues } from "../scripts/video-factory/chartCues";
import type { ChartSpec, SceneSpec } from "../src/shortform/types";

const manifest = loadManifest();
const asset = (id: string) => manifest.assets.find((a) => a.id === id)!;
const withChart = (s: SceneSpec, patch: Partial<ChartSpec>): SceneSpec => ({ ...s, chart: { ...s.chart!, ...patch } });
const spoken = (p: { scenes: SceneSpec[] }) => p.scenes.map((s) => s.narration).join(" ");

// The nine shipped concepts are all HTML mocks now; the "bars" drawing is still supported, so it is tested on this plan.
const BARS_FIXTURE = buildBarsPlan({
  planId: "fixture-bars-day-of-week",
  title: "Tuesday made $157, Monday lost $57",
  topic: "A sample account's profit by day of the week, and the one weekday that lost money",
  variationId: "fixture-dow",
  assetId: "rec.p8-day-of-week.v1",
  expectedTopic: "day_of_week",
  lines: ["Tuesday made $157.", "Monday lost $57."],
  accent: "bad",
  highlight: 0,
  rows: [
    { label: "Monday · 5 trades", display: "-$57.32", amount: 57.32, tone: "bad" },
    { label: "Tuesday · 5 trades", display: "$157.12", amount: 157.12, tone: "good" },
    { label: "Wednesday · 4 trades", display: "$60.60", amount: 60.6, tone: "good" },
    { label: "Thursday · 4 trades", display: "$104.60", amount: 104.6, tone: "good" },
    { label: "Friday · 4 trades", display: "$122.08", amount: 122.08, tone: "good" },
  ],
  beats: [
    { stage: 1, seconds: 3.0, facts: ["dow.all"], narration: "Fillbook Reports show profit by day of the week.", takeaway: "Reports split profit by weekday.", caption: "Reports: profit by weekday." },
    { stage: 2, seconds: 3.2, facts: ["dow.all"], narration: "Tuesday made $157.12. Friday made $122.08.", takeaway: "The two best days.", caption: "Tuesday: $157.12." },
    { stage: 3, seconds: 3.4, facts: ["dow.all", "dow.monday"], narration: "But Monday is the only red day: -$57.32.", takeaway: "Monday is the only losing day.", caption: "Only Monday is red." },
    { stage: 4, seconds: 3.2, facts: ["dow.all"], closing: true, narration: "Tuesday made $157. Monday lost $57. Fillbook shows yours by weekday.", takeaway: "Look at your own weekdays.", caption: "Check your own weekdays." },
  ],
});

describe("bar-chart concepts", () => {
  it("are all valid plans that clear the render bar, with no errors", () => {
    expect(BARS_PILOTS.length).toBeGreaterThanOrEqual(9);
    for (const p of BARS_PILOTS) {
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
      expect(isChartPlan(p)).toBe(true);
      expect(MOTION_SCENE_PLANS).toContain(p);
    }
  });

  it("each cover a different part of the product", () => {
    const topics = BARS_PILOTS.map((p) => p.scenes[0]!.expectedTopics[0]);
    expect(new Set(topics).size).toBe(topics.length);
    expect(new Set(BARS_PILOTS.map((p) => `${p.scenes[0]!.assetId}/${p.scenes[0]!.expectedTopics[0]}`)).size).toBe(BARS_PILOTS.length);
  });

  it("do not repeat each other's hooks or wording, nor the other hand-made chart cards'", () => {
    const engine = new OriginalityEngine();
    const others = MOTION_SCENE_PLANS.filter((p) => isChartPlan(p) && !p.planId.startsWith("chart-o-"));
    for (const p of BARS_PILOTS) {
      const rest = others.filter((o) => o !== p);
      expect(findRepeatedHook(p.hook, rest.map((o) => o.hook)), p.planId).toBeNull();
      const sims = engine.compareAgainstRecent(spoken(p), rest.map(spoken));
      expect(sims[0]?.similarity ?? 0, p.planId).toBeLessThan(0.6);
    }
  });

  it("say where in Fillbook the feature lives, and never end a line on an engagement-bait question", () => {
    // The AI review (growth_strategist) failed a concept that showed numbers with no mechanism: it must name the product and the screen.
    for (const p of BARS_PILOTS) {
      const opening = p.scenes[0]!;
      expect(`${opening.narration} ${opening.captionText}`, `${p.planId} opening`).toMatch(/fillbook|reports|insights|progress|plan|account health/i);
      expect(spoken(p), `${p.planId}`).toMatch(/\bFillbook\b/);
      for (const s of p.scenes) expect(s.narration.trim().endsWith("?"), `${s.sceneId} ends on a question`).toBe(p.planId === "chart-bars-conviction" && s === opening);
    }
  });

  it("keep every chart inside the platforms' safe area, including the closing beat", () => {
    for (const p of BARS_PILOTS) {
      for (const s of p.scenes) expect(s.chart!.kind, s.sceneId).toBe("mock"); // HTML mocks: their boxes are checked in mockLayout.test.ts
    }
    for (const s of BARS_FIXTURE.scenes) {
      const g = chartGeometry(s.chart!);
      expect(g.maxX, s.sceneId).toBeLessThanOrEqual(CHART.safeRight);
      expect(g.maxY, s.sceneId).toBeLessThanOrEqual(CHART.safeBottom);
      expect(g.rowBars).toHaveLength(s.chart!.rows!.length);
    }
  });

  it("size each bar against the largest row", () => {
    const g = chartGeometry(BARS_FIXTURE.scenes[0]!.chart!);
    const lengths = g.rowBars.map((b) => b.x1 - b.x0);
    expect(Math.max(...lengths)).toBe(CHART.barsBarLength);
    expect(lengths[0]!).toBeLessThan(lengths[1]!); // Monday's $57.32 is shorter than Tuesday's $157.12
  });

  it("tighten the row pitch as rows are added", () => {
    expect(barsPitch(2)).toBeGreaterThanOrEqual(barsPitch(4));
    expect(barsPitch(4)).toBeGreaterThan(barsPitch(5));
  });
});

describe("validateChartScene for bars", () => {
  const plan = BARS_FIXTURE;
  const scene = plan.scenes[2]!;
  const rows = scene.chart!.rows!;
  const codes = (s: SceneSpec) => validateChartScene(s, asset(s.assetId!)).map((i) => i.code);

  it("accepts the real scene", () => expect(codes(scene)).toEqual([]));

  it("refuses a figure no cited fact supports", () => {
    const bad = withChart(scene, { rows: [{ ...rows[0]!, display: "-$99.99", amount: 99.99 }, ...rows.slice(1)] });
    expect(codes(bad)).toContain("chart_unsupported_number");
  });

  it("refuses a bar whose figure and amount disagree", () => {
    const bad = withChart(scene, { rows: [{ ...rows[0]!, amount: 70 }, ...rows.slice(1)] });
    expect(codes(bad)).toContain("chart_row_display_mismatch");
  });

  it("refuses a negative figure drawn as a good bar", () => {
    const bad = withChart(scene, { rows: [{ ...rows[0]!, tone: "good" }, ...rows.slice(1)] });
    expect(codes(bad)).toContain("chart_row_tone");
  });

  it("refuses a chart with too few or too many rows, or a highlight that is not a row", () => {
    expect(codes(withChart(scene, { rows: rows.slice(0, 1) }))).toContain("chart_bad_rows");
    expect(codes(withChart(scene, { rows: [...rows, rows[0]!] }))).toContain("chart_bad_rows");
    expect(codes(withChart(scene, { highlight: 9 }))).toContain("chart_bad_highlight");
  });
});

describe("bars drawing", () => {
  const s = BARS_FIXTURE.scenes;
  const cues = (i: number) => buildChartCues({ chart: s[i]!.chart!, headline: s[i]!.headline, captionText: s[i]!.captionText, cta: s[i]!.cta, start: 0, end: s[i]!.durationSeconds });

  it("draws every row's label and figure, and animates them in on the first beat only", () => {
    for (const row of s[0]!.chart!.rows!) {
      expect(cues(0).some((c) => c.text.includes(row.display))).toBe(true);
      expect(cues(0).some((c) => c.text.includes(row.label))).toBe(true);
    }
    expect(cues(0).some((c) => c.text.includes("\\clip(") && c.text.includes("\\t("))).toBe(true);
    expect(cues(1).some((c) => c.text.includes("\\clip("))).toBe(false);
  });

  it("rings the highlighted row on the third beat only", () => {
    const rings = (i: number) => cues(i).filter((c) => c.text.includes("\\bord6")).length;
    expect(rings(2)).toBe(3);
    expect(rings(0) + rings(1) + rings(3)).toBe(0);
  });
});

describe("the daily queue", () => {
  it("serves the 30 daily concepts in their fixed order, day 1 first, then the extra offered ones, and offers none of the first twelve", () => {
    const ids = offeredChartConcepts().map((c) => c.id);
    expect(ids).toEqual([...DAILY_CONCEPT_ORDER, ...EXTRA_OFFERED_CONCEPT_IDS]);
    expect(ids).toHaveLength(31);
    expect(EXTRA_OFFERED_CONCEPT_IDS).toEqual(["chart-bars-conviction"]);
    expect(ids.some((id) => !EXTRA_OFFERED_CONCEPT_IDS.includes(id) && BARS_PILOTS.some((p) => p.planId === id))).toBe(false);
  });

  it("never serves two concepts about the same recording back to back", () => {
    const byId = new Map(MOTION_SCENE_PLANS.map((p) => [p.planId, p] as const));
    const assets = offeredChartConcepts().map((c) => byId.get(c.id)!.scenes[0]!.assetId);
    for (let i = 1; i < assets.length; i++) expect(assets[i], `day ${i + 1}`).not.toBe(assets[i - 1]);
  });
});
