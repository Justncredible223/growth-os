import { describe, it, expect } from "vitest";
import { MOTION_SCENE_PLANS, isPayoffPlan } from "../src/shortform/motionPlans";
import { PILOTS } from "../src/shortform/pilots";
import { PAYOFF_PILOTS } from "../src/shortform/payoffPilots";
import { STORY_PILOTS } from "../src/shortform/storyPilots";
import { MORE_STORY_PILOTS } from "../src/shortform/storyPilotsMore";
import { PILOT7_STORY_PILOTS } from "../src/shortform/storyPilots7";
import { CHART_PILOTS } from "../src/shortform/chartPilots";
import { OUTCOMES_PILOTS } from "../src/shortform/chartConcepts";
import { BARS_PILOTS } from "../src/shortform/chartBarsConcepts";
import { DAILY_PILOTS } from "../src/shortform/dailyConcepts";
import { listMotionConcepts, resolveMotionScenePlan } from "../scripts/video-factory/motionCatalog";
import { buildVideoScriptFromScenePlan } from "../src/content/videoScriptWriter";
import { manualMotionConceptTitle, manualMotionConceptOpportunityInput } from "../src/opportunities/manualMotionConcept";
import { extractMotionConceptRefFromRationale } from "../scripts/video-factory/motionCatalog";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { PAYOFF_SPEECH_RATE, PAYOFF_TRANSITION_SECONDS } from "../scripts/video-factory/payoffCues";

describe("the motion catalog includes the payoff variants", () => {
  it("lists every original pilot, the three payoff variants and the story rebuilds, once each", () => {
    const ids = listMotionConcepts().map((c) => c.id);
    expect(ids).toEqual(MOTION_SCENE_PLANS.map((p) => p.planId));
    expect(ids.length).toBe(PILOTS.length + PAYOFF_PILOTS.length + STORY_PILOTS.length + MORE_STORY_PILOTS.length + PILOT7_STORY_PILOTS.length + CHART_PILOTS.length + BARS_PILOTS.length + OUTCOMES_PILOTS.length + DAILY_PILOTS.length);
    for (const p of PAYOFF_PILOTS) expect(ids).toContain(p.planId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every concept its own title, because the app treats a concept as already made when its title exists", () => {
    const titles = listMotionConcepts().map((c) => manualMotionConceptTitle(c).toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    const pilot7 = PILOTS.find((p) => p.planId === "pilot-7-daily-brief")!;
    for (const p of PAYOFF_PILOTS) expect(manualMotionConceptTitle({ id: p.planId, title: p.title, hook: p.hook, topic: p.topic })).not.toBe(manualMotionConceptTitle({ id: pilot7.planId, title: pilot7.title, hook: pilot7.hook, topic: pilot7.topic }));
  });

  it("carries the concept id in the opportunity rationale so the campaign step finds the plan", () => {
    const a = PAYOFF_PILOTS[0]!;
    const opp = manualMotionConceptOpportunityInput({ id: a.planId, title: a.title, hook: a.hook, topic: a.topic });
    expect(extractMotionConceptRefFromRationale(opp.rationale)).toBe("pilot-7-payoff-a");
  });

  it("resolves an approved script for each variant back to its own plan, and refuses one whose text changed", () => {
    for (const plan of PAYOFF_PILOTS) {
      const script = buildVideoScriptFromScenePlan(plan);
      expect(script.motionScenePlan?.scenePlanId).toBe(plan.planId);
      const resolved = resolveMotionScenePlan(script);
      expect(resolved.plan?.planId).toBe(plan.planId);
      expect(() => resolveMotionScenePlan({ ...script, script: `${script.script} Extra words.` })).toThrow();
    }
  });

  it("only drafts a script for a plan that passes its own claim and evidence validation", () => {
    const manifest = loadManifest();
    for (const plan of PAYOFF_PILOTS) expect(validateScenePlan(plan, manifest, { checkFiles: true }).ok).toBe(true);
  });

  it("marks payoff plans, and only them, for the payoff render settings the worker applies", () => {
    for (const p of PAYOFF_PILOTS) expect(isPayoffPlan(p)).toBe(true);
    for (const p of PILOTS) expect(isPayoffPlan(p)).toBe(false);
    expect(PAYOFF_SPEECH_RATE).toBe("+18%");
    expect(PAYOFF_TRANSITION_SECONDS).toBe(0.15);
  });
});
