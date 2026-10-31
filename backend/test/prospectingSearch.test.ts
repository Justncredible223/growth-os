import { describe, it, expect, vi } from "vitest";
import { groupedTopicQuery, runProspectingSearch, topicForPost, TOPICS_PER_QUERY } from "../src/prospecting/prospectingSearch";
import { PROSPECTING_TOPICS, topicsInSearchOrder } from "../src/prospecting/prospectingTopics";
import { CRYPTO_QUERY_EXCLUSIONS, FUTURES_QUERY_ANCHORS, withCryptoExclusions } from "../src/prospecting/prospectingRelevance";
import { DAILY_SEARCH_BUDGET_USD, DAILY_SEARCH_CAP, TOPICS_PER_SEARCH_RUN, selectPrioritizedTopicsForRun } from "../src/prospecting/prospectingEligibility";
import { MAX_AGE_FOR_DAILY_SELECTION_MS } from "../src/prospecting/prospectingFreshness";
import type { XSearchResult } from "../src/signals/adapters/xAdapter";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

/** Every test starts with no hand-picked seed creators (production seeds the owner's twelve, see PROSPECTING_SEED_CREATORS); a test that wants seeds passes watchlistSeeds. */
const runSearch = (deps: Parameters<typeof runProspectingSearch>[0]) => runProspectingSearch({ watchlistSeeds: [], ...deps });

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
  watchRows: Array<{ authorHandle: string | null; authorFollowerCount: number | null; status: string; opportunityScore: number }> = [];
  watchFails = false;
  async listWatchlistRows() {
    if (this.watchFails) throw new Error("watchlist read failed");
    return this.watchRows;
  }
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

    const result = await runSearch({
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

    await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    expect(adapter.searchRecentPosts).toHaveBeenCalledWith(expect.any(String), expect.any(Number), now, MAX_AGE_FOR_DAILY_SELECTION_MS);
  });

  it("never re-inserts a post already known from a prior run", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([searchResult({ id: "1", text: "how do you track your futures trading over time?" })]) };
    const repo = new FakeProspectingRepo();
    const deps = { adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now };

    const first = await runSearch(deps);
    const second = await runSearch({ ...deps, now: new Date(now.getTime() + 24 * 60 * 60 * 1000) });

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

    const result = await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

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

    const result = await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    expect(result.excludedAsIrrelevant).toBe(TOPICS_PER_SEARCH_RUN);
    expect(result.newCandidates).toBe(0);
    expect(repo.rows.size).toBe(0);
  });

  it("skips entirely once the monthly budget is exhausted, without calling search", async () => {
    const adapter = { searchRecentPosts: vi.fn() };
    const repo = new FakeProspectingRepo();

    const result = await runSearch({
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

    const result = await runSearch({
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
    const resultNotPaused = await runSearch({
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
    const resultNoDep = await runSearch({
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

    const result = await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/queue_full/);
    expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
  });

  it("runIndexOverride picks a topic slice independent of now's schedule slot, for manual 'search now' runs", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
    const repo = new FakeProspectingRepo();

    await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, runIndexOverride: 0 });
    const queriesAtZero = adapter.searchRecentPosts.mock.calls.map((c) => c[0]);

    adapter.searchRecentPosts.mockClear();
    await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, runIndexOverride: 1 });
    const queriesAtOne = adapter.searchRecentPosts.mock.calls.map((c) => c[0]);

    expect(queriesAtZero).not.toEqual(queriesAtOne);
  });

  it("no topic skips the futures anchor today (the unanchored experiment of 2026-10-30 read only non-futures posts and was switched off)", async () => {
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
    const repo = new FakeProspectingRepo();
    for (let i = 0; i < 24; i++) {
      await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, runIndexOverride: i, getRecentSearchQueries: async () => new Set() });
    }
    const queries = adapter.searchRecentPosts.mock.calls.map((c) => c[0] as string);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toContain(FUTURES_QUERY_ANCHORS);
  });

  it("scores a previously-engaged author's post higher via the prior-outreach bonus", async () => {
    const post = searchResult({ id: "1", text: "how do you actually review your futures trading journal weekly?", authorId: "known-author" });
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([post]) };
    const repo = new FakeProspectingRepo();
    repo.outreach.add("known-author");

    await runSearch({ adapter: adapter as any, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now });

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
      runProspectingSearch({ watchlistSeeds: [], adapter, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, ...extra });
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

    it("never repeats a topic search that was just made: it skips to the next topics, and makes no request at all when every one was recent (2026-10-28)", async () => {
      const asked: string[] = [];
      const blockFirstTwo = new (class extends Set<string> {
        has(q: string) {
          if (!asked.includes(q)) asked.push(q);
          return asked.indexOf(q) < 2;
        }
      })();
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      await run(new FakeProspectingRepo(), adapter, { runIndexOverride: 3, getRecentSearchQueries: async () => blockFirstTwo });
      expect(asked.length).toBeGreaterThanOrEqual(3);
      const sent = adapter.searchRecentPosts.mock.calls.map((c) => c[0] as string);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.some((q) => q.includes(asked[0]!) || q.includes(asked[1]!))).toBe(false);
      expect(sent[0]).toContain(asked[2]!);

      const none = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const all = new (class extends Set<string> {
        has() {
          return true;
        }
      })();
      const result = await run(new FakeProspectingRepo(), none, { runIndexOverride: 3, getRecentSearchQueries: async () => all });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/searched_recently/);
      expect(none.searchRecentPosts).not.toHaveBeenCalled();
    });

    it("a failed read of the recent searches never blocks a search", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, {
        getRecentSearchQueries: async () => {
          throw new Error("db down");
        },
      });
      expect(result.skipped).toBe(false);
      expect(adapter.searchRecentPosts).toHaveBeenCalled();
    });

    it("stops at the daily search limit, with a clear reason, before any X read", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchCount: async () => DAILY_SEARCH_CAP });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/daily_search_cap/);
      expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
    });

    it("makes only the searches the daily limit still allows", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchCount: async () => DAILY_SEARCH_CAP - 1, runIndexOverride: 5 });
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(1);
      expect(result.searchRequests).toBe(1);
    });
    it("stops at the daily search budget (dollars, not requests), with a clear reason, before any X read", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchSpendUsd: async () => DAILY_SEARCH_BUDGET_USD });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/daily_search_budget/);
      expect(adapter.searchRecentPosts).not.toHaveBeenCalled();
    });

    it("near-empty searches do not use up the day: many requests are fine while the spend stays small", async () => {
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([]) };
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchCount: async () => 10, getTodaySearchSpendUsd: async () => 0.09, runIndexOverride: 5 });
      expect(result.skipped).toBe(false);
      expect(adapter.searchRecentPosts).toHaveBeenCalled();
    });

    it("stops mid-run once this run's own spend reaches the daily budget", async () => {
      const posts = Array.from({ length: 10 }, (_, i) => searchResult({ id: `junk-${i}`, text: "nothing relevant here at all", authorId: `a${i}` }));
      const adapter = { searchRecentPosts: vi.fn().mockResolvedValue(posts) };
      // 10 reads cost $0.05 each request; with $0.04 of the budget left only one more request fits.
      const result = await run(new FakeProspectingRepo(), adapter, { getTodaySearchSpendUsd: async () => DAILY_SEARCH_BUDGET_USD - 0.04, runIndexOverride: 5 });
      expect(adapter.searchRecentPosts).toHaveBeenCalledTimes(1);
      expect(result.searchRequests).toBe(1);
    });
  });

  describe("grouped queries (2026-10-25: one near-empty request per narrow topic burned the day)", () => {
    it("ORs several topics into one query, as many as fit, keeping each topic's own meaning", () => {
      const { query, used } = groupedTopicQuery(PROSPECTING_TOPICS.slice(0, TOPICS_PER_QUERY));
      expect(used.length).toBeGreaterThan(1);
      expect(query).toContain(" OR ");
      expect(query.startsWith("(")).toBe(true);
      for (const t of used) expect(query).toContain(`(${t.query})`);
    });

    it("every rotation group, once wrapped with the futures anchor and exclusions, fits inside X's 512 characters", () => {
      for (let start = 0; start < PROSPECTING_TOPICS.length; start++) {
        const group = Array.from({ length: TOPICS_PER_QUERY }, (_, i) => PROSPECTING_TOPICS[(start + i) % PROSPECTING_TOPICS.length]!);
        const { query } = groupedTopicQuery(group);
        expect(withCryptoExclusions(query).length + " -is:retweet -is:reply lang:en".length, `group at ${start}`).toBeLessThanOrEqual(512);
      }
    });

    it("every pain-phrase topic is searched before any noun topic, and every ordered rotation group still fits 512 characters with -has:links", () => {
      const ordered = topicsInSearchOrder();
      expect(ordered).toHaveLength(PROSPECTING_TOPICS.length);
      const firstNoun = ordered.findIndex((t) => t.priority === 2);
      expect(ordered.slice(0, firstNoun).every((t) => t.priority === 1)).toBe(true);
      expect(ordered.slice(firstNoun).every((t) => t.priority === 2)).toBe(true);
      for (const key of ["blown_account", "broke_rules", "why_i_lost", "revenge_trading", "losing_streak", "sized_up", "tilt", "holding_losers", "bad_trading_day", "first_loss", "plan_adherence", "overtrading", "trading_mistakes", "strategy_hopping", "daily_loss", "consistency_rule"]) {
        expect(ordered.findIndex((t) => t.key === key), key).toBeLessThan(firstNoun);
      }
      for (const key of ["prop_firm", "funded_account", "trailing_drawdown", "drawdown", "self_funded", "own_capital_futures", "live_futures_account", "risk_management", "trading_journal", "expectancy", "futures_margin"]) {
        expect(ordered.findIndex((t) => t.key === key), key).toBeGreaterThanOrEqual(firstNoun);
      }
      for (let start = 0; start < ordered.length; start++) {
        const group = Array.from({ length: TOPICS_PER_QUERY }, (_, i) => ordered[(start + i) % ordered.length]!);
        const wrapped = withCryptoExclusions(groupedTopicQuery(group).query);
        expect(wrapped).toContain("-has:links");
        expect(wrapped.length + " -is:retweet -is:reply lang:en".length, `ordered group at ${start}`).toBeLessThanOrEqual(512);
      }
    });

    it("a run's first topic slots are all pain topics while there are enough of them", () => {
      for (let run = 0; run < 12; run++) {
        const picked = selectPrioritizedTopicsForRun(topicsInSearchOrder(), run, 8);
        expect(picked.every((t) => t.priority === 1), `run ${run}`).toBe(true);
      }
      const wide = selectPrioritizedTopicsForRun(topicsInSearchOrder(), 0, 30);
      expect(wide.slice(0, 5).every((t) => t.priority === 1)).toBe(true);
      expect(wide.some((t) => t.priority === 2)).toBe(true);
    });

    it("assigns each post to the topic it matched, else the group's first", () => {
      const group = PROSPECTING_TOPICS.filter((t) => ["revenge_trading", "trading_journal", "prop_firm"].includes(t.key));
      expect(topicForPost(group, "Revenge trading cost me my funded account again").key).toBe("revenge_trading");
      expect(topicForPost(group, "Which trading journal do you use for futures?").key).toBe("trading_journal");
      expect(topicForPost(group, "Something unrelated to any phrase").key).toBe(group[0]!.key);
    });

    it("a request covers up to four topics, so a run's two requests cover up to eight", async () => {
      const queries: string[] = [];
      const adapter = { searchRecentPosts: vi.fn(async (q: string) => (queries.push(q), [])) };
      const result = await runSearch({ adapter: adapter as any, repo: new FakeProspectingRepo(), client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now: new Date("2026-09-01T12:00:00Z") });
      expect(queries).toHaveLength(2);
      expect(result.topicsSearched.length).toBeGreaterThan(queries.length);
    });
  });
});

