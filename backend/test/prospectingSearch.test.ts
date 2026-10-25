import { describe, it, expect, vi } from "vitest";
import { runProspectingSearch } from "../src/prospecting/prospectingSearch";
import { TOPICS_PER_SEARCH_RUN } from "../src/prospecting/prospectingEligibility";
import { MAX_AGE_FOR_DAILY_SELECTION_MS } from "../src/prospecting/prospectingFreshness";
import type { XSearchResult } from "../src/signals/adapters/xAdapter";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

function candidateFrom(c: NewProspectingCandidate, id: string): ProspectingCandidate {
  return {
    id,
    ...c,
    creatorCandidate: c.creatorCandidate,
    status: "new",
    shownAt: null,
    openedAt: null,
    draftReply: null,
    finalReply: null,
    replyMentionsFillbook: null,
    replyUsedLink: null,
    repliedAt: null,
    skipReason: null,
    createdAt: c.discoveredAt,
    updatedAt: c.discoveredAt,
  };
}

class FakeProspectingRepo implements ProspectingRepository {
  rows = new Map<string, ProspectingCandidate>();
  outreach = new Set<string>();
  private nextId = 1;

  async upsertIfNew(candidate: NewProspectingCandidate) {
    const key = `${candidate.platform}:${candidate.externalId}`;
    const existing = [...this.rows.values()].find((r) => `${r.platform}:${r.externalId}` === key);
    if (existing) return { id: existing.id, created: false };
    const id = `cand-${this.nextId++}`;
    this.rows.set(id, candidateFrom(candidate, id));
    return { id, created: true };
  }
  async listByStatus(statuses: ProspectingStatus[]) {
    return [...this.rows.values()].filter((r) => statuses.includes(r.status));
  }
  async listRepliedSince(since: Date) {
    return [...this.rows.values()].filter((r) => r.status === "replied" && r.repliedAt !== null && new Date(r.repliedAt) >= since);
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async markShown() {}
  async updateStatus(id: string, status: ProspectingStatus) {
    const row = this.rows.get(id);
    if (row) row.status = status;
  }
  async hasPriorOutreach(_platform: string, authorExternalId: string) {
    return this.outreach.has(authorExternalId);
  }
  async recordOutreach(_platform: string, authorExternalId: string) {
    this.outreach.add(authorExternalId);
  }
  async expireStale() {
    return 0;
  }
}

function fakeSupabaseClient() {
  return { from: () => ({ insert: async () => ({ error: null }) }) } as any;
}

function searchResult(overrides: Partial<XSearchResult> & Pick<XSearchResult, "id" | "text">): XSearchResult {
  return {
    authorId: "author-1",
    authorHandle: "trader1",
    authorName: "Trader One",
    authorFollowerCount: 500,
    authorVerified: false,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    publicMetrics: { reply_count: 1, like_count: 2 },
    lang: "en",
    ...overrides,
  };
}

describe("runProspectingSearch", () => {
  const now = new Date("2026-09-01T12:00:00Z");

  it("inserts new candidates found via search, one call per selected topic", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "how do you track your futures trading over time?" })]) };
    const repo = new FakeProspectingRepo();

    const result = await runProspectingSearch({
      adapter: adapter as any,
      repo,
      client: fakeSupabaseClient(),
      getMonthSpendUsd: async () => 0,
      now,
    });

    expect(result.skipped).toBe(false);
    expect(result.newCandidates).toBeGreaterThan(0);
    expect(adapter.searchRecentPosts).toHaveBeenCalled();
    expect(repo.rows.size).toBe(result.newCandidates);
  });

  it("REFINED (2026-09-07 freshness review): bounds discovery itself to the same 72h freshness window selection enforces, via X's own start_time filter -- not just filtering stale posts out after paying to read them", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
    const repo = new FakeProspectingRepo();

    await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    expect(adapter.searchRecentPosts).toHaveBeenCalledWith(expect.any(String), expect.any(Number), now, MAX_AGE_FOR_DAILY_SELECTION_MS);
  });

  it("never re-inserts a post already known from a prior run", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "how do you track your futures trading over time?" })]) };
    const repo = new FakeProspectingRepo();
    const deps = { adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now };

    const first = await runProspectingSearch(deps);
    const second = await runProspectingSearch({ ...deps, now: new Date(now.getTime() + 24 * 60 * 60 * 1000) });

    expect(first.newCandidates).toBeGreaterThan(0);
    // Same post id keeps coming back from search (still matches the query) but must not duplicate.
    const totalRows = repo.rows.size;
    expect(second.newCandidates + first.newCandidates).toBeLessThanOrEqual(totalRows + first.newCandidates);
    expect(totalRows).toBe(first.newCandidates);
  });

  it("excludes spam-pattern posts from the inserted count without erroring", async () => {
    const adapter = {
      searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "DM me for trading signals, guaranteed profit trading futures!!!" })]),
    };
    const repo = new FakeProspectingRepo();

    const result = await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    // The same spam post comes back from every one of this run's topic searches (mockResolvedValue applies to every call).
    expect(result.excludedAsSpam).toBe(TOPICS_PER_SEARCH_RUN);
    expect(result.newCandidates).toBe(0);
    expect(repo.rows.size).toBe(0);
  });

  it("excludes off-topic posts (crypto, prop-firm ad spam, generic stock content) from the inserted count without erroring -- real bug, 2026-09-28: these were previously stored and only reclassified 'not_relevant' the next time the queue was fetched", async () => {
    const adapter = {
      searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "Bitcoin just broke $90k, huge crypto rally today" })]),
    };
    const repo = new FakeProspectingRepo();

    const result = await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    expect(result.excludedAsIrrelevant).toBe(TOPICS_PER_SEARCH_RUN);
    expect(result.newCandidates).toBe(0);
    expect(repo.rows.size).toBe(0);
  });

  it("skips entirely once the monthly budget is exhausted, without calling search", async () => {
    const adapter = { searchRecentPosts: vi.fn() };
    const repo = new FakeProspectingRepo();

    const result = await runProspectingSearch({
      adapter: adapter as any,
      repo,
      client: fakeSupabaseClient(),
      getMonthSpendUsd: async () => 999,
      now,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/monthly_budget_reached/);
    expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
  });

  it("skips entirely while the system is paused, before even checking the monthly budget or calling search", async () => {
    const adapter = { searchRecentPosts: vi.fn() };
    const repo = new FakeProspectingRepo();
    const getMonthSpendUsd = vi.fn().mockResolvedValue(0);

    const result = await runProspectingSearch({
      adapter: adapter as any,
      repo,
      client: fakeSupabaseClient(),
      getMonthSpendUsd,
      isPaused: async () => true,
      now,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("system_paused");
    expect(result.newCandidates).toBe(0);
    expect(getMonthSpendUsd).not.toHaveBeenCalled();
    expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
  });

  it("runs normally when isPaused resolves false, and when it's omitted entirely (existing callers' contract is unchanged)", async () => {
    const post = searchResult({ id: "1", text: "how do you track your futures trading over time?" });

    const repoNotPaused = new FakeProspectingRepo();
    const adapterNotPaused = { searchRecentPosts: vi.fn().mockResolvedValue([post]) };
    const resultNotPaused = await runProspectingSearch({
      adapter: adapterNotPaused as any,
      repo: repoNotPaused,
      client: fakeSupabaseClient(),
      getMonthSpendUsd: async () => 0,
      isPaused: async () => false,
      now,
    });
    expect(resultNotPaused.skipped).toBe(false);
    expect(resultNotPaused.newCandidates).toBeGreaterThan(0);

    const repoNoDep = new FakeProspectingRepo();
    const adapterNoDep = { searchRecentPosts: vi.fn().mockResolvedValue([post]) };
    const resultNoDep = await runProspectingSearch({
      adapter: adapterNoDep as any,
      repo: repoNoDep,
      client: fakeSupabaseClient(),
      getMonthSpendUsd: async () => 0,
      now,
    });
    expect(resultNoDep.skipped).toBe(false);
    expect(resultNoDep.newCandidates).toBeGreaterThan(0);
  });

  it("skips entirely once the queue already has enough unshown candidates", async () => {
    const adapter = { searchRecentPosts: vi.fn() };
    const repo = new FakeProspectingRepo();
    for (let i = 0; i < 30; i++) {
      await repo.upsertIfNew({
        platform: "x",
        externalId: `existing-${i}`,
        discoveryQuery: "drawdown",
        authorHandle: null,
        authorExternalId: null,
        authorName: null,
        authorFollowerCount: null,
        authorVerified: null,
        postText: "existing candidate",
        postUrl: "https://x.com/i/web/status/existing",
        postCreatedAt: null,
        publicMetrics: {},
        opportunityScore: 10,
        scoreBreakdown: {},
        creatorCandidate: false,
        discoveredAt: now.toISOString(),
      });
    }

    const result = await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/queue_full/);
    expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
  });

  it("runIndexOverride picks a topic slice independent of now's schedule slot, for manual 'search now' runs", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
    const repo = new FakeProspectingRepo();

    await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, runIndexOverride: 0 });
    const queriesAtZero = adapter.searchRecentPosts.mock.calls.map((c) => c[0]);

    adapter.searchRecentPosts.mockClear();
    await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, runIndexOverride: 1 });
    const queriesAtOne = adapter.searchRecentPosts.mock.calls.map((c) => c[0]);

    expect(queriesAtZero).not.toEqual(queriesAtOne);
  });

  it("scores a previously-engaged author's post higher via the prior-outreach bonus", async () => {
    const post = searchResult({ id: "1", text: "how do you actually review your futures trading journal weekly?", authorId: "known-author" });
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([post]) };
    const repo = new FakeProspectingRepo();
    repo.outreach.add("known-author");

    await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    const inserted = [...repo.rows.values()][0]!;
    expect(inserted.scoreBreakdown.priorRelationship).toMatch(/already replied/);
  });

  describe("search tops up a small fresh buffer and stops as soon as it is met (2026-10-24)", () => {
    async function seedSelectable(repo: FakeProspectingRepo, count: number) {
      for (let i = 0; i < count; i++) {
        await repo.upsertIfNew({
          platform: "x",
          externalId: `waiting-${i}`,
          discoveryQuery: "drawdown",
          authorHandle: `author${i}`,
          authorExternalId: `author-${i}`,
          authorName: null,
          authorFollowerCount: 800,
          authorVerified: false,
          postText: "how do you manage trailing drawdown on a funded account?",
          postUrl: `https://x.com/i/web/status/waiting-${i}`,
          postCreatedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
          publicMetrics: {},
          opportunityScore: 60,
          scoreBreakdown: {},
          creatorCandidate: false,
          discoveredAt: now.toISOString(),
        });
      }
    }
    /** A fresh futures post that scores above the daily bar: a question, a mid-sized author, posted an hour ago. */
    function good(id: string, text = "how do you handle the trailing drawdown on your Topstep funded account on MNQ futures?") {
      return searchResult({
        id,
        text,
        authorId: `author-${id}`,
        authorHandle: `h${id}`,
        authorFollowerCount: 5000,
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        publicMetrics: { reply_count: 2, like_count: 6, impression_count: 400 },
      });
    }
    const run = (repo: FakeProspectingRepo, adapter: any, extra: Record<string, unknown> = {}) =>
      runProspectingSearch({ adapter, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, ...extra });
    const trackingRepo = () => new FakeProspectingRepo();

    it("makes no X read when two usable posts are already waiting", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 2);
      const result = await run(repo, adapter);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/enough_waiting/);
      expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
    });

    it("searches one topic and stops when that already fills the buffer", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([good("a"), good("b"), good("c")]) };
      const result = await run(new FakeProspectingRepo(), adapter);
      expect(result.skipped).toBe(false);
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(1);
      expect(result.searchRequests).toBe(1);
      expect(result.selectableAfter).toBeGreaterThanOrEqual(2);
    });

    it("moves to the next topic only when the first topic left the buffer short, and never past the slice", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      await run(new FakeProspectingRepo(), adapter);
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(TOPICS_PER_SEARCH_RUN);
    });

    it("does not count candidates that are not selectable (stale, or off-topic)", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 15);
      for (const row of repo.rows.values()) row.postCreatedAt = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();
      const result = await run(repo, adapter);
      expect(result.skipped).toBe(false);
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(TOPICS_PER_SEARCH_RUN);
    });

    it("an owner-tapped search now keeps going, topic by topic, until it finds one more usable post (at most 3 topics)", async () => {
      const calls: string[] = [];
      const adapter = {
        searchRecentPosts: vi.fn(async (q: string) => {
          calls.push(q);
          return calls.length === 2 ? [good("m1")] : [];
        }),
      };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 3);
      const result = await run(repo, adapter, { runIndexOverride: 3 });
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(2);
      expect(result.selectableAfter).toBe(4);
    });

    it("an owner-tapped search now gives up after 3 topics and says so honestly", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { runIndexOverride: 3 });
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(3);
      expect(result.skipped).toBe(false);
      expect(result.selectableAfter).toBe(0);
    });

    it("asks X for futures posts only (crypto and options left out), and the query stays inside X's limit", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      await run(new FakeProspectingRepo(), adapter);
      const query = adapter.searchRecentPosts.mock.calls[0]![0] as string;
      expect(query).toContain("-crypto");
      expect(query).toContain("-0dte");
      expect(query).toContain("futures OR MNQ");
      expect(query.length).toBeLessThan(480);
    });

    it("drops options, forex, stock and generic-trading posts before storing them", async () => {
      const adapter = {
        searchRecentPosts: vi.fn().mockResolvedValue([
          good("o1", "Selling covered calls on NVDA, how do you size your trading risk?"),
          good("f1", "Passed my FTMO challenge on EURUSD, how do you manage the daily loss limit?"),
          good("g1", "How do you stay disciplined with trading psychology and risk management?"),
          good("ok", "How do you manage the trailing drawdown on a funded account trading ES futures?"),
        ]),
      };
      const repo = new FakeProspectingRepo();
      const result = await run(repo, adapter);
      expect(result.newCandidates).toBe(1);
      expect(result.excludedAsIrrelevant).toBeGreaterThanOrEqual(3);
      expect([...repo.rows.values()].map((r) => r.externalId)).toEqual(["ok"]);
    });

    it("screens the best new posts with the model check, turns the irrelevant one away, and moves on to the next topic", async () => {
      const repo = trackingRepo();
      const posts = [good("keep1"), good("drop1", "how do you size positions on your funded account trading ES futures every day?")];
      const calls = { n: 0 };
      const adapter = {
        searchRecentPosts: vi.fn(async () => {
          calls.n++;
          return calls.n === 1 ? posts : [good("later1"), good("later2")];
        }),
      };
      const screenRelevance = vi.fn(async (post: { postText: string }) => !post.postText.includes("every day"));
      const result = await run(repo, adapter, { screenRelevance });
      expect(screenRelevance).toHaveBeenCalled();
      expect(result.screenedOut).toBe(1);
      expect([...repo.rows.values()].find((r) => r.externalId === "drop1")!.status).toBe("not_relevant");
      expect([...repo.rows.values()].find((r) => r.externalId === "keep1")!.status).toBe("new");
      expect(result.selectableAfter).toBeGreaterThanOrEqual(2);
    });

    it("a failed model check never hides a post", async () => {
      const repo = trackingRepo();
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([good("x1"), good("x2")]) };
      const screenRelevance = vi.fn(async () => {
        throw new Error("model unavailable");
      });
      const result = await run(repo, adapter, { screenRelevance });
      expect(result.screenedOut).toBe(0);
      expect(result.selectableAfter).toBe(2);
    });

    it("only screens posts that clear the quality bar, and at most 8 a run", async () => {
      const repo = trackingRepo();
      const many = Array.from({ length: 12 }, (_, i) => good(`p${i}`));
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue(many) };
      const screenRelevance = vi.fn(async () => true);
      await run(repo, adapter, { screenRelevance, runIndexOverride: 1 });
      expect(screenRelevance.mock.calls.length).toBeLessThanOrEqual(8);
    });

    it("stops at the daily search limit, with a clear reason, before any X read", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchCount: async () => 10 });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/daily_search_cap/);
      expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
    });

    it("makes only the searches the daily limit still allows", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchCount: async () => 9, runIndexOverride: 5 });
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(1);
      expect(result.searchRequests).toBe(1);
    });
  });
});
