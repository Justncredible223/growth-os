import { describe, it, expect } from "vitest";
import { resolveMotionScenePlan, extractMotionConceptRefFromRationale, listMotionConcepts, MOTION_CONCEPT_REF_PREFIX } from "../../scripts/video-factory/motionCatalog";
import { computeScenePlanHash } from "../../src/shortform/scenePlan";
import { PILOTS, PILOT_1, PILOT_2, PILOT_3 } from "../../src/shortform/pilots";
import { MOTION_SCENE_PLANS } from "../../src/shortform/motionPlans";
import { PAYOFF_PILOTS } from "../../src/shortform/payoffPilots";
import { STORY_PILOTS } from "../../src/shortform/storyPilots";
import { MORE_STORY_PILOTS } from "../../src/shortform/storyPilotsMore";
import { PILOT7_STORY_PILOTS } from "../../src/shortform/storyPilots7";
import { CHART_PILOTS } from "../../src/shortform/chartPilots";
import { OUTCOMES_PILOTS } from "../../src/shortform/chartConcepts";
import { BARS_PILOTS } from "../../src/shortform/chartBarsConcepts";
import { DAILY_PILOTS } from "../../src/shortform/dailyConcepts";
import { buildVideoScriptFromScenePlan } from "../../src/content/videoScriptWriter";

