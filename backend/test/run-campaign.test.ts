import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// These tests exercise request states, pipeline mechanics and render paths with real pilots as their fixtures. The story
// bar (only A and A+ concepts render) has its own tests in storyBar.test.ts, so it is switched off here: otherwise every
// test that happens to pick a lower-graded pilot would fail for a reason it is not about.
vi.mock("../src/shortform/storyScore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shortform/storyScore")>();
  return { ...actual, assertMeetsRenderBar: () => {}, renderBar: () => ({ ok: true, score: 100, grade: "A+" as const, fixes: [] }) };
});

/**
 * Exercises the ACTUAL api/run-campaign.ts handler (not just
 * campaignPipeline.ts directly) with a fake Supabase client -- proves the
 * real request-body validation, opportunity creation, and
 * enqueue_campaign_run RPC call construction for a motion-concept request,
 * with every external effect (Supabase) mocked. The real GitHub Actions
 * worker side of the chain (campaign-worker/run-single.ts reading the
 * resulting opportunity and calling runCampaignPipeline) is proven
 * separately in campaignPipeline.test.ts's own motion-concept tests --
 * together they cover payload construction through to what the worker
 * actually receives.
 */

// A chart-card concept: the only kind the app offers for a new video (older concepts are retired from the list).
const CONCEPT_ID = "daily-01-brief-room";
const CONCEPT_TITLE = "$1,725 to the floor, $1,000 left today";

function fakeReq(body: unknown, method = "POST"): VercelRequest {
  return { method, headers: { authorization: "Bearer test-app-token" }, body } as unknown as VercelRequest;
}

function fakeRes() {
  const res: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const handle = {
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return handle;
    }),
    json: vi.fn((payload: unknown) => {
      res.body = payload;
      return handle;
    }),
  };
  return { res: handle as unknown as VercelResponse, result: res };
}

/** The fake database cannot filter by date, so the one-a-day lookup (src/video/dailyLimit.ts) is stubbed here and tested on its own in dailyLimit.test.ts. */
function stubOneADay(requestedToday: string | null) {
  vi.doMock("../src/video/dailyLimit.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/video/dailyLimit")>();
    return { ...actual, motionRequestedToday: async () => requestedToday };
  });
}

