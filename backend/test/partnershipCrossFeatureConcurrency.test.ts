import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { createPartnership, qualifyPartnership, generateDraftForPartnership } from "../src/partnerships/partnershipsHandlers";
import { runPartnershipDiscoveryStep } from "../src/partnerships/discovery";
import type { XSignalAdapter, XSearchResult } from "../src/signals/adapters/xAdapter";
import type { NewPartnershipProspect } from "../src/partnerships/types";

/**
 * Discovery and generation are two entirely separate code paths
 * (discovery.ts / partnershipsHandlers.ts) that both spend against the
 * SAME shared Partnerships budget. The per-prospect generation_claimed_at
 * mutex (0023) only ever serialized generation against itself; nothing
 * previously stopped a discovery run and a generation attempt from each
 * reading a stale month-spend total at the same time. These tests prove
 * the atomic reservation (migration 0024) closes that gap too, not just
 * the same-feature case already covered elsewhere.
 */

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function draftResponse(body: string) {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_draft", input: { body } }], usage: { input_tokens: 500, output_tokens: 100 } });
}
function verdictResponse(pass: boolean) {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_verdict", input: { pass, score: pass ? 1 : 0.2, reasoning: "ok", issues: [] } }], usage: { input_tokens: 500, output_tokens: 50 } });
}
const GOOD_DRAFT = "Fillbook is a broker-agnostic futures trading journal built for session review and visible account-rule tracking -- a natural fit for a guided journaling pilot with a small cohort of your students.";

function contentAwareFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const toolName = body.tools?.[0]?.name as string | undefined;
    if (toolName === "submit_draft") return draftResponse(GOOD_DRAFT);
    if (toolName === "submit_verdict") return verdictResponse(true);
    throw new Error(`unexpected tool_choice: ${toolName}`);
  });
}

function fakeAdapter(resultsByQuery: Record<string, XSearchResult[]>): XSignalAdapter {
  return { searchRecentPosts: async (query: string) => resultsByQuery[query] ?? [] } as unknown as XSignalAdapter;
}
function xResult(overrides: Partial<XSearchResult> = {}): XSearchResult {
  return {
    id: "1",
    text: "I'm a futures trading coach helping traders build a real journaling habit.",
    authorId: "u1",
    authorHandle: "coachdana",
    authorName: "Dana",
    authorFollowerCount: 500,
    authorVerified: false,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    publicMetrics: null,
    lang: "en",
    ...overrides,
  };
}

function newProspect(overrides: Partial<NewPartnershipProspect> = {}): NewPartnershipProspect {
  return {
    organizationName: "Example Trading Coach LLC",
    partnerCategory: "educator_coach",
    websiteUrl: "https://coachsite.com",
    proposedCollaboration: "A guided journaling pilot for a small cohort of the coach's students.",
    evidenceExcerpts: ["We run a weekly journaling session for our funded-account students, focused on catching revenge-trading patterns before they cost an eval."],
    ...overrides,
  };
}

function buildClient(overrides: Record<string, any[]> = {}) {
  return new FakeSupabaseClient({
    partnership_prospects: [],
    partnership_interactions: [],
    partnership_outcomes: [],
    partnership_budget_reservations: [],
    partnership_discovery_runs: [],
    creators: [],
    prospecting_candidates: [],
    inbound_engagements: [],
    cost_events: [],
    brand_rules: [],
    knowledge_documents: [],
    opportunities: [],
    campaigns: [],
    campaign_assets: [],
    content_versions: [],
    content_scores: [],
    ...overrides,
  });
}

const NOW = new Date("2026-09-05T00:00:00Z");

// The budget reservation reads the real clock for "this month", so pin Date to NOW or the September fixtures stop counting once the calendar month rolls over.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("discovery and generation running CONCURRENTLY share one atomic budget check", () => {
  it("both proceed without interfering when each independently fits its own bucket AND the combined shared cap has room", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = contentAwareFetch() as unknown as typeof fetch;

    const client = buildClient({
      // $1.70 generation (bucket headroom $0.30, fits the $0.25 ceiling)
      // + $0.70 discovery (bucket headroom $0.30, fits the $0.275 ceiling)
      // = $2.40 shared actual, $0.60 shared headroom -- comfortably above
      // the combined $0.525 the two reservations need together.
      cost_events: [
        { event_type: "partnership_llm_call", cost_usd: 1.7, created_at: NOW.toISOString() },
        { event_type: "partnership_x_search_read", cost_usd: 0.7, created_at: NOW.toISOString() },
      ],
    });
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    const adapter = fakeAdapter({ "futures trading coach OR trading mentor": [xResult({ authorHandle: "otherhandle" })] });

    const [genResult, discResult] = await Promise.all([
      generateDraftForPartnership(asSupabase(client), prospect.id),
      runPartnershipDiscoveryStep({ client: asSupabase(client), adapter, triggeredBy: "owner", force: true, now: NOW }),
    ]);

    expect(genResult.status).toBe("ready");
    expect(discResult.status).toBe("found");

    const totalSpend = client.tables.cost_events!.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
    expect(totalSpend).toBeLessThanOrEqual(3.0);

    const openReservations = client.tables.partnership_budget_reservations!.filter((r) => r.released_at == null);
    expect(openReservations).toHaveLength(0);
  });

  it("a concurrent discovery run does NOT block a generation attempt that only needs headroom in its OWN bucket, and vice versa", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = contentAwareFetch() as unknown as typeof fetch;

    const client = buildClient({
      // Discovery bucket is essentially exhausted; generation bucket is untouched.
      cost_events: [{ event_type: "partnership_x_search_read", cost_usd: 1.99, created_at: NOW.toISOString() }],
    });
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    const adapter = fakeAdapter({ "futures trading coach OR trading mentor": [xResult()] });

    const [genResult, discResult] = await Promise.all([
      generateDraftForPartnership(asSupabase(client), prospect.id),
      runPartnershipDiscoveryStep({ client: asSupabase(client), adapter, triggeredBy: "owner", force: true, now: NOW }),
    ]);

    expect(genResult.status).toBe("ready"); // generation's own bucket is untouched -- not penalized for discovery's near-exhaustion
    expect(discResult.status).toBe("budget_exhausted"); // discovery's OWN bucket is what's actually exhausted
  });
});
