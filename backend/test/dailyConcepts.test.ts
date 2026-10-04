import { describe, it, expect } from "vitest";
import { DAILY_CONCEPT_ORDER, DAILY_PILOTS } from "../src/shortform/dailyConcepts";
import { nearCopies } from "../src/shortform/conceptVariety";
import { isOfferedPlan, MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";

const manifest = loadManifest();
const words = (t: string) => t.trim().split(/\s+/).length;

describe("the 30 daily concepts", () => {
  it("are 30 distinct plans in the catalog, offered, and listed in day order", () => {
    expect(DAILY_PILOTS).toHaveLength(30);
    expect(new Set(DAILY_CONCEPT_ORDER).size).toBe(30);
    DAILY_PILOTS.forEach((p, i) => {
      expect(p.planId, `day ${i + 1}`).toMatch(new RegExp(`^daily-${String(i + 1).padStart(2, "0")}-`));
      expect(MOTION_SCENE_PLANS).toContain(p);
      expect(isOfferedPlan(p)).toBe(true);
    });
  });

  it("are all valid plans that clear the render bar, with no errors", () => {
    for (const p of DAILY_PILOTS) {
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
    }
  });

  it("draw only on facts a verified recording holds: every beat cites at least one fact", () => {
    for (const p of DAILY_PILOTS) {
      for (const s of p.scenes) {
        const evidence = s.claims.flatMap((c) => c.evidence);
        expect(evidence.length, `${s.sceneId}`).toBeGreaterThan(0);
        for (const e of evidence) {
          const asset = manifest.assets.find((a) => a.id === e.assetId);
          expect(asset?.facts.some((f) => f.key === e.factKey), `${s.sceneId}: ${e.assetId}/${e.factKey}`).toBe(true);
        }
      }
    }
  });

  it("are not near-copies of each other, and no two about the same recording run back to back", () => {
    for (let i = 0; i < DAILY_PILOTS.length; i++) {
      for (let j = i + 1; j < DAILY_PILOTS.length; j++) expect(nearCopies(DAILY_PILOTS[i]!, DAILY_PILOTS[j]!), `${DAILY_PILOTS[i]!.planId} vs ${DAILY_PILOTS[j]!.planId}`).toBe(false);
    }
    for (let i = 1; i < DAILY_PILOTS.length; i++) expect(DAILY_PILOTS[i]!.scenes[0]!.assetId, `day ${i + 1}`).not.toBe(DAILY_PILOTS[i - 1]!.scenes[0]!.assetId);
  });

  it("say where in Fillbook the feature lives and are labelled Demo data on every beat", () => {
    for (const p of DAILY_PILOTS) {
      const opening = p.scenes[0]!;
      expect(`${opening.narration} ${opening.captionText}`, `${p.planId} opening`).toMatch(/fillbook|reports|insights|progress|plan|account health|daily brief/i);
      expect(p.scenes.map((s) => s.narration).join(" "), p.planId).toMatch(/\bFillbook\b/);
      for (const s of p.scenes) {
        expect(s.disclosure, s.sceneId).toBe("Demo data");
        expect(s.narration.trim().endsWith("?"), s.sceneId).toBe(false);
      }
    }
  });

  it("keep each spoken line to 7 words, with no cents and no behavior label that is not framed as a flag", () => {
    for (const p of DAILY_PILOTS) {
      for (const s of p.scenes) {
        expect(words(s.narration), `${p.planId}: "${s.narration}"`).toBeLessThanOrEqual(7);
        expect(s.narration, p.planId).not.toMatch(/\$[\d,]+\.\d/);
        if (/\b(?:revenge|oversized|tilt|fomo|overtrad\w*)\b/i.test(s.narration)) expect(s.narration, p.planId).toMatch(/\b(?:flag\w*|tagged|possible|review)\b/i);
      }
    }
  });

  it("never claim the product is live, real-time, or that it prevents a breach or promises a pass", () => {
    for (const p of DAILY_PILOTS) {
      const all = p.scenes.map((s) => `${s.narration} ${s.captionText} ${s.takeaway}`).join(" ");
      expect(all, p.planId).not.toMatch(/\b(?:live|real[- ]?time|guarantee\w*|prevent\w*|you will pass|helps? you pass)\b/i);
    }
  });
});
