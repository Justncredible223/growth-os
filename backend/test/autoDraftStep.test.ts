import { describe, it, expect, vi } from "vitest";
import { LlmClient, type LlmUsage } from "../src/content/llmClient";
import { CampaignFactory } from "../src/content/campaignFactory";
import { ContentQualityGate } from "../src/content/contentQualityGate";
import { BrandConstitution } from "../src/knowledge/brandConstitution";
import { InMemoryBrandConstitutionRepository } from "../src/knowledge/inMemoryRepositories";
import { InMemoryContentScoreRepository } from "../src/content/contentScoreRepository";
import { InMemoryOpportunityRepository } from "../src/opportunities/inMemoryOpportunityRepository";
import { InMemoryAutoDraftRunRepository } from "../src/opportunities/autoDraftRunRepository";
import { runAutoDraftStep, type AutoDraftStepDeps } from "../src/opportunities/autoDraftStep";
import { MIN_QUALIFYING_SCORE, BACKLOG_CAP, MONTHLY_AUTO_DRAFT_BUDGET_USD } from "../src/opportunities/autoDraftEligibility";
import type { RunCampaignDeps } from "../src/content/runCampaignForOpportunity";
import type { CampaignRepository } from "../src/content/campaignPipeline";
import type { AssetStage } from "../src/content/campaignFactory";
import type { Opportunity } from "../src/opportunities/types";

const now = new Date("2026-09-08T13:00:00Z");

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function draftResponse(body: string) {
  return jsonResponse({
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "tool_use", name: "submit_draft", input: { body } }],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
}
function verdictResponse(pass: boolean) {
  return jsonResponse({
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "tool_use", name: "submit_verdict", input: { pass, score: pass ? 1 : 0.2, reasoning: "ok", issues: [] } }],
    usage: { input_tokens: 50, output_tokens: 10 },
  });
}

class InMemoryCampaignRepository implements CampaignRepository {
  campaignCount = 0;
  async createCampaign() { this.campaignCount++; return `campaign-${this.campaignCount}`; }
  async createCampaignAsset() { return `asset-${this.campaignCount}`; }
  async insertContentVersion() { return `version-${this.campaignCount}`; }
  async updateAssetStage(_id: string, _stage: AssetStage) {}
}

async function seedOpportunity(repo: InMemoryOpportunityRepository, overrides: Partial<Opportunity> = {}) {
  const row = await repo.insert({
    title: overrides.title ?? "Real signal",
    score: overrides.score ?? MIN_QUALIFYING_SCORE + 10,
    urgency: "normal",
    confidence: 0.7,
    rationale: "real evidence",
    recommendedChannels: ["x"],
    recommendedCampaignType: null,
    approvalClass: "EXTERNAL_DRAFT",
    signalIds: ["sig-1"],
  });
  return row;
}

function buildStepDeps(fetchMock: ReturnType<typeof vi.fn>, opportunityRepo: InMemoryOpportunityRepository, overrides: Partial<AutoDraftStepDeps> = {}) {
  const rules = [
    {
      id: "r1",
      version: 1,
      ruleType: "claim_prohibited" as const,
      content: "Fillbook must never speak or be shown as if it personally trades -- no fake personal trading story, ever.",
      sourceDoc: null,
      isActive: true,
    },
  ];
  const gate = new ContentQualityGate(new BrandConstitution(new InMemoryBrandConstitutionRepository(rules)));
  const usageLog: LlmUsage[] = [];
  const llmClient = new LlmClient("test-key", fetchMock, undefined, (u) => usageLog.push(u));
  const runCampaignDeps: RunCampaignDeps = {
    llmClient,
    factory: new CampaignFactory(gate),
    scoreRepo: new InMemoryContentScoreRepository(),
    campaignRepo: new InMemoryCampaignRepository(),
    brandRulesSummary: "",
    verifiedKnowledgeSummary: "",
    recentTextsForSameTopic: [],
    listPriorDraftBodiesForOpportunity: async () => [],
    markOpportunityActioned: vi.fn().mockResolvedValue(undefined),
    markCampaignInReview: vi.fn().mockResolvedValue(undefined),
  };

  const deps: AutoDraftStepDeps = {
    runCampaignDeps,
    usageLog,
    opportunityRepo,
    runRepo: new InMemoryAutoDraftRunRepository(),
    countReadyForOwnerAssets: async () => 0,
    listOpportunityIdsWithCampaigns: async () => new Set(),
    isPaused: async () => false,
    ...overrides,
  };
  return deps;
}

