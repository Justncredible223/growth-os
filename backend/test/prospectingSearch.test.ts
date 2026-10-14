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
  async updateStatus() {}
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
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "how do you track your trading over time?" })]) };
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
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "how do you track your trading over time?" })]) };
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
    const post = searchResult({ id: "1", text: "how do you track your trading over time?" });

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
    const post = searchResult({ id: "1", text: "how do you actually review your trading journal weekly?", authorId: "known-author" });
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([post]) };
    const repo = new FakeProspectingRepo();
    repo.outreach.add("known-author");

    await runProspectingSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    const inserted = [...repo.rows.values()][0]!;
    expect(inserted.scoreBreakdown.priorRelationship).toMatch(/already replied/);
  });

  describe("search breadth follows what is already selectable (2026-10-14 cost cut)", () => {
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
    const run = (repo: FakeProspectingRepo, adapter: any, extra: Record<string, unknown> = {}) =>
      runProspectingSearch({ adapter, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, ...extra });

    it("makes no X read when a full daily set (15) is already waiting", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 15);
      const result = await run(repo, adapter);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/enough_waiting/);
      expect(result.costUsd).toBe(0);
      expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
    });

    it("searches one topic instead of two once the daily minimum (8) is waiting", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 8);
      const result = await run(repo, adapter);
      expect(result.skipped).toBe(false);
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(1);
      expect(result.selectableBefore).toBe(8);
    });

    it("searches the full slice when fewer than 8 are waiting", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 7);
      await run(repo, adapter);
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

    it("an owner-triggered search now (runIndexOverride) always searches the full slice", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 15);
      const result = await run(repo, adapter, { runIndexOverride: 3 });
      expect(result.skipped).toBe(false);
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(TOPICS_PER_SEARCH_RUN);
    });

    it("a thinned run searches the FIRST topic of the same slice, so rotation position is unchanged", async () => {
      const full = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      await run(new FakeProspectingRepo(), full);
      const thin = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const repo = new FakeProspectingRepo();
      await seedSelectable(repo, 9);
      await run(repo, thin);
      expect(thin.searchRecentPosts.mock.calls[0]![0]).toBe(full.searchRecentPosts.mock.calls[0]![0]);
    });
  });
});
