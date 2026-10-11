import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RETIRED_STEPS, isStepRetired, retiredStepSkip } from "../src/retiredSteps";

describe("retired step list", () => {
  it("lists exactly the four owner-retired steps, each dated and with a reason", () => {
    expect(Object.keys(RETIRED_STEPS).sort()).toEqual(["auto_draft", "generate_opportunities", "strategy_evolution", "x_mentions"]);
    for (const entry of Object.values(RETIRED_STEPS)) {
      expect(entry.retiredOn).toBe("2026-10-10");
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("kept steps are never on the list", () => {
    for (const kept of ["search_console", "x_feed_post", "x_inbound", "x_prospecting", "x_own_posts", "partnerships_discovery", "engagement_autofill", "youtube_stats", "youtube_comments", "chart_card_requests", "notifications"]) {
      expect(isStepRetired(kept)).toBe(false);
      expect(retiredStepSkip(kept)).toBeNull();
    }
  });

  it("the skip text says retired, gives the date and the one-line re-enable", () => {
    const text = retiredStepSkip("auto_draft")!;
    expect(text.startsWith("skipped -- retired 2026-10-10")).toBe(true);
    expect(text).toContain("Radar/Strategy screens removed");
    expect(text).toContain("deleting \"auto_draft\" from src/retiredSteps.ts");
  });

  it("re-enabling is just deleting the entry (a table without it is live)", () => {
    expect(retiredStepSkip("auto_draft", {})).toBeNull();
    expect(retiredStepSkip("auto_draft", { auto_draft: { retiredOn: "x", reason: "y" } })).not.toBeNull();
  });
});

const mocked: string[] = [];
/** vi.doMock that is undone after each test, so one suite's module fakes never leak into the next. */
function mock(path: string, factory: () => any) {
  mocked.push(path);
  vi.doMock(path, factory);
}
afterEach(() => {
  for (const p of mocked.splice(0)) vi.doUnmock(p);
});

function fakeRes() {
  const out: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

/** A chainable supabase stand-in: every read resolves to empty data, and `paused` can be flipped. */
function fakeClient(opts: { paused?: boolean } = {}) {
  const make = (table: string): any => {
    const result = table === "system_settings" ? { data: { paused: opts.paused ?? false }, error: null } : { data: [], error: null, count: 0 };
    const single = table === "system_settings" ? result : { data: null, error: null, count: 0 };
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result);
          if (prop === "maybeSingle" || prop === "single") return async () => single;
          return () => chain;
        },
      },
    );
    return chain;
  };
  return { from: (table: string) => make(table) };
}

