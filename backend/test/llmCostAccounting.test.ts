import { describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import {
  COST_EVENTS_PAGE_SIZE,
  breakdownCostEvents,
  contextWithUsage,
  estimateCostUsd,
  getTodaySpendUsd,
  pricingForModel,
  recordCostEvent,
  selectCostEvents,
  stepOfCostRow,
} from "../src/cost/costTracking";
import { LlmBudgetError, LlmClient, isLlmBudgetError, type LlmUsage } from "../src/content/llmClient";
import { DailyBudgetGuard, budgetExceeded, loadTodayLlmSpend } from "../src/cost/llmBudget";
import { createRecordedLlmClient } from "../src/cost/recordedLlmClient";

const NOW = new Date("2026-10-13T12:00:00.000Z");

function fakeResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function toolResponse(input: unknown, usage = { input_tokens: 1000, output_tokens: 200 } as Record<string, number>) {
  return fakeResponse({ model: "claude-sonnet-4-5-20250929", content: [{ type: "tool_use", name: "t", input }], usage });
}

describe("price table", () => {
  it("prices Haiku 4.5 at $1 / $5 (it was $0.80 / $4, the Haiku 3.5 rate)", () => {
    expect(estimateCostUsd({ model: "claude-haiku-4-5-20251001", inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(6, 6);
  });
  it("knows the 5.x generation and strips a date suffix", () => {
    expect(pricingForModel("claude-sonnet-5-5")).toEqual({ input: 2, output: 10 });
    expect(pricingForModel("claude-opus-5-5")).toEqual({ input: 4, output: 20 });
    expect(pricingForModel("claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5 });
    expect(pricingForModel("claude-sonnet-4-5-20250929")).toEqual({ input: 3, output: 15 });
    expect(pricingForModel("claude-nothing-yet")).toBeNull();
  });
  it("bills cache reads at 0.1x and cache writes at 1.25x", () => {
    const cost = estimateCostUsd({ model: "claude-sonnet-4-5-20250929", inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.3 + 3.75, 6);
  });
  it("records cached tokens, the step and an unknown-price flag in the cost row context", () => {
    const usage: LlmUsage = { step: "engagement-draft", model: "mystery-model", inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 900, cacheCreationInputTokens: 100 };
    expect(contextWithUsage({ engagementItemId: "i1" }, usage)).toEqual({
      engagementItemId: "i1",
      step: "engagement-draft",
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 100,
      priceKnown: false,
    });
  });
});

describe("cost totals are not capped at 1000 rows", () => {
  const rows = (n: number, day = "2026-10-13") =>
    Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, event_type: "llm_call", model: "m", input_tokens: 10, output_tokens: 5, cost_usd: 0.01, created_at: `${day}T00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, context: { endpoint: "engagement-draft" } }));

  it("pages through every row", async () => {
    const client = new FakeSupabaseClient({ cost_events: rows(COST_EVENTS_PAGE_SIZE * 2 + 137) });
    const all = await selectCostEvents(asSupabase(client), "cost_usd");
    expect(all).toHaveLength(COST_EVENTS_PAGE_SIZE * 2 + 137);
    expect(client.queriesFor("cost_events").length).toBe(3);
  });

  it("getTodaySpendUsd sums all of today's rows (the old single select stopped at 1000)", async () => {
    const client = new FakeSupabaseClient({ cost_events: rows(1500) });
    expect(await getTodaySpendUsd(asSupabase(client), NOW)).toBeCloseTo(15, 6);
  });

  it("keeps the caller's error text when a read fails", async () => {
    const client = new FakeSupabaseClient({});
    client.failTable("cost_events", { message: "boom" });
    await expect(getTodaySpendUsd(asSupabase(client), NOW)).rejects.toThrow(/getTodaySpendUsd failed: boom/);
  });
});

describe("cost breakdown by step and day", () => {
  const rowOf = (day: string, step: string | null, cost: number, extra: Record<string, unknown> = {}) => ({
    event_type: "llm_call",
    model: "claude-sonnet-4-5-20250929",
    input_tokens: 100,
    output_tokens: 10,
    cost_usd: cost,
    created_at: `${day}T10:00:00Z`,
    context: step ? { endpoint: step, ...extra } : {},
  });

  it("groups by step (step, else endpoint, else event type), day and model, and ignores rows outside the window", () => {
    const rows = [
      rowOf("2026-10-12", "engagement-draft", 0.01, { cacheReadInputTokens: 800 }),
      rowOf("2026-10-12", "engagement-draft", 0.02),
      rowOf("2026-10-11", "live-host-line", 1.5),
      rowOf("2026-10-11", null, 0.1),
      rowOf("2026-08-01", "run-campaign", 9),
    ];
    const b = breakdownCostEvents(rows, NOW, 30);
    expect(b.totalCalls).toBe(4);
    expect(b.totalCostUsd).toBeCloseTo(1.63, 6);
    expect(b.byStep[0]).toMatchObject({ key: "live-host-line", calls: 1 });
    expect(b.byStep.find((s) => s.key === "engagement-draft")).toMatchObject({ calls: 2, cachedReadTokens: 800 });
    expect(b.byStep.find((s) => s.key === "llm_call")).toBeTruthy();
    expect(b.byDay.map((d) => d.key)).toEqual(["2026-10-12", "2026-10-11"]);
    expect(b.byDayStep.find((d) => d.day === "2026-10-11" && d.step === "live-host-line")?.costUsd).toBeCloseTo(1.5, 6);
    expect(stepOfCostRow({ cost_usd: 1, context: { step: "a", endpoint: "b" } })).toBe("a");
  });
});

describe("LlmClient: awaited usage recording and the budget guard", () => {
  it("awaits onUsage so the cost row exists before callTool returns", async () => {
    let written = false;
    const fetchImpl = vi.fn(async () => toolResponse({ ok: 1 })) as unknown as typeof fetch;
    const client = new LlmClient("k", fetchImpl, undefined, async () => {
      await new Promise((r) => setTimeout(r, 20));
      written = true;
    });
    await client.callTool("sys", "msg", "t", {});
    expect(written).toBe(true);
  });

  it("a failing onUsage never loses the model's answer", async () => {
    const fetchImpl = vi.fn(async () => toolResponse({ answer: 42 })) as unknown as typeof fetch;
    const client = new LlmClient("k", fetchImpl, undefined, async () => {
      throw new Error("db down");
    });
    await expect(client.callTool("s", "m", "t", {})).resolves.toEqual({ answer: 42 });
  });

  it("tags usage with the step and passes cached token counts through", async () => {
    const seen: LlmUsage[] = [];
    const fetchImpl = vi.fn(async () => toolResponse({}, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 })) as unknown as typeof fetch;
    const client = new LlmClient("k", fetchImpl, undefined, (u) => void seen.push(u), undefined, { step: "x" });
    await client.callTool("s", "m", "t", {});
    expect(seen[0]).toMatchObject({ step: "x", cacheReadInputTokens: 900 });
  });

  it("skips with a clean LlmBudgetError BEFORE any network call when the guard says the budget is spent", async () => {
    const fetchImpl = vi.fn(async () => toolResponse({})) as unknown as typeof fetch;
    const guard = { check: async () => { throw new LlmBudgetError(); } };
    const client = new LlmClient("k", fetchImpl, undefined, undefined, undefined, { guard });
    const err = (await client.callTool("s", "m", "t", {}).catch((e) => e)) as Error;
    expect(isLlmBudgetError(err)).toBe(true);
    expect(String(err.message)).toBe("skipped -- daily LLM budget reached");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("daily budget tiers", () => {
  const env = {} as NodeJS.ProcessEnv;
  it("background work stops at the daily budget, excluding the live host's own spend", () => {
    expect(budgetExceeded("background", { totalUsd: 1.6, liveHostUsd: 0 }, env)).toBe(true);
    expect(budgetExceeded("background", { totalUsd: 1.6, liveHostUsd: 1.2 }, env)).toBe(false);
  });
  it("owner actions and the live host are exempt from the background budget but not from the absolute ceiling", () => {
    expect(budgetExceeded("owner", { totalUsd: 3, liveHostUsd: 0 }, env)).toBe(false);
    expect(budgetExceeded("live", { totalUsd: 3, liveHostUsd: 3 }, env)).toBe(false);
    expect(budgetExceeded("owner", { totalUsd: 5, liveHostUsd: 0 }, env)).toBe(true);
    expect(budgetExceeded("live", { totalUsd: 5.2, liveHostUsd: 5 }, env)).toBe(true);
  });
  it("is tunable by env and ignores junk values", () => {
    expect(budgetExceeded("background", { totalUsd: 0.6, liveHostUsd: 0 }, { LLM_DAILY_BUDGET_USD: "0.5" })).toBe(true);
    expect(budgetExceeded("background", { totalUsd: 1.4, liveHostUsd: 0 }, { LLM_DAILY_BUDGET_USD: "abc" })).toBe(false);
  });

  it("reads today's spend (all event types for the LLM, live host split out) with paging", async () => {
    const client = new FakeSupabaseClient({
      cost_events: [
        { id: "1", event_type: "llm_call", cost_usd: 0.5, created_at: "2026-10-13T01:00:00Z", context: { endpoint: "live-host-line" } },
        { id: "2", event_type: "prospecting_llm_call", cost_usd: 0.25, created_at: "2026-10-13T02:00:00Z", context: {} },
        { id: "3", event_type: "x_search_read", cost_usd: 9, created_at: "2026-10-13T02:00:00Z", context: {} },
        { id: "4", event_type: "llm_call", cost_usd: 7, created_at: "2026-10-12T23:59:00Z", context: {} },
      ],
    });
    expect(await loadTodayLlmSpend(asSupabase(client), NOW)).toEqual({ totalUsd: 0.75, liveHostUsd: 0.5 });
  });

  it("guard fails open when spend cannot be read, and counts a call's own cost locally", async () => {
    const broken = new DailyBudgetGuard(async () => { throw new Error("db"); }, "background", {} as NodeJS.ProcessEnv);
    await expect(broken.check()).resolves.toBeUndefined();

    const guard = new DailyBudgetGuard(async () => ({ totalUsd: 1.49, liveHostUsd: 0 }), "background", {} as NodeJS.ProcessEnv);
    await expect(guard.check()).resolves.toBeUndefined();
    guard.note({ model: "claude-sonnet-4-5-20250929", inputTokens: 100_000, outputTokens: 0 }, false); // $0.30
    await expect(guard.check()).rejects.toThrow(/daily LLM budget reached/);
  });
});

describe("createRecordedLlmClient: one recorder for every call", () => {
  function setup(cost_events: any[] = []) {
    const client = new FakeSupabaseClient({ cost_events });
    return client;
  }
  async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
    const original = global.fetch;
    global.fetch = impl;
    try {
      return await fn();
    } finally {
      global.fetch = original;
    }
  }

  it("writes the cost row (step, model, tokens, cached tokens) before the call returns", async () => {
    const db = setup();
    const impl = vi.fn(async () => toolResponse({ ok: true }, { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 900 })) as unknown as typeof fetch;
    await withFetch(impl, () => {
      // Built inside withFetch: createLlmClient captures the global fetch when it is constructed.
      const llm = createRecordedLlmClient(asSupabase(db), { step: "engagement-draft", tier: "owner", context: { engagementItemId: "i1" }, env: { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv });
      return llm.callTool("s", "m", "t", {});
    });
    const row = db.tables.cost_events!.at(-1)!;
    expect(row).toMatchObject({ event_type: "llm_call", model: "claude-sonnet-4-5-20250929", input_tokens: 200, output_tokens: 50 });
    expect(row.context).toMatchObject({ step: "engagement-draft", endpoint: "engagement-draft", engagementItemId: "i1", cacheReadInputTokens: 900 });
  });

  it("a background caller is skipped (no fetch, no row) once today's background budget is spent; an owner caller is not", async () => {
    const spent = [{ id: "s", event_type: "llm_call", cost_usd: 1.6, created_at: "2026-10-13T08:00:00Z", context: { endpoint: "run-campaign" } }];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const impl = vi.fn(async () => toolResponse({ ok: true })) as unknown as typeof fetch;
      const env = { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv;

      const bgDb = setup(spent);
      await withFetch(impl, async () => {
        const bg = createRecordedLlmClient(asSupabase(bgDb), { step: "engagement-draft", tier: "background", env });
        const err = await bg.callTool("s", "m", "t", {}).catch((e) => e);
        expect(isLlmBudgetError(err)).toBe(true);
      });
      expect(impl).not.toHaveBeenCalled();
      expect(bgDb.tables.cost_events).toHaveLength(1);

      const ownerDb = setup(spent);
      await withFetch(impl, () => {
        const owner = createRecordedLlmClient(asSupabase(ownerDb), { step: "opportunity-reply-draft", tier: "owner", env });
        return owner.callTool("s", "m", "t", {});
      });
      expect(impl).toHaveBeenCalledTimes(1);
      expect(ownerDb.tables.cost_events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recordCostEvent still reports whether the write landed", async () => {
    const db = setup();
    db.failTable("cost_events", { message: "nope" });
    expect(await recordCostEvent(asSupabase(db), { model: "m", inputTokens: 1, outputTokens: 1 })).toBe(false);
  });
});

