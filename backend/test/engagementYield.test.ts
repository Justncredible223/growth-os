import { describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import {
  AUTOFILL_DETAIL_HEALTH_KEY,
  AUTOFILL_MAX_AGE_DAYS,
  AUTOFILL_MAX_DRAFTS_PER_RUN,
  AUTOFILL_MAX_SEARCHES_PER_RUN,
  AUTOFILL_MIN_VIEWS,
  AUTOFILL_SEED_MARKER,
  AUTOFILL_SEED_MARKER_V2,
  DEFAULT_WATCH_QUERIES,
  ORIGINAL_WATCH_QUERIES,
  autoFillRotationSeed,
  funnelLine,
  runEngagementAutoFill,
  seedDefaultWatchlist,
  type AutoFillDeps,
} from "../src/engagement/engagementAutoFill";
import { buildEngagementSystemPrompt, buildEngagementUserMessage } from "../src/engagement/engagementDrafter";
import { YOUTUBE_UNIT_COSTS, estimatedAutoFillUnitsPerDay, AUTOFILL_RUN_HOURS_UTC, AUTOFILL_SEARCH_ORDERS } from "../src/engagement/policy";
import { YoutubeDataClient } from "../src/engagement/youtubeDataClient";

const NOW = new Date("2026-10-10T20:00:00.000Z");
const DAY = 86400000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const iso = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
const KEY = "AIza-test-key";

interface FakeVideo {
  id: string;
  title?: string;
  creator?: string;
  creatorName?: string;
  published?: string;
  views?: number;
  comments?: number;
  duration?: string;
}

/** A YouTube fake: one fixed result list per search call, a video table for videos.list. */
function youtube(videos: FakeVideo[], opts: { searchIds?: string[] } = {}) {
  const searches: URLSearchParams[] = [];
  const videoCalls: string[][] = [];
  const impl = vi.fn(async (input: string) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith("/search")) {
      searches.push(url.searchParams);
      return json({ items: (opts.searchIds ?? videos.map((v) => v.id)).map((id) => ({ id: { videoId: id } })) });
    }
    if (url.pathname.endsWith("/videos")) {
      const wanted = (url.searchParams.get("id") ?? "").split(",");
      videoCalls.push(wanted);
      return json({
        items: videos
          .filter((v) => wanted.includes(v.id))
          .map((v) => ({
            id: v.id,
            snippet: {
              title: v.title ?? "Futures trading lesson",
              channelId: v.creator ?? `UC-${v.id}`,
              channelTitle: v.creatorName ?? `Creator ${v.id}`,
              publishedAt: v.published ?? ago(2),
            },
            statistics: { viewCount: String(v.views ?? 800), commentCount: String(v.comments ?? 3) },
            contentDetails: { duration: v.duration ?? "PT40S" },
          })),
      });
    }
    if (url.pathname.endsWith("/commentThreads")) return json({ items: [] });
    return new Response("{}", { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, searches, videoCalls };
}

let optionSeed = 0;
function freshOptions() {
  const word = () => {
    let n = ++optionSeed;
    let w = "";
    for (let i = 0; i < 6; i++) {
      w += String.fromCharCode(97 + (n % 26));
      n = Math.floor(n / 26) + i * 3 + 1;
    }
    return `${w}${optionSeed}`;
  };
  return Array.from({ length: 3 }, () => `Honest question about ${word()} ${word()} ${word()} ${word()} ${word()} ${word()} when sizing positions?`);
}

function deps(overrides: Partial<AutoFillDeps> = {}): AutoFillDeps {
  return {
    now: () => NOW,
    env: { YOUTUBE_API_KEY: KEY },
    isPaused: async () => false,
    loadGrounding: async () => ({ brandRulesSummary: "" }),
    drafter: async () => ({ options: freshOptions(), skipReason: null }),
    ...overrides,
  };
}

function build(tables: Record<string, any[]> = {}) {
  return new FakeSupabaseClient({
    engagement_items: [],
    engagement_actions: [],
    engagement_watchlist: [],
    engagement_quota_ledger: [],
    integration_health: [],
    ...tables,
  });
}

const watch = (values: readonly string[], label: string | null = "default") =>
  values.map((value, i) => ({ id: `w-${i}-${value}`, kind: "query", value, label, active: true, created_at: iso(1000 - i) }));
const marker = (platform: string) => ({ platform, status: "healthy" });
const seededV2 = marker(AUTOFILL_SEED_MARKER_V2);

function doneRow(secondsAgo: number, creatorId: string) {
  return { id: `act-${creatorId}`, item_id: null, platform: "youtube", external_id: `x-${creatorId}`, creator_id: creatorId, creator_name: "Other", kind: "done", did: "commented", final_text: null, created_at: iso(secondsAgo) };
}

function itemRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `item-${n}`,
    platform: "youtube",
    external_id: `queued${String(n).padStart(5, "0")}`,
    url: `https://www.youtube.com/shorts/queued${n}`,
    title: `Existing short ${n}`,
    creator_id: `UCexisting${n}`,
    creator_name: `Existing ${n}`,
    thumbnail_url: null,
    description: null,
    top_comments: [],
    stats: null,
    source: "search",
    status: "drafted",
    drafts: [{ id: "d1", text: "A draft" }],
    skip_reason: null,
    fetched_at: iso(60),
    created_at: iso(1000 - n),
    updated_at: iso(60),
    ...overrides,
  };
}