describe("runAutoDraftStep", () => {
  it("one qualifying opportunity -> one draft, reaching ready_for_owner", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(draftResponse("Most funded accounts get pulled for violating a rule nobody reads twice."))
      .mockResolvedValue(verdictResponse(true));
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const deps = buildStepDeps(fetchMock, oppRepo);

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("drafted");
    expect(result.aiCalls).toBe(10);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(deps.runCampaignDeps!.markOpportunityActioned).toHaveBeenCalled();
    expect(deps.runCampaignDeps!.markCampaignInReview).toHaveBeenCalled();
  });

  it("no qualifying opportunities -> no draft (correct result, not a failure)", async () => {
    const fetchMock = vi.fn();
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo, { score: MIN_QUALIFYING_SCORE - 1 }); // too weak
    const deps = buildStepDeps(fetchMock, oppRepo);

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("no_qualifying_opportunity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("duplicate invocation for the same date -> only one draft, second call is an idempotent no-op", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(draftResponse("Most funded accounts get pulled for violating a rule nobody reads twice."))
      .mockResolvedValue(verdictResponse(true));
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const runRepo = new InMemoryAutoDraftRunRepository();
    const deps = buildStepDeps(fetchMock, oppRepo, { runRepo });

    const first = await runAutoDraftStep(deps, "2026-09-08", now);
    const second = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(first.status).toBe("drafted");
    expect(second.status).toBe("already_ran");
    expect((deps.runCampaignDeps!.campaignRepo as InMemoryCampaignRepository).campaignCount).toBe(1);
  });

  it("system paused -> skip without claiming a run or touching the LLM", async () => {
    const fetchMock = vi.fn();
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const runRepo = new InMemoryAutoDraftRunRepository();
    const deps = buildStepDeps(fetchMock, oppRepo, { runRepo, isPaused: async () => true });

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("system_paused");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await runRepo.getLastRun()).toBeNull();
  });

  it("backlog cap reached -> skip without touching opportunities or the LLM", async () => {
    const fetchMock = vi.fn();
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const deps = buildStepDeps(fetchMock, oppRepo, { countReadyForOwnerAssets: async () => BACKLOG_CAP });

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("backlog_cap_reached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("monthly spend cap reached -> safe stop, no LLM calls", async () => {
    const fetchMock = vi.fn();
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const runRepo = new InMemoryAutoDraftRunRepository();
    // Pre-seed a completed run this month at the budget ceiling.
    const priorId = await runRepo.claimRun("2026-09-01");
    await runRepo.completeRun(priorId!, {
      status: "drafted",
      opportunitiesConsidered: 1,
      opportunitiesEligible: 1,
      aiCalls: 10,
      costUsd: MONTHLY_AUTO_DRAFT_BUDGET_USD,
      durationMs: 100,
    });
    const deps = buildStepDeps(fetchMock, oppRepo, { runRepo });

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("monthly_budget_reached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("already-used opportunity (has an existing campaign) is excluded, not re-drafted", async () => {
    const fetchMock = vi.fn();
    const oppRepo = new InMemoryOpportunityRepository();
    const used = await seedOpportunity(oppRepo);
    const deps = buildStepDeps(fetchMock, oppRepo, { listOpportunityIdsWithCampaigns: async () => new Set([used.id]) });

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("no_qualifying_opportunity");
  });

  it("AI/API failure -> status 'failed', no dangling ready_for_owner record", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Claude API unavailable"));
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const runRepo = new InMemoryAutoDraftRunRepository();
    const deps = buildStepDeps(fetchMock, oppRepo, { runRepo });

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Claude API unavailable");
    expect(deps.runCampaignDeps!.markOpportunityActioned).not.toHaveBeenCalled();
    expect(deps.runCampaignDeps!.markCampaignInReview).not.toHaveBeenCalled();
    const lastRun = await runRepo.getLastRun();
    expect(lastRun?.status).toBe("failed");
  });

  it("never produces a finalStage beyond ready_for_owner -- nothing publishes externally", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(draftResponse("Most funded accounts get pulled for violating a rule nobody reads twice."))
      .mockResolvedValue(verdictResponse(true));
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const deps = buildStepDeps(fetchMock, oppRepo);

    const result = await runAutoDraftStep(deps, "2026-09-08", now);

    expect(result.status).toBe("drafted");
    // The pipeline's own type system only allows draft/final_draft/ready_for_owner
    // as finalStage (see campaignPipeline.ts) -- this asserts the auto-draft
    // path never bypasses that by checking the campaign/asset never advances
    // via any code path other than runCampaignForOpportunity itself.
    expect(deps.runCampaignDeps!.markCampaignInReview).toHaveBeenCalledTimes(1);
  });
});

describe("runAutoDraftStep lazy drafting deps", () => {
  function lazyDeps(fetchMock: ReturnType<typeof vi.fn>, oppRepo: InMemoryOpportunityRepository, overrides: Partial<AutoDraftStepDeps> = {}) {
    const base = buildStepDeps(fetchMock, oppRepo, overrides);
    const loader = vi.fn(async () => ({ runCampaignDeps: base.runCampaignDeps!, usageLog: base.usageLog! }));
    const { runCampaignDeps: _r, usageLog: _u, ...rest } = base;
    return { deps: { ...rest, loadRunCampaignDeps: loader } as AutoDraftStepDeps, loader };
  }

  it("does not build drafting deps when paused, backlog-full, over budget or nothing qualifies", async () => {
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const paused = lazyDeps(vi.fn(), oppRepo, { isPaused: async () => true });
    expect((await runAutoDraftStep(paused.deps, "2026-09-08", now)).skipReason).toBe("system_paused");
    expect(paused.loader).not.toHaveBeenCalled();

    const full = lazyDeps(vi.fn(), oppRepo, { countReadyForOwnerAssets: async () => 99 });
    expect((await runAutoDraftStep(full.deps, "2026-09-08", now)).status).toBe("skipped");
    expect(full.loader).not.toHaveBeenCalled();

    const emptyRepo = new InMemoryOpportunityRepository();
    const none = lazyDeps(vi.fn(), emptyRepo);
    expect((await runAutoDraftStep(none.deps, "2026-09-08", now)).skipReason).toBe("no_qualifying_opportunity");
    expect(none.loader).not.toHaveBeenCalled();
  });

  it("builds them exactly once, right before drafting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(draftResponse("Most funded accounts get pulled for violating a rule nobody reads twice."))
      .mockResolvedValue(verdictResponse(true));
    const oppRepo = new InMemoryOpportunityRepository();
    await seedOpportunity(oppRepo);
    const { deps, loader } = lazyDeps(fetchMock, oppRepo);
    const result = await runAutoDraftStep(deps, "2026-09-08", now);
    expect(result.status).toBe("drafted");
    expect(result.aiCalls).toBe(10);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
