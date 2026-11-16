import { describe, it, expect } from "vitest";
import { computeInboundSummary } from "../src/inbound/inboundHandlers";
import type { InboundEngagement } from "../src/inbound/types";

function item(overrides: Partial<InboundEngagement>): InboundEngagement {
  return {
    id: "1",
    platform: "x",
    externalId: "1",
    conversationId: null,
    inReplyToExternalId: null,
    authorHandle: "someone",
    authorExternalId: "author-1",
    creatorId: null,
    body: "text",
    inResponseToText: null,
    publicMetrics: {},
    priority: "p3_comment",
    status: "needs_response",
    draftResponse: null,
    draftUsesLink: null,
    respondedAt: null,
    respondedNote: null,
    isRepeatEngager: false,
    observedAt: "2026-09-01T12:00:00Z",
    sourceReference: null,
    createdAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
    ...overrides,
  };
}

const now = new Date("2026-09-02T12:00:00Z");

describe("computeInboundSummary", () => {
  it("counts review_needed toward needsResponse -- regression for a real bug found against production data", () => {
    const summary = computeInboundSummary([item({ status: "review_needed" })], now);
    expect(summary.needsResponse).toBe(1);
  });

  it("counts draft_ready toward needsResponse -- a draft is not a response, so it must not read as resolved", () => {
    const summary = computeInboundSummary([item({ status: "draft_ready", draftResponse: "a draft" })], now);
    expect(summary.needsResponse).toBe(1);
  });

  it("does NOT count responded or closed toward needsResponse", () => {
    const summary = computeInboundSummary(
      [item({ id: "1", externalId: "1", status: "responded" }), item({ id: "2", externalId: "2", status: "closed" })],
      now,
    );
    expect(summary.needsResponse).toBe(0);
  });

  it("counts follow_up separately from needsResponse", () => {
    const summary = computeInboundSummary([item({ status: "follow_up" })], now);
    expect(summary.needsResponse).toBe(0);
    expect(summary.followUp).toBe(1);
  });

  it("counts repeat engagers regardless of status, as long as they're in the active set passed in", () => {
    const summary = computeInboundSummary([item({ status: "needs_response", isRepeatEngager: true })], now);
    expect(summary.repeatEngagers).toBe(1);
  });

  it("flags an unresolved item older than 48h as overdue, but not a recent one", () => {
    const old = item({ id: "1", externalId: "1", status: "needs_response", observedAt: "2026-08-30T00:00:00Z" }); // 60h before `now`
    const recent = item({ id: "2", externalId: "2", status: "needs_response", observedAt: "2026-09-02T06:00:00Z" }); // 6h before `now`

    const summary = computeInboundSummary([old, recent], now);

    expect(summary.overdue).toBe(1);
  });

  it("never counts an already-resolved item as overdue, no matter how old", () => {
    const summary = computeInboundSummary(
      [item({ status: "responded", observedAt: "2026-01-01T00:00:00Z" })],
      now,
    );
    expect(summary.overdue).toBe(0);
  });

  it("returns all zeros for an empty active set -- an empty queue is a real state, not an error", () => {
    expect(computeInboundSummary([], now)).toEqual({ needsResponse: 0, people: 0, followUp: 0, followUpDue: 0, repeatEngagers: 0, overdue: 0 });
  });
});

describe("P1 2026-11-15: people, due follow-ups, backlog not overdue, queue order", () => {
  it("counts people, due follow-ups, and leaves backlog review items out of overdue", async () => {
    const { computeInboundSummary, sortInboundQueue } = await import("../src/inbound/inboundHandlers");
    const now = new Date("2026-11-16T12:00:00Z");
    const row = (o: Record<string, unknown>) => ({ platform: "x", authorExternalId: "a", authorHandle: "a", isRepeatEngager: false, priority: "p3_comment", status: "needs_response", observedAt: "2026-11-16T10:00:00Z", updatedAt: "2026-11-16T10:00:00Z", id: Math.random().toString(), ...o }) as any;
    const rows = [
      ...Array.from({ length: 8 }, () => row({ authorExternalId: "kezie" })),
      row({ authorExternalId: "b", status: "review_needed", observedAt: "2026-11-01T10:00:00Z" }),
      row({ authorExternalId: "c", status: "follow_up", updatedAt: "2026-11-13T10:00:00Z" }),
      row({ authorExternalId: "d", status: "follow_up", updatedAt: "2026-11-16T09:00:00Z" }),
    ];
    const s = computeInboundSummary(rows, now);
    expect(s.needsResponse).toBe(9);
    expect(s.people).toBe(2);
    expect(s.followUpDue).toBe(1);
    expect(s.overdue).toBe(0);
    const order = sortInboundQueue([
      row({ id: "mention", priority: "p4_mention" }),
      row({ id: "direct", priority: "p1_direct_reply", observedAt: "2026-11-15T10:00:00Z" }),
      row({ id: "due", status: "follow_up", priority: "p4_mention", updatedAt: "2026-11-10T10:00:00Z" }),
    ], now).map((r: any) => r.id);
    expect(order).toEqual(["due", "direct", "mention"]);
  });
});

describe("P2 2026-11-15: possibly automated is an advisory label on a person", () => {
  it("labels an author with 4+ short non-question messages in 24h, even if others are long or ask questions", async () => {
    const { automatedBurstAuthors, qualifiesForAutomatedSignal } = await import("../src/inbound/inboundHandlers");
    const m = (author: string, body: string, at: string) => ({ platform: "x", authorExternalId: author, body, observedAt: at });
    const rows = [
      ...["20:00", "20:01", "20:02", "23:30"].map((t) => m("kz", "@FillbookHQ Consistency share is the silent killer.", `2026-11-15T${t}:00Z`)),
      m("kz", "@FillbookHQ How do you handle the trailing floor on a funded account?", "2026-11-15T21:00:00Z"),
      ...["01:00", "02:00", "03:00"].map((t) => m("real", "@FillbookHQ Nice post.", `2026-11-15T${t}:00Z`)),
      m("spread", "@FillbookHQ ok", "2026-11-10T10:00:00Z"), m("spread", "@FillbookHQ ok", "2026-11-12T10:00:00Z"),
      m("spread", "@FillbookHQ ok", "2026-11-14T10:00:00Z"), m("spread", "@FillbookHQ ok", "2026-11-16T10:00:00Z"),
    ];
    expect([...automatedBurstAuthors(rows)]).toEqual(["x:kz"]);
    expect(qualifiesForAutomatedSignal("@FillbookHQ @someone Great point")).toBe(true);
    expect(qualifiesForAutomatedSignal("@FillbookHQ what about EOD drawdown?")).toBe(false);
  });
});