describe("rejection breakdown", () => {
  it("counts every candidate into exactly one bucket and records the detail row and queries", async () => {
    const videos: FakeVideo[] = [
      { id: "good00000001", title: "Topstep payout day", creator: "UCgood1" },
      { id: "long0000001", duration: "PT5M10S" },
      { id: "old00000001", published: ago(20) },
      { id: "low00000001", views: 40 },
      { id: "low00000002", views: 5 },
      { id: "offtopic001", title: "My cat knocks a glass off the table" },
      { id: "cooldown001", creator: "UCcool" },
      { id: "dupcreator01", creator: "UCgood1", title: "Second futures trading video" },
      { id: "ownchannel01", creatorName: "Fillbook | Journal" },
      { id: "handled00001" },
      { id: "queued000001" },
      // "missing00001" is returned by search but not by videos.list (private or removed)
    ];
    const client = build({
      engagement_watchlist: watch(["topstep payout"]),
      integration_health: [seededV2],
      engagement_actions: [doneRow(86400, "UCcool"), { ...doneRow(5 * 86400, "UCzzz"), external_id: "handled00001", kind: "skipped" }],
      engagement_items: [itemRow(1, { external_id: "queued000001", status: "drafted" })],
    });
    const yt = youtube(videos, { searchIds: [...videos.map((v) => v.id), "missing00001"] });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));

    const f = result.detail!.funnel!;
    expect(f.queries).toEqual([{ q: "topstep payout", order: AUTOFILL_SEARCH_ORDERS[0], hits: 12 }]);
    expect(f).toMatchObject({
      seen: 12,
      seenFromSearch: 12,
      seenFromChannels: 0,
      alreadyQueued: 1,
      alreadyHandled: 1,
      notReturned: 1,
      notShortLength: 1,
      tooOld: 1,
      tooFewViews: 2,
      noTradingWords: 1,
      noCreatorOrOwn: 1,
      creatorCooldown: 1,
      creatorAlreadyQueued: 1,
      added: 1,
    });
    expect(f.viewsBelowFloor).toEqual({ under10: 1, under50: 1, under100: 0 });
    // Every seen id is accounted for.
    const accounted = f.alreadyQueued + f.alreadyHandled + f.notReturned + f.notShortLength + f.tooOld + f.tooFewViews + f.noTradingWords + f.noCreatorOrOwn + f.creatorCooldown + f.creatorAlreadyQueued + f.roomExhausted + f.added;
    expect(accounted).toBe(f.seen);

    // One short line in the summary, the full detail in its own integration_health row.
    expect(result.summary).toMatch(/^discovered 1, drafted 1, queue 2, quota \d+ units this run \(\d+\/3000 today\)/);
    expect(result.summary).toContain("funnel 12 seen, 1 added; long 1, old 1, low views 2, off topic 1, cooldown 1, same creator 1, handled 1, queued 1, gone 1, own/none 1");
    const row = client.tables.integration_health!.find((r) => r.platform === AUTOFILL_DETAIL_HEALTH_KEY)!;
    const stored = JSON.parse(row.notes);
    expect(stored.funnel.tooFewViews).toBe(2);
    expect(stored.funnel.queries[0].q).toBe("topstep payout");
    expect(stored.knobs).toMatchObject({ searchesPerRun: AUTOFILL_MAX_SEARCHES_PER_RUN, maxAgeDays: AUTOFILL_MAX_AGE_DAYS, minViews: AUTOFILL_MIN_VIEWS });
    expect(stored.queue.waitingAfter).toBe(2);
  });

  it("records drafter declines with their reasons, separate from guardrail failures", async () => {
    const videos: FakeVideo[] = [{ id: "dec00000001" }, { id: "dec00000002" }, { id: "gr000000001" }, { id: "ok000000001" }];
    const client = build({ engagement_watchlist: watch(["trading journal"]), integration_health: [seededV2] });
    const yt = youtube(videos);
    const drafter = vi.fn(async (ctx: { creatorName: string }) => {
      if (ctx.creatorName.includes("dec")) return { options: [], skipReason: "not about trading" };
      if (ctx.creatorName.includes("gr0")) return { options: ["Check out my channel https://example.com"], skipReason: null };
      return { options: freshOptions(), skipReason: null };
    });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl, drafter }));
    expect(result.detail!.drafting).toMatchObject({ drafted: 1, declined: 2, guardrail: 1, blocked: 0 });
    expect(result.detail!.drafting.declineReasons).toEqual(["not about trading", "not about trading"]);
    expect(result.autoSkipped).toBe(3);
    expect(result.summary).toMatch(/auto-skipped 3/);
  });

  it("funnelLine omits zero buckets", () => {
    expect(funnelLine({ queries: [], seen: 3, seenFromSearch: 3, seenFromChannels: 0, alreadyQueued: 0, alreadyHandled: 0, notReturned: 0, notShortLength: 0, tooOld: 0, tooFewViews: 2, noTradingWords: 0, noCreatorOrOwn: 0, creatorCooldown: 0, creatorAlreadyQueued: 0, roomExhausted: 0, added: 1, viewsBelowFloor: { under10: 0, under50: 0, under100: 2 } })).toBe(
      "funnel 3 seen, 1 added; low views 2",
    );
  });
});

