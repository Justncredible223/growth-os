import { describe, it, expect } from "vitest";
import { FRESH_PILOTS, FRESH_CONCEPT_ORDER } from "../src/shortform/freshConcepts";
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts";
import { nearCopies } from "../src/shortform/conceptVariety";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS, EXTRA_OFFERED_CONCEPT_IDS, dailyPosition, isOfferedPlan } from "../src/shortform/motionPlans";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { scoreStory, renderBar } from "../src/shortform/storyScore";

const manifest = loadManifest();
const words = (t: string) => t.trim().split(/\s+/).length;

describe("the 9 fresh hook-first concepts (the whole offered pool since 2026-10-07)", () => {
  it("are the only offered plans, in order, and every older plan stays resolvable but is not offered", () => {
    expect(FRESH_PILOTS).toHaveLength(9);
    expect([...OFFERED_DAILY_CONCEPT_IDS]).toEqual(FRESH_CONCEPT_ORDER);
    expect(EXTRA_OFFERED_CONCEPT_IDS).toEqual([]);
    expect(MOTION_SCENE_PLANS.filter(isOfferedPlan).map((p) => p.planId)).toEqual(FRESH_CONCEPT_ORDER);
    FRESH_PILOTS.forEach((p, i) => expect(dailyPosition(p.planId)).toBe(i));
    for (const p of DAILY_PILOTS) {
      expect(MOTION_SCENE_PLANS).toContain(p);
      expect(dailyPosition(p.planId)).toBe(-1);
    }
  });

  it("are valid plans that clear the A/A+ render bar and cite verified facts on every beat", () => {
    for (const p of FRESH_PILOTS) {
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
      expect(["A", "A+"], p.planId).toContain(scoreStory(p).grade);
      for (const s of p.scenes) {
        const evidence = s.claims.flatMap((c) => c.evidence);
        expect(evidence.length, s.sceneId).toBeGreaterThan(0);
        for (const e of evidence) expect(manifest.assets.find((a) => a.id === e.assetId)?.facts.some((f) => f.key === e.factKey), `${s.sceneId}: ${e.factKey}`).toBe(true);
      }
    }
  });

  it("open on the hook (a figure or a question in the first spoken line) and end on a question; no other beat is a question", () => {
    for (const p of FRESH_PILOTS) {
      const first = p.scenes[0]!.narration;
      expect(/\d|\?/.test(`${first} ${p.hook}`), `${p.planId} opening "${first}" / hook "${p.hook}"`).toBe(true);
      // The old pool's opening ("Fillbook's X shows...") described the screen; the hook must come first.
      expect(first, p.planId).not.toMatch(/^(?:your )?fillbook/i);
      const last = p.scenes[p.scenes.length - 1]!;
      expect(last.narration.trim().endsWith("?"), `${p.planId} closing`).toBe(true);
      expect(last.cta, p.planId).not.toBeNull();
      p.scenes.slice(1, -1).forEach((s) => expect(s.narration.trim().endsWith("?"), s.sceneId).toBe(false));
    }
  });

  it("are not near-copies of each other and no two about the same recording run back to back", () => {
    for (let i = 0; i < FRESH_PILOTS.length; i++) {
      for (let j = i + 1; j < FRESH_PILOTS.length; j++) expect(nearCopies(FRESH_PILOTS[i]!, FRESH_PILOTS[j]!), `${FRESH_PILOTS[i]!.planId} vs ${FRESH_PILOTS[j]!.planId}`).toBe(false);
    }
    for (let i = 1; i < FRESH_PILOTS.length; i++) expect(FRESH_PILOTS[i]!.scenes[0]!.assetId).not.toBe(FRESH_PILOTS[i - 1]!.scenes[0]!.assetId);
  });

  it("name Fillbook, are labelled Demo data on every beat, keep lines to 7 words and whole dollars, and frame behavior labels as flags", () => {
    for (const p of FRESH_PILOTS) {
      expect(p.scenes.map((s) => s.narration).join(" "), p.planId).toMatch(/\bFillbook\b/);
      for (const s of p.scenes) {
        expect(s.disclosure, s.sceneId).toBe("Demo data");
        expect(words(s.narration), `${p.planId}: "${s.narration}"`).toBeLessThanOrEqual(7);
        expect(s.narration, p.planId).not.toMatch(/\$[\d,]+\.\d/);
        if (/\b(?:revenge|oversized|tilt|fomo|overtrad\w*)\b/i.test(s.narration)) expect(s.narration, p.planId).toMatch(/\b(?:flag\w*|tagged|possible|review)\b/i);
      }
    }
  });

  it("never claim the product is live or real-time, prevents a breach, promises a pass or a payout, or gives advice", () => {
    for (const p of FRESH_PILOTS) {
      const all = p.scenes.map((s) => `${s.narration} ${s.captionText} ${s.takeaway}`).join(" ") + ` ${p.title}`;
      expect(all, p.planId).not.toMatch(/\b(?:live|real[- ]?time|guarantee\w*|prevent\w*|you will pass|helps? you pass|payout|should|must)\b/i);
    }
  });
});
