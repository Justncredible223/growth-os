import { describe, it, expect } from "vitest";
import { ingestInboundMentions, INBOUND_CURSOR_SOURCE } from "../src/inbound/inboundIngestion";
import { InMemoryInboundRepository } from "../src/inbound/inMemoryInboundRepository";
import { InMemoryIngestionCursorStore } from "../src/signals/adapters/ingestionCursorStore";
import type { XMention } from "../src/signals/adapters/xAdapter";

const OUR_USER_ID = "our-id";

function mention(overrides: Partial<XMention> & Pick<XMention, "id" | "text">): XMention {
  return {
    authorId: "author-1",
    authorHandle: "someTrader",
    createdAt: new Date("2026-09-01T12:00:00Z"),
    publicMetrics: null,
    inReplyToUserId: null,
    conversationId: null,
    referencedTweets: [],
    ...overrides,
  };
}

class FakeAdapter {
  constructor(private mentions: XMention[]) {}
  async fetchOwnMentions(_userId: string, _sinceId?: string): Promise<XMention[]> {
    return this.mentions;
  }
}

function buildDeps(mentions: XMention[], creatorHandles: string[] = []) {
  return {
    adapter: new FakeAdapter(mentions) as any,
    repo: new InMemoryInboundRepository(),
    findCreatorIdByHandle: async (handle: string) => (creatorHandles.includes(handle) ? `creator-${handle}` : null),
  };
}

describe("ingestInboundMentions", () => {
  const now = new Date("2026-09-01T13:00:00Z");

  it("inserts a fresh direct reply as p1/needs_response", async () => {
    const deps = buildDeps([mention({ id: "1", text: "how do you track drawdown?", inReplyToUserId: OUR_USER_ID })]);
    const cursors = new InMemoryIngestionCursorStore();

    const result = await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    expect(result).toEqual({ fetched: 1, inserted: 1, skippedExisting: 0 });
    const row = deps.repo.all()[0]!;
    expect(row.priority).toBe("p1_direct_reply");
    expect(row.status).toBe("needs_response");
  });

  it("classifies low-value text as closed, not needs_response, but still inserts it (visible, not silently dropped)", async () => {
    const deps = buildDeps([mention({ id: "1", text: "🔥" })]);
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    const row = deps.repo.all()[0]!;
    expect(row.priority).toBe("low_value");
    expect(row.status).toBe("closed");
  });

  it("dedupes on (platform, externalId) across repeated runs -- same mention twice never creates two rows", async () => {
    const m = mention({ id: "1", text: "great tool" });
    const deps = buildDeps([m]);
    const cursors = new InMemoryIngestionCursorStore();

    const first = await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);
    const second = await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(deps.repo.all()).toHaveLength(1);
  });

  it("links a matched creator's handle and classifies as p2_relationship", async () => {
    const deps = buildDeps([mention({ id: "1", text: "following up on our last chat", authorHandle: "knownCreator" })], ["knownCreator"]);
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    const row = deps.repo.all()[0]!;
    expect(row.creatorId).toBe("creator-knownCreator");
    expect(row.priority).toBe("p2_relationship");
  });

  it("detects a repeat engager -- second message from the same author id is flagged, first is not", async () => {
    const repo = new InMemoryInboundRepository();
    const cursors = new InMemoryIngestionCursorStore();
    const deps1 = { adapter: new FakeAdapter([mention({ id: "1", text: "first message" })]) as any, repo, findCreatorIdByHandle: async () => null };
    await ingestInboundMentions(deps1, cursors, OUR_USER_ID, now);

    const deps2 = { adapter: new FakeAdapter([mention({ id: "2", text: "second message, different tweet" })]) as any, repo, findCreatorIdByHandle: async () => null };
    await ingestInboundMentions(deps2, cursors, OUR_USER_ID, now);

    const rows = repo.all();
    expect(rows.find((r) => r.externalId === "1")!.isRepeatEngager).toBe(false);
    expect(rows.find((r) => r.externalId === "2")!.isRepeatEngager).toBe(true);
  });

  it("backlog recovery marks genuinely new items as review_needed, not needs_response", async () => {
    const deps = buildDeps([mention({ id: "1", text: "was this ever answered?", inReplyToUserId: OUR_USER_ID })]);
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundMentions(deps, cursors, OUR_USER_ID, now, true);

    expect(deps.repo.all()[0]!.status).toBe("review_needed");
  });

  it("backlog recovery never touches an already-tracked row's status", async () => {
    const repo = new InMemoryInboundRepository();
    const cursors = new InMemoryIngestionCursorStore();
    const m = mention({ id: "1", text: "already handled this" });
    await ingestInboundMentions({ adapter: new FakeAdapter([m]) as any, repo, findCreatorIdByHandle: async () => null }, cursors, OUR_USER_ID, now);
    await repo.updateStatus(repo.all()[0]!.id, "responded", { respondedAt: now.toISOString() });

    await ingestInboundMentions({ adapter: new FakeAdapter([m]) as any, repo, findCreatorIdByHandle: async () => null }, cursors, OUR_USER_ID, now, true);

    expect(repo.all()).toHaveLength(1);
    expect(repo.all()[0]!.status).toBe("responded");
  });

  it("saves the newest mention id as the inbound-specific cursor, separate from x_mention's own cursor", async () => {
    const deps = buildDeps([mention({ id: "300", text: "newest" }), mention({ id: "200", text: "older" })]);
    const cursors = new InMemoryIngestionCursorStore();
    await cursors.save("x_mention", "999"); // a different pipeline's cursor -- must not be read or overwritten

    await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    expect(await cursors.load(INBOUND_CURSOR_SOURCE)).toBe("300");
    expect(await cursors.load("x_mention")).toBe("999");
  });

  it("does not advance the cursor during backlog recovery", async () => {
    const deps = buildDeps([mention({ id: "1", text: "old item" })]);
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundMentions(deps, cursors, OUR_USER_ID, now, true);

    expect(await cursors.load(INBOUND_CURSOR_SOURCE)).toBeNull();
  });

  it("treats a prior Prospecting outreach as an existing relationship (p2), even with no prior inbound row or tracked creator", async () => {
    const deps = {
      adapter: new FakeAdapter([mention({ id: "1", text: "hey thanks for the reply the other day", authorId: "prospect-1", authorHandle: "randomTrader" })]) as any,
      repo: new InMemoryInboundRepository(),
      findCreatorIdByHandle: async () => null,
      hasProspectingOutreach: async (authorExternalId: string) => authorExternalId === "prospect-1",
    };
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    const row = deps.repo.all()[0]!;
    expect(row.priority).toBe("p2_relationship");
  });

  it("works unchanged when hasProspectingOutreach is omitted (pre-Prospecting callers)", async () => {
    const deps = buildDeps([mention({ id: "1", text: "hi there", authorId: "someone-else" })]);
    const cursors = new InMemoryIngestionCursorStore();

    const result = await ingestInboundMentions(deps, cursors, OUR_USER_ID, now);

    expect(result.inserted).toBe(1);
  });

  it("a reply arriving in an existing conversation after we've responded still lands as its own new row needing a response", async () => {
    const repo = new InMemoryInboundRepository();
    const cursors = new InMemoryIngestionCursorStore();
    const firstMessage = mention({ id: "1", text: "question about pricing", conversationId: "conv-1", inReplyToUserId: OUR_USER_ID });
    await ingestInboundMentions({ adapter: new FakeAdapter([firstMessage]) as any, repo, findCreatorIdByHandle: async () => null }, cursors, OUR_USER_ID, now);
    await repo.updateStatus(repo.all()[0]!.id, "responded", { respondedAt: now.toISOString() });

    const followUpMessage = mention({ id: "2", text: "thanks, one more question", conversationId: "conv-1", inReplyToUserId: OUR_USER_ID });
    await ingestInboundMentions({ adapter: new FakeAdapter([followUpMessage]) as any, repo, findCreatorIdByHandle: async () => null }, cursors, OUR_USER_ID, now);

    const rows = repo.all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.externalId === "1")!.status).toBe("responded");
    expect(rows.find((r) => r.externalId === "2")!.status).toBe("needs_response");
    expect(rows.find((r) => r.externalId === "2")!.conversationId).toBe("conv-1");
  });
});