describe("api/growth-pulse retirement", { timeout: 60_000 }, () => {
  const calls = { userId: 0, mentions: [] as Array<string | undefined>, ingestInboundArgs: 0, prospecting: 0 };
  const cursors = new Map<string, string>();
  let mentionsToServe: Array<{ id: string }> = [];

  beforeEach(() => {
    vi.resetModules();
    calls.userId = 0;
    calls.mentions = [];
    calls.ingestInboundArgs = 0;
    calls.prospecting = 0;
    cursors.clear();
    mentionsToServe = [];
    process.env.CRON_SECRET = "s3cret";
  });

  async function loadHandler(pausedSystem = false) {
    mock("../src/lib/supabaseClient", () => ({ getServiceClient: () => fakeClient({ paused: pausedSystem }) }));
    mock("../src/signals/adapters/xAdapter", () => ({
      createXSignalAdapter: () => ({
        resolveOwnUserId: async () => {
          calls.userId++;
          return "me";
        },
        fetchOwnMentions: async (_u: string, since?: string) => {
          calls.mentions.push(since);
          return mentionsToServe.filter((m) => since === undefined || BigInt(m.id) > BigInt(since));
        },
        fetchOwnTweets: async () => [],
      }),
    }));
    mock("../src/signals/adapters/ingestionCursorStore", () => ({
      SupabaseIngestionCursorStore: class {
        async load(s: string) {
          return cursors.get(s) ?? null;
        }
        async save(s: string, id: string) {
          cursors.set(s, id);
        }
      },
    }));
    mock("../src/inbound/inboundIngestion", () => ({
      INBOUND_CURSOR_SOURCE: "x_mention_inbound",
      ingestInboundMentions: async (deps: any, store: any, userId: string) => {
        calls.ingestInboundArgs++;
        const since = (await store.load("x_mention_inbound")) ?? undefined;
        const fetched = await deps.adapter.fetchOwnMentions(userId, since);
        if (fetched.length > 0) await store.save("x_mention_inbound", fetched[0].id);
        return { fetched: fetched.length, inserted: fetched.length, skippedExisting: 0 };
      },
    }));
    mock("../src/lib/integrationHealth", () => ({
      recordSyncAttempt: async () => {},
      recordSyncSuccess: async () => {},
      recordSyncFailure: async () => {},
    }));
    mock("../src/prospecting/prospectingSearch", () => ({
      runProspectingSearch: async () => {
        calls.prospecting++;
        return { skipped: false, newCandidates: 0, postsRead: 0, excludedAsSpam: 0, costUsd: 0, topicsSearched: [] };
      },
    }));
    return (await import("../api/growth-pulse")).default;
  }

  async function run(handler: any, query: Record<string, string>) {
    const { res, out } = fakeRes();
    await handler({ method: "POST", headers: { authorization: "Bearer s3cret" }, query }, res);
    return out;
  }

  it("x_mentions returns the skipped-retired result and ingests nothing; x_inbound still gets its mentions through the shared read", async () => {
    mentionsToServe = [{ id: "300" }, { id: "200" }];
    cursors.set("x_mention_inbound", "100");
    cursors.set("x_mention", "1"); // stale: nothing advances it any more
    const handler = await loadHandler();
    const out = await run(handler, { x: "1" });

    const byStep = Object.fromEntries(out.body.results.map((r: any) => [r.step, r]));
    expect(byStep.x_mentions.ok).toBe(true);
    expect(byStep.x_mentions.detail).toMatch(/^skipped -- retired 2026-10-10/);
    // x_mentions made no paid read of its own and never touched its cursor.
    expect(cursors.get("x_mention")).toBe("1");

    expect(byStep.x_inbound.ok).toBe(true);
    expect(byStep.x_inbound.detail).toContain("2 new inbound");
    // exactly one mentions read, bounded by Inbound's cursor (not the stale x_mention one): same as before.
    expect(calls.mentions).toEqual(["100"]);
    expect(cursors.get("x_mention_inbound")).toBe("300");
    expect(calls.userId).toBe(1);
    // the other kept X steps still ran
    expect(byStep.x_prospecting.ok).toBe(true);
    expect(calls.prospecting).toBe(1);
  });

  it("with no inbound cursor yet, the inbound read is unbounded exactly as before", async () => {
    mentionsToServe = [{ id: "5" }];
    const handler = await loadHandler();
    const out = await run(handler, { x: "1" });
    expect(calls.mentions).toEqual([undefined]);
    expect(out.body.results.find((r: any) => r.step === "x_inbound").detail).toContain("1 new inbound");
  });

  it("kept Results step x_own_posts still runs (does its own X read) and is not marked retired", async () => {
    const handler = await loadHandler();
    const out = await run(handler, { results: "1" });
    const own = out.body.results.find((r: any) => r.step === "x_own_posts");
    expect(own).toBeTruthy();
    expect(own.detail).not.toMatch(/retired/);
    expect(calls.userId).toBe(1);
  });

  it("step list and ordering for the X group is unchanged apart from x_mentions being a skip", async () => {
    mentionsToServe = [{ id: "9" }];
    const handler = await loadHandler(true);
    const out = await run(handler, { x: "1" });
    expect(out.status).toBe(200);
    expect(out.body.results.map((r: any) => r.step)).toEqual(["x_mentions", "x_inbound", "x_prospecting"]);
  });
});