/** Minimal, chainable, thenable Supabase client fake -- records every rpc()/insert() call so a test can assert on exactly what was sent. */
function createFakeClient(
  opts: {
    existingOpportunity?: { id: string; status: string } | null;
    campaignRows?: Array<{ thesis: string; status: string; decided_by?: string | null }>;
    /** Campaign-run requests still queued or running, with their opportunity's title. */
    pendingRuns?: Array<{ opportunity_id: string; title: string }>;
  } = {},
) {
  const calls: { kind: string; args: unknown }[] = [];
  const insertedOpportunities: Record<string, unknown>[] = [];

  function builderFor(table: string): any {
    const builder: any = {
      select: (cols: string) => {
        builder._cols = cols;
        return builder;
      },
      eq: () => builder,
      ilike: () => builder,
      like: () => builder,
      in: () => builder,
      // Awaiting the builder itself (motionConceptStates' campaigns lookup) resolves the table's rows.
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data:
            table === "campaigns"
              ? (opts.campaignRows ?? [])
              : table === "campaign_run_requests"
                ? (opts.pendingRuns ?? []).map((r) => ({ opportunity_id: r.opportunity_id }))
                : table === "opportunities"
                  ? (opts.pendingRuns ?? []).map((r) => ({ title: r.title }))
                  : [],
          error: null,
        }),
      // SupabaseOpportunityRepository.listOpen awaits `.order(...)` directly -- resolve to full DB-row-shaped opportunities.
      order: async () => {
        if (table === "opportunities" && opts.existingOpportunity) {
          const e = opts.existingOpportunity;
          return {
            data: [
              {
                id: e.id,
                title: `Motion concept request: ${CONCEPT_TITLE}`,
                score: 100,
                urgency: "normal",
                confidence: 1,
                rationale: `MOTION_CONCEPT_REF:${CONCEPT_ID}`,
                recommended_channels: [],
                recommended_campaign_type: null,
                approval_class: "EXTERNAL_DRAFT",
                status: e.status,
                signal_ids: [],
                created_at: new Date().toISOString(),
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      },
      limit: async () => {
        if (table === "opportunities") return { data: opts.existingOpportunity ? [opts.existingOpportunity] : [], error: null };
        return { data: [], error: null };
      },
      single: async () => {
        if (table === "system_settings") return { data: { paused: false }, error: null };
        return { data: null, error: null };
      },
      insert: (row: Record<string, unknown>) => {
        insertedOpportunities.push(row);
        return {
          select: () => ({
            single: async () => ({ data: { ...row, id: "opp-new-1", status: "open", created_at: new Date().toISOString() }, error: null }),
          }),
        };
      },
    };
    return builder;
  }

  return {
    client: {
      from: (table: string) => builderFor(table),
      rpc: async (fn: string, args: unknown) => {
        calls.push({ kind: fn, args });
        if (fn === "enqueue_campaign_run") {
          return { data: [{ campaign_run_request_id: "run-req-1", job_id: "job-1", already_existed: false }], error: null };
        }
        return { data: null, error: null };
      },
    },
    calls,
    insertedOpportunities,
  };
}

describe("api/run-campaign.ts handler -- motion-concept payload construction", () => {
  let handler: typeof import("../api/run-campaign").default;
  let fakeClientState: ReturnType<typeof createFakeClient>;

  beforeEach(async () => {
    process.env.APP_API_TOKEN = "test-app-token";
    fakeClientState = createFakeClient();
    vi.resetModules();
    vi.doMock("../src/lib/supabaseClient.js", () => ({ getServiceClient: () => fakeClientState.client }));
    stubOneADay(null);
    handler = (await import("../api/run-campaign")).default;
  });

  afterEach(() => {
    vi.doUnmock("../src/lib/supabaseClient.js");
    vi.doUnmock("../src/video/dailyLimit.js");
    vi.resetModules();
  });

  it("GET returns the fixed motion-concept catalog, never an open-ended/inferred list", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq(undefined, "GET"), res);
    expect(result.statusCode).toBe(200);
    const body = result.body as { motionConcepts: { id: string }[] };
    expect(body.motionConcepts.map((c) => c.id)).toContain(CONCEPT_ID);
    // 2026-10-03: only the 30 daily concepts are offered (dailyConcepts.ts). The first twelve product mocks and every older
    // concept are retired from the list but stay in the catalog so a script already drafted or approved still renders.
    expect(body.motionConcepts.map((c) => c.id)).toEqual(expect.arrayContaining(["daily-01-brief-room", "daily-05-size-over-plan", "daily-08-weak-hour"]));
    expect(body.motionConcepts.every((c) => c.id.startsWith("daily-"))).toBe(true);
    expect(body.motionConcepts.length).toBe(30);
    expect(body.motionConcepts.some((c) => c.id.startsWith("chart-"))).toBe(false);
    expect((result.body as { hiddenNearCopyConceptIds: string[] }).hiddenNearCopyConceptIds).toHaveLength(0);
  });

  it("POST for a retired (older-style) concept is refused with 409, and a custom-topic or Radar video request is refused too", async () => {
    for (const body of [{ motionConceptId: "pilot-2-balance-isnt-your-buffer" }, { topic: "stop loss discipline", assetType: "video_script" }, { opportunityId: "opp-1", assetType: "video_script" }]) {
      const { res, result } = fakeRes();
      await handler(fakeReq(body), res);
      expect(result.statusCode, JSON.stringify(body)).toBe(409);
    }
    expect(fakeClientState.insertedOpportunities).toHaveLength(0);
    expect(fakeClientState.calls).toHaveLength(0);
  });

  it("POST with a valid motionConceptId creates a real opportunity row and enqueues via the SAME enqueue_campaign_run RPC every other request uses, with asset_type video_script", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: CONCEPT_ID }), res);

    expect(result.statusCode).toBe(200);
    const body = result.body as { status: string; campaignRunRequestId: string; opportunityId: string };
    expect(body.status).toBe("queued");
    expect(body.campaignRunRequestId).toBe("run-req-1");

    // The opportunity actually inserted carries the machine-parseable
    // reference AND the required title prefix (both required by
    // campaignPipeline.ts's own guard against a coincidental rationale match).
    expect(fakeClientState.insertedOpportunities).toHaveLength(1);
    const inserted = fakeClientState.insertedOpportunities[0]!;
    expect(inserted.title).toContain("Motion concept request:");
    expect(inserted.rationale).toContain(`MOTION_CONCEPT_REF:${CONCEPT_ID}`);

    const enqueueCall = fakeClientState.calls.find((c) => c.kind === "enqueue_campaign_run");
    expect(enqueueCall?.args).toMatchObject({ p_opportunity_id: "opp-new-1", p_asset_type_override: "video_script" });
  });

  it("POST with an unknown motionConceptId is rejected with 400 before any opportunity is created or anything enqueued", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "not-a-real-concept" }), res);

    expect(result.statusCode).toBe(400);
    expect((result.body as { error: string }).error).toContain("Unknown motionConceptId");
    expect(fakeClientState.insertedOpportunities).toHaveLength(0);
    expect(fakeClientState.calls).toHaveLength(0);
  });

  it("POST with motionConceptId AND topic together is rejected with 400 -- exactly one selector is ever valid", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: CONCEPT_ID, topic: "some custom topic" }), res);
    expect(result.statusCode).toBe(400);
    expect(fakeClientState.insertedOpportunities).toHaveLength(0);
  });

  it("POST with motionConceptId AND opportunityId together is rejected with 400", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: CONCEPT_ID, opportunityId: "some-id" }), res);
    expect(result.statusCode).toBe(400);
    expect(fakeClientState.insertedOpportunities).toHaveLength(0);
  });

  it("re-runs a still-open (stuck) prior request for the SAME concept instead of creating a duplicate opportunity", async () => {
    fakeClientState = createFakeClient({ existingOpportunity: { id: "opp-existing-1", status: "open" } });
    vi.doMock("../src/lib/supabaseClient.js", () => ({ getServiceClient: () => fakeClientState.client }));
    vi.resetModules();
    handler = (await import("../api/run-campaign")).default;

    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: CONCEPT_ID }), res);

    expect(result.statusCode).toBe(200);
    expect(fakeClientState.insertedOpportunities).toHaveLength(0); // no NEW opportunity created
    const enqueueCall = fakeClientState.calls.find((c) => c.kind === "enqueue_campaign_run");
    expect(enqueueCall?.args).toMatchObject({ p_opportunity_id: "opp-existing-1" });
  });

  it("refuses to enqueue anything while the system is paused (existing safeguard, unaffected by motion-concept routing)", async () => {
    fakeClientState.client.from = ((table: string) => {
      if (table === "system_settings") {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { paused: true }, error: null }) }) }) };
      }
      return (createFakeClient().client.from as any)(table);
    }) as any;

    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: CONCEPT_ID }), res);
    expect(result.statusCode).toBe(409);
    expect(fakeClientState.calls).toHaveLength(0);
  });
});

