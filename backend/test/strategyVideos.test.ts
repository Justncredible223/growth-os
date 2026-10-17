import { describe, it, expect } from "vitest";
import { STRATEGIES, STRATEGY_PILOTS, STRATEGY_DAY_ORDER, isStrategyPlan } from "../src/shortform/strategyVideos";
import { ILLUSTRATION_TAG, SCENARIOS, strategyChartSvg, vwapOf } from "../src/shortform/strategyCharts";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";
import { buildVideoScriptFromScenePlan } from "../src/content/videoScriptWriter";
import { buildTeachHtml } from "../scripts/video-factory/mockCard";

const manifest = loadManifest();
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean);

describe("the 10 strategy videos", () => {
  it("cover the four setups the owner picked, and go out rotated so no setup runs twice in a row", () => {
    expect(STRATEGY_PILOTS).toHaveLength(10);
    const kinds = STRATEGY_DAY_ORDER.map((id) => (id.includes("orb") ? "orb" : id.includes("vwap") ? "vwap" : id.includes("retest") ? "retest" : "zones"));
    expect(new Set(kinds)).toEqual(new Set(["orb", "vwap", "retest", "zones"]));
    for (let i = 1; i < kinds.length; i++) expect(kinds[i], `slot ${i + 1}`).not.toBe(kinds[i - 1]);
    for (const p of STRATEGY_PILOTS) expect(isStrategyPlan(p)).toBe(true);
  });

  it("are valid plans that clear the render bar", () => {
    for (const p of STRATEGY_PILOTS) {
      expect(validateScenePlan(p, manifest).issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
    }
  });

  it("say one sentence a beat and never tell the viewer what to trade", () => {
    for (const p of STRATEGY_PILOTS) {
      for (const s of p.scenes) {
        expect(sentences(s.narration), `${p.planId}: ${s.narration}`).toHaveLength(1);
        expect(`${s.narration} ${s.headline} ${s.captionText}`, p.planId).not.toMatch(/\byou should\b|\bbuy now\b|\bsell now\b|\bguarantee|\bmost traders\b|\bmany traders\b/i);
      }
    }
  });

  it("draw a chart on the hook and the four setup beats, each tagged as an illustration", () => {
    for (const p of STRATEGY_PILOTS) {
      for (const s of p.scenes.slice(0, 5)) {
        expect(s.teach?.chart, s.sceneId).toBeDefined();
        expect(buildTeachHtml({ step: s.teach!.step, headline: s.headline, captionText: s.captionText, chart: s.teach!.chart })).toContain(ILLUSTRATION_TAG.toUpperCase());
      }
    }
  });

  it("captions say the charts are illustrations, never demo account data", () => {
    for (const p of STRATEGY_PILOTS) {
      const v = buildVideoScriptFromScenePlan(p);
      expect(v.youtubeTitle).toBe(p.title);
      for (const t of [v.youtubeDescription, v.tiktokCaption, v.instagramCaption]) {
        expect(t, p.planId).toMatch(/illustration/i);
        expect(t, p.planId).not.toMatch(/demo (account )?data/i);
      }
    }
  });
});

describe("the figures the videos say match the drawings", () => {
  it("the VWAP chop chart crosses VWAP 8 times, as the video says", () => {
    const k = SCENARIOS.vwapChop;
    const v = vwapOf(k);
    let crosses = 0;
    for (let i = 1; i < k.length; i++) if ((k[i]!.c - v[i]!) * (k[i - 1]!.c - v[i - 1]!) < 0) crosses++;
    expect(crosses).toBe(8);
    expect(STRATEGIES.find((s) => s.slug === "vwap-chop")!.beats[0].say).toContain("8 times");
  });

  it("the opening range is 47 to 56, and the break closes above it", () => {
    const range = SCENARIOS.orbBreak.slice(0, 3);
    expect(Math.max(...range.map((k) => k.h))).toBe(56);
    expect(Math.min(...range.map((k) => k.l))).toBe(47);
    expect(SCENARIOS.orbBreak[7]!.c).toBeGreaterThan(56);
    // The fake: closes above, then back inside on the next candle.
    expect(SCENARIOS.orbFake[7]!.c).toBeGreaterThan(56);
    expect(SCENARIOS.orbFake[8]!.c).toBeLessThan(56);
  });

  it("the retest risks about 3 points against about 6 to the target", () => {
    const entry = SCENARIOS.breakRetest[13]!.c;
    expect(entry - 54.6).toBeCloseTo(3, 0);
    expect(63.8 - entry).toBeCloseTo(6, 0);
  });

  it("the stop placements risk 7.5 and 12 points from the breakout close", () => {
    const entry = SCENARIOS.orbBreak[7]!.c;
    expect(entry - 51.5).toBe(7.5);
    expect(entry - 47).toBe(12);
  });

  it("the SVG is well formed and sized", () => {
    const svg = strategyChartSvg({ scenario: "demandSupply", show: 24, overlays: [{ kind: "vwap", label: "VWAP" }] });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="780"');
  });
});
