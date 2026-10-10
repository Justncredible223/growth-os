import { describe, it, expect } from "vitest";
import { RunScopedXReads, compareXIds } from "../src/signals/adapters/runScopedXReads";
import { InMemoryIngestionCursorStore } from "../src/signals/adapters/ingestionCursorStore";
import { ingestXMentions, X_MENTION_CURSOR_SOURCE } from "../src/signals/adapters/xIngestion";
import { ingestInboundMentions, INBOUND_CURSOR_SOURCE } from "../src/inbound/inboundIngestion";
import { InMemoryInboundRepository } from "../src/inbound/inMemoryInboundRepository";
import { SignalGraph } from "../src/signals/signalGraph";
import { InMemorySignalRepository } from "../src/signals/inMemorySignalRepository";
import type { XMention } from "../src/signals/adapters/xAdapter";

function mention(id: string): XMention {
  return {
    id,
    text: `question about drawdown ${id}?`,
    authorId: `author-${id}`,
    authorHandle: `h${id}`,
    createdAt: new Date("2026-10-01T12:00:00Z"),
    publicMetrics: null,
    inReplyToUserId: null,
    conversationId: null,
    referencedTweets: [],
  };
}

/** Behaves like X: newest first, honours since_id, caps a page at 50, and counts every request. */
class FakeAdapter {
  userIdCalls = 0;
  mentionCalls: Array<string | undefined> = [];
  failNextMentions = false;
  constructor(private all: string[]) {}
  async resolveOwnUserId(): Promise<string> {
    this.userIdCalls++;
    return "me";
  }
  async fetchOwnMentions(_userId: string, sinceId?: string): Promise<XMention[]> {
    this.mentionCalls.push(sinceId);
    if (this.failNextMentions) {
      this.failNextMentions = false;
      throw new Error("429");
    }
    return this.all
      .filter((id) => sinceId === undefined || compareXIds(id, sinceId) > 0)
      .sort((a, b) => compareXIds(b, a))
      .slice(0, 50)
      .map(mention);
  }
}

function setup(ids: string[]) {
  const adapter = new FakeAdapter(ids);
  const cursors = new InMemoryIngestionCursorStore();
  const reads = new RunScopedXReads(adapter as any, cursors, [X_MENTION_CURSOR_SOURCE, INBOUND_CURSOR_SOURCE]);
  return { adapter, cursors, reads };
}

describe("compareXIds", () => {
  it("compares snowflakes numerically, not lexically", () => {
    expect(compareXIds("9", "10")).toBe(-1);
    expect(compareXIds("1790000000000000002", "1790000000000000001")).toBe(1);
    expect(compareXIds("5", "5")).toBe(0);
  });
});

describe("RunScopedXReads", () => {
  it("looks the user id up once however many steps ask", async () => {
    const { adapter, reads } = setup([]);
    const ids = await Promise.all([reads.resolveOwnUserId(), reads.resolveOwnUserId()]);
    await reads.resolveOwnUserId();
    expect(ids).toEqual(["me", "me"]);
    expect(adapter.userIdCalls).toBe(1);
  });

  it("retries the user id after a failure instead of caching the error", async () => {
    let calls = 0;
    const flaky = {
      resolveOwnUserId: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return "me";
      },
    };
    const reads = new RunScopedXReads(flaky as any, new InMemoryIngestionCursorStore(), []);
    await expect(reads.resolveOwnUserId()).rejects.toThrow("boom");
    await expect(reads.resolveOwnUserId()).resolves.toBe("me");
  });

  it("makes one mentions request for both consumers and each keeps its own cursor semantics", async () => {
    const { adapter, cursors, reads } = setup(["101", "102", "103", "104"]);
    await cursors.save(X_MENTION_CURSOR_SOURCE, "103"); // signal graph has seen up to 103
    await cursors.save(INBOUND_CURSOR_SOURCE, "101"); // inbound is behind

    const signals = await ingestXMentions(reads, new SignalGraph(new InMemorySignalRepository()), cursors, "me");
    const inboundRepo = new InMemoryInboundRepository();
    const inbound = await ingestInboundMentions(
      { adapter: reads, repo: inboundRepo, findCreatorIdByHandle: async () => null },
      cursors,
      "me",
    );

    expect(adapter.mentionCalls).toEqual(["101"]); // ONE request, bounded by the older cursor
    expect(signals.map((s) => (s.evidence as { postId: string }).postId)).toEqual(["104"]);
    expect(inbound.fetched).toBe(3); // 102, 103, 104
    expect(await cursors.load(X_MENTION_CURSOR_SOURCE)).toBe("104");
    expect(await cursors.load(INBOUND_CURSOR_SOURCE)).toBe("104");
  });

  it("matches what two separate requests would have delivered, with nothing lost or duplicated", async () => {
    const ids = Array.from({ length: 70 }, (_, i) => String(1000 + i));
    const separate = setup(ids);
    await separate.cursors.save(X_MENTION_CURSOR_SOURCE, "1040");
    await separate.cursors.save(INBOUND_CURSOR_SOURCE, "1010");
    const expectA = (await separate.adapter.fetchOwnMentions("me", "1040")).map((m) => m.id);
    const expectB = (await separate.adapter.fetchOwnMentions("me", "1010")).map((m) => m.id);

    const shared = setup(ids);
    await shared.cursors.save(X_MENTION_CURSOR_SOURCE, "1040");
    await shared.cursors.save(INBOUND_CURSOR_SOURCE, "1010");
    const a = (await shared.reads.fetchOwnMentions("me", "1040")).map((m) => m.id);
    const b = (await shared.reads.fetchOwnMentions("me", "1010")).map((m) => m.id);

    expect(a).toEqual(expectA);
    expect(b).toEqual(expectB);
    expect(shared.adapter.mentionCalls).toEqual(["1010"]);
  });

  it("fetches without a bound when any consumer has no cursor yet", async () => {
    const { adapter, cursors, reads } = setup(["1", "2", "3"]);
    await cursors.save(X_MENTION_CURSOR_SOURCE, "2");
    const a = await reads.fetchOwnMentions("me", "2");
    const b = await reads.fetchOwnMentions("me", undefined);
    expect(adapter.mentionCalls).toEqual([undefined]);
    expect(a.map((m) => m.id)).toEqual(["3"]);
    expect(b.map((m) => m.id)).toEqual(["3", "2", "1"]);
  });

  it("falls through to a real request for a caller older than the cached one (backlog recovery)", async () => {
    const { adapter, cursors, reads } = setup(["1", "2", "3"]);
    await cursors.save(X_MENTION_CURSOR_SOURCE, "2");
    await cursors.save(INBOUND_CURSOR_SOURCE, "2");
    await reads.fetchOwnMentions("me", "2");
    const backlog = await reads.fetchOwnMentions("me", undefined);
    expect(adapter.mentionCalls).toEqual(["2", undefined]);
    expect(backlog.map((m) => m.id)).toEqual(["3", "2", "1"]);
  });

  it("does not cache a failed mentions request", async () => {
    const { adapter, cursors, reads } = setup(["1", "2"]);
    await cursors.save(X_MENTION_CURSOR_SOURCE, "1");
    await cursors.save(INBOUND_CURSOR_SOURCE, "1");
    adapter.failNextMentions = true;
    await expect(reads.fetchOwnMentions("me", "1")).rejects.toThrow("429");
    const retry = await reads.fetchOwnMentions("me", "1");
    expect(retry.map((m) => m.id)).toEqual(["2"]);
    expect(adapter.mentionCalls).toHaveLength(2);
  });
});