describe("the creator watchlist in the search loop (2026-10-25)", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const creators = (n: number) => Array.from({ length: n }, (_, i) => ({ authorHandle: `creator${i}`, authorFollowerCount: 6000, status: "ready", opportunityScore: 70 }));
  const post = (id: string, text: string, authorId = `a-${id}`) =>
    searchResult({ id, text, authorId, authorHandle: `h${id}`, authorFollowerCount: 5000, createdAt: new Date(now.getTime() - 60 * 60 * 1000), publicMetrics: { reply_count: 2, like_count: 6 } });
  const run = (repo: FakeProspectingRepo, adapter: any, extra: Record<string, unknown> = {}) =>
    runProspectingSearch({ watchlistSeeds: [], adapter, repo, client: fakeSupabaseClient(), getMonthSpendUsd: async () => 0, now, ...extra });

  it("reads the creators first, then topics, when enough creators are known", async () => {
    const queries: string[] = [];
    const adapter = { searchRecentPosts: vi.fn(async (q: string) => (queries.push(q), [])) };
    const repo = new FakeProspectingRepo();
    repo.watchRows = creators(6);
    const result = await run(repo, adapter);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^\(from:creator\d/);
    expect(queries[0]).toContain(" OR from:");
    expect(queries[0]).not.toContain("-crypto"); // the people are already vetted; the gates below still judge every post
    expect(queries[1]).toContain("futures OR MNQ"); // the second request is a topic search with the anchor
    expect(result.creatorRequests).toBe(1);
    expect(result.topicsSearched[0]).toBe("watchlist");
  });

  it("an owner-tapped search alternates creators, topics, creators", async () => {
    const queries: string[] = [];
    const adapter = { searchRecentPosts: vi.fn(async (q: string) => (queries.push(q), [])) };
    const repo = new FakeProspectingRepo();
    repo.watchRows = creators(6);
    await run(repo, adapter, { runIndexOverride: 4 });
    expect(queries).toHaveLength(3);
    expect(queries.map((q) => q.startsWith("(from:"))).toEqual([true, false, true]);
  });

  it("falls back to topics only when fewer than four creators are known, or the list cannot be read", async () => {
    for (const setup of [(r: FakeProspectingRepo) => (r.watchRows = creators(3)), (r: FakeProspectingRepo) => (r.watchFails = true)]) {
      const queries: string[] = [];
      const adapter = { searchRecentPosts: vi.fn(async (q: string) => (queries.push(q), [])) };
      const repo = new FakeProspectingRepo();
      setup(repo);
      const result = await run(repo, adapter);
      expect(queries.some((q) => q.startsWith("(from:"))).toBe(false);
      expect(result.creatorRequests).toBe(0);
    }
  });

  it("seeds from the deps are always watched, and count toward the minimum", async () => {
    const queries: string[] = [];
    const adapter = { searchRecentPosts: vi.fn(async (q: string) => (queries.push(q), [])) };
    await run(new FakeProspectingRepo(), adapter, { watchlistSeeds: ["FuturesFox", "ES_Ed", "NQ_Nate", "MNQ_Mia"] });
    expect(queries[0]).toContain("from:FuturesFox");
    expect(queries[0]).toContain("from:MNQ_Mia");
  });

  it("a creator's post still has to show futures evidence; a clean futures post is stored, scored with the bonus, and labelled by its topic", async () => {
    const generic = post("g1", "Rough week for everyone. Stay disciplined and manage your risk, traders.");
    const futures = post("f1", "Revenge trading cost me my funded NQ futures account again. How do you stop it?");
    const adapter = { searchRecentPosts: vi.fn(async (q: string) => (q.startsWith("(from:") ? [generic, futures] : [])) };
    const repo = new FakeProspectingRepo();
    repo.watchRows = creators(5);
    const result = await run(repo, adapter);
    const stored = [...repo.rows.values()];
    expect(stored.map((r) => r.externalId)).toEqual(["f1"]);
    expect(stored[0]!.scoreBreakdown.watchedCreator).toMatch(/already vetted/);
    expect(stored[0]!.discoveryQuery).toBe("revenge_trading");
    expect(result.excludedAsIrrelevant).toBeGreaterThanOrEqual(1);
  });

  it("a hand-picked seed creator's trading post needs no futures word and skips the model screen; the same text from anyone else is dropped (2026-10-30)", async () => {
    const text = "Trading is a lot like chess. You do not lose because of your last move, you lose because of your process. How do you review your trades?";
    const fromSeed = { ...post("s1", text), authorHandle: "RC_FUTURES" };
    const fromOther = { ...post("o1", text + " "), authorHandle: "somebody_else" };
    const adapter = { searchRecentPosts: vi.fn(async (q: string) => (q.startsWith("(from:") ? [fromSeed, fromOther] : [])) };
    const repo = new FakeProspectingRepo();
    const screenRelevance = vi.fn(async () => false);
    await run(repo, adapter, { watchlistSeeds: ["RC_FUTURES", "ES_Ed", "NQ_Nate", "MNQ_Mia"], screenRelevance });
    expect([...repo.rows.values()].map((r) => r.externalId)).toEqual(["s1"]);
    expect(screenRelevance).not.toHaveBeenCalled();
  });

  it("the same creator request is not made again within the repeat window (2026-10-31)", async () => {
    const seeds = ["FuturesFox", "ES_Ed", "NQ_Nate", "MNQ_Mia"];
    const first: string[] = [];
    await run(new FakeProspectingRepo(), { searchRecentPosts: vi.fn(async (q: string) => (first.push(q), [])) }, { watchlistSeeds: seeds });
    const creatorQuery = first.find((q) => q.startsWith("(from:"))!;
    expect(creatorQuery).toBeDefined();
    const second: string[] = [];
    // The recorded query is the request without the wrapper; the adapter query starts with the same text.
    const recent = new Set([creatorQuery.replace(/ -is:retweet.*$/, "")]);
    const result = await run(new FakeProspectingRepo(), { searchRecentPosts: vi.fn(async (q: string) => (second.push(q), [])) }, { watchlistSeeds: seeds, getRecentSearchQueries: async () => recent });
    expect(second.some((q) => q.startsWith("(from:"))).toBe(false);
    expect(result.creatorRequests).toBe(0);
  });

  it("a creator's post with no matching topic is labelled with the general futures-trader topic", async () => {
    const adapter = { searchRecentPosts: vi.fn(async (q: string) => (q.startsWith("(from:") ? [post("p1", "Took the opening range break on MNQ futures and let it run. What would you have done?")] : [])) };
    const repo = new FakeProspectingRepo();
    repo.watchRows = creators(5);
    await run(repo, adapter);
    expect([...repo.rows.values()][0]!.discoveryQuery).toBe("futures_trader");
  });
});

