import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import {
  AUTOFILL_MAX_DRAFTS_PER_RUN,
  AUTOFILL_MAX_SEARCHES_PER_RUN,
  AUTOFILL_SEED_MARKER,
  DEFAULT_WATCH_QUERIES,
  runEngagementAutoFill,
  seedDefaultWatchlist,
  type AutoFillDeps,
} from "../src/engagement/engagementAutoFill";
import { getEngagementStatus } from "../src/engagement/engagementHandlers";
import { AUTOFILL_TARGET_WAITING, nextAutoFillRun } from "../src/engagement/policy";

const NOW = new Date("2026-10-10T20:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
const KEY = "AIza-test-key-should-never-appear-in-urls";

function itemRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `item-${n}`,
    platform: "youtube",
    external_id: `vid${String(n).padStart(8, "0")}`,
    url: `https://www.youtube.com/shorts/vid${n}`,
    title: `Existing short ${n}`,
    creator_id: `UCcreator${n}`,
    creator_name: `Creator ${n}`,
    thumbnail_url: null,
    description: null,
    top_comments: [],
    stats: null,
    source: "search",
    status: "new",
    drafts: [],
    skip_reason: null,
    fetched_at: iso(60),
    created_at: iso(1000 - n),
    updated_at: iso(60),
    ...overrides,
  };
}

