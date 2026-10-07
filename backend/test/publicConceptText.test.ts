import { describe, it, expect } from "vitest";
import { buildVideoScriptFromScenePlan, publicConceptText } from "../src/content/videoScriptWriter";
import { MOTION_SCENE_PLANS, isOfferedPlan } from "../src/shortform/motionPlans";

describe("text the owner copies into a post", () => {
  it("strips the app's internal recording markers", () => {
    expect(publicConceptText("Plan said 3. The trade was 5. (screen recording)")).toBe("Plan said 3. The trade was 5.");
    expect(publicConceptText("A trade log (shown on the real screen recording)")).toBe("A trade log");
    expect(publicConceptText("No marker here")).toBe("No marker here");
  });

  it("never puts 'screen recording' in the title, description or captions of any offered concept", () => {
    const offered = MOTION_SCENE_PLANS.filter(isOfferedPlan);
    expect(offered.some((p) => /screen recording/i.test(p.title))).toBe(true); // the internal titles keep the marker (the app tracks a concept by its title)
    for (const plan of offered) {
      const video = buildVideoScriptFromScenePlan(plan);
      for (const text of [video.youtubeTitle, video.youtubeDescription, video.tiktokCaption, video.instagramCaption]) {
        expect(text, plan.planId).not.toMatch(/screen recording/i);
      }
    }
  });
});
