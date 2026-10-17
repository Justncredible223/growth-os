import { describe, it, expect } from "vitest";
import { MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";
import { buildVideoScriptFromScenePlan, youtubeTitleProblems } from "../src/content/videoScriptWriter";
import { FALLBACK_TOPIC, YOUTUBE_TITLE_MAX, searchTopicFor, youtubeSearchDescription, youtubeSearchTitle } from "../src/shortform/youtubeSearchTitles";

describe("search-style YouTube titles", () => {
  it("lead with a searchable phrase and keep the concept's teaser", () => {
    expect(youtubeSearchTitle("One day made 46% of the profit", "A sample account's Account Health: one day against the firm's consistency cap"))
      .toBe("Prop firm consistency rule explained: One day made 46% of the profit");
    expect(youtubeSearchTitle("Won $3,100. Then lost $3,060.", "A sample account's calendar: a $3,100 day and a $3,060 loss two trades apart"))
      .toBe("What your trading P&L doesn't show: Won $3,100. Then lost $3,060");
  });

  it("uses the short lead before dropping the teaser", () => {
    expect(youtubeSearchTitle("Lost $127, then sized up 2.5x", "Five flagged trades a sample account opened soon after a loss"))
      .toBe("Revenge trading: Lost $127, then sized up 2.5x");
  });

  it("matches the topics that were misfiled while tuning", () => {
    expect(searchTopicFor("Would your trades pass?", "Replaying logged trades against evaluation rules shows whether they would have passed").id).toBe("evaluation");
    expect(searchTopicFor("Win rate 76% to 55%. Here's why.", "Comparing recent trading against your own baseline shows what changed").id).toBe("win-rate");
    expect(searchTopicFor("Do more of what already works.", "The single best setup in a trader's own history").id).toBe("setup");
    expect(searchTopicFor("One score for how you actually trade.", "One score that blends profitability, consistency, risk control and rule adherence").id).toBe("score");
  });

  it("every verified concept gets a title under the limit that passes the title lint, and nearly all are distinct", () => {
    const titles = MOTION_SCENE_PLANS.map((p) => buildVideoScriptFromScenePlan(p).youtubeTitle);
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(YOUTUBE_TITLE_MAX);
    for (const p of MOTION_SCENE_PLANS) {
      const problems = youtubeTitleProblems(buildVideoScriptFromScenePlan(p)).filter((x) => !/ALL CAPS word \((FOMO|EOD)\)/.test(x.reason));
      expect(problems, p.planId).toEqual([]);
    }
    expect(new Set(titles).size).toBeGreaterThanOrEqual(MOTION_SCENE_PLANS.length - 6);
  });

  it("only a handful of concepts fall back to the generic journal phrase", () => {
    const fallback = MOTION_SCENE_PLANS.filter((p) => searchTopicFor(p.title, p.topic).id === FALLBACK_TOPIC.id);
    expect(fallback.length).toBeLessThanOrEqual(10);
  });
});

describe("search-style YouTube description", () => {
  const d = youtubeSearchDescription("One day made 46% of the profit", "A sample account's Account Health: one day against the firm's consistency cap", "@fillbookhq");

  it("opens with the explainer, not the disclaimer", () => {
    expect(d.startsWith("Many prop firms cap")).toBe(true);
  });

  it("still says the numbers are demo data, and ends with the handle", () => {
    expect(d).toContain("Every number shown is demo data from a sample Fillbook account, not a real trader's results.");
    expect(d.trim().endsWith("@fillbookhq")).toBe(true);
  });

  it("every concept's description keeps the demo-data line, and a strategy video says its charts are illustrations instead", () => {
    for (const p of MOTION_SCENE_PLANS) {
      const d = buildVideoScriptFromScenePlan(p).youtubeDescription;
      if (p.planId.startsWith("strategy-")) {
        expect(d, p.planId).toContain("drawn illustration, not a real market and not a recommendation");
        expect(d, p.planId).not.toMatch(/demo data/i);
      } else expect(d, p.planId).toContain("demo data from a sample Fillbook account");
    }
  });
});
