import { describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import {
  EngagementActionError,
  EngagementBlockedError,
  MAX_SEARCHES_PER_RUN,
  addLink,
  addWatch,
  discoverYoutube,
  draftItem,
  getEngagementStats,
  getEngagementStatus,
  logOutcome,
  markDone,
  recordCopy,
  recordOpen,
  skipItem,
  type EngagementDeps,
} from "../src/engagement/engagementHandlers";
import { isMissingEngagementTables } from "../src/engagement/engagementRepository";

const NOW = new Date("2026-10-10T20:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    platform: "youtube",
    external_id: "vid00000001",
    url: "https://www.youtube.com/shorts/vid00000001",
    title: "Why I stopped moving my stop",
    creator_id: "UCcreator00000000000001",
    creator_name: "Some Trader",
    thumbnail_url: null,
    description: null,
    top_comments: [],
    stats: null,
    source: "pasted",
    status: "new",
    drafts: [],
    skip_reason: null,
    fetched_at: iso(60),
    created_at: iso(60),
    updated_at: iso(60),
    ...overrides,
  };
}

function doneRow(secondsAgo: number, creatorId = "UCsomeoneelse", platform = "youtube", extra: Record<string, unknown> = {}) {
  return {
    id: `act-${Math.random().toString(36).slice(2)}`,
    item_id: null,
    platform,
    external_id: `x-${creatorId}-${secondsAgo}`,
    creator_id: creatorId,
    creator_name: "Other",
    kind: "done",
    did: "commented",
    final_text: null,
    created_at: iso(secondsAgo),
    ...extra,
  };
}

function build(tables: Record<string, any[]> = {}) {
  return new FakeSupabaseClient({
    engagement_items: [],
    engagement_actions: [],
    engagement_watchlist: [],
    engagement_quota_ledger: [],
    ...tables,
  });
}

const GOOD_OPTIONS = [
  "Moving the stop at the first sign of red is exactly the habit I could not break either.",
  "What changed once you stopped, did the average loser actually get smaller?",
  "Is the rule written down before the open or decided on the spot?",
];

function deps(overrides: Partial<EngagementDeps> = {}): EngagementDeps {
  return {
    now: () => NOW,
    env: {},
    loadGrounding: async () => ({ brandRulesSummary: "" }),
    ...overrides,
  };
}

describe("status and graceful degradation", () => {
  it("reports YouTube as not configured without a key and still returns the queue", async () => {
    const client = build({ engagement_items: [itemRow({ platform: "tiktok", creator_id: "someone" })] });
    const status = await getEngagementStatus(asSupabase(client), deps());
    expect(status.configured).toBe(true);
    expect(status.youtubeConfigured).toBe(false);
    expect(status.queue).toHaveLength(1);
    expect(status.today.youtube).toEqual({ done: 0, cap: 25 });
    expect(status.limits.minSpacingSeconds).toBe(90);
  });

  it("flags a queued item whose creator is on cooldown", async () => {
    const client = build({
      engagement_items: [itemRow()],
      engagement_actions: [doneRow(86400, "UCcreator00000000000001")],
    });
    const status = await getEngagementStatus(asSupabase(client), deps());
    expect(status.queue[0]!.block?.code).toBe("creator_cooldown");
  });

  it("recognizes the missing-migration error", () => {
    expect(isMissingEngagementTables(new Error('relation "engagement_items" does not exist'))).toBe(true);
    expect(isMissingEngagementTables(new Error("network down"))).toBe(false);
  });

  it("purges cached YouTube rows older than 30 days and old creator names, on status", async () => {
    const client = build({
      engagement_items: [itemRow({ id: "old", fetched_at: iso(31 * 86400) }), itemRow({ id: "new", external_id: "vid00000002", fetched_at: iso(10) })],
      engagement_actions: [doneRow(40 * 86400, "UCx", "youtube", { creator_name: "Old Name" })],
    });
    await getEngagementStatus(asSupabase(client), deps());
    expect(client.tables.engagement_items!.map((r) => r.id)).toEqual(["new"]);
    expect(client.tables.engagement_actions![0]!.creator_name).toBeNull();
  });
});

