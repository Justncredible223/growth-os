import { describe, it, expect } from "vitest";
import { MAX_CONCEPT_OVERLAP, distinctConcepts, nearCopies } from "../src/shortform/conceptVariety";
import { MOTION_SCENE_PLANS, RETIRED_FRESH_DAILY_ORDER } from "../src/shortform/motionPlans";
import { offeredChartConcepts, runDailyChartCardRequests, type ConceptState } from "../src/video/dailyChartCardRequests";
import { manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept";

const planOf = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id);
const offered = offeredChartConcepts();
// The retired clip pool (2026-10-07 to 2026-10-16): its recording/card twins are what the near-copy rules below were written for.
const freshPool = RETIRED_FRESH_DAILY_ORDER.map((id) => ({ id }));
const isOutcomes = (id: string) => id.startsWith("chart-o-");
// The illustrative win-rate cards are no longer offered (they are not drawn like the rest), but they still resolve for scripts already drafted.
const outcomesConcepts = MOTION_SCENE_PLANS.filter((p) => isOutcomes(p.planId)).map((p) => ({ id: p.planId }));

describe("nearCopies", () => {
  it("treats the illustrative win-rate cards as copies of each other", () => {
    const outcomes = outcomesConcepts.map((c) => planOf(c.id)!);
    expect(outcomes).toHaveLength(12);
    for (let i = 0; i < outcomes.length; i++) for (let j = i + 1; j < outcomes.length; j++) expect(nearCopies(outcomes[i]!, outcomes[j]!), `${outcomes[i]!.planId} vs ${outcomes[j]!.planId}`).toBe(true);
  });

  it("treats the 30 fresh ideas as different videos, and a screen-recording alternative as a near-copy of its own card version only", () => {
    const others = freshPool.map((c) => planOf(c.id)!);
    expect(others).toHaveLength(33); // the 30 distinct ideas, then the 3 card versions as hidden fallbacks
    const pairOf = (id: string) => id.replace(/^(fresh-\d+)b-(.*)-recording$/, "$1-$2");
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const a = others[i]!.planId;
        const b = others[j]!.planId;
        const twins = pairOf(a) === b || pairOf(b) === a;
        expect(nearCopies(others[i]!, others[j]!), `${a} vs ${b}`).toBe(twins);
      }
    }
    expect(MAX_CONCEPT_OVERLAP).toBeLessThanOrEqual(0.5);
  });
});

describe("distinctConcepts", () => {
  it("offers all 30 different ideas (the recording alternative wins over its card version), none of them a win-rate card", () => {
    const kept = distinctConcepts(freshPool, [], planOf);
    expect(kept).toHaveLength(30);
    expect(kept.map((c) => c.id)).toEqual(expect.arrayContaining(["fresh-02b-plan-said-3-recording", "fresh-04b-setup-lost-422-recording", "fresh-06b-five-revenge-recording"]));
    expect(kept.map((c) => c.id)).not.toContain("fresh-02-plan-said-3");
    expect(kept.filter((c) => isOutcomes(c.id))).toHaveLength(0);
    expect(kept.map((c) => c.id)).toEqual(freshPool.filter((c) => kept.includes(c)).map((c) => c.id)); // order kept
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) expect(nearCopies(planOf(kept[i]!.id)!, planOf(kept[j]!.id)!)).toBe(false);
  });

  it("hides every win-rate card once one has been made or is waiting", () => {
    // Not offered any more, but a made or waiting win-rate card still hides the others if they are ever passed in.
    const [first, ...rest] = outcomesConcepts;
    expect(distinctConcepts(rest, [first!.id], planOf)).toEqual([]);
    expect(distinctConcepts([first!, ...rest], [], planOf)).toHaveLength(1);
  });

  it("does not hide a different concept because a made one is on another feature", () => {
    const kept = distinctConcepts(freshPool, ["fresh-03-one-day-46"], planOf);
    expect(kept.map((c) => c.id)).toContain("fresh-08-nobody-fines");
  });

  it("offers EITHER the card OR the recording version of an idea: made or waiting hides the other, a rejected recording leaves the card", () => {
    expect(distinctConcepts(freshPool, ["fresh-02b-plan-said-3-recording"], planOf).map((c) => c.id)).not.toContain("fresh-02-plan-said-3");
    expect(distinctConcepts(freshPool, ["fresh-02-plan-said-3"], planOf).map((c) => c.id)).not.toContain("fresh-02b-plan-said-3-recording");
    // A rejected recording version is neither made nor waiting, and the refill leaves it out of its candidates: the card version is then the one on offer.
    const withoutRejected = freshPool.filter((c) => c.id !== "fresh-02b-plan-said-3-recording");
    expect(distinctConcepts(withoutRejected, [], planOf).map((c) => c.id)).toContain("fresh-02-plan-said-3");
  });

  it("keeps a candidate it has no plan for, and leaves the input alone", () => {
    const input = [{ id: "unknown-concept" }];
    expect(distinctConcepts(input, [], planOf)).toEqual(input);
    expect(offeredChartConcepts()).toHaveLength(30);
  });
});

describe("the explainers", () => {
  // The nine clips already posted (Oct 8-16): an explainer must not read as a copy of any of them, or the app would hide it.
  const posted = ["fresh-06b-five-revenge-recording", "fresh-02b-plan-said-3-recording", "fresh-07-take-it-again", "fresh-01-two-limits", "fresh-12-one-red-day", "fresh-19-biggest-leak", "fresh-10-eight-contracts", "fresh-14-won-then-lost", "fresh-08-nobody-fines"];

  it("are all offered: none is a near-copy of another, nor of a clip already posted", () => {
    expect(offered.every((c) => /^(explain|strategy)-/.test(c.id))).toBe(true);
    expect(distinctConcepts(offered, [], planOf)).toHaveLength(30);
    expect(distinctConcepts(offered, posted, planOf)).toHaveLength(30);
  });
});

describe("the daily refill never queues two near-copies", () => {
  it("over a whole run of the supply, requests only mutually different concepts and then reports none left", async () => {
    const states = new Map<string, ConceptState>();
    const requested: string[] = [];
    const deps = {
      now: () => new Date("2026-10-27T18:00:00Z"), // a Tuesday, so the two-a-week gate lets every pass through
      isPaused: async () => false,
      states: async () => states,
      requestedToday: async () => null,
      request: async (id: string) => {
        requested.push(id);
        const c = offered.find((x) => x.id === id)!;
        states.set(manualMotionConceptTitle(c), "made");
        return { campaignRunRequestId: `run-${id}`, opportunityId: `opp-${id}` };
      },
    };
    let report = "";
    for (let day = 0; day < 80 && !report.startsWith("no unused"); day++) report = await runDailyChartCardRequests(deps);
    expect(requested).toHaveLength(30);
    expect(new Set(requested).size).toBe(30);
    expect(requested.filter(isOutcomes)).toHaveLength(0);
    for (let i = 0; i < requested.length; i++) for (let j = i + 1; j < requested.length; j++) expect(nearCopies(planOf(requested[i]!)!, planOf(requested[j]!)!)).toBe(false);
    expect(report).toMatch(/no unused chart concepts left/);
  });
});
