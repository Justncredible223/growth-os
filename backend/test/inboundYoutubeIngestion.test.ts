import { describe, it, expect } from "vitest";
import { ingestInboundYoutubeComments, youtubeCommentCursorKey } from "../src/inbound/inboundYoutubeIngestion";
import { InMemoryInboundRepository } from "../src/inbound/inMemoryInboundRepository";
import { InMemoryIngestionCursorStore } from "../src/signals/adapters/ingestionCursorStore";
import type { YoutubeComment } from "../src/signals/adapters/youtubeAdapter";

function comment(overrides: Partial<YoutubeComment> & Pick<YoutubeComment, "id" | "text">): YoutubeComment {
  return {
    authorDisplayName: "Some Trader",
    authorChannelId: "channel-1",
    publishedAt: new Date("2026-09-01T12:00:00Z"),
    ...overrides,
  };
}

class FakeAdapter {
  constructor(private comments: YoutubeComment[]) {}
  async fetchTopLevelComments(_videoId: string): Promise<YoutubeComment[]> {
    return this.comments;
  }
}

function buildDeps(comments: YoutubeComment[]) {
  return { adapter: new FakeAdapter(comments) as any, repo: new InMemoryInboundRepository() };
}

describe("ingestInboundYoutubeComments", () => {
  const now = new Date("2026-09-01T13:00:00Z");
  const VIDEO_ID = "video-1";

  it("inserts a fresh comment as needs_response, platform 'youtube'", async () => {
    const deps = buildDeps([comment({ id: "c1", text: "how do you track drawdown?" })]);
    const cursors = new InMemoryIngestionCursorStore();

    const result = await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    expect(result).toEqual({ fetched: 1, inserted: 1, skippedExisting: 0 });
    const row = deps.repo.all()[0]!;
    expect(row.platform).toBe("youtube");
    expect(row.status).toBe("needs_response");
    expect(row.authorHandle).toBe("Some Trader");
    expect(row.authorExternalId).toBe("channel-1");
    expect(row.sourceReference).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}&lc=c1`);
  });

  it("classifies low-value text as closed, but still inserts it visibly", async () => {
    const deps = buildDeps([comment({ id: "c1", text: "🔥" })]);
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    const row = deps.repo.all()[0]!;
    expect(row.priority).toBe("low_value");
    expect(row.status).toBe("closed");
  });

  it("never resolves a creatorId for a YouTube comment -- display names aren't stable identifiers", async () => {
    const deps = buildDeps([comment({ id: "c1", text: "love this tool" })]);
    const cursors = new InMemoryIngestionCursorStore();

    await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    expect(deps.repo.all()[0]!.creatorId).toBeNull();
  });

  it("never re-inserts across repeated runs of the same video -- the per-video cursor filters an already-seen comment out before it ever reaches the repository", async () => {
    const c = comment({ id: "c1", text: "great tool" });
    const deps = buildDeps([c]);
    const cursors = new InMemoryIngestionCursorStore();

    const first = await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);
    const second = await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    expect(first.inserted).toBe(1);
    expect(second).toEqual({ fetched: 0, inserted: 0, skippedExisting: 0 });
    expect(deps.repo.all()).toHaveLength(1);
  });

  it("still dedupes via the repository's own (platform, externalId) upsert if the same comment id somehow appears twice within one fetched page", async () => {
    const c = comment({ id: "c1", text: "great tool" });
    const deps = buildDeps([c, c]);
    const cursors = new InMemoryIngestionCursorStore();

    const result = await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    expect(result.inserted).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(deps.repo.all()).toHaveLength(1);
  });

  it("only ingests comments newer than the stored per-video cursor -- comments arrive newest-first", async () => {
    const cursors = new InMemoryIngestionCursorStore();
    await cursors.save(youtubeCommentCursorKey(VIDEO_ID), "c-old");

    const deps = buildDeps([
      comment({ id: "c-new-2", text: "second new comment" }),
      comment({ id: "c-new-1", text: "first new comment" }),
      comment({ id: "c-old", text: "already seen" }),
      comment({ id: "c-older", text: "older still" }),
    ]);

    const result = await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    expect(result.fetched).toBe(2);
    const externalIds = deps.repo.all().map((r) => r.externalId);
    expect(externalIds).toEqual(["c-new-2", "c-new-1"]);
  });

  it("keeps a separate cursor per video id", async () => {
    const cursors = new InMemoryIngestionCursorStore();
    const depsA = buildDeps([comment({ id: "a1", text: "on video A" })]);
    const depsB = buildDeps([comment({ id: "b1", text: "on video B" })]);

    await ingestInboundYoutubeComments(depsA, cursors, "video-a", now);
    await ingestInboundYoutubeComments(depsB, cursors, "video-b", now);

    expect(await cursors.load(youtubeCommentCursorKey("video-a"))).toBe("a1");
    expect(await cursors.load(youtubeCommentCursorKey("video-b"))).toBe("b1");
  });

  it("treats the whole page as new if the stored cursor id isn't found in it (scrolled off / stale cursor) rather than silently dropping everything", async () => {
    const cursors = new InMemoryIngestionCursorStore();
    await cursors.save(youtubeCommentCursorKey(VIDEO_ID), "long-gone-id");
    const deps = buildDeps([comment({ id: "c1", text: "still surfaces" })]);

    const result = await ingestInboundYoutubeComments(deps, cursors, VIDEO_ID, now);

    expect(result.inserted).toBe(1);
  });

  it("detects a repeat commenter on the same video -- second comment from the same channel id is flagged, first is not", async () => {
    const repo = new InMemoryInboundRepository();
    const cursors = new InMemoryIngestionCursorStore();
    await ingestInboundYoutubeComments(
      { adapter: new FakeAdapter([comment({ id: "c1", text: "first comment" })]) as any, repo },
      cursors,
      VIDEO_ID,
      now,
    );
    await ingestInboundYoutubeComments(
      { adapter: new FakeAdapter([comment({ id: "c2", text: "second comment" })]) as any, repo },
      cursors,
      VIDEO_ID,
      now,
    );

    const rows = repo.all();
    expect(rows.find((r) => r.externalId === "c1")!.isRepeatEngager).toBe(false);
    expect(rows.find((r) => r.externalId === "c2")!.isRepeatEngager).toBe(true);
  });
});

describe("P0 2026-11-15: YouTube comments follow pages until the stored cursor", () => {
  it("reads older pages until it finds the cursor, and stores only the new comments", async () => {
    const { ingestInboundYoutubeComments } = await import("../src/inbound/inboundYoutubeIngestion");
    const { InMemoryInboundRepository } = await import("../src/inbound/inMemoryInboundRepository");
    const c = (id: string) => ({ id, text: "nice video", authorDisplayName: "a", authorChannelId: "ch-" + id, publishedAt: new Date("2026-11-15T10:00:00Z") });
    const pages: Record<string, { comments: ReturnType<typeof c>[]; nextPageToken?: string }> = {
      first: { comments: [c("c9"), c("c8")], nextPageToken: "t2" },
      t2: { comments: [c("c7"), c("c6")], nextPageToken: "t3" },
      t3: { comments: [c("c5"), c("old")], nextPageToken: "t4" },
    };
    const adapter = {
      fetchTopLevelComments: async () => pages.first!.comments,
      fetchTopLevelCommentsPage: async (_v: string, token?: string) => pages[token ?? "first"]!,
    };
    const saved = new Map<string, string>([["youtube_comments:vid", "old"]]);
    const cursorStore = { load: async (k: string) => saved.get(k) ?? null, save: async (k: string, v: string) => void saved.set(k, v) } as any;
    const repo = new InMemoryInboundRepository();
    const keyFn = (await import("../src/inbound/inboundYoutubeIngestion")) as any;
    if (keyFn.youtubeCommentCursorKey) { saved.clear(); saved.set(keyFn.youtubeCommentCursorKey("vid"), "old"); }
    const result = await ingestInboundYoutubeComments({ adapter: adapter as any, repo }, cursorStore, "vid");
    expect(result.inserted).toBe(5);
    expect(result.truncated).toBeUndefined();
  });
});