describe("api/run-campaign.ts handler -- a concept is used up once requested (owner rule 2026-09-25)", () => {
  const A = "Motion concept request: $1,725 to the floor, $1,000 left today";
  const B = "Motion concept request: 5 contracts against a plan of 3";
  const C = "Motion concept request: 11:00 wins 25%; the account wins 62%";
  let handler: typeof import("../api/run-campaign").default;
  let state: ReturnType<typeof createFakeClient>;

  async function load(opts: Parameters<typeof createFakeClient>[0]) {
    process.env.APP_API_TOKEN = "test-app-token";
    state = createFakeClient(opts);
    vi.resetModules();
    vi.doMock("../src/lib/supabaseClient.js", () => ({ getServiceClient: () => state.client }));
    stubOneADay(null);
    handler = (await import("../api/run-campaign")).default;
  }

  afterEach(() => {
    vi.doUnmock("../src/lib/supabaseClient.js");
    vi.doUnmock("../src/video/dailyLimit.js");
    vi.resetModules();
  });

  it("GET leaves out a concept that's queued, waiting in Approvals, made or rejected, and keeps one whose draft was blocked", async () => {
    await load({
      campaignRows: [
        { thesis: A, status: "approved" },
        { thesis: B, status: "in_review" },
        { thesis: C, status: "draft" },
      ],
    });
    const { res, result } = fakeRes();
    await handler(fakeReq(undefined, "GET"), res);
    const body = result.body as { motionConcepts: { id: string }[]; unavailableMotionConcepts: { id: string; state: string }[] };
    const ids = body.motionConcepts.map((c) => c.id);
    expect(ids).not.toContain("daily-01-brief-room");
    expect(ids).not.toContain("daily-05-size-over-plan");
    expect(ids).toContain("daily-08-weak-hour");
    expect(body.unavailableMotionConcepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "daily-01-brief-room", state: "made" }),
        expect.objectContaining({ id: "daily-05-size-over-plan", state: "waiting" }),
      ]),
    );
  });

  it("GET lists a concept whose request is still queued or rejected as unavailable, never as retired-and-hidden", async () => {
    await load({ campaignRows: [{ thesis: A, status: "retired" }], pendingRuns: [{ opportunity_id: "opp-queued", title: C }] });
    const { res, result } = fakeRes();
    await handler(fakeReq(undefined, "GET"), res);
    const body = result.body as { unavailableMotionConcepts: { id: string; state: string }[] };
    expect(body.unavailableMotionConcepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "daily-01-brief-room", state: "rejected" }),
        expect.objectContaining({ id: "daily-08-weak-hour", state: "waiting" }),
      ]),
    );
  });

  it("a draft retired by the plan-update cleanup does not use its concept up: it is offered again and can be requested", async () => {
    await load({ campaignRows: [{ thesis: A, status: "retired", decided_by: "plan update cleanup" }, { thesis: C, status: "retired", decided_by: "owner" }] });
    const { res, result } = fakeRes();
    await handler(fakeReq(undefined, "GET"), res);
    const body = result.body as { motionConcepts: { id: string }[]; unavailableMotionConcepts: { id: string; state: string }[] };
    expect(body.motionConcepts.map((c) => c.id)).toContain("daily-01-brief-room");
    expect(body.unavailableMotionConcepts).toEqual(expect.arrayContaining([expect.objectContaining({ id: "daily-08-weak-hour", state: "rejected" })]));
    expect(body.unavailableMotionConcepts.map((c) => c.id)).not.toContain("daily-01-brief-room");
  });

  it("POST for a concept that already has a video is refused with 409 before anything is created or enqueued", async () => {
    await load({ campaignRows: [{ thesis: A, status: "approved" }] });
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "daily-01-brief-room" }), res);
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: string }).error).toContain("already been made");
    expect(state.insertedOpportunities).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
  });

  it("POST for a concept waiting in Approvals is refused with 409", async () => {
    await load({ campaignRows: [{ thesis: B, status: "in_review" }] });
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "daily-05-size-over-plan" }), res);
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: string }).error).toContain("waiting in Approvals");
  });

  it("POST for a concept whose request is still queued is refused with 409, so it can't be run twice", async () => {
    await load({ pendingRuns: [{ opportunity_id: "opp-queued", title: C }] });
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "daily-08-weak-hour" }), res);
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: string }).error).toContain("already in progress");
    expect(state.calls).toHaveLength(0);
  });

  it("POST for a concept whose script was rejected is refused with 409", async () => {
    await load({ campaignRows: [{ thesis: A, status: "retired" }] });
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "daily-01-brief-room" }), res);
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: string }).error).toContain("already rejected");
  });
});

