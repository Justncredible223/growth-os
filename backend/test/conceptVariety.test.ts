import { describe, it, expect } from "vitest";
import { MAX_CONCEPT_OVERLAP, distinctConcepts, nearCopies } from "../src/shortform/conceptVariety";
import { MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";
import { offeredChartConcepts, runDailyChartCardRequests, type ConceptState } from "../src/video/dailyChartCardRequests";
import { manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept";

const planOf = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id);
const offered = offeredChartConcepts();
const isOutcomes = (id: string) => id.startsWith("chart-o-");
// The illustrative win-rate cards are no longer offered (they are not drawn like the rest), but they still resolve for scripts already drafted.
const outcomesConcepts = MOTION_SCENE_PLANS.filter((p) => isOutcomes(p.planId)).map((p) => ({ id: p.planId }));

describe("nearCopies", () => {
  it("treats the illustrative win-rate cards as copies of each other", () => {
    const outcomes = outcomesConcepts.map((c) => planOf(c.id)!);
    expect(outcomes).toHaveLength(12);
    for (let i = 0; i < outcomes.length; i++) for (let j = i + 1; j < outcomes.length; j++) expect(nearCopies(outcomes[i]!, outcomes[j]!), `${outcomes[i]!.planId} vs ${outcomes[j]!.planId}`).toBe(true);
  });

  it("treats the 9 fresh ideas as different videos, and a screen-recording alternative as a near-copy of its own card version only", () => {
    const others = offered.map((c) => planOf(c.id)!);
    expect(others).toHaveLength(12);
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
  it("offers all 9 different ideas (the recording alternative wins over its card version), none of them a win-rate card", () => {
    const kept = distinctConcepts(offered, [], planOf);
    expect(kept).toHaveLength(9);
    expect(kept.map((c) => c.id)).toEqual(expect.arrayContaining(["fresh-02b-plan-said-3-recording", "fresh-04b-setup-lost-422-recording", "fresh-06b-five-revenge-recording"]));
    expect(kept.map((c) => c.id)).not.toContain("fresh-02-plan-said-3");
    expect(kept.filter((c) => isOutcomes(c.id))).toHaveLength(0);
    expect(kept.map((c) => c.id)).toEqual(offered.filter((c) => kept.includes(c)).map((c) => c.id)); // order kept
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) expect(nearCopies(planOf(kept[i]!.id)!, planOf(kept[j]!.id)!)).toBe(false);
  });

  it("hides every win-rate card once one has been made or is waiting", () => {
    // Not offered any more, but a made or waiting win-rate card still hides the others if they are ever passed in.
    const [first, ...rest] = outcomesConcepts;
    expect(distinctConcepts(rest, [first!.id], planOf)).toEqual([]);
    expect(distinctConcepts([first!, ...rest], [], planOf)).toHaveLength(1);
  });

  it("does not hide a different concept because a made one is on another feature", () => {
    const kept = distinctConcepts(offered, ["fresh-03-one-day-46"], planOf);
    expect(kept.map((c) => c.id)).toContain("fresh-08-nobody-fines");
  });

  it("offers EITHER the card OR the recording version of an idea: made or waiting hides the other, a rejected recording leaves the card", () => {
    expect(distinctConcepts(offered, ["fresh-02b-plan-said-3-recording"], planOf).map((c) => c.id)).not.toContain("fresh-02-plan-said-3");
    expect(distinctConcepts(offered, ["fresh-02-plan-said-3"], planOf).map((c) => c.id)).not.toContain("fresh-02b-plan-said-3-recording");
    // A rejected recording version is neither made nor waiting, and the refill leaves it out of its candidates: the card version is then the one on offer.
    const withoutRejected = offered.filter((c) => c.id !== "fresh-02b-plan-said-3-recording");
    expect(distinctConcepts(withoutRejected, [], planOf).map((c) => c.id)).toContain("fresh-02-plan-said-3");
  });

  it("keeps a candidate it has no plan for, and leaves the input alone", () => {
    const input = [{ id: "unknown-concept" }];
    expect(distinctConcepts(input, [], planOf)).toEqual(input);
    expect(offeredChartConcepts()).toHaveLength(12);
  });
});

describe("the daily refill never queues two near-copies", () => {
  it("over a whole run of the supply, requests only mutually different concepts and then reports none left", async () => {
    const states = new Map<string, ConceptState>();
    const requested: string[] = [];
    const deps = {
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
    for (let day = 0; day < 40 && !report.startsWith("no unused"); day++) report = await runDailyChartCardRequests(deps);
    expect(requested).toHaveLength(9);
    expect(new Set(requested).size).toBe(9);
    expect(requested.filter(isOutcomes)).toHaveLength(0);
    for (let i = 0; i < requested.length; i++) for (let j = i + 1; j < requested.length; j++) expect(nearCopies(planOf(requested[i]!)!, planOf(requested[j]!)!)).toBe(false);
    expect(report).toMatch(/no unused chart concepts left/);
  });
});
