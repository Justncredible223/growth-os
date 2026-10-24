import { describe, it, expect } from "vitest";
import { EXPLAINERS, EXPLAINERS_OFFERED, EXPLAINER_PILOTS, EXPLAINER_ORDER, EXPLAINER_SERIES, isExplainerPlan } from "../src/shortform/explainers";
import { STRATEGY_ORDER } from "../src/shortform/strategyVideos";
import { findSuppliedVoice } from "../scripts/video-factory/suppliedVoice";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS, RETIRED_FRESH_DAILY_ORDER, dailyPosition, isNarratedMockPlan, isOfferedPlan } from "../src/shortform/motionPlans";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";
import { FRESH_PILOTS } from "../src/shortform/freshConcepts";
import { FRESH2_PILOTS } from "../src/shortform/freshConcepts2";

const manifest = loadManifest();
const sources = new Map([...FRESH_PILOTS, ...FRESH2_PILOTS].map((p) => [p.planId, p] as const));
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);
/** The clips already posted before the explainers (days 1-9 of the retired order). */
const POSTED = RETIRED_FRESH_DAILY_ORDER.slice(0, 9);
const cardOf = (id: string) => id.replace(/^(fresh-\d{2})b-(.*)-recording$/, "$1-$2");

describe("the explainers", () => {
  it("fill 20 of the 30 days, the other 10 (every third day) going to the strategy videos", () => {
    expect(EXPLAINER_PILOTS).toHaveLength(30);
    expect(EXPLAINERS_OFFERED).toHaveLength(20);
    expect(OFFERED_DAILY_CONCEPT_IDS).toHaveLength(30);
    expect(new Set(OFFERED_DAILY_CONCEPT_IDS).size).toBe(30);
    OFFERED_DAILY_CONCEPT_IDS.forEach((id, i) => {
      expect(dailyPosition(id)).toBe(i);
      expect(id.startsWith((i + 1) % 3 === 0 ? "strategy-" : "explain-"), `day ${i + 1}: ${id}`).toBe(true);
    });
    expect(OFFERED_DAILY_CONCEPT_IDS.filter((id) => id.startsWith("explain-"))).toEqual([...EXPLAINERS_OFFERED]);
    expect([...OFFERED_DAILY_CONCEPT_IDS.filter((id) => id.startsWith("strategy-"))].sort()).toEqual([...STRATEGY_ORDER].sort());
    expect(MOTION_SCENE_PLANS.filter(isOfferedPlan).map((p) => p.planId).sort()).toEqual([...OFFERED_DAILY_CONCEPT_IDS].sort());
    for (const p of EXPLAINER_PILOTS) {
      expect(p.series).toBe(EXPLAINER_SERIES);
      expect(isExplainerPlan(p)).toBe(true);
      expect(isNarratedMockPlan(p), p.planId).toBe(true);
    }
  });

  it("leave out number 5 and the ones built on clips already posted", () => {
    expect(EXPLAINERS_OFFERED).not.toContain(EXPLAINER_ORDER[4]);
    for (const id of EXPLAINER_ORDER.slice(21)) expect(EXPLAINERS_OFFERED).not.toContain(id);
  });

  it("every offered video has a recorded voice part for each beat", () => {
    for (const id of OFFERED_DAILY_CONCEPT_IDS) {
      const plan = MOTION_SCENE_PLANS.find((p) => p.planId === id)!;
      expect(findSuppliedVoice(plan.planId, plan.scenes.length)?.kind, id).toBe("parts");
    }
  });

  it("each use a different example concept, and the examples not yet posted come first", () => {
    const used = EXPLAINERS.map((e) => e.source);
    expect(new Set(used).size).toBe(30);
    const postedCards = new Set(POSTED.map(cardOf));
    const firstPosted = used.findIndex((s) => postedCards.has(s));
    expect(firstPosted).toBe(21);
    expect(used.slice(21).every((s) => postedCards.has(s))).toBe(true);
  });

  it("open on a new card instead of the example's hook exactly when that example was already posted", () => {
    const postedCards = new Set(POSTED.map(cardOf));
    // 2026-10-24 direct-hook test: five unposted explainers also open on their own rewritten card, to compare watch time against the rest.
    const DIRECT_HOOK_TEST = new Set(["one-day-carries-month", "edge-score", "normal-trade-count", "weak-hour", "weekday-results"]);
    for (const e of EXPLAINERS) expect(Boolean(e.hook), e.slug).toBe(postedCards.has(e.source) || DIRECT_HOOK_TEST.has(e.slug));
  });

  it("are valid plans with verified figures that clear the render bar", () => {
    for (const p of EXPLAINER_PILOTS) {
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
    }
  });

  it("keep the example's verified beats word for word, around four teaching cards", () => {
    for (const [i, e] of EXPLAINERS.entries()) {
      const p = EXPLAINER_PILOTS[i]!;
      const src = sources.get(e.source)!;
      expect(p.scenes).toHaveLength(9);
      const example = [p.scenes[1], p.scenes[2], p.scenes[7], p.scenes[8]].map((s) => s!.narration);
      expect(example, p.planId).toEqual([src.scenes[1], src.scenes[2], src.scenes[3], src.scenes[4]].map((s) => s!.narration));
      expect(p.scenes.slice(3, 7).map((s) => s.narration)).toEqual(e.teach.map((t) => t.say));
      // Only the last scene invites, and it carries the handle.
      expect(p.scenes.filter((s) => s.cta).map((s) => s.sceneId)).toEqual([p.scenes[8]!.sceneId]);
    }
  });

  it("teach without figures, in one sentence a card, so one recording per video cuts cleanly", () => {
    for (const e of EXPLAINERS) {
      for (const t of e.teach) {
        expect(t.say, e.slug).not.toMatch(/\d/);
        expect(t.headline, e.slug).not.toMatch(/\d/);
        expect(sentences(t.say), `${e.slug}: ${t.say}`).toHaveLength(1);
        expect(t.headline.length, t.headline).toBeLessThanOrEqual(34);
        expect(t.caption.length, t.caption).toBeLessThanOrEqual(110);
      }
      if (e.hook) expect(sentences(e.hook.say), `${e.slug}: ${e.hook.say}`).toHaveLength(1);
    }
  });

  it("have titles of their own (the app treats a concept as made when its title exists) and say nothing about 'most traders'", () => {
    const titles = MOTION_SCENE_PLANS.map((p) => p.title.toLowerCase());
    for (const p of EXPLAINER_PILOTS) expect(titles.filter((t) => t === p.title.toLowerCase()), p.title).toHaveLength(1);
    for (const p of EXPLAINER_PILOTS) for (const s of p.scenes) expect(s.narration, p.planId).not.toMatch(/\b(most|many) traders\b/i);
  });

  it("never show the same recording two days in a row", () => {
    const rec = (i: number) => EXPLAINER_PILOTS[i]!.scenes.find((s) => s.assetId)!.assetId;
    for (let i = 1; i < EXPLAINER_PILOTS.length; i++) expect(rec(i), `day ${i + 1}`).not.toBe(rec(i - 1));
  });
});
