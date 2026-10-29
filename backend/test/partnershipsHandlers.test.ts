import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import {
  PartnershipActionError,
  activatePartnership,
  archivePartnership,
  closePartnership,
  createPartnership,
  generateDraftForPartnership,
  listPartnerships,
  markPartnershipContacted,
  markPartnershipDoNotContact,
  qualifyPartnership,
  recordPartnershipOutcome,
  recordPartnershipReply,
  sendPartnershipEmail,
  startPartnershipPilot,
} from "../src/partnerships/partnershipsHandlers";
import type { NewPartnershipProspect } from "../src/partnerships/types";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
// Real Anthropic responses always carry a `usage` block; onUsage (and so
// recordCostEvent/cost_events) only fires when it's present -- omitting it
// silently meant costUsd/cost_events were always zero/empty in every test
// here, which is exactly what let the partnership_llm_call event-type bug
// go unnoticed.
function draftResponse(body: string) {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_draft", input: { body } }], usage: { input_tokens: 500, output_tokens: 100 } });
}
function verdictResponse(pass: boolean, reasoning = "ok") {
  return jsonResponse({
    content: [{ type: "tool_use", name: "submit_verdict", input: { pass, score: pass ? 1 : 0.2, reasoning, issues: [] } }],
    usage: { input_tokens: 500, output_tokens: 50 },
  });
}
function verdicts(pass: boolean, reasoning = "ok"): Response[] {
  return Array.from({ length: 9 }, () => verdictResponse(pass, reasoning));
}
function sequenceFetch(responses: Response[]) {
  let i = 0;
  return vi.fn(async (_url?: string, _init?: RequestInit) => responses[Math.min(i++, responses.length - 1)]!);
}

const GOOD_DRAFT = "Fillbook is a broker-agnostic futures trading journal built for session review and visible account-rule tracking -- a natural fit for a guided journaling pilot with a small cohort of your students.";

function newProspect(overrides: Partial<NewPartnershipProspect> = {}): NewPartnershipProspect {
  return {
    organizationName: "Example Trading Coach LLC",
    partnerCategory: "educator_coach",
    websiteUrl: "https://coachsite.com",
    proposedCollaboration: "A guided journaling pilot for a small cohort of the coach's students.",
    // Sufficient by default so every test not specifically about the
    // evidence-sufficiency gate exercises the real pipeline, same as
    // before that gate existed -- tests for the gate itself override this.
    evidenceExcerpts: ["We run a weekly journaling session for our funded-account students, focused on catching revenge-trading patterns before they cost an eval."],
    ...overrides,
  };
}

