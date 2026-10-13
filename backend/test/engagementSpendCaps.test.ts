import { describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { AUTOFILL_MAX_DRAFTER_CALLS_PER_RUN, AUTOFILL_MAX_DRAFT_CALLS_PER_ITEM_PER_DAY } from "../src/engagement/policy";
import { draftItem, EngagementRunBudgetReached } from "../src/engagement/engagementHandlers";
import { draftEngagementOptions } from "../src/engagement/engagementDrafter";

describe("Engage drafting spend caps", () => {
  const NOW_E = new Date("2026-10-13T20:00:00.000Z");
  const itemRow = (overrides: Record<string, unknown> = {}) => ({
    id: "item-1",
    platform: "youtube",
    external_id: "vid00000001",
    url: "https://www.youtube.com/shorts/vid1",
    title: "Futures trading lesson",
    creator_id: "UC1",
    creator_name: "Creator",
    thumbnail_url: null,
    description: null,
    top_comments: ["A"],
    stats: null,
    source: "search",
    status: "new",
    drafts: [],
    skip_reason: null,
    fetched_at: NOW_E.toISOString(),
    created_at: NOW_E.toISOString(),
    updated_at: NOW_E.toISOString(),
    ...overrides,
  });
  const build = (items: any[], cost_events: any[] = []) =>
    new FakeSupabaseClient({ engagement_items: items, engagement_actions: [], engagement_quota_ledger: [], integration_health: [], cost_events });
  const baseDeps = { now: () => NOW_E, env: {} as NodeJS.ProcessEnv, loadGrounding: async () => ({ brandRulesSummary: "" }) };

  it("never redrafts an item that already has drafts on the scheduled path (no model call)", async () => {
    const db = build([itemRow({ status: "new", drafts: [{ id: "d1", text: "Existing draft" }] })]);
    const drafter = vi.fn(async () => ({ options: ["Does the rule survive a red day?"], skipReason: null }));
    const item = await draftItem(asSupabase(db), "item-1", { ...baseDeps, drafter, llmTier: "background" });
    expect(drafter).not.toHaveBeenCalled();
    expect(item.drafts).toHaveLength(1);
  });

  it("a shared per-run drafter-call budget stops regeneration rounds, keeping what already passed", async () => {
    const db = build([itemRow()]);
    // Every option fails the guardrails (generic praise), so rounds would normally run three times.
    const drafter = vi.fn(async () => ({ options: ["Great video, love this content!"], skipReason: null }));
    const budget = { remaining: 2 };
    const err = await draftItem(asSupabase(db), "item-1", { ...baseDeps, drafter, llmTier: "background", draftCallBudget: budget }).catch((e) => e);
    expect(drafter).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(0);
    expect(err).toBeInstanceOf(EngagementRunBudgetReached);
    expect(db.tables.engagement_items![0]!.status).toBe("new"); // left for the next run, not closed
  });

  it("an item that has used its model calls today is left alone by the scheduled fill (but not by the owner's tap)", async () => {
    const used = Array.from({ length: AUTOFILL_MAX_DRAFT_CALLS_PER_ITEM_PER_DAY }, (_, i) => ({
      id: `c${i}`, event_type: "llm_call", cost_usd: 0.01, created_at: "2026-10-13T05:00:00Z", context: { endpoint: "engagement-draft", engagementItemId: "item-1" },
    }));
    const drafter = vi.fn(async () => ({
      options: ["Does the rule survive a red day, or only at breakeven?", "Is the stop written down before the open, or decided on the spot?"],
      skipReason: null,
    }));

    const scheduledDb = build([itemRow()], used);
    await expect(draftItem(asSupabase(scheduledDb), "item-1", { ...baseDeps, drafter, llmTier: "background" })).rejects.toBeInstanceOf(EngagementRunBudgetReached);
    expect(drafter).not.toHaveBeenCalled();

    const ownerDb = build([itemRow()], used);
    await draftItem(asSupabase(ownerDb), "item-1", { ...baseDeps, drafter });
    expect(drafter).toHaveBeenCalledTimes(1);
  });

  it("per-run call cap is tighter than items x rounds", () => {
    expect(AUTOFILL_MAX_DRAFTER_CALLS_PER_RUN).toBeLessThan(10 * 3);
  });

  it("the drafter marks its instruction block for prompt caching and keeps max_tokens at 600", async () => {
    const callTool = vi.fn(async (..._args: unknown[]) => ({ options: [], skipReason: "x" }));
    await draftEngagementOptions({ callTool } as any, {
      platform: "youtube", title: "t", creatorName: "c", description: null, topComments: [], recentOpeners: [], brandRulesSummary: "", feedback: [],
    });
    const args = callTool.mock.calls[0]!;
    expect(args[5]).toBe(600); // max_tokens
    expect(args[7]).toBe(true); // cacheSystemPrompt
  });
});

describe("scheduled fill under the spend controls", () => {
  const T = new Date("2026-10-13T20:00:00.000Z");
  const row = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: `item-${n}`, platform: "youtube", external_id: `vid${String(n).padStart(8, "0")}`, url: `https://www.youtube.com/shorts/vid${n}`,
    title: `Futures trading lesson ${n}`, creator_id: `UC${n}`, creator_name: `Creator ${n}`, thumbnail_url: null, description: null,
    top_comments: ["A comment"], stats: null, source: "search", status: "drafted", drafts: [{ id: "d1", text: "A draft" }],
    skip_reason: null, fetched_at: T.toISOString(), created_at: new Date(T.getTime() - n * 1000).toISOString(), updated_at: T.toISOString(), ...overrides,
  });
  const world = (extra: any[]) =>
    new FakeSupabaseClient({
      engagement_items: [...Array.from({ length: 10 }, (_, i) => row(i)), ...extra],
      engagement_actions: [], engagement_watchlist: [], engagement_quota_ledger: [],
      integration_health: [{ platform: "engagement_seed_v2", status: "healthy" }], cost_events: [],
    });
  const deps = (drafter: any) => ({ now: () => T, env: { YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, isPaused: async () => false, loadGrounding: async () => ({ brandRulesSummary: "" }), drafter });

  it("stops drafting with 'skipped -- daily LLM budget reached' and leaves the item waiting", async () => {
    const { runEngagementAutoFill } = await import("../src/engagement/engagementAutoFill");
    const { LlmBudgetError } = await import("../src/content/llmClient");
    const db = world([row(50, { status: "new", drafts: [] }), row(51, { status: "new", drafts: [] })]);
    const drafter = vi.fn(async () => { throw new LlmBudgetError(); });
    const result = await runEngagementAutoFill(asSupabase(db), deps(drafter));
    expect(drafter).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("skipped -- daily LLM budget reached");
    expect(db.tables.engagement_items!.filter((i) => i.status === "new")).toHaveLength(2);
  });

  it("stops at the per-run drafter-call cap even when every item needs several rounds", async () => {
    const { runEngagementAutoFill } = await import("../src/engagement/engagementAutoFill");
    const items = Array.from({ length: 8 }, (_, i) => row(60 + i, { status: "new", drafts: [] }));
    const db = world(items);
    // Generic praise fails the guardrails every round, so each item would take 3 rounds (24 calls without the cap).
    const drafter = vi.fn(async () => ({ options: ["Great video, love this content!"], skipReason: null }));
    const result = await runEngagementAutoFill(asSupabase(db), deps(drafter));
    expect(drafter.mock.calls.length).toBeLessThanOrEqual(AUTOFILL_MAX_DRAFTER_CALLS_PER_RUN);
    expect(result.summary).toMatch(/drafter call cap per run/);
  });
});