describe("api/daily-pipeline retirement", { timeout: 60_000 }, () => {
  const spies = {
    searchConsoleAdapter: vi.fn(),
    ingestSearchConsole: vi.fn(async () => []),
    generateOpportunities: vi.fn(),
    autoDraft: vi.fn(),
    strategyLatest: vi.fn(),
    strategyCollect: vi.fn(),
    strategyGenerate: vi.fn(),
    buildFeedDeps: vi.fn(async () => ({ deps: {} })),
    feedPost: vi.fn(async () => ({ status: "ready", topicKey: "t", attempts: 1, aiCalls: 1, costUsd: 0 })),
    prune: vi.fn(async () => "pruned"),
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(spies).forEach((s) => s.mockClear());
    process.env.CRON_SECRET = "s3cret";
    delete process.env.YOUTUBE_PUBLISHING_ENABLED;
    delete process.env.TIKTOK_PUBLISHING_ENABLED;
  });

  async function loadHandler(pausedSystem = false) {
    mock("../src/lib/supabaseClient", () => ({ getServiceClient: () => fakeClient({ paused: pausedSystem }) }));
    mock("../src/signals/adapters/searchConsoleAdapter", () => ({
      createSearchConsoleAdapter: () => {
        spies.searchConsoleAdapter();
        return { resolveSiteUrl: async () => "sc-domain:x" };
      },
    }));
    mock("../src/signals/adapters/searchConsoleIngestion", () => ({ ingestSearchConsoleQueries: spies.ingestSearchConsole }));
    mock("../src/opportunities/runGenerateOpportunities", () => ({ runGenerateOpportunities: spies.generateOpportunities }));
    mock("../src/opportunities/autoDraftStep", () => ({ runAutoDraftStep: spies.autoDraft }));
    mock("../src/strategy/strategyEngine", () => ({ generateStrategy: spies.strategyGenerate }));
    mock("../src/strategy/supabaseStrategyRepository", () => ({
      SupabaseStrategyRepository: class {
        getLatest = spies.strategyLatest;
        save = vi.fn();
      },
      collectStrategyEngineInputs: spies.strategyCollect,
    }));
    mock("../src/cost/costTracking", () => ({ pruneOldCostEvents: spies.prune }));
    mock("../src/video/videoRenderRetention", () => ({ pruneOldVideoRenders: spies.prune }));
    mock("../src/content/buildXFeedPostStepDeps", () => ({ buildXFeedPostStepDeps: spies.buildFeedDeps }));
    mock("../src/content/dailyXFeedPost", () => ({ runDailyXFeedPostStep: spies.feedPost }));
    mock("../src/notifications/supabaseNotificationRepository", () => ({
      SupabaseNotificationRepository: class {
        create = vi.fn();
      },
      collectNotificationInputs: async (_c: unknown, failed: unknown) => ({ failed }),
    }));
    mock("../src/notifications/notificationEngine", () => ({ decideNotifications: () => [] }));
    return (await import("../api/daily-pipeline")).default;
  }

  async function run(handler: any, query: Record<string, string>) {
    const { res, out } = fakeRes();
    await handler({ method: "POST", headers: { authorization: "Bearer s3cret" }, query }, res);
    return out;
  }

  it("auto_draft, generate_opportunities and strategy_evolution report skipped-retired and call none of their dependencies", async () => {
    const handler = await loadHandler();
    const out = await run(handler, { group: "core" });
    const byStep = Object.fromEntries(out.body.results.map((r: any) => [r.step, r]));
    for (const step of ["auto_draft", "generate_opportunities", "strategy_evolution"]) {
      expect(byStep[step].ok).toBe(true);
      expect(byStep[step].detail).toMatch(/^skipped -- retired 2026-10-10/);
    }
    expect(spies.autoDraft).not.toHaveBeenCalled();
    expect(spies.generateOpportunities).not.toHaveBeenCalled();
    expect(spies.strategyLatest).not.toHaveBeenCalled();
    expect(spies.strategyCollect).not.toHaveBeenCalled();
    expect(spies.strategyGenerate).not.toHaveBeenCalled();
    expect(out.status).toBe(200);
  });

  it("search_console and retention still run (search_console feeds x_feed_post's topic-freshness bonus)", async () => {
    const handler = await loadHandler();
    const out = await run(handler, { group: "core" });
    const byStep = Object.fromEntries(out.body.results.map((r: any) => [r.step, r]));
    expect(byStep.search_console.detail).toBe("0 ingested");
    expect(spies.searchConsoleAdapter).toHaveBeenCalledTimes(1);
    expect(spies.ingestSearchConsole).toHaveBeenCalledTimes(1);
    expect(spies.prune).toHaveBeenCalledTimes(2);
    expect(byStep.notifications.ok).toBe(true);
  });

  it("x_feed_post still runs in its own group", async () => {
    const handler = await loadHandler();
    const out = await run(handler, { group: "x_feed_post" });
    const feed = out.body.results.find((r: any) => r.step === "x_feed_post");
    expect(feed.ok).toBe(true);
    expect(feed.detail).toContain("ready");
    expect(spies.feedPost).toHaveBeenCalledTimes(1);
    expect(spies.autoDraft).not.toHaveBeenCalled();
  });

  it("x_feed_post pause behaviour unchanged: paused system skips before building any deps", async () => {
    const handler = await loadHandler(true);
    const out = await run(handler, { group: "x_feed_post" });
    const feed = out.body.results.find((r: any) => r.step === "x_feed_post");
    expect(feed.detail).toBe("skipped -- system_paused");
    expect(spies.buildFeedDeps).not.toHaveBeenCalled();
  });
});

