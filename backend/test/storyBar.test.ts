import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { MOTION_SCENE_PLANS, isChartPlan, isOfferedPlan } from "../src/shortform/motionPlans";
import { MIN_RENDER_SCORE, assertMeetsRenderBar, renderBar, renderBarRefusal } from "../src/shortform/storyScore";

/**
 * Owner rule (2026-09-30): only concepts that grade A or A+ are ever rendered. Enforced at three points, each proven here
 * without any mock of the bar: the app's concept list, the request handler, and the render worker's own guard.
 */
const passing = MOTION_SCENE_PLANS.filter((p) => renderBar(p).ok);
const failing = MOTION_SCENE_PLANS.filter((p) => !renderBar(p).ok);
const WEAK_ID = "pilot-7-payoff-a";

function fakeReq(body: unknown, method = "POST"): VercelRequest {
  return { method, headers: { authorization: "Bearer test-app-token" }, body } as unknown as VercelRequest;
}
function fakeRes() {
  const res: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const handle = {
    status: vi.fn((code: number) => { res.statusCode = code; return handle; }),
    json: vi.fn((payload: unknown) => { res.body = payload; return handle; }),
  };
  return { res: handle as unknown as VercelResponse, result: res };
}
function createFakeClient() {
  const rpcCalls: string[] = [];
  const inserted: unknown[] = [];
  const builder: any = {
    select: () => builder, eq: () => builder, ilike: () => builder, like: () => builder, in: () => builder, gte: () => builder,
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    order: async () => ({ data: [], error: null }),
    limit: async () => ({ data: [], error: null }),
    single: async () => ({ data: { paused: false }, error: null }),
    insert: (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { ...row, id: "opp-1", status: "open", created_at: new Date().toISOString() }, error: null }) }) }; },
  };
  return {
    client: { from: () => builder, rpc: async (fn: string) => { rpcCalls.push(fn); return { data: [{ campaign_run_request_id: "run-1", job_id: "job-1", already_existed: false }], error: null }; } },
    rpcCalls,
    inserted,
  };
}

describe("the render bar", () => {
  it("passes only A and A+ concepts, and the library has both kinds", () => {
    expect(MIN_RENDER_SCORE).toBe(85);
    expect(passing.length).toBeGreaterThan(0);
    expect(failing.length).toBeGreaterThan(0);
    for (const p of passing) expect(["A", "A+"]).toContain(renderBar(p).grade);
    for (const p of failing) expect(["B", "C", "D"]).toContain(renderBar(p).grade);
  });

  it("refuses a concept below the bar with its grade, the bar and what to fix", () => {
    const weak = MOTION_SCENE_PLANS.find((p) => p.planId === WEAK_ID)!;
    expect(() => assertMeetsRenderBar(weak)).toThrow(/Story bar not met/);
    const text = renderBarRefusal(weak);
    expect(text).toContain(WEAK_ID);
    expect(text).toMatch(/only A and A\+ \(85\+\) are rendered/);
    expect(text).toMatch(/Fix first: .+:/);
  });

  it("lets a passing concept through untouched", () => {
    for (const p of passing) expect(() => assertMeetsRenderBar(p)).not.toThrow();
  });
});