describe("search shape and recency", () => {
  it("asks for English/US results, a 14 day window, ranked orders and a wide page", async () => {
    const client = build({ engagement_watchlist: watch(DEFAULT_WATCH_QUERIES), integration_health: [seededV2] });
    const yt = youtube([], { searchIds: [] });
    await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(yt.searches).toHaveLength(AUTOFILL_MAX_SEARCHES_PER_RUN);
    for (const [i, p] of yt.searches.entries()) {
      expect(p.get("type")).toBe("video");
      expect(p.get("videoDuration")).toBe("short");
      expect(p.get("relevanceLanguage")).toBe("en");
      expect(p.get("regionCode")).toBe("US");
      expect(p.get("maxResults")).toBe("25");
      expect(p.get("order")).toBe(AUTOFILL_SEARCH_ORDERS[i % AUTOFILL_SEARCH_ORDERS.length]);
      expect(new Date(p.get("publishedAfter")!).getTime()).toBe(NOW.getTime() - AUTOFILL_MAX_AGE_DAYS * DAY);
    }
    expect(AUTOFILL_MAX_AGE_DAYS).toBe(14);
  });

  it("keeps a 10 day old video that the old 7 day window dropped, and drops a 15 day old one", async () => {
    const client = build({ engagement_watchlist: watch(["topstep payout"]), integration_health: [seededV2] });
    const yt = youtube([
      { id: "ten0000000a", published: ago(10), title: "Funded account payout" },
      { id: "fifteen000a", published: ago(15), title: "Funded account payout two" },
    ]);
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(client.tables.engagement_items!.map((i) => i.external_id)).toEqual(["ten0000000a"]);
    expect(result.detail!.funnel!.tooOld).toBe(1);
  });

  it("reads more than 50 candidates in 50-id chunks at 1 unit each", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `vid${String(i).padStart(8, "0")}`);
    const spent: Array<[string, number]> = [];
    const calls: number[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      const wanted = (new URL(String(input)).searchParams.get("id") ?? "").split(",");
      calls.push(wanted.length);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const yt = new YoutubeDataClient(KEY, async (endpoint, units) => void spent.push([endpoint, units]), fetchImpl as unknown as typeof fetch);
    await yt.videos(ids);
    expect(calls).toEqual([50, 50, 20]);
    expect(spent).toEqual([["videos.list", 1], ["videos.list", 1], ["videos.list", 1]]);
  });
});