describe("resolveMotionScenePlan", () => {
  it("returns no plan (never throws) when the script carries no motionScenePlan reference at all", () => {
    const result = resolveMotionScenePlan({ hook: "Anything", script: "Anything.", motionScenePlan: undefined });
    expect(result.plan).toBeNull();
    expect(result.reason).toContain("no motionScenePlan reference");
  });

  it("returns no plan when motionScenePlan is explicitly null", () => {
    const result = resolveMotionScenePlan({ hook: "Anything", script: "Anything.", motionScenePlan: null });
    expect(result.plan).toBeNull();
  });

  it("resolves the exact plan when the reference's hash matches the current plan's content AND the approved script text equals the canonical text", () => {
    const canonical = buildVideoScriptFromScenePlan(PILOT_1);
    const result = resolveMotionScenePlan({ hook: PILOT_1.hook, script: canonical.script, motionScenePlan: { scenePlanId: PILOT_1.planId, scenePlanHash: computeScenePlanHash(PILOT_1) } });
    expect(result.plan?.planId).toBe(PILOT_1.planId);
  });

  it("throws on an unknown scenePlanId -- never silently falls back to stock footage for an explicit motion request", () => {
    expect(() => resolveMotionScenePlan({ hook: "x", script: "x", motionScenePlan: { scenePlanId: "not-a-real-plan", scenePlanHash: "a".repeat(64) } })).toThrow(/not a known verified ScenePlan/);
  });

  it("throws on a hash that doesn't match the current plan -- stale/modified content since generation", () => {
    expect(() => resolveMotionScenePlan({ hook: PILOT_2.hook, script: "x", motionScenePlan: { scenePlanId: PILOT_2.planId, scenePlanHash: "0".repeat(64) } })).toThrow(/content changed since this script was generated/);
  });

  it("throws when the resolved plan's hook doesn't match the approved script's own hook, even with a correct hash (defense in depth against a mismatched reference)", () => {
    // Hash IS correct for PILOT_3, but the caller's own hook field disagrees -- should never happen honestly, but must fail loudly if it does.
    expect(() =>
      resolveMotionScenePlan({ hook: "A completely different hook text", script: "x", motionScenePlan: { scenePlanId: PILOT_3.planId, scenePlanHash: computeScenePlanHash(PILOT_3) } }),
    ).toThrow(/does not match that plan's own hook/);
  });

  it("a SAME-hook-different-body script must not select the pilot: a reference to a DIFFERENT plan than the one the hook actually belongs to is rejected", () => {
    // PILOT_1's hook, but incorrectly referencing PILOT_2's plan id (with PILOT_2's own valid hash) --
    // simulates a same-hook-coincidence attack where only the reference, not the hook, was swapped.
    expect(() =>
      resolveMotionScenePlan({ hook: PILOT_1.hook, script: "x", motionScenePlan: { scenePlanId: PILOT_2.planId, scenePlanHash: computeScenePlanHash(PILOT_2) } }),
    ).toThrow(/does not match that plan's own hook/);
  });

  it("rejects a valid scenePlanId+hash+hook whose approved SCRIPT TEXT was altered after generation -- hash matching the plan is not enough on its own", () => {
    // Simulates a revision/edit step that rewrote the approved narration
    // (different figures/claims) while leaving the motionScenePlan
    // reference itself untouched -- the plan and hash both check out, but
    // the approved row no longer says what the plan actually generates.
    const canonical = buildVideoScriptFromScenePlan(PILOT_2);
    expect(canonical.script).not.toBe("A completely rewritten narration with different figures and claims.");
    expect(() =>
      resolveMotionScenePlan({
        hook: PILOT_2.hook, // hook left alone by the hypothetical edit
        script: "A completely rewritten narration with different figures and claims.",
        motionScenePlan: { scenePlanId: PILOT_2.planId, scenePlanHash: computeScenePlanHash(PILOT_2) }, // hash still valid -- the PLAN itself never changed
      }),
    ).toThrow(/no longer equals the canonical text/);
  });
});

describe("computeScenePlanHash", () => {
  it("is sensitive to a scene's narration text -- a body/figures change invalidates any reference generated before it", () => {
    const original = computeScenePlanHash(PILOT_2);
    const modified = { ...PILOT_2, scenes: [{ ...PILOT_2.scenes[0]!, narration: "Completely different narration text." }, ...PILOT_2.scenes.slice(1)] };
    expect(computeScenePlanHash(modified)).not.toBe(original);
  });

  it("is sensitive to a claim's text -- changing an evidence claim invalidates the reference", () => {
    const original = computeScenePlanHash(PILOT_1);
    const modified = { ...PILOT_1, scenes: [{ ...PILOT_1.scenes[0]!, claims: [{ ...PILOT_1.scenes[0]!.claims[0]!, text: "A different claim entirely." }] }, ...PILOT_1.scenes.slice(1)] };
    expect(computeScenePlanHash(modified)).not.toBe(original);
  });

  it("is deterministic -- the same plan hashes identically every time", () => {
    expect(computeScenePlanHash(PILOT_1)).toBe(computeScenePlanHash(PILOT_1));
  });
});

describe("extractMotionConceptRefFromRationale", () => {
  it("finds the marker anywhere in a human-readable rationale sentence", () => {
    const rationale = `Owner-requested motion-backed video concept, entered directly in the app: "Balance isn't your buffer.". ${MOTION_CONCEPT_REF_PREFIX}${PILOT_2.planId}`;
    expect(extractMotionConceptRefFromRationale(rationale)).toBe(PILOT_2.planId);
  });

  it("returns null for an ordinary rationale with no marker", () => {
    expect(extractMotionConceptRefFromRationale("High audience relevance, strong Fillbook fit.")).toBeNull();
  });
});

describe("listMotionConcepts", () => {
  it("lists exactly the known verified plans (the pilots plus the payoff variants), never an open-ended/inferred set", () => {
    const concepts = listMotionConcepts();
    expect(concepts.map((c) => c.id).sort()).toEqual(MOTION_SCENE_PLANS.map((p) => p.planId).sort());
    expect(concepts.map((c) => c.id).sort()).toEqual([...PILOTS, ...PAYOFF_PILOTS, ...STORY_PILOTS, ...MORE_STORY_PILOTS, ...PILOT7_STORY_PILOTS, ...CHART_PILOTS, ...BARS_PILOTS, ...OUTCOMES_PILOTS, ...DAILY_PILOTS].map((p) => p.planId).sort());
    // 2026-09-30: 62 -> 65, the +3 being the payoff-layout variants of pilot 7 (payoffPilots.ts); 65 -> 66, the +1 being the
    // story rebuild of pilot 20 (storyPilots.ts).
    // 66 -> 69: the story rebuilds of pilots 19, 21 and 22 (storyPilotsMore.ts). 69 -> 72: those of pilot 7 (storyPilots7.ts).
    expect(concepts).toHaveLength(126); // 96 -> 126: the 30 daily concepts (dailyConcepts.ts); 72 -> 75: the chart-card concepts (chartPilots.ts); 75 -> 87: the illustrative outcomes cards (chartConcepts.ts); 87 -> 96: the bar-chart concepts (chartBarsConcepts.ts)
    // Below: the pilots alone.
    expect(concepts.filter((c) => PILOTS.some((p) => p.planId === c.id))).toHaveLength(62); // 18 recorded concepts plus two angles each (2026-09-25), plus 3 opening-only A/B variants (2026-09-27), plus the 5-concept high-stakes batch (2026-09-28, PILOT_19-23), see pilots.ts's openingOnlyVariant
    expect(new Set(concepts.map((c) => c.title)).size).toBe(concepts.length); // availability is tracked by title
    for (const c of concepts) expect(c.hook.length).toBeGreaterThan(0);
  });
});