describe("P0 2026-11-15: a mentions read that hit its page cap is reported, not hidden", () => {
  it("passes the adapter's truncated flag through to the result", async () => {
    const { InMemoryIngestionCursorStore } = await import("../src/signals/adapters/ingestionCursorStore");
    const { InMemoryInboundRepository } = await import("../src/inbound/inMemoryInboundRepository");
    const adapter = { fetchOwnMentions: async () => [], mentionsTruncated: () => true };
    const result = await ingestInboundMentions({ adapter, repo: new InMemoryInboundRepository() } as any, new InMemoryIngestionCursorStore(), "me");
    expect(result.truncated).toBe(true);
    const quiet = await ingestInboundMentions({ adapter: { fetchOwnMentions: async () => [] }, repo: new InMemoryInboundRepository() } as any, new InMemoryIngestionCursorStore(), "me");
    expect(quiet.truncated).toBeUndefined();
  });
});

describe("P1 2026-11-15: p2 relationship means a conversation we answered", () => {
  it("an earlier unanswered message from the same author does not make the next one p2", async () => {
    const { InMemoryIngestionCursorStore } = await import("../src/signals/adapters/ingestionCursorStore");
    const { InMemoryInboundRepository } = await import("../src/inbound/inMemoryInboundRepository");
    const repo = new InMemoryInboundRepository();
    const m = (id: string, conv: string) => ({ id, text: "Great breakdown of drawdown, how do you track it?", authorId: "kz", authorHandle: "kezie", createdAt: new Date("2026-11-15T20:00:00Z"), publicMetrics: null, inReplyToUserId: "someone-else", conversationId: conv, referencedTweets: [] });
    const deps = { adapter: { fetchOwnMentions: async () => [m("2", "c2"), m("1", "c1")] }, repo, findCreatorIdByHandle: async () => null } as any;
    await ingestInboundMentions(deps, new InMemoryIngestionCursorStore(), "me");
    const rows = await repo.listByStatus(["needs_response", "new", "review_needed", "draft_ready", "follow_up", "responded", "closed"] as any);
    expect(rows.every((r: any) => r.priority !== "p2_relationship")).toBe(true);
  });
});
