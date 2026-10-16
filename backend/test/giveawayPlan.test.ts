import { describe, it, expect, vi } from "vitest";
import {
  DRAFTS,
  GIVEAWAY_CLOSES_AT,
  GIVEAWAY_DRAW_DEADLINE,
  GIVEAWAY_MILESTONES,
  GIVEAWAY_OPENS_AT,
  GIVEAWAY_PAGE,
  MAX_LATE_MS,
  dueMilestones,
  relatedIdFor,
  runGiveawayPlanStep,
} from "../src/giveaway/giveawayPlan";

describe("dates match the official rules", () => {
  it("opens Oct 11 12:00 AM EDT and closes Nov 30 11:59 PM EST", () => {
    expect(new Date(GIVEAWAY_OPENS_AT).toISOString()).toBe("2026-10-11T04:00:00.000Z"); // EDT = UTC-4
    expect(new Date(GIVEAWAY_CLOSES_AT).toISOString()).toBe("2026-12-01T04:59:59.000Z"); // EST = UTC-5
  });

  it("the draw deadline is exactly 7 days after the entry period ends", () => {
    expect(Date.parse(GIVEAWAY_DRAW_DEADLINE) - Date.parse(GIVEAWAY_CLOSES_AT)).toBe(7 * 24 * 3600 * 1000);
  });

  it("no milestone is dated before it can be true: the draw is only prompted once the giveaway has closed", () => {
    const closed = GIVEAWAY_MILESTONES.find((m) => m.id === "closed")!;
    expect(Date.parse(closed.dueAt)).toBeGreaterThan(Date.parse(GIVEAWAY_CLOSES_AT));
    const deadline = GIVEAWAY_MILESTONES.find((m) => m.id === "draw-deadline")!;
    expect(Date.parse(deadline.dueAt)).toBeLessThan(Date.parse(GIVEAWAY_DRAW_DEADLINE));
  });

  it("milestones are in date order, each with a unique id", () => {
    const times = GIVEAWAY_MILESTONES.map((m) => Date.parse(m.dueAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(GIVEAWAY_MILESTONES.map((m) => m.id)).size).toBe(GIVEAWAY_MILESTONES.length);
  });
});

describe("public drafts stay inside the official rules", () => {
  const countdown = [DRAFTS.lastWeek, DRAFTS.lastDay];

  it("every entry-inviting draft says free, no purchase necessary, 18 or older, and links the rules", () => {
    for (const d of countdown) {
      expect(d).toMatch(/Free to enter/);
      expect(d).toMatch(/no purchase necessary/i);
      expect(d).toMatch(/18 or older/);
      expect(d).toContain(GIVEAWAY_PAGE);
    }
  });

  it("no draft promises a result, uses emoji, hashtags or exclamation marks, or asks for a follow", () => {
    for (const d of Object.values(DRAFTS)) {
      expect(d).not.toMatch(/guarantee|will make you|never blow|#\w|!|\p{Extended_Pictographic}/u);
      expect(d).not.toMatch(/follow (us|me|@)|give us a follow|repost to enter/i);
    }
  });

  it("the winner post names only a first name and country (what the rules allow), as placeholders to fill", () => {
    expect(DRAFTS.winner).toContain("[FIRST NAME]");
    expect(DRAFTS.winner).toContain("[COUNTRY]");
    expect(DRAFTS.winner).not.toMatch(/@|email|@\w+/);
  });

  it("the post-close draft does not name a winner before one is drawn and says how it is notified", () => {
    expect(DRAFTS.closed).toMatch(/drawn at random within 7 days/);
    expect(DRAFTS.closed).not.toMatch(/\[FIRST NAME\]/);
  });
});

describe("the draw checklist carries the rules that are easy to miss", () => {
  const closed = GIVEAWAY_MILESTONES.find((m) => m.id === "closed")!.body;

  it("says to check the winner still follows, redraw if not, and the 7-day reply window", () => {
    expect(closed).toMatch(/Follows you/);
    expect(closed).toMatch(/Forfeited/);
    expect(closed).toMatch(/7 days to reply/);
  });

  it("forbids mailing non-winners promotions unless they opted in", () => {
    expect(closed).toMatch(/only those who ticked the newsletter box/);
  });

  it("asks permission before naming the winner, and only first name and country", () => {
    expect(closed).toMatch(/first name and country/);
  });
});

describe("dueMilestones", () => {
  const none = new Set<string>();

  it("nothing is due before the first date", () => {
    expect(dueMilestones(new Date("2026-11-01T00:00:00Z"), none)).toEqual([]);
  });

  it("a milestone becomes due on its date and is not repeated once created", () => {
    const now = new Date("2026-11-23T14:00:00Z");
    expect(dueMilestones(now, none).map((m) => m.id)).toEqual(["last-week"]);
    expect(dueMilestones(now, new Set([relatedIdFor("last-week")]))).toEqual([]);
  });

  it("a milestone missed by more than three days is not sent late as if it were current", () => {
    // afterglow has no expiry of its own, so only the lateness rule applies to it
    const due = Date.parse("2026-12-09T13:00:00Z");
    expect(dueMilestones(new Date(due + MAX_LATE_MS + 60_000), new Set()).some((m) => m.id === "afterglow")).toBe(false);
    expect(dueMilestones(new Date(due + MAX_LATE_MS - 60_000), new Set()).some((m) => m.id === "afterglow")).toBe(true);
  });
});

describe("runGiveawayPlanStep", () => {
  function fakeClient(existing: string[], created: (row: any) => void) {
    return {
      from() {
        const chain: any = {
          select: () => chain,
          in: () => Promise.resolve({ data: existing.map((related_id) => ({ related_id })), error: null }),
          insert: (row: any) => {
            created(row);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: "n", ...row, created_at: "x", read_at: null, related_id: row.related_id }, error: null }) }) };
          },
        };
        return chain;
      },
    } as any;
  }

  it("creates one notification per due milestone, typed and severity-tagged", async () => {
    const created = vi.fn();
    const out = await runGiveawayPlanStep(fakeClient([], created), new Date("2026-12-01T13:30:00Z"));
    expect(out).toBe("1 created: closed");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ type: "giveaway_plan", severity: "warning", related_id: "giveaway-plan-closed" }));
  });

  it("is a quiet no-op the second time and says what comes next", async () => {
    const created = vi.fn();
    const out = await runGiveawayPlanStep(fakeClient(["giveaway-plan-closed"], created), new Date("2026-12-01T20:00:00Z"));
    expect(created).not.toHaveBeenCalled();
    expect(out).toBe("nothing due; next: draw-deadline on 2026-12-05");
  });

  it("reports complete after the last milestone", async () => {
    const out = await runGiveawayPlanStep(fakeClient(GIVEAWAY_MILESTONES.map((m) => relatedIdFor(m.id)), vi.fn()), new Date("2027-01-15T13:00:00Z"));
    expect(out).toBe("giveaway plan complete");
  });
});

describe("countdown reminders never go out late", () => {
  it("none of the countdowns is created once the giveaway has closed, even if the daily run missed it", () => {
    const afterClose = new Date("2026-12-01T13:30:00Z");
    const ids = dueMilestones(afterClose, new Set()).map((m) => m.id);
    expect(ids).toEqual(["closed"]);
  });

  it("the draw-deadline reminder is not sent after the deadline has passed", () => {
    expect(dueMilestones(new Date("2026-12-08T13:00:00Z"), new Set()).some((m) => m.id === "draw-deadline")).toBe(false);
  });
});