describe("the app's request handler", () => {
  let handler: typeof import("../api/run-campaign").default;
  let state: ReturnType<typeof createFakeClient>;

  beforeEach(async () => {
    process.env.APP_API_TOKEN = "test-app-token";
    state = createFakeClient();
    vi.resetModules();
    vi.doMock("../src/lib/supabaseClient.js", () => ({ getServiceClient: () => state.client }));
    handler = (await import("../api/run-campaign")).default;
  });
  afterEach(() => {
    vi.doUnmock("../src/lib/supabaseClient.js");
    vi.resetModules();
  });

  it("offers only chart-card concepts that clear the bar; every older concept is retired from the list", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq(undefined, "GET"), res);
    expect(result.statusCode).toBe(200);
    const body = result.body as { motionConcepts: { id: string }[]; belowBarMotionConcepts: { id: string }[]; hiddenNearCopyConceptIds: string[] };
    const charts = MOTION_SCENE_PLANS.filter(isOfferedPlan);
    expect(charts.length).toBeGreaterThan(0);
    // Every chart concept that clears the bar is either offered or hidden as a near-copy of one that is (never lost, never both).
    expect([...body.motionConcepts.map((c) => c.id), ...body.hiddenNearCopyConceptIds].sort()).toEqual(charts.filter((p) => renderBar(p).ok).map((p) => p.planId).sort());
    expect(body.motionConcepts.some((c) => body.hiddenNearCopyConceptIds.includes(c.id))).toBe(false);
    expect(body.belowBarMotionConcepts.map((c) => c.id).sort()).toEqual(charts.filter((p) => !renderBar(p).ok).map((p) => p.planId).sort());
    const listed = new Set([...body.motionConcepts, ...body.belowBarMotionConcepts].map((c) => c.id));
    expect(listed.has(WEAK_ID)).toBe(false);
    expect([...listed].every((id) => charts.some((p) => p.planId === id))).toBe(true);
  });

  it("refuses a request for a retired (older-style) concept with a 409, before anything is created or queued", async () => {
    for (const id of [WEAK_ID, passing.find((p) => !isChartPlan(p))!.planId]) {
      const { res, result } = fakeRes();
      await handler(fakeReq({ motionConceptId: id }), res);
      expect(result.statusCode, id).toBe(409);
      expect((result.body as { error: string }).error).toMatch(/retired/);
    }
    expect(state.inserted).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });

  it("accepts a request for a chart-card concept that clears the bar", async () => {
    const { res, result } = fakeRes();
    await handler(fakeReq({ motionConceptId: MOTION_SCENE_PLANS.find((p) => isOfferedPlan(p) && renderBar(p).ok)!.planId }), res);
    expect(result.statusCode).toBe(200);
    expect(state.rpcCalls).toContain("enqueue_campaign_run");
  });
});

describe("the bar still applies to an offered chart concept", () => {
  const WEAKENED = "fresh-01-two-limits";
  let handler: typeof import("../api/run-campaign").default;
  let state: ReturnType<typeof createFakeClient>;

  beforeEach(async () => {
    process.env.APP_API_TOKEN = "test-app-token";
    state = createFakeClient();
    vi.resetModules();
    vi.doMock("../src/lib/supabaseClient.js", () => ({ getServiceClient: () => state.client }));
    vi.doMock("../src/shortform/storyScore", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/shortform/storyScore")>();
      return {
        ...actual,
        renderBar: (p: { planId: string }) => (p.planId === WEAKENED ? { ok: false, score: 50, grade: "D" as const, fixes: ["stubbed weakness"] } : actual.renderBar(p as never)),
        renderBarRefusal: (p: { planId: string }) => `Story bar not met: ${p.planId} (stubbed)`,
      };
    });
    handler = (await import("../api/run-campaign")).default;
  });
  afterEach(() => {
    vi.doUnmock("../src/lib/supabaseClient.js");
    vi.doUnmock("../src/shortform/storyScore");
    vi.resetModules();
  });

  it("lists it below the bar with its grade and fixes, and refuses a request for it with a 409", async () => {
    const get = fakeRes();
    await handler(fakeReq(undefined, "GET"), get.res);
    const body = get.result.body as { motionConcepts: { id: string }[]; belowBarMotionConcepts: { id: string; score: number; grade: string; fixes: string[] }[] };
    expect(body.motionConcepts.map((c) => c.id)).not.toContain(WEAKENED);
    expect(body.belowBarMotionConcepts).toEqual([expect.objectContaining({ id: WEAKENED, score: 50, grade: "D", fixes: ["stubbed weakness"] })]);

    const post = fakeRes();
    await handler(fakeReq({ motionConceptId: WEAKENED }), post.res);
    expect(post.result.statusCode).toBe(409);
    expect((post.result.body as { error: string }).error).toMatch(/Story bar not met/);
    expect(state.inserted).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("the guards stay wired in", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");

  it("the campaign step refuses to draft a below-bar concept before it validates or spends review budget", () => {
    const src = read("src/content/campaignPipeline.ts");
    expect(src).toContain("assertMeetsRenderBar(plan)");
    expect(src.indexOf("assertMeetsRenderBar(plan)")).toBeLessThan(src.indexOf("validateScenePlan(plan"));
  });

  it("the render worker refuses a below-bar plan before it builds anything, even one approved earlier", () => {
    const src = read("scripts/video-worker/render-single.ts");
    expect(src).toContain("assertMeetsRenderBar(motionMatch.plan)");
    expect(src.indexOf("assertMeetsRenderBar(motionMatch.plan)")).toBeLessThan(src.indexOf("buildVerifiedMotionPlan(motionMatch.plan"));
  });
});
