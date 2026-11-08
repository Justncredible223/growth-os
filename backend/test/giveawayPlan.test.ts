import { describe, it, expect } from "vitest";
import { GIVEAWAY_ENDED_LINE, GIVEAWAY_MILESTONES, GIVEAWAY_OWNER_EMAIL, runGiveawayPlanStep } from "../src/giveaway/giveawayPlan";

describe("the giveaway has ended", () => {
  it("the playbook is retired: no milestone is ever sent", async () => {
    expect(GIVEAWAY_MILESTONES).toEqual([]);
    expect(await runGiveawayPlanStep({} as any, new Date("2026-11-23T13:00:00Z"))).toBe("giveaway ended; no milestones");
  });

  it("the public line says only that it ended and thanks entrants: no link, winner, prize or count", () => {
    expect(GIVEAWAY_ENDED_LINE).toBe("The Fillbook Elite giveaway has ended. Thank you to everyone who entered.");
    expect(GIVEAWAY_ENDED_LINE).not.toMatch(/giveaway\.|fillbookhq\.com|winner|drawn|\$|\d/i);
    expect(GIVEAWAY_OWNER_EMAIL).toBe("developer@fillbookhq.com");
  });
});