describe("the funnel is recorded on each request's cost event (2026-10-25)", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const p = (id: string, text: string) =>
    searchResult({ id, text, authorId: `a-${id}`, authorHandle: `h${id}`, authorFollowerCount: 5000, createdAt: new Date(now.getTime() - 60 * 60 * 1000), publicMetrics: { reply_count: 2, like_count: 6 } });

  it("counts the posts dropped by each free gate, the ones kept and the ones the model turned away, with samples", async () => {
    const events: any[] = [];
    const client = { from: () => ({ insert: async (row: any) => (events.push(row), { error: null }) }) } as any;
    const posts = [
      p("o1", "Selling covered calls on NVDA, how do you size your trading risk?"),
      p("f1", "Passed my FTMO challenge on EURUSD, how do you manage the daily loss limit?"),
      p("n1", "Video later today on how to pass prop firm challenges with a higher success rate"),
      p("k1", "How do you manage the trailing drawdown on a funded account trading ES futures?"),
      p("k2", "Revenge trading cost me my funded NQ futures account again. How do you stop it?"),
    ];
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue(posts) };
    const repo = new FakeProspectingRepo();
    const screenRelevance = vi.fn(async (post: { postText: string }) => !post.postText.includes("Revenge"));
    await runSearch({ adapter: adapter as any, repo, client, getMonthSpendUsd: async () => 0, now, screenRelevance, runIndexOverride: 1 });
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0];
    expect(ev.event_type).toBe("x_search_read");
    expect(ev.context.read).toBe(5);
    expect(ev.context.funnel.gate).toMatchObject({ options: 1, forex_stock: 1, no_futures_evidence: 1, model_screen: 1 });
    expect(ev.context.funnel.inserted).toBe(2);
    expect(ev.context.funnel.screenedOut).toBe(1);
    expect(ev.context.funnel.kept.length).toBe(2);
    const whys = ev.context.funnel.samples.map((s: { why: string }) => s.why);
    expect(whys).toEqual(expect.arrayContaining(["options", "forex_stock", "no_futures_evidence", "model_screen"]));
    expect(ev.context.funnel.samples[0].t.length).toBeLessThanOrEqual(110);
    expect(ev.cost_usd).toBeCloseTo(5 * 0.005, 6);
  });

  it("still records the cost event if processing a request throws", async () => {
    const events: any[] = [];
    const client = { from: () => ({ insert: async (row: any) => (events.push(row), { error: null }) }) } as any;
    const repo = new FakeProspectingRepo();
    repo.upsertIfNew = async () => {
      throw new Error("db down");
    };
    const adapter = { searchRecentPosts: vi.fn().mockResolvedValue([p("k1", "How do you manage the trailing drawdown on a funded account trading ES futures?")]) };
    await expect(runProspectingSearch({ watchlistSeeds: [], adapter: adapter as any, repo, client, getMonthSpendUsd: async () => 0, now, runIndexOverride: 1 })).rejects.toThrow("db down");
    expect(events).toHaveLength(1);
    expect(events[0].cost_usd).toBeCloseTo(0.005, 6);
  });
});