describe("pasted links", () => {
  const oembed = {
    title: "Revenge trading cost me a week",
    author_name: "Trader Tom",
    author_url: "https://www.tiktok.com/@tradertom",
    thumbnail_url: "https://p16.tiktokcdn.com/thumb.jpg",
    embed_product_id: "7300000000000000001",
  };

  it("reads a TikTok link through public oEmbed only: exactly one request, to tiktok.com/oembed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(oembed), { status: 200 }));
    const client = build();
    const item = await addLink(asSupabase(client), "https://www.tiktok.com/@tradertom/video/7300000000000000001", deps({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = fetchImpl.mock.calls as unknown as Array<[string]>;
    const calledUrl = new URL(calls[0]![0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe("https://www.tiktok.com/oembed");
    expect(item.platform).toBe("tiktok");
    expect(item.creatorId).toBe("tradertom");
    expect(item.title).toBe("Revenge trading cost me a week");
    expect(client.tables.engagement_items!).toHaveLength(1);
  });

  it("works with no YOUTUBE_API_KEY at all", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(oembed), { status: 200 }));
    await expect(addLink(asSupabase(build()), "https://vm.tiktok.com/ZMabc123/", deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).resolves.toBeTruthy();
  });

  it("refuses non-TikTok hosts and lookalike hosts without making any request", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["https://example.com/video/1", "https://tiktok.com.evil.test/@a/video/1", "not a url"]) {
      await expect(addLink(asSupabase(build()), url, deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).rejects.toBeInstanceOf(EngagementActionError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains that YouTube links need YOUTUBE_API_KEY when it is missing", async () => {
    await expect(addLink(asSupabase(build()), "https://www.youtube.com/shorts/abcdefghijk", deps())).rejects.toThrow(/YOUTUBE_API_KEY/);
  });

  it("will not re-add a video the owner already handled", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(oembed), { status: 200 }));
    const client = build({ engagement_items: [itemRow({ platform: "tiktok", external_id: "7300000000000000001", status: "done" })] });
    await expect(addLink(asSupabase(client), "https://www.tiktok.com/@tradertom/video/7300000000000000001", deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).rejects.toThrow(/already handled/);
  });
});

describe("drafting", () => {
  it("returns distinct, guardrail-clean options and writes an audit row", async () => {
    const client = build({ engagement_items: [itemRow()] });
    const drafter = vi.fn(async () => ({ options: GOOD_OPTIONS, skipReason: null }));
    const item = await draftItem(asSupabase(client), "item-1", deps({ drafter }));
    expect(item.status).toBe("drafted");
    expect(item.drafts.map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(client.tables.engagement_actions!.find((a) => a.kind === "drafted")).toMatchObject({ platform: "youtube", external_id: "vid00000001", creator_id: "UCcreator00000000000001" });
    expect(client.tables.engagement_items![0]!.status).toBe("drafted");
  });

  it("refuses to draft when the creator is on cooldown, without calling the model", async () => {
    const client = build({ engagement_items: [itemRow()], engagement_actions: [doneRow(2 * 86400, "UCcreator00000000000001")] });
    const drafter = vi.fn();
    await expect(draftItem(asSupabase(client), "item-1", deps({ drafter }))).rejects.toMatchObject({ block: { code: "creator_cooldown" } });
    expect(drafter).not.toHaveBeenCalled();
  });

  it("refuses to draft when the daily cap is hit", async () => {
    const actions = Array.from({ length: 25 }, (_, i) => doneRow(3600 + i, `UCother${i}`));
    const client = build({ engagement_items: [itemRow()], engagement_actions: actions });
    const drafter = vi.fn();
    await expect(draftItem(asSupabase(client), "item-1", deps({ drafter }))).rejects.toMatchObject({ block: { code: "daily_cap" } });
    expect(drafter).not.toHaveBeenCalled();
  });

  it("drops guardrail failures and regenerates with the reason fed back", async () => {
    const client = build({ engagement_items: [itemRow()] });
    const seen: string[][] = [];
    const drafter = vi.fn(async (ctx: { feedback: string[] }) => {
      seen.push(ctx.feedback);
      if (seen.length === 1) {
        return { options: ["Great video, super helpful stuff here.", "Check it out at example.com, same idea there."], skipReason: null };
      }
      return { options: GOOD_OPTIONS.slice(0, 2), skipReason: null };
    });
    const item = await draftItem(asSupabase(client), "item-1", deps({ drafter }));
    expect(drafter).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual([]);
    expect(seen[1]!.join(" ")).toMatch(/generic praise/);
    expect(item.drafts).toHaveLength(2);
  });

  it("drops options that are near-duplicates of the last 200 comments", async () => {
    const past = GOOD_OPTIONS[0]!;
    const client = build({
      engagement_items: [itemRow(), itemRow({ id: "item-0", external_id: "vid00000000", status: "done", drafts: [{ id: "d1", text: past }] })],
    });
    const drafter = vi.fn(async () => ({
      options: [past.replace("exactly ", ""), GOOD_OPTIONS[1]!, GOOD_OPTIONS[2]!],
      skipReason: null,
    }));
    const item = await draftItem(asSupabase(client), "item-1", deps({ drafter }));
    expect(item.drafts.map((d) => d.text)).toEqual([GOOD_OPTIONS[1], GOOD_OPTIONS[2]]);
  });

  it("also compares against comments the owner actually posted", async () => {
    const client = build({
      engagement_items: [itemRow()],
      engagement_actions: [doneRow(5 * 86400, "UCold", "youtube", { final_text: GOOD_OPTIONS[1] })],
    });
    const drafter = vi.fn(async () => ({ options: [GOOD_OPTIONS[1]!, GOOD_OPTIONS[0]!, GOOD_OPTIONS[2]!], skipReason: null }));
    const item = await draftItem(asSupabase(client), "item-1", deps({ drafter }));
    expect(item.drafts.map((d) => d.text)).not.toContain(GOOD_OPTIONS[1]);
  });

  it("surfaces the model's decision to skip", async () => {
    const client = build({ engagement_items: [itemRow()] });
    const drafter = vi.fn(async () => ({ options: [], skipReason: "not about trading" }));
    await expect(draftItem(asSupabase(client), "item-1", deps({ drafter }))).rejects.toThrow(/not about trading/);
    expect(client.tables.engagement_items![0]!.status).toBe("new");
  });

  it("gives up with a clear error when nothing passes after 3 rounds", async () => {
    const client = build({ engagement_items: [itemRow()] });
    const drafter = vi.fn(async () => ({ options: ["Great video, super helpful stuff here."], skipReason: null }));
    await expect(draftItem(asSupabase(client), "item-1", deps({ drafter }))).rejects.toThrow(/guardrails/);
    expect(drafter).toHaveBeenCalledTimes(3);
  });
});

describe("owner actions and the caps", () => {
  const drafted = () =>
    itemRow({ status: "drafted", drafts: [{ id: "d1", text: GOOD_OPTIONS[0] }, { id: "d2", text: GOOD_OPTIONS[1] }] });

  it("Mark done writes the audit row with the chosen draft and the owner's edited text", async () => {
    const client = build({ engagement_items: [drafted()] });
    const result = await markDone(asSupabase(client), { id: "item-1", did: "commented", draftId: "d2", finalText: "Did the average loser shrink once the stop stayed put?" }, deps());
    const row = client.tables.engagement_actions!.find((a) => a.kind === "done")!;
    expect(row).toMatchObject({
      platform: "youtube",
      external_id: "vid00000001",
      creator_id: "UCcreator00000000000001",
      draft_id: "d2",
      draft_text: GOOD_OPTIONS[1],
      final_text: "Did the average loser shrink once the stop stayed put?",
      did: "commented",
      created_at: NOW.toISOString(),
    });
    expect(client.tables.engagement_items![0]!.status).toBe("done");
    expect(result.item.status).toBe("done");
  });

  it("records a like with no text", async () => {
    const client = build({ engagement_items: [drafted()] });
    await markDone(asSupabase(client), { id: "item-1", did: "liked" }, deps());
    expect(client.tables.engagement_actions!.find((a) => a.kind === "done")!.final_text).toBeNull();
  });

  it("blocks Mark done inside the 90 second spacing window and says how long to wait", async () => {
    const client = build({ engagement_items: [drafted()], engagement_actions: [doneRow(30)] });
    let error: unknown;
    try {
      await markDone(asSupabase(client), { id: "item-1", draftId: "d1" }, deps());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EngagementBlockedError);
    expect((error as EngagementBlockedError).block).toMatchObject({ code: "min_spacing", retryAfterSeconds: 60 });
    expect(client.tables.engagement_actions!.filter((a) => a.kind === "done")).toHaveLength(1);
  });

  it("blocks the 26th Mark done of the day on that platform but not the other one", async () => {
    const actions = Array.from({ length: 25 }, (_, i) => doneRow(600 + i * 10, `UCother${i}`));
    const client = build({
      engagement_items: [drafted(), itemRow({ id: "tt", platform: "tiktok", external_id: "7300000000000000009", creator_id: "tt-creator", status: "drafted", drafts: [{ id: "d1", text: GOOD_OPTIONS[2] }] })],
      engagement_actions: actions,
    });
    await expect(markDone(asSupabase(client), { id: "item-1", draftId: "d1" }, deps())).rejects.toMatchObject({ block: { code: "daily_cap" } });
    await expect(markDone(asSupabase(client), { id: "tt", draftId: "d1" }, deps())).resolves.toBeTruthy();
  });

  it("blocks Mark done for a creator inside the 3-day cooldown", async () => {
    const client = build({ engagement_items: [drafted()], engagement_actions: [doneRow(2 * 86400, "UCcreator00000000000001")] });
    await expect(markDone(asSupabase(client), { id: "item-1", draftId: "d1" }, deps())).rejects.toMatchObject({ block: { code: "creator_cooldown" } });
  });

  it("copy is gated by the same limits and logs what was copied", async () => {
    const blocked = build({ engagement_items: [drafted()], engagement_actions: [doneRow(10)] });
    await expect(recordCopy(asSupabase(blocked), { id: "item-1", draftId: "d1" }, deps())).rejects.toMatchObject({ block: { code: "min_spacing" } });

    const ok = build({ engagement_items: [drafted()] });
    const copied = await recordCopy(asSupabase(ok), { id: "item-1", draftId: "d1" }, deps());
    expect(copied.text).toBe(GOOD_OPTIONS[0]);
    expect(copied.warnings).toEqual([]);
    expect(ok.tables.engagement_actions![0]).toMatchObject({ kind: "copied", draft_id: "d1", final_text: GOOD_OPTIONS[0] });
  });

  it("warns, but does not refuse, when the owner edits a draft into something promotional", async () => {
    const client = build({ engagement_items: [drafted()] });
    const copied = await recordCopy(asSupabase(client), { id: "item-1", draftId: "d1", text: "Same here, check out my channel." }, deps());
    expect(copied.text).toBe("Same here, check out my channel.");
    expect(copied.warnings.length).toBeGreaterThan(0);
  });

  it("open is gated by cap and cooldown but not by spacing", async () => {
    const spaced = build({ engagement_items: [drafted()], engagement_actions: [doneRow(5)] });
    await expect(recordOpen(asSupabase(spaced), "item-1", deps())).resolves.toMatchObject({ url: "https://www.youtube.com/shorts/vid00000001" });
    const cooling = build({ engagement_items: [drafted()], engagement_actions: [doneRow(86400, "UCcreator00000000000001")] });
    await expect(recordOpen(asSupabase(cooling), "item-1", deps())).rejects.toBeInstanceOf(EngagementBlockedError);
  });

  it("skip closes the item, audits it, and does not count toward any cap", async () => {
    const client = build({ engagement_items: [drafted()] });
    await skipItem(asSupabase(client), { id: "item-1", reason: "off topic" }, deps());
    expect(client.tables.engagement_items![0]).toMatchObject({ status: "skipped", skip_reason: "off topic" });
    const status = await getEngagementStatus(asSupabase(client), deps());
    expect(status.today.youtube.done).toBe(0);
    expect(status.queue).toHaveLength(0);
  });
});

describe("outcomes and stats", () => {
  it("logs an outcome on a done action only", async () => {
    const client = build({
      engagement_actions: [
        { ...doneRow(100), id: "act-done" },
        { ...doneRow(100), id: "act-copy", kind: "copied" },
      ],
    });
    const logged = await logOutcome(asSupabase(client), { actionId: "act-done", gotReply: true, profileVisits: 4, note: "creator replied" }, deps());
    expect(logged).toMatchObject({ gotReply: true, profileVisits: 4 });
    await expect(logOutcome(asSupabase(client), { actionId: "act-copy", gotReply: true }, deps())).rejects.toBeInstanceOf(EngagementActionError);
    await expect(logOutcome(asSupabase(client), { actionId: "act-done", profileVisits: -1 }, deps())).rejects.toBeInstanceOf(EngagementActionError);
  });

  it("counts per day and platform, with the logged outcomes", async () => {
    const client = build({
      engagement_actions: [
        doneRow(3600, "a", "youtube", { got_reply: true, profile_visits: 3 }),
        doneRow(7200, "b", "youtube"),
        doneRow(3600, "c", "tiktok"),
        { ...doneRow(3000, "d"), kind: "skipped" },
        doneRow(3 * 86400, "e", "youtube"),
      ],
    });
    const stats = await getEngagementStats(asSupabase(client), 14, deps());
    const today = stats.byDay.filter((d) => d.day === "2026-10-10");
    expect(today.find((d) => d.platform === "youtube")).toMatchObject({ done: 2, skipped: 1 });
    expect(today.find((d) => d.platform === "tiktok")).toMatchObject({ done: 1 });
    expect(stats.outcomes).toEqual({ done: 4, logged: 1, gotReply: 1, profileVisits: 3 });
    expect(stats.totals.youtube.done).toBe(3);
  });
});

describe("YouTube discovery", () => {
  const KEY = "AIza-test-key-should-never-appear-in-urls";

  function youtubeFetch(options: { videos?: Array<Record<string, unknown>> } = {}) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl = vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(input), headers: init?.headers ?? {} });
      const path = new URL(String(input)).pathname;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path.endsWith("/channels")) return json({ items: [{ id: "UCwatched0000000000001", contentDetails: { relatedPlaylists: { uploads: "UUwatched" } } }] });
      if (path.endsWith("/playlistItems")) return json({ items: [{ contentDetails: { videoId: "vidAAAAAAAA" } }, { contentDetails: { videoId: "vidBBBBBBBB" } }] });
      if (path.endsWith("/search")) return json({ items: [{ id: { videoId: "vidCCCCCCCC" } }] });
      if (path.endsWith("/videos")) {
        const wanted = (new URL(String(input)).searchParams.get("id") ?? "").split(",");
        const all = options.videos ?? [
            { id: "vidAAAAAAAA", snippet: { title: "Short A", channelId: "UCwatched0000000000001", channelTitle: "Watched", thumbnails: { medium: { url: "https://i.ytimg.com/a.jpg" } } }, statistics: { viewCount: "1200" }, contentDetails: { duration: "PT45S" } },
            { id: "vidBBBBBBBB", snippet: { title: "Long B", channelId: "UCwatched0000000000001", channelTitle: "Watched" }, contentDetails: { duration: "PT12M" } },
            { id: "vidCCCCCCCC", snippet: { title: "Search C", channelId: "UCsearched000000000001", channelTitle: "Searched" }, contentDetails: { duration: "PT30S" } },
        ];
        return json({ items: all.filter((v) => wanted.includes(String(v.id))) });
      }
      return new Response("{}", { status: 404 });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  it("refuses with a clear message when YOUTUBE_API_KEY is not set", async () => {
    await expect(discoverYoutube(asSupabase(build()), deps())).rejects.toThrow(/YOUTUBE_API_KEY/);
  });

  it("queues short videos only, spends the expected units, and never puts the key in a URL", async () => {
    const client = build({
      engagement_watchlist: [
        { id: "w1", kind: "channel", value: "UCwatched0000000000001", label: null, active: true, created_at: iso(500) },
        { id: "w2", kind: "query", value: "prop firm", label: null, active: true, created_at: iso(400) },
      ],
    });
    const yt = youtubeFetch();
    const result = await discoverYoutube(asSupabase(client), deps({ env: { YOUTUBE_API_KEY: KEY }, fetchImpl: yt.impl }));
    expect(result.added).toBe(2); // the 12 minute video is dropped
    expect(client.tables.engagement_items!.map((r) => r.external_id).sort()).toEqual(["vidAAAAAAAA", "vidCCCCCCCC"]);
    expect(client.tables.engagement_items!.find((r) => r.external_id === "vidCCCCCCCC")!.source).toBe("search");
    // channels 1 + playlistItems 1 + search 100 + videos 1
    const units = client.tables.engagement_quota_ledger!.reduce((s, r) => s + r.units, 0);
    expect(units).toBe(103);
    expect(yt.calls.length).toBe(4);
    for (const call of yt.calls) {
      expect(call.url).not.toContain(KEY);
      expect(call.url).not.toMatch(/[?&]key=/);
      expect(call.headers["x-goog-api-key"]).toBe(KEY);
      expect(call.url.startsWith("https://www.googleapis.com/youtube/v3/")).toBe(true);
    }
  });

  it("stops at the daily quota budget instead of calling search", async () => {
    const client = build({
      engagement_watchlist: [{ id: "w2", kind: "query", value: "prop firm", label: null, active: true, created_at: iso(400) }],
      engagement_quota_ledger: [{ id: "q", day: "2026-10-10", endpoint: "videos.list", units: 2950, created_at: iso(60) }],
    });
    const yt = youtubeFetch();
    const result = await discoverYoutube(asSupabase(client), deps({ env: { YOUTUBE_API_KEY: KEY }, fetchImpl: yt.impl }));
    expect(result.stoppedReason).toMatch(/quota budget/i);
    expect(yt.calls).toHaveLength(0);
    expect(result.added).toBe(0);
  });

  it("runs at most the per-run search cap", async () => {
    const queries = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, kind: "query", value: `query ${i}`, label: null, active: true, created_at: iso(1000 - i) }));
    const client = build({ engagement_watchlist: queries });
    const yt = youtubeFetch();
    await discoverYoutube(asSupabase(client), deps({ env: { YOUTUBE_API_KEY: KEY }, fetchImpl: yt.impl }));
    expect(yt.calls.filter((c) => c.url.includes("/search?")).length).toBe(MAX_SEARCHES_PER_RUN);
  });

  it("skips creators on cooldown and videos already handled", async () => {
    const client = build({
      engagement_watchlist: [{ id: "w1", kind: "channel", value: "UCwatched0000000000001", label: null, active: true, created_at: iso(500) }],
      engagement_actions: [
        doneRow(86400, "UCwatched0000000000001"),
      ],
    });
    const yt = youtubeFetch({
      videos: [{ id: "vidAAAAAAAA", snippet: { title: "Short A", channelId: "UCwatched0000000000001", channelTitle: "Watched" }, contentDetails: { duration: "PT45S" } }],
    });
    const result = await discoverYoutube(asSupabase(client), deps({ env: { YOUTUBE_API_KEY: KEY }, fetchImpl: yt.impl }));
    expect(result.added).toBe(0);
    expect(result.skippedCooldown).toBeGreaterThan(0);

    const handled = build({
      engagement_watchlist: [{ id: "w1", kind: "channel", value: "UCwatched0000000000001", label: null, active: true, created_at: iso(500) }],
      engagement_actions: [{ ...doneRow(10 * 86400, "UCzzz"), platform: "youtube", external_id: "vidAAAAAAAA", kind: "skipped" }],
    });
    const second = await discoverYoutube(asSupabase(handled), deps({ env: { YOUTUBE_API_KEY: KEY }, fetchImpl: youtubeFetch().impl }));
    expect(second.skippedHandled).toBe(1);
    expect(handled.tables.engagement_items!.map((r) => r.external_id)).not.toContain("vidAAAAAAAA");
  });

  it("does not top up a full queue", async () => {
    const items = Array.from({ length: 40 }, (_, i) => itemRow({ id: `i${i}`, external_id: `v${i}` }));
    const client = build({
      engagement_items: items,
      engagement_watchlist: [{ id: "w1", kind: "channel", value: "UCwatched0000000000001", label: null, active: true, created_at: iso(500) }],
    });
    const yt = youtubeFetch();
    const result = await discoverYoutube(asSupabase(client), deps({ env: { YOUTUBE_API_KEY: KEY }, fetchImpl: yt.impl }));
    expect(result.added).toBe(0);
    expect(yt.calls).toHaveLength(0);
  });

  it("fetches top comments for a draft (1 unit) and feeds them to the drafter", async () => {
    const client = build({ engagement_items: [itemRow()] });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [{ snippet: { topLevelComment: { snippet: { textDisplay: "Best advice I got on stops" } } } }] }), { status: 200 }));
    const drafter = vi.fn(async (_ctx: { topComments: string[] }) => ({ options: GOOD_OPTIONS, skipReason: null }));
    await draftItem(asSupabase(client), "item-1", deps({ env: { YOUTUBE_API_KEY: "k" }, fetchImpl: fetchImpl as unknown as typeof fetch, drafter }));
    expect(drafter.mock.calls[0]![0].topComments).toEqual(["Best advice I got on stops"]);
    expect(client.tables.engagement_quota_ledger!).toHaveLength(1);
    expect(client.tables.engagement_quota_ledger![0]!.units).toBe(1);
  });
});

describe("watchlist input", () => {
  it("validates channel ids and handles", async () => {
    const client = build();
    await expect(addWatch(asSupabase(client), { kind: "channel", value: "not a channel" }, deps())).rejects.toBeInstanceOf(EngagementActionError);
    await expect(addWatch(asSupabase(client), { kind: "channel", value: "@tradertom" }, deps())).resolves.toMatchObject({ value: "@tradertom" });
    await expect(addWatch(asSupabase(client), { kind: "query", value: "prop firm" }, deps())).resolves.toMatchObject({ kind: "query" });
    await expect(addWatch(asSupabase(client), { kind: "other", value: "x" }, deps())).rejects.toBeInstanceOf(EngagementActionError);
  });
});