describe("api/run-campaign.ts handler -- one new concept request a day (owner rule 2026-10-03)", () => {
  let handler: typeof import("../api/run-campaign").default;
  let state: ReturnType<typeof createFakeClient>;

  async function load(requestedToday: string | null) {
    process.env.APP_API_TOKEN = "test-app-token";
    state = createFakeClient();
    vi.resetModules();
    vi.doMock("../src/lib/supabaseClient.js", () => ({ getServiceClient: () => state.client }));
    stubOneADay(requestedToday);
    handler = (await import("../api/run-campaign")).default;
  }

  afterEach(() => {
    vi.doUnmock("../src/lib/supabaseClient.js");
    vi.doUnmock("../src/video/dailyLimit.js");
    vi.resetModules();
  });

  it("refuses a second request on the same day with a 409 that names today's concept, before anything is created or queued", async () => {
    await load("Motion concept request: 5 contracts against a plan of 3");
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "daily-01-brief-room" }), res);
    expect(result.statusCode).toBe(409);
    const error = (result.body as { error: string }).error;
    expect(error).toMatch(/One video a day/);
    expect(error).toContain("5 contracts against a plan of 3");
    expect(error).toMatch(/Eastern/);
    expect(state.calls.filter((c) => c.kind === "enqueue_campaign_run")).toEqual([]);
    expect(state.insertedOpportunities).toEqual([]);
  });

  it("accepts the day's first request", async () => {
    await load(null);
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: "daily-01-brief-room" }), res);
    expect(result.statusCode).toBe(200);
    expect(state.calls.filter((c) => c.kind === "enqueue_campaign_run")).toHaveLength(1);
  });

  it("GET tells the app which concept was requested today and when the next request opens", async () => {
    await load("Motion concept request: 5 contracts against a plan of 3");
    const { res, result } = fakeRes();
    await handler(fakeReq(undefined, "GET"), res);
    const body = result.body as { dailyLimit: { requestedToday: string | null; nextRequestAt: string | null } };
    expect(body.dailyLimit.requestedToday).toContain("5 contracts");
    expect(new Date(body.dailyLimit.nextRequestAt!).getTime()).toBeGreaterThan(Date.now());

    await load(null);
    const free = fakeRes();
    await handler(fakeReq(undefined, "GET"), free.res);
    expect((free.result.body as { dailyLimit: unknown }).dailyLimit).toEqual({ requestedToday: null, nextRequestAt: null });
  });
});