function buildClient(overrides: Record<string, any[]> = {}) {
  return new FakeSupabaseClient({
    partnership_prospects: [],
    partnership_interactions: [],
    partnership_outcomes: [],
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

describe("createPartnership -- dedup is informational, never blocking", () => {
  it("creates a prospect and reports zero existing matches when nothing overlaps", async () => {
    const client = buildClient();
    const { prospect, existingMatches } = await createPartnership(asSupabase(client), newProspect());
    expect(prospect.organizationName).toBe("Example Trading Coach LLC");
    expect(prospect.stage).toBe("prospect");
    expect(existingMatches).toEqual([]);
  });

  it("still creates the prospect even when a cross-system match is found, but reports it", async () => {
    const client = buildClient({ creators: [{ id: "creator-1", handle: "coachsite", platform: "x" }] });
    const { existingMatches } = await createPartnership(asSupabase(client), newProspect({ socialLinks: { x: "@coachsite" } }));
    expect(existingMatches.some((m) => m.source === "creators")).toBe(true);
  });
});

describe("qualifyPartnership -- stage-guarded", () => {
  it("moves prospect -> qualified and records the rationale", async () => {
    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    const qualified = await qualifyPartnership(asSupabase(client), prospect.id, "Real evidence of futures audience, no competing journal.");
    expect(qualified.stage).toBe("qualified");
    expect(qualified.qualificationRationale).toContain("Real evidence");
  });

  it("refuses to qualify a prospect that is not in 'prospect' stage", async () => {
    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await expect(qualifyPartnership(asSupabase(client), prospect.id, "again")).rejects.toThrow(PartnershipActionError);
  });

  it("404s cleanly for a nonexistent id rather than throwing an unrelated error", async () => {
    const client = buildClient();
    await expect(qualifyPartnership(asSupabase(client), "no-such-id", "x")).rejects.toThrow(/No partnership prospect found/);
  });
});

describe("generateDraftForPartnership -- reuses the real pipeline, full rigor", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("passes mechanical gate + all 9 reviewers on the first attempt -> draft_ready with an approved campaign_asset", async () => {
    const fetchMock = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "Good fit.");

    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(result.status).toBe("ready");
    expect(result.campaignAssetId).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(10); // 1 draft + 9 reviewers -- same full rigor as every other content type

    const updated = (await listPartnerships(asSupabase(client))).find((p) => p.id === prospect.id)!;
    expect(updated.stage).toBe("draft_ready");
    expect(updated.approvedCampaignAssetId).toBe(result.campaignAssetId);
  });

  it("records its LLM cost under 'partnership_llm_call' (not the generic 'llm_call' every other feature shares) so its OWN budget gate actually sees real spend -- regression test for a real production gap: the budget check queries 'partnership_llm_call' specifically, and recordCostEvent's default event_type never matched it until this was fixed, so the $3/month cap never actually gated generation cost", async () => {
    const fetchMock = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "Good fit.");

    await generateDraftForPartnership(asSupabase(client), prospect.id);
    // recordCostEvent is deliberately fire-and-forget (void, not awaited) so
    // a cost-write failure never blocks the real pipeline -- flush pending
    // microtasks so this test observes the writes it triggered.
    await new Promise((resolve) => setImmediate(resolve));

    const costRows = client.tables.cost_events!;
    expect(costRows.length).toBeGreaterThan(0);
    expect(costRows.every((r) => r.event_type === "partnership_llm_call")).toBe(true);
    expect(costRows.some((r) => r.event_type === "llm_call")).toBe(false);
  });

  it("blocks generation before spending anything when the recipient's evidence is too thin -- a manually created-and-qualified prospect gets no free pass just because discovery's own gate wasn't the path that created it", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ evidenceExcerpts: [] }));
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    await expect(generateDraftForPartnership(asSupabase(client), prospect.id)).rejects.toThrow(/Not enough of this recipient's own words/);
    expect(fetchMock).not.toHaveBeenCalled();
    const updated = (await listPartnerships(asSupabase(client))).find((p) => p.id === prospect.id)!;
    expect(updated.stage).toBe("qualified"); // unchanged
  });

  it("FIXED: blocks generation before spending anything when the evidence is long enough to personalize but shows no concrete partnership basis -- text LENGTH and partnership-basis KIND are separate checks", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(
      asSupabase(client),
      newProspect({
        evidenceExcerpts: [
          "Honestly, my experience with this prop firm has been really positive so far. The rules are clear, the payouts are fast, and everything feels transparent.",
        ],
      }),
    );
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    await expect(generateDraftForPartnership(asSupabase(client), prospect.id)).rejects.toThrow(/doesn't show this recipient runs or offers/);
    expect(fetchMock).not.toHaveBeenCalled();
    const updated = (await listPartnerships(asSupabase(client))).find((p) => p.id === prospect.id)!;
    expect(updated.stage).toBe("qualified"); // unchanged
  });

  it("reuses an already-passing draft instead of regenerating -- a duplicate call on a prospect already at draft_ready costs and calls nothing", async () => {
    const fetchMock = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    const first = await generateDraftForPartnership(asSupabase(client), prospect.id);
    expect(first.status).toBe("ready");
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(second.status).toBe("ready");
    expect(second.campaignAssetId).toBe(first.campaignAssetId);
    expect(second.costUsd).toBe(0);
    expect(second.attempts).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // zero new calls
  });

  it("stops after ONE attempt (not the usual 2) when the rejection itself says the recipient evidence is too generic -- a same-evidence rewrite can't fix that, so a second attempt would just spend more for the same predictable outcome", async () => {
    const fetchMock = sequenceFetch([
      draftResponse("Hi -- interested in a pilot?"),
      // All 9 reviewers independently flag the same root cause in a way isUnresolvedEvidenceGap should catch.
      ...Array.from({ length: 9 }, () => verdictResponse(false, "This pitch demonstrates zero evidence the sender has any specific knowledge of the recipient -- it could be sent to any prop firm with only the name swapped.")),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1); // stopped early, never tried a second time
    expect(result.error).toContain("a rewrite can't fix this");
    expect(fetchMock).toHaveBeenCalledTimes(10); // exactly 1 attempt's worth of calls
  });

  it("refuses to generate a draft before proposedCollaboration is set -- no blank-ask pitches", async () => {
    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ proposedCollaboration: undefined }));
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await expect(generateDraftForPartnership(asSupabase(client), prospect.id)).rejects.toThrow(/proposedCollaboration/);
  });

  it("a mechanical gate failure records the failed attempt without reaching draft_ready", async () => {
    const fetchMock = sequenceFetch([draftResponse("When I traded NQ today I caught a great move.")]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient({
      brand_rules: [
        {
          id: "r1",
          version: 1,
          rule_type: "claim_prohibited",
          content: "Fillbook must never speak or be shown as if it personally trades -- no fake personal trading story, ever.",
          source_doc: null,
          is_active: true,
        },
      ],
    });
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(result.status).toBe("failed");
    const updated = (await listPartnerships(asSupabase(client))).find((p) => p.id === prospect.id)!;
    expect(updated.stage).toBe("qualified"); // unchanged -- never advanced on a failed attempt
    expect(updated.approvedCampaignAssetId).toBeNull();
  });

  it("bounded revision: a first attempt rejected by review is retried ONCE with that feedback, and a passing second attempt reports attempts:2", async () => {
    const fetchMock = sequenceFetch([
      draftResponse("Hi -- interested in a pilot?"), // attempt 1 draft
      ...verdicts(false, "too generic, no recipient-specific evidence"), // attempt 1: all 9 reject
      draftResponse(GOOD_DRAFT), // attempt 2 draft (writer sees priorFeedback)
      ...verdicts(true), // attempt 2: all 9 pass
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "Good fit.");

    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(result.status).toBe("ready");
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(20); // 2 full (draft + 9 reviewers) attempts

    // The second attempt's draft call must actually carry the first attempt's rejection reasons.
    const secondDraftUserMessage = JSON.parse((fetchMock.mock.calls[10]![1] as RequestInit).body as string).messages[0].content as string;
    expect(secondDraftUserMessage).toContain("A prior draft was rejected for these specific reasons");
    expect(secondDraftUserMessage).toContain("too generic");
  });

  it("never retries a third time -- two straight rejections stop at attempts:2, still reported as failed", async () => {
    const fetchMock = sequenceFetch([
      draftResponse("Hi -- interested in a pilot?"),
      ...verdicts(false, "still generic"),
      draftResponse("Hi -- still interested in a pilot?"),
      ...verdicts(false, "still generic"),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "Good fit.");

    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(20); // exactly 2 attempts, never a 3rd
  });

  it("blocks a genuinely concurrent SECOND call on the SAME prospect -- a duplicate tap/retry can't double-spend on identical work, and the slot is released afterward so a later, real retry can still proceed", async () => {
    let resolveFirstDraft!: () => void;
    const firstDraftGate = new Promise<void>((resolve) => {
      resolveFirstDraft = resolve;
    });
    let fetchCallCount = 0;
    global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) await firstDraftGate; // hold the first call's very first fetch open
      const body = JSON.parse(init.body as string);
      const toolName = body.tools?.[0]?.name as string | undefined;
      return toolName === "submit_draft" ? draftResponse(GOOD_DRAFT) : verdictResponse(true);
    }) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    const firstCall = generateDraftForPartnership(asSupabase(client), prospect.id);
    // Let the first call actually reach (and hold open) its first fetch before firing the second.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(generateDraftForPartnership(asSupabase(client), prospect.id)).rejects.toThrow(/already being generated/);

    resolveFirstDraft();
    const firstResult = await firstCall;
    expect(firstResult.status).toBe("ready");

    // The slot must be released after the first call finishes -- a real, later retry works fine.
    const laterRetry = await generateDraftForPartnership(asSupabase(client), prospect.id);
    expect(laterRetry.status).toBe("ready"); // reuses the now-existing passing draft, per the reuse test above
    expect(laterRetry.costUsd).toBe(0);
  });

  it("threads the recipient's real evidence excerpts to every reviewer, not just the recipient name", async () => {
    const fetchMock = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ evidenceExcerpts: ["We run a 6-week risk-management cohort for funded futures traders."] }));
    await qualifyPartnership(asSupabase(client), prospect.id, "Good fit.");

    await generateDraftForPartnership(asSupabase(client), prospect.id);

    const reviewerCallBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    const reviewerUserMessage = reviewerCallBody.messages[0].content as string;
    expect(reviewerUserMessage).toContain("6-week risk-management cohort");
  });

  /** Routes by the REAL request shape (tool_choice.name) instead of call order -- required for true concurrency tests, since two overlapping generate-draft calls interleave their fetch calls unpredictably against a shared mock. */
  function contentAwareFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const toolName = body.tools?.[0]?.name as string | undefined;
      if (toolName === "submit_draft") return draftResponse(GOOD_DRAFT);
      if (toolName === "submit_verdict") return verdictResponse(true);
      throw new Error(`unexpected tool_choice in test fetch mock: ${toolName}`);
    });
  }

  it("FIXED (was a known limitation, now closed): two concurrent generate-draft calls for DIFFERENT prospects near the generation budget cap no longer both spend -- an atomic, serialized reservation (not the per-prospect generation_claimed_at mutex, which never covered this) closes the cross-prospect race", async () => {
    global.fetch = contentAwareFetch() as unknown as typeof fetch;
    // This test seeds $9.70 of spend TODAY to exercise the partnerships month cap; the daily LLM ceiling
    // (llmBudget.ts) would otherwise trip first, so it is lifted here to keep this test about the month cap.
    vi.stubEnv("LLM_DAILY_HARD_CEILING_USD", "1000");

    // $9.70 of real generation-bucket spend leaves $0.30 of headroom under
    // the $10.00 generation cap -- enough for ONE $0.25 reservation ceiling,
    // not two. If the race were still open, both would read the same
    // $9.70 and both would proceed; the atomic reservation must instead
    // let exactly one through.
    const client = buildClient({ cost_events: [{ event_type: "partnership_llm_call", cost_usd: 9.7, created_at: new Date().toISOString() }] });
    const p1 = await createPartnership(asSupabase(client), newProspect({ organizationName: "Coach A" }));
    const p2 = await createPartnership(asSupabase(client), newProspect({ organizationName: "Coach B", websiteUrl: "https://coachsiteb.com" }));
    await qualifyPartnership(asSupabase(client), p1.prospect.id, "ok");
    await qualifyPartnership(asSupabase(client), p2.prospect.id, "ok");

    const [r1, r2] = await Promise.all([
      generateDraftForPartnership(asSupabase(client), p1.prospect.id),
      generateDraftForPartnership(asSupabase(client), p2.prospect.id),
    ]);

    const statuses = [r1.status, r2.status];
    expect(statuses.filter((s) => s === "ready")).toHaveLength(1);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(1);
    const skipped = r1.status === "skipped" ? r1 : r2;
    expect(skipped.skipReason).toMatch(/bucket_budget_reached/);

    // The generation bucket cap was never actually exceeded -- unlike the
    // old behavior, real recorded spend stays inside it.
    const bucketSpend = client.tables.cost_events!.filter((r) => r.event_type === "partnership_llm_call").reduce((sum, r) => sum + Number(r.cost_usd), 0);
    expect(bucketSpend).toBeLessThanOrEqual(10.0);

    // No leftover reservation from either call -- both released cleanly.
    const openReservations = (client.tables.partnership_budget_reservations ?? []).filter((r: any) => r.released_at == null);
    expect(openReservations).toHaveLength(0);
  });

  it("an interrupted request (one reviewer call fails mid-flight) still fails the whole attempt, but every OTHER call that already completed keeps its recorded cost -- nothing is silently lost, and the prospect is never left mid-transitioned", async () => {
    // The 9 reviewers run via Promise.all (genuinely concurrent, not
    // sequential) -- one failing rejects the whole batch, but the other 8
    // (plus the earlier draft call) still completed and were billed before
    // that rejection surfaced. That's the real, correct invariant to test
    // here: failure never means "we don't know what we spent."
    let reviewerCalls = 0;
    global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const toolName = body.tools?.[0]?.name as string | undefined;
      if (toolName === "submit_draft") return draftResponse(GOOD_DRAFT);
      reviewerCalls += 1;
      if (reviewerCalls === 3) throw new Error("simulated network interruption");
      return verdictResponse(true);
    }) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    await expect(generateDraftForPartnership(asSupabase(client), prospect.id)).rejects.toThrow(/simulated network interruption/);
    await new Promise((resolve) => setImmediate(resolve));

    // At least the draft call, and most of the 8 reviewers that didn't hit
    // the simulated failure, must still be costed -- failure must never
    // silently erase already-incurred spend.
    const costRows = client.tables.cost_events!.filter((r) => r.event_type === "partnership_llm_call");
    expect(costRows.length).toBeGreaterThanOrEqual(8); // 1 draft + at least 7 of 9 reviewers (one throws, others may not all finish before the reject wins the race)

    // The prospect itself must be untouched -- still 'qualified', no
    // approved draft, no interaction log claiming a real outcome that
    // never actually happened.
    const updated = (await listPartnerships(asSupabase(client))).find((p) => p.id === prospect.id)!;
    expect(updated.stage).toBe("qualified");
    expect(updated.approvedCampaignAssetId).toBeNull();

    // The budget reservation for this attempt must be released even
    // though it failed mid-flight -- an interrupted request must never
    // leave budget silently and permanently held (only the bounded
    // migration-0024 expiry window would eventually reclaim a truly stuck
    // one, and this path shouldn't need that safety net at all).
    const openReservations = client.tables.partnership_budget_reservations!.filter((r) => r.released_at == null);
    expect(openReservations).toHaveLength(0);

    // The real incurred cost (the 8 completed calls) is recorded exactly
    // once, in cost_events -- never duplicated by, or confused with, the
    // now-released reservation, which lived in a wholly separate table
    // and never itself represented real spend.
    const recordedSpend = client.tables.cost_events!.filter((r) => r.event_type === "partnership_llm_call").reduce((sum, r) => sum + Number(r.cost_usd), 0);
    expect(recordedSpend).toBeGreaterThan(0);
    expect(recordedSpend).toBeLessThan(0.05); // ~9 tiny fixture calls -- sanity bound, not inflated by any phantom reservation amount
  });

  it("FIXED (was a real gap): when the LLM call succeeds but the cost_events WRITE itself silently fails, a later-settled reservation is NOT wrongly reversed -- 'the call returned usage' and 'the cost was durably recorded' are different facts", async () => {
    // The draft call succeeds and returns real usage, but every cost_events
    // INSERT for this attempt is made to fail (simulating an RLS/network
    // blip on that one table, not a thrown exception -- exactly how a real
    // Supabase failure surfaces: {error}, not a throw).
    global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const toolName = body.tools?.[0]?.name as string | undefined;
      if (toolName === "submit_draft") return draftResponse(GOOD_DRAFT);
      return verdictResponse(true);
    }) as unknown as typeof fetch;

    const client = buildClient();
    client.failTable("cost_events", { message: "simulated transient write failure" }, "insert");
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    // The pipeline itself still completes successfully (a cost-recording
    // failure must never block the actual reviewed work) -- but zero real
    // cost_events rows exist for it, since every insert was made to fail.
    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);
    expect(result.status).toBe("ready");
    expect(client.tables.cost_events!.filter((r) => r.event_type === "partnership_llm_call")).toHaveLength(0);

    // The reservation was released (this attempt finished normally) --
    // confirm it was released WITHOUT being told a real cost was
    // confirmed, since no write actually succeeded. This is the exact
    // signal migration 0025's settlement/reversal mechanism depends on
    // (see partnershipBudgetReservation.test.ts's dedicated tests for the
    // full reversal-safety proof): a genuinely-successful attempt whose
    // cost-write failed must never be mistaken for a confirmed-real-cost
    // attempt, or a settled conservative charge for this same work could
    // later be wrongly reversed, silently losing track of real spend.
    const openReservations = client.tables.partnership_budget_reservations!.filter((r) => r.released_at == null);
    expect(openReservations).toHaveLength(0);
  });

  it("is skipped, spending nothing, once the independent partnership budget is exhausted -- never touches auto-draft/prospecting/x-feed-post's own budgets", async () => {
    const client = buildClient({
      cost_events: [{ event_type: "partnership_llm_call", cost_usd: 999, created_at: new Date().toISOString() }],
    });
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateDraftForPartnership(asSupabase(client), prospect.id);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/budget_reached/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("markPartnershipContacted -- requires an actual approved draft, never inferred", () => {
  it("refuses when there is no approved draft yet", async () => {
    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await expect(markPartnershipContacted(asSupabase(client), prospect.id, "email", "Hi there")).rejects.toThrow(/Cannot mark contacted/);
  });

  it("succeeds once draft_ready with an approved draft, recording the real channel and final (possibly owner-edited) text", async () => {
    const originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await generateDraftForPartnership(asSupabase(client), prospect.id);

    const contacted = await markPartnershipContacted(asSupabase(client), prospect.id, "email", "Hi -- edited final version of the pitch.");
    expect(contacted.stage).toBe("contacted");
    expect(contacted.contactedChannel).toBe("email");
    expect(contacted.contactedAt).not.toBeNull();

    global.fetch = originalFetch;
  });
});

describe("sendPartnershipEmail -- Resend-backed alternative to the copy/mailto flow", () => {
  const originalResendKey = process.env.RESEND_API_KEY;
  const originalFromEmail = process.env.OUTREACH_FROM_EMAIL;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.RESEND_API_KEY = originalResendKey;
    process.env.OUTREACH_FROM_EMAIL = originalFromEmail;
    global.fetch = originalFetch;
  });

  it("refuses when there is no approved draft yet -- same precondition as markPartnershipContacted", async () => {
    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ contactRoute: "email:coach@example.com" }));
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await expect(sendPartnershipEmail(asSupabase(client), prospect.id, "Subject", "Hi there")).rejects.toThrow(/Cannot send email/);
  });

  it("refuses when the prospect's contact route isn't an email address", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ contactRoute: "x:@examplecoach" }));
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await generateDraftForPartnership(asSupabase(client), prospect.id);

    await expect(sendPartnershipEmail(asSupabase(client), prospect.id, "Subject", GOOD_DRAFT)).rejects.toThrow(/isn't an email address/);
  });

  it("refuses when RESEND_API_KEY/OUTREACH_FROM_EMAIL aren't configured, rather than silently no-op-ing", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OUTREACH_FROM_EMAIL;
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ contactRoute: "email:coach@example.com" }));
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await generateDraftForPartnership(asSupabase(client), prospect.id);

    await expect(sendPartnershipEmail(asSupabase(client), prospect.id, "Subject", GOOD_DRAFT)).rejects.toThrow(/not configured/);
  });

  it("sends via Resend and marks the prospect contacted, once configured with an approved draft and an email contact route", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.OUTREACH_FROM_EMAIL = "growth@fillbookhq.com";
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect({ contactRoute: "email:coach@example.com" }));
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await generateDraftForPartnership(asSupabase(client), prospect.id);

    const sent = await sendPartnershipEmail(asSupabase(client), prospect.id, "A partnership idea", GOOD_DRAFT);

    expect(sent.stage).toBe("contacted");
    expect(sent.contactedChannel).toBe("email");
    expect(sent.contactedAt).not.toBeNull();
  });
});