function doneRow(secondsAgo: number, creatorId: string) {
  return { id: `act-${creatorId}-${secondsAgo}`, item_id: null, platform: "youtube", external_id: `x-${creatorId}`, creator_id: creatorId, creator_name: "Other", kind: "done", did: "commented", final_text: null, created_at: iso(secondsAgo) };
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

const GOOD_OPTIONS = [
  "Moving the stop at the first sign of red is exactly the habit I could not break either.",
  "What changed once you stopped, did the average loser actually get smaller?",
  "Is the rule written down before the open or decided on the spot?",
];

let optionSeed = 0;
/** Three options sharing no words with any other call's options, so the near-duplicate check never trips. */
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

/** A YouTube fake: `count` search results (new ids each call index), all short, recent, trading titles. */
function youtubeFetch(options: { count?: number; creatorFor?: (i: number) => string; title?: (i: number) => string } = {}) {
  const count = options.count ?? 4;
  const calls: string[] = [];
  const ids = Array.from({ length: count }, (_, i) => `vidNEW${String(i).padStart(5, "0")}`);
  const impl = vi.fn(async (input: string) => {
    const url = new URL(String(input));
    calls.push(url.pathname.split("/").pop()! + (url.pathname.endsWith("/search") ? `?q=${url.searchParams.get("q")}` : ""));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith("/search")) return json({ items: ids.map((id) => ({ id: { videoId: id } })) });
    if (url.pathname.endsWith("/videos")) {
      const wanted = (url.searchParams.get("id") ?? "").split(",");
      return json({
        items: ids
          .filter((id) => wanted.includes(id))
          .map((id, i) => ({
            id,
            snippet: {
              title: options.title ? options.title(i) : `Futures trading lesson ${i}`,
              channelId: options.creatorFor ? options.creatorFor(i) : `UCnew${i}`,
              channelTitle: `New Creator ${i}`,
              publishedAt: new Date(NOW.getTime() - 2 * 86400000).toISOString(),
            },
            statistics: { viewCount: String(500 + i * 10), commentCount: String(i) },
            contentDetails: { duration: "PT40S" },
          })),
      });
    }
    if (url.pathname.endsWith("/commentThreads")) return json({ items: [] });
    return new Response("{}", { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, calls, raw: impl };
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

const seededWatch = (n = 2) =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, kind: "query", value: `query ${i}`, label: null, active: true, created_at: iso(1000 - i) }));
const seededMarker = { platform: AUTOFILL_SEED_MARKER, status: "healthy" };

describe("watchlist seeding", () => {
  it("seeds the default queries once into an empty, never-seeded watchlist", async () => {
    const client = build();
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(DEFAULT_WATCH_QUERIES.length);
    expect(client.tables.engagement_watchlist!.map((w) => w.value).sort()).toEqual([...DEFAULT_WATCH_QUERIES].sort());
    expect(client.tables.engagement_watchlist!.every((w) => w.kind === "query")).toBe(true);
  });

  it("is idempotent: a second run adds nothing", async () => {
    const client = build();
    await seedDefaultWatchlist(asSupabase(client), NOW);
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(0);
    expect(client.tables.engagement_watchlist).toHaveLength(DEFAULT_WATCH_QUERIES.length);
  });

  it("does not re-seed after the owner emptied the list", async () => {
    const client = build();
    await seedDefaultWatchlist(asSupabase(client), NOW);
    client.tables.engagement_watchlist = [];
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(0);
    expect(client.tables.engagement_watchlist).toHaveLength(0);
  });

  it("never touches an owner-curated watchlist", async () => {
    const client = build({ engagement_watchlist: seededWatch(1) });
    expect(await seedDefaultWatchlist(asSupabase(client), NOW)).toBe(0);
    expect(client.tables.engagement_watchlist).toHaveLength(1);
  });
});

describe("scheduled fill", () => {
  it("discovers, pre-drafts, and reports a one-line summary", async () => {
    const client = build({ engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const yt = youtubeFetch({ count: 4 });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(result.skipped).toBe(false);
    expect(result.discovered).toBe(4);
    expect(result.drafted).toBe(4);
    expect(result.waiting).toBe(4);
    expect(result.summary).toMatch(/^discovered 4, drafted 4, queue 4, quota \d+ units this run/);
    expect(client.tables.engagement_items!.every((i) => i.status === "drafted" && i.drafts.length >= 2)).toBe(true);
    // search 2 x 100 + videos 1 + 4 top-comment lookups
    expect(result.quotaUsed).toBe(205);
    for (const call of yt.raw.mock.calls) expect(String(call[0])).not.toContain(KEY);
  });

  it("tops up only to the target and respects the search cap", async () => {
    const existing = Array.from({ length: 7 }, (_, i) => itemRow(i, { status: "drafted", drafts: [{ id: "d1", text: "A draft" }] }));
    const client = build({ engagement_items: existing, engagement_watchlist: seededWatch(6), integration_health: [seededMarker] });
    const yt = youtubeFetch({ count: 10 });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(result.discovered).toBe(AUTOFILL_TARGET_WAITING - 7);
    expect(result.waiting).toBe(AUTOFILL_TARGET_WAITING);
    expect(yt.calls.filter((c) => c.startsWith("search")).length).toBeLessThanOrEqual(AUTOFILL_MAX_SEARCHES_PER_RUN);
  });

  it("does no discovery when the queue already has enough waiting, and a second run is a no-op", async () => {
    const existing = Array.from({ length: AUTOFILL_TARGET_WAITING }, (_, i) => itemRow(i, { status: "drafted", drafts: [{ id: "d1", text: "A draft" }] }));
    const client = build({ engagement_items: existing, engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const yt = youtubeFetch();
    const drafter = vi.fn(async () => ({ options: freshOptions(), skipReason: null }));
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl, drafter }));
    expect(yt.raw).not.toHaveBeenCalled();
    expect(drafter).not.toHaveBeenCalled();
    expect(result.discovered).toBe(0);

    const fresh = build({ engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const yt2 = youtubeFetch({ count: 3 });
    await runEngagementAutoFill(asSupabase(fresh), deps({ fetchImpl: yt2.impl }));
    const callsAfterFirst = yt2.raw.mock.calls.length;
    const itemsAfterFirst = fresh.tables.engagement_items!.length;
    const again = await runEngagementAutoFill(asSupabase(fresh), deps({ fetchImpl: yt2.impl }));
    expect(fresh.tables.engagement_items!.length).toBe(itemsAfterFirst); // same videos are deduped, nothing doubled
    expect(again.drafted).toBe(0);
    expect(yt2.raw.mock.calls.length).toBeGreaterThanOrEqual(callsAfterFirst);
  });

  it("skips creators on cooldown and videos already handled", async () => {
    const client = build({
      engagement_watchlist: seededWatch(),
      integration_health: [seededMarker],
      engagement_actions: [
        doneRow(86400, "UCnew0"),
        { ...doneRow(5 * 86400, "UCzzz"), external_id: "vidNEW00001", kind: "skipped" },
      ],
    });
    const yt = youtubeFetch({ count: 3 });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    const ids = client.tables.engagement_items!.map((i) => i.external_id).sort();
    expect(ids).toEqual(["vidNEW00002"]); // 0 = cooldown creator, 1 = already skipped
    expect(result.discovered).toBe(1);
  });

  it("filters by recency, tiny view counts, length and relevance", async () => {
    const client = build({ engagement_watchlist: seededWatch(1), integration_health: [seededMarker] });
    const yt = youtubeFetch({ count: 3, title: (i) => (i === 0 ? "My cat knocks a glass off the table" : `Topstep combine day ${i}`) });
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(client.tables.engagement_items!.map((i) => i.title).sort()).toEqual(["Topstep combine day 1", "Topstep combine day 2"]);
    expect(result.discovered).toBe(2);
  });

  it("stops searching when the daily quota budget is reached and says so", async () => {
    const client = build({
      engagement_watchlist: seededWatch(),
      integration_health: [seededMarker],
      engagement_quota_ledger: [{ id: "q", day: "2026-10-10", endpoint: "videos.list", units: 2950, created_at: iso(60) }],
    });
    const yt = youtubeFetch();
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl }));
    expect(yt.calls.filter((c) => c.startsWith("search"))).toHaveLength(0);
    expect(result.discovered).toBe(0);
    expect(result.summary).toMatch(/quota/i);

    const full = build({
      engagement_watchlist: seededWatch(),
      engagement_quota_ledger: [{ id: "q", day: "2026-10-10", endpoint: "videos.list", units: 3000, created_at: iso(60) }],
    });
    const none = youtubeFetch();
    const skipped = await runEngagementAutoFill(asSupabase(full), deps({ fetchImpl: none.impl }));
    expect(skipped.summary).toMatch(/^skipped -- YouTube quota budget reached/);
    expect(none.raw).not.toHaveBeenCalled();
  });

  it("auto-skips items the drafter declines, with the reason", async () => {
    const client = build({ engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const yt = youtubeFetch({ count: 2 });
    const drafter = vi.fn(async (ctx: { title: string }) =>
      ctx.title.endsWith("0") ? { options: [], skipReason: "not about trading" } : { options: freshOptions(), skipReason: null },
    );
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: yt.impl, drafter }));
    expect(result.drafted).toBe(1);
    expect(result.autoSkipped).toBe(1);
    const skipped = client.tables.engagement_items!.find((i) => i.status === "skipped")!;
    expect(skipped.skip_reason).toMatch(/not about trading/);
    expect(client.tables.engagement_actions!.some((a) => a.kind === "skipped" && a.external_id === skipped.external_id)).toBe(true);
    expect(result.waiting).toBe(1);
    expect(result.summary).toMatch(/auto-skipped 1/);
  });

  it("caps drafting per run", async () => {
    const existing = Array.from({ length: 12 }, (_, i) => itemRow(i));
    const client = build({ engagement_items: existing, engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const drafter = vi.fn(async () => ({ options: freshOptions(), skipReason: null }));
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: youtubeFetch({ count: 0 }).impl, drafter }));
    expect(drafter.mock.calls.length).toBeLessThanOrEqual(AUTOFILL_MAX_DRAFTS_PER_RUN * 3);
    expect(result.drafted).toBe(AUTOFILL_MAX_DRAFTS_PER_RUN);
    expect(result.summary).toMatch(/draft cap per run/);
  });

  it("degrades cleanly without a key, with no network", async () => {
    const client = build({ engagement_watchlist: seededWatch() });
    const fetchImpl = vi.fn();
    const result = await runEngagementAutoFill(asSupabase(client), deps({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(result).toMatchObject({ skipped: true, summary: "skipped -- YOUTUBE_API_KEY not configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips when the system is paused, but still runs the 30-day cache purge", async () => {
    const client = build({ engagement_items: [itemRow(1, { fetched_at: iso(31 * 86400) })], engagement_watchlist: seededWatch() });
    const fetchImpl = vi.fn();
    const result = await runEngagementAutoFill(asSupabase(client), deps({ isPaused: async () => true, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(result.summary).toBe("skipped -- system is paused");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.tables.engagement_items).toHaveLength(0);
  });

  it("purges cached YouTube data older than 30 days on every normal run too", async () => {
    const client = build({
      engagement_items: [itemRow(1, { fetched_at: iso(31 * 86400), status: "drafted", drafts: [{ id: "d1", text: "x" }] })],
      engagement_watchlist: seededWatch(),
      integration_health: [seededMarker],
    });
    await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: youtubeFetch({ count: 0 }).impl }));
    expect(client.tables.engagement_items!.find((i) => i.id === "item-1")).toBeUndefined();
  });

  it("degrades cleanly when migration 0050 is not applied", async () => {
    const client = build();
    client.failTable("engagement_items", { message: 'relation "engagement_items" does not exist', code: "42P01" });
    const result = await runEngagementAutoFill(asSupabase(client), deps());
    expect(result.skipped).toBe(true);
    expect(result.summary).toMatch(/^skipped -- migration 0050/);
  });

  it("turns an unexpected error into a summary line instead of throwing", async () => {
    const client = build({ engagement_watchlist: seededWatch() });
    client.failTable("engagement_quota_ledger", { message: "boom" });
    const result = await runEngagementAutoFill(asSupabase(client), deps());
    expect(result.summary).toMatch(/^failed -- /);
  });

  it("a discovery HTTP failure does not stop drafting what is already queued", async () => {
    const client = build({ engagement_items: [itemRow(1)], engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const bad = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: bad as unknown as typeof fetch }));
    expect(result.drafted).toBe(1);
  });
});

describe("status for the app", () => {
  it("reports the next scheduled fill and the last summary", async () => {
    const client = build({ integration_health: [{ platform: "engagement_autofill", last_success_at: iso(3600), notes: "discovered 3, drafted 3, queue 3" }] });
    const status = await getEngagementStatus(asSupabase(client), { now: () => NOW, env: {} });
    expect(status.autoFill.targetWaiting).toBe(AUTOFILL_TARGET_WAITING);
    expect(status.autoFill.lastRunNote).toBe("discovered 3, drafted 3, queue 3");
    expect(status.autoFill.nextRunLabel).toBe("6:00 PM Arizona time");
  });

  it("computes the next Arizona slot across midnight", () => {
    expect(nextAutoFillRun(new Date("2026-10-10T21:00:00Z")).label).toBe("6:00 PM Arizona time");
    expect(nextAutoFillRun(new Date("2026-10-10T02:00:00Z")).label).toBe("8:00 AM Arizona time");
    expect(nextAutoFillRun(new Date("2026-10-10T16:00:00Z")).label).toBe("1:00 PM Arizona time");
  });
});

describe("posting is impossible from the fill", () => {
  it("the fill and discovery code never reference a write/post/like API or any non-read endpoint", () => {
    const sources = ["engagementAutoFill.ts", "engagementHandlers.ts", "youtubeDataClient.ts"].map((f) => readFileSync(new URL(`../src/engagement/${f}`, import.meta.url), "utf8"));
    const joined = sources.join("\n");
    // Only these YouTube endpoints may be requested (all read-only list calls).
    const resources = [...joined.matchAll(/this\.get<[\s\S]*?>\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(new Set(resources)).toEqual(new Set(["videos", "channels", "playlistItems", "search"]));
    expect(joined).not.toMatch(/commentThreads\.insert|comments\.insert|videos\.rate|subscriptions\.insert|method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(joined).not.toMatch(/googleapis\.com\/upload|oauth2|Authorization/i);
  });

  it("every request the fill makes is a GET to a YouTube read endpoint", async () => {
    const client = build({ engagement_watchlist: seededWatch(), integration_health: [seededMarker] });
    const seen: Array<{ url: string; method: string | undefined }> = [];
    const base = youtubeFetch({ count: 2 });
    const spy = vi.fn(async (input: string, init?: { method?: string }) => {
      seen.push({ url: String(input), method: init?.method });
      return (base.impl as unknown as (i: string) => Promise<Response>)(input);
    });
    await runEngagementAutoFill(asSupabase(client), deps({ fetchImpl: spy as unknown as typeof fetch }));
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.method === undefined || r.method === "GET").toBe(true);
      expect(r.url.startsWith("https://www.googleapis.com/youtube/v3/")).toBe(true);
      expect(new URL(r.url).pathname).toMatch(/\/(videos|channels|playlistItems|search|commentThreads)$/);
    }
  });
});