describe("query rotation and quota math", () => {
  it("scheduled runs of one day search every default query, three at a time, with no overlap", async () => {
    const client = build({ engagement_watchlist: watch(DEFAULT_WATCH_QUERIES), integration_health: [seededV2] });
    const searched: string[][] = [];
    for (const hour of AUTOFILL_RUN_HOURS_UTC) {
      const at = new Date(Date.UTC(2026, 9, 11, hour, 0, 0));
      const yt = youtube([], { searchIds: [] });
      await runEngagementAutoFill(asSupabase(client), deps({ now: () => at, fetchImpl: yt.impl }));
      searched.push(yt.searches.map((p) => p.get("q")!));
    }
    expect(searched.map((s) => s.length)).toEqual([3, 3, 3]);
    expect(new Set(searched.flat())).toEqual(new Set(DEFAULT_WATCH_QUERIES));
    expect(searched.flat()).toHaveLength(DEFAULT_WATCH_QUERIES.length);
  });

  it("consecutive days keep rotating (every query is reached within two days for any list size)", () => {
    for (let n = 3; n <= 12; n++) {
      const seen = new Set<number>();
      const hours = [...AUTOFILL_RUN_HOURS_UTC];
      for (let d = 0; d < 2; d++) {
        for (const h of hours) {
          const seed = autoFillRotationSeed(new Date(Date.UTC(2026, 9, 10 + d, h)));
          const offset = (seed * AUTOFILL_MAX_SEARCHES_PER_RUN) % n;
          for (let k = 0; k < AUTOFILL_MAX_SEARCHES_PER_RUN; k++) seen.add((offset + k) % n);
        }
      }
      expect(seen.size).toBe(n);
    }
  });

  it("a normal day stays near 1,000 units and a worst-case run cannot cross the 3,000 budget", async () => {
    expect(estimatedAutoFillUnitsPerDay()).toBeLessThanOrEqual(1000);
    expect(AUTOFILL_MAX_SEARCHES_PER_RUN * YOUTUBE_UNIT_COSTS.searchList * AUTOFILL_RUN_HOURS_UTC.length).toBe(900);

    // Empty queue, plenty of candidates: measured units for one run stay within the per-run estimate.
    const videos: FakeVideo[] = Array.from({ length: 30 }, (_, i) => ({ id: `cand${String(i).padStart(7, "0")}`, creator: `UCc${i}`, title: `Prop firm lesson ${i}` }));
    const client = build({ engagement_watchlist: watch(DEFAULT_WATCH_QUERIES), integration_health: [seededV2] });
    const yt = youtube(videos);
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(result.quotaUsed).toBeLessThanOrEqual(estimatedAutoFillUnitsPerDay() / AUTOFILL_RUN_HOURS_UTC.length);
    expect(result.drafted).toBe(10);

    // A day already at 2,900 units: the guard refuses a 100-unit search that would cross 3,000, and nothing runs after.
    const nearFull = build({
      engagement_watchlist: watch(DEFAULT_WATCH_QUERIES),
      integration_health: [seededV2],
      engagement_quota_ledger: [{ id: "q", day: "2026-10-10", endpoint: "videos.list", units: 2950, created_at: iso(60) }],
    });
    const yt2 = youtube(videos);
    const capped = await runEngagementAutoFill(asSupabase(nearFull), deps({ fetchImpl: yt2.impl }));
    expect(capped.quotaUsed).toBeLessThanOrEqual(3000);
    expect(yt2.searches).toHaveLength(0);
  });
});