describe("app endpoints stay well-formed when Radar data stops arriving", { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.APP_API_TOKEN = "tok";
  });

  async function call(path: "summary" | "health", query: Record<string, string>) {
    mock("../src/lib/supabaseClient", () => ({ getServiceClient: () => fakeClient() }));
    mock("../src/video/videoHealth", () => ({ loadVideoHealth: async () => [] }));
    const handler = (await (path === "summary" ? import("../api/summary") : import("../api/health"))).default;
    const { res, out } = fakeRes();
    await handler({ method: "GET", headers: { authorization: "Bearer tok" }, query, body: undefined } as any, res);
    return out;
  }

  it("morning brief: empty lists, zero counts, null strategy summary", async () => {
    const out = await call("summary", { resource: "brief" });
    expect(out.status).toBe(200);
    expect(out.body.signalsOvernight).toBe(0);
    expect(out.body.topNewOpportunities).toEqual([]);
    expect(out.body.strategySummary).toBeNull();
    expect(out.body.unreadNotifications).toEqual([]);
  });

  it("evening report: topOpportunity is null, not a crash", async () => {
    const out = await call("summary", { resource: "evening-report" });
    expect(out.status).toBe(200);
    expect(out.body.topOpportunity).toBeNull();
    expect(out.body.assetsDrafted).toBe(0);
  });

  it("home summary: counts zero, autoDraft block has null last-run fields", async () => {
    const out = await call("summary", {});
    expect(out.status).toBe(200);
    expect(out.body.signalsAnalyzedToday).toBe(0);
    expect(out.body.opportunitiesFound).toBe(0);
    expect(out.body.analytics.signalsBySource).toEqual({});
    expect(out.body.analytics.autoDraft.lastRunDate).toBeNull();
    expect(out.body.analytics.autoDraft.lastRunStatus).toBeNull();
  });

  it("notifications list: empty list and zero unread", async () => {
    const out = await call("summary", { resource: "notifications" });
    expect(out.status).toBe(200);
    expect(out.body.notifications).toEqual([]);
    expect(out.body.unreadCount).toBe(0);
  });

  it("health: still returns a list; X is not-yet-verified rather than throwing when no cursor exists", async () => {
    const out = await call("health", {});
    expect(out.status).toBe(200);
    expect(Array.isArray(out.body.health)).toBe(true);
  });
});