describe("startPartnershipPilot -- the backend path behind Android's new 'Start pilot' action", () => {
  it("refuses to start a pilot before a reply has actually been recorded", async () => {
    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    // Still 'qualified' -- no draft, no contact, no reply yet.
    await expect(startPartnershipPilot(asSupabase(client), prospect.id, "Free access for 10 students", "2026-10-01")).rejects.toThrow(PartnershipActionError);
  });

  it("succeeds once replied, persisting the agreed terms and start date", async () => {
    const originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await generateDraftForPartnership(asSupabase(client), prospect.id);
    await markPartnershipContacted(asSupabase(client), prospect.id, "email", GOOD_DRAFT);
    await recordPartnershipReply(asSupabase(client), prospect.id, "They said yes.");

    const piloted = await startPartnershipPilot(asSupabase(client), prospect.id, "Free access for 10 students, 60-day pilot.", "2026-10-01");

    expect(piloted.stage).toBe("pilot");
    expect(piloted.pilotTermsAgreed).toBe("Free access for 10 students, 60-day pilot.");
    expect(piloted.pilotStartDate).toBe("2026-10-01");

    global.fetch = originalFetch;
  });
});

describe("full lifecycle -- replied -> pilot -> active_partner -> closed, plus outcomes", () => {
  it("walks the whole graph and records outcomes distinctly as measured vs manual", async () => {
    const originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = sequenceFetch([draftResponse(GOOD_DRAFT), ...verdicts(true)]) as unknown as typeof fetch;

    const client = buildClient();
    const { prospect } = await createPartnership(asSupabase(client), newProspect());
    await qualifyPartnership(asSupabase(client), prospect.id, "ok");
    await generateDraftForPartnership(asSupabase(client), prospect.id);
    await markPartnershipContacted(asSupabase(client), prospect.id, "email", GOOD_DRAFT);
    const replied = await recordPartnershipReply(asSupabase(client), prospect.id, "They said yes, interested in a small pilot.");
    expect(replied.stage).toBe("replied");

    const piloted = await startPartnershipPilot(asSupabase(client), prospect.id, "Free access for 10 students, 60-day pilot.", "2026-10-01");
    expect(piloted.stage).toBe("pilot");

    await recordPartnershipOutcome(asSupabase(client), prospect.id, "signups", 4, "measured");
    await recordPartnershipOutcome(asSupabase(client), prospect.id, "activations", 2, "manual_entry", "Coach reported via email, no direct tracking.");

    const active = await activatePartnership(asSupabase(client), prospect.id);
    expect(active.stage).toBe("active_partner");

    const closed = await closePartnership(asSupabase(client), prospect.id, "Pilot period ended, converted to standing partnership.");
    expect(closed.stage).toBe("closed");

    global.fetch = originalFetch;
  });

  it("archive and do-not-contact are reachable from an early stage without ever having generated a draft", async () => {
    const client = buildClient();
    const { prospect: p1 } = await createPartnership(asSupabase(client), newProspect());
    const archived = await archivePartnership(asSupabase(client), p1.id, "Not a fit after further research.");
    expect(archived.stage).toBe("archived");

    const { prospect: p2 } = await createPartnership(asSupabase(client), newProspect({ organizationName: "Another Org" }));
    const dnc = await markPartnershipDoNotContact(asSupabase(client), p2.id, "Explicitly asked not to be contacted.");
    expect(dnc.stage).toBe("do_not_contact");
  });
});