describe("watchlist seed migration", () => {
  it("migrates an untouched original seed to the new queries once", async () => {
    const client = build({ engagement_watchlist: watch(ORIGINAL_WATCH_QUERIES), integration_health: [marker(AUTOFILL_SEED_MARKER)] });
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(DEFAULT_WATCH_QUERIES.length);
    expect(client.tables.engagement_watchlist!.map((w) => w.value).sort()).toEqual([...DEFAULT_WATCH_QUERIES].sort());
    expect(client.tables.integration_health!.some((r) => r.platform === AUTOFILL_SEED_MARKER_V2)).toBe(true);
    // Idempotent.
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(0);
    expect(client.tables.engagement_watchlist).toHaveLength(DEFAULT_WATCH_QUERIES.length);
  });

  it("leaves an owner-curated list alone: extra query, removed original, relabelled or deactivated row", async () => {
    const cases: Array<[string, any[]]> = [
      ["owner added a query", [...watch(ORIGINAL_WATCH_QUERIES), ...watch(["my own query"], null)]],
      ["owner removed an original", watch(ORIGINAL_WATCH_QUERIES.slice(1))],
      ["owner relabelled one", [...watch(ORIGINAL_WATCH_QUERIES.slice(1)), ...watch([ORIGINAL_WATCH_QUERIES[0]], "my favourite")]],
      ["owner deactivated one", watch(ORIGINAL_WATCH_QUERIES).map((w, i) => (i === 0 ? { ...w, active: false } : w))],
      ["owner channel added", [...watch(ORIGINAL_WATCH_QUERIES), { id: "c", kind: "channel", value: "@somecreator", label: null, active: true, created_at: iso(5) }]],
      ["fully owner list", watch(["only mine", "also mine"], null)],
    ];
    for (const [name, rows] of cases) {
      const client = build({ engagement_watchlist: rows, integration_health: [marker(AUTOFILL_SEED_MARKER)] });
      const before = JSON.stringify(client.tables.engagement_watchlist);
      expect(await seedDefaultWatchlist(asSupabase(client), NOW), name).toBe(0);
      expect(JSON.stringify(client.tables.engagement_watchlist), name).toBe(before);
      // And it never comes back to it.
      expect(await seedDefaultWatchlist(asSupabase(client), NOW), name).toBe(0);
      expect(JSON.stringify(client.tables.engagement_watchlist), name).toBe(before);
    }
  });

  it("does not re-seed a list the owner emptied after the first seed", async () => {
    const client = build({ integration_health: [marker(AUTOFILL_SEED_MARKER)] });
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(0);
    expect(client.tables.engagement_watchlist).toHaveLength(0);
  });

  it("finishes a half-done migration (new rows inserted, originals still there)", async () => {
    const rows = [...watch(ORIGINAL_WATCH_QUERIES), ...watch(DEFAULT_WATCH_QUERIES)].map((w, i) => ({ ...w, id: `r${i}` }));
    const client = build({ engagement_watchlist: rows, integration_health: [marker(AUTOFILL_SEED_MARKER)] });
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(0);
    expect(client.tables.engagement_watchlist!.map((w) => w.value).sort()).toEqual([...DEFAULT_WATCH_QUERIES].sort());
  });

  it("the fill itself migrates on its first run and then searches the new queries", async () => {
    const client = build({ engagement_watchlist: watch(ORIGINAL_WATCH_QUERIES), integration_health: [marker(AUTOFILL_SEED_MARKER)] });
    const yt = youtube([], { searchIds: [] });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(result.seeded).toBe(DEFAULT_WATCH_QUERIES.length);
    for (const p of yt.searches) expect(DEFAULT_WATCH_QUERIES as readonly string[]).toContain(p.get("q"));
  });

  it("every default query is short natural search phrasing", () => {
    expect(DEFAULT_WATCH_QUERIES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(DEFAULT_WATCH_QUERIES.map((q) => q.toLowerCase())).size).toBe(DEFAULT_WATCH_QUERIES.length);
    for (const q of DEFAULT_WATCH_QUERIES) {
      expect(q).toBe(q.toLowerCase());
      expect(q.split(" ").length).toBeLessThanOrEqual(5);
      expect(q).not.toMatch(/[#@"]/);
    }
  });
});

describe("one declined video never blocks a creator", () => {
  it("auto-skipping one video leaves the same creator's other videos eligible on the next run", async () => {
    const client = build({ engagement_watchlist: watch(["topstep payout"]), integration_health: [seededV2] });
    const first = youtube([{ id: "decl0000001", creator: "UCsame", title: "Topstep payout meme" }]);
    const drafter = vi.fn(async () => ({ options: [], skipReason: "not about trading" }));
    const r1 = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: first.impl, drafter }));
    expect(r1.autoSkipped).toBe(1);
    expect(r1.waiting).toBe(0);

    const second = youtube([
      { id: "decl0000001", creator: "UCsame", title: "Topstep payout meme" },
      { id: "other000001", creator: "UCsame", title: "Topstep payout real numbers" },
    ]);
    const r2 = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: second.impl }));
    expect(r2.discovered).toBe(1);
    expect(client.tables.engagement_items!.find((i) => i.external_id === "other000001")!.status).toBe("drafted");
    expect(r2.detail!.funnel!.alreadyHandled).toBe(1);
    expect(r2.detail!.funnel!.creatorCooldown).toBe(0);
  });

  it("queues one video per creator at a time", async () => {
    const client = build({ engagement_watchlist: watch(["topstep payout"]), integration_health: [seededV2] });
    const yt = youtube([
      { id: "same0000001", creator: "UCsame", comments: 9 },
      { id: "same0000002", creator: "UCsame", comments: 2 },
      { id: "diff0000001", creator: "UCdiff" },
    ]);
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(client.tables.engagement_items!.map((i) => i.external_id).sort()).toEqual(["diff0000001", "same0000001"]);
    expect(result.detail!.funnel!.creatorAlreadyQueued).toBe(1);
  });

  it("items stuck behind a creator cooldown do not count toward the ready target", async () => {
    const existing = Array.from({ length: 10 }, (_, i) => itemRow(i));
    const client = build({
      engagement_items: existing,
      engagement_watchlist: watch(["topstep payout"]),
      integration_health: [seededV2],
      engagement_actions: [doneRow(3600, "UCexisting0"), doneRow(7200, "UCexisting1"), doneRow(9000, "UCexisting2")],
    });
    const yt = youtube(Array.from({ length: 6 }, (_, i) => ({ id: `new${String(i).padStart(8, "0")}`, creator: `UCnew${i}` })));
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(result.discovered).toBe(3);
    expect(result.detail!.queue).toMatchObject({ waitingBefore: 10, onCooldownBefore: 3, waitingAfter: 13 });
  });
});

describe("drafter prompt", () => {
  it("does not treat few comments or a trading loss as a reason to skip, and keeps every hard rule", () => {
    const prompt = buildEngagementSystemPrompt("youtube", "");
    expect(prompt).toMatch(/DO NOT skip for these reasons/);
    expect(prompt).toMatch(/few or no comments/);
    expect(prompt).toMatch(/blown or failed funded account/);
    // Hard rules are unchanged.
    for (const rule of [
      "Mention Fillbook, any product, app, site, journal, channel or account of the commenter's.",
      "No links, no handles",
      "Generic praise",
      "Claim results, a track record",
      "Emoji, hashtags, exclamation marks, em or en dashes.",
      "Repeat a phrase, opener, or joke from the RECENT OPENERS list",
    ]) {
      expect(prompt).toContain(rule);
    }
  });

  it("tells the model when a video has no comments yet", () => {
    const msg = buildEngagementUserMessage({ platform: "youtube", title: "T", creatorName: "C", description: null, topComments: [], recentOpeners: [], brandRulesSummary: "", feedback: [] });
    expect(msg).toMatch(/TOP COMMENTS: none yet/);
  });
});
