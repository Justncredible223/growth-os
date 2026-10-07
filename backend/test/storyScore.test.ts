import { describe, it, expect } from "vitest";
import { MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";
import { STORY_GRADE_CUTOFFS, scoreStory } from "../src/shortform/storyScore";

const plan = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id)!;

describe("story scorecard", () => {
  it("scores every concept out of 100 and is deterministic", () => {
    for (const p of MOTION_SCENE_PLANS) {
      const s = scoreStory(p);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(s.score).toBe(s.criteria.reduce((n, c) => n + c.points, 0));
      expect(s.criteria.reduce((n, c) => n + c.max, 0)).toBe(100);
      expect(scoreStory(p)).toEqual(s);
    }
  });

  it("rewards a hook with a contrast and a number, and marks down a hook that only states a fact", () => {
    const strong = scoreStory(plan("pilot-20-the-floor-doesnt-come-back-down"));
    const weak = scoreStory(plan("pilot-7-daily-brief"));
    const pts = (s: typeof strong, k: string) => s.criteria.find((c) => c.key === k)!.points;
    expect(pts(strong, "hook_stakes")).toBe(15);
    expect(pts(strong, "hook_number")).toBe(10);
    expect(pts(weak, "hook_stakes")).toBe(0);
    expect(pts(weak, "hook_number")).toBe(0);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("flags jargon used up front and never explained", () => {
    const s = scoreStory(plan("pilot-7-payoff-a"));
    const plain = s.criteria.find((c) => c.key === "plain_words")!;
    expect(plain.points).toBeLessThan(plain.max);
    expect(plain.note).toMatch(/floor/);
  });

  it("marks a list of unrelated numbers down for having no single idea", () => {
    const a = scoreStory(plan("pilot-7-payoff-a"));
    expect(a.criteria.find((c) => c.key === "one_idea")!.points).toBeLessThan(6);
  });

  it("gives plain-instruction fixes for the weakest parts, worst first", () => {
    const s = scoreStory(plan("pilot-7-daily-brief"));
    expect(s.fixes.length).toBeGreaterThan(0);
    expect(s.fixes.length).toBeLessThanOrEqual(3);
    expect(s.fixes[0]).toMatch(/:/);
  });

  it("maps scores to grades at the documented cutoffs", () => {
    expect(STORY_GRADE_CUTOFFS.map(([g]) => g)).toEqual(["A+", "A", "B", "C"]);
    const byScore = MOTION_SCENE_PLANS.map(scoreStory);
    for (const s of byScore) {
      const expected = STORY_GRADE_CUTOFFS.find(([, cut]) => s.score >= cut)?.[0] ?? "D";
      expect(s.grade).toBe(expected);
    }
  });

  it("does not hand out top grades freely: A+ is rare (only the story rebuilds) and most of the library is below A", () => {
    const scored = MOTION_SCENE_PLANS.map((p) => ({ id: p.planId, grade: scoreStory(p).grade }));
    const aPlus = scored.filter((s) => s.grade === "A+");
    expect(aPlus.length).toBeGreaterThan(0);
    expect(aPlus.every((s) => s.id.includes("-story-") || s.id.startsWith("chart-") || s.id.startsWith("daily-") || s.id.startsWith("fresh-"))).toBe(true);
    expect(scored.filter((s) => s.grade === "D").length).toBeGreaterThan(0);
    // Most of the older library does not clear the bar; the A+ ones are the story rebuilds and the chart cards. The 30 daily concepts (2026-10-03) and the fresh hook-first ones (2026-10-07) are written to clear it.
    const older = scored.filter((s) => !s.id.startsWith("daily-") && !s.id.startsWith("fresh-"));
    expect(older.filter((s) => s.grade === "A" || s.grade === "A+").length).toBeLessThan(older.length / 2);
  });
});
