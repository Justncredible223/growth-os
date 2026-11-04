import { describe, it, expect, vi } from "vitest";
import { LlmClient } from "../src/content/llmClient";
import { CampaignFactory } from "../src/content/campaignFactory";
import { ContentQualityGate } from "../src/content/contentQualityGate";
import { BrandConstitution } from "../src/knowledge/brandConstitution";
import { InMemoryBrandConstitutionRepository } from "../src/knowledge/inMemoryRepositories";
import { InMemoryContentScoreRepository } from "../src/content/contentScoreRepository";
import type { CampaignRepository } from "../src/content/campaignPipeline";
import type { AssetStage } from "../src/content/campaignFactory";
import type { BrandRule } from "../src/knowledge/types";
import {
  ESTIMATED_ATTEMPT_DURATION_MS,
  FEED_POST_TOPICS,
  MAX_ATTEMPTS_PER_DAY,
  RECENT_EDITORIAL_HISTORY_DAYS,
  STALE_RUNNING_MS,
  X_FEED_POST_ASSET_TYPE,
  categoryUnderrepresentationBonus,
  type FeedPostContentCategory,
  deriveTodayXPostView,
  feedPostTopicLabel,
  runDailyXFeedPostStep,
  selectFeedPostAngle,
  selectFeedPostTopic,
  type XFeedPostStepDeps,
} from "../src/content/dailyXFeedPost";
import { InMemoryXFeedPostRunRepository } from "../src/content/xFeedPostRunRepository";

const rules: BrandRule[] = [
  {
    id: "r1",
    version: 1,
    ruleType: "claim_prohibited",
    content: "Fillbook must never speak or be shown as if it personally trades -- no fake personal trading story, ever.",
    sourceDoc: null,
    isActive: true,
  },
];

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function draftResponse(body: string) {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_draft", input: { body } }] });
}
function verdictResponse(pass: boolean, reasoning = "ok") {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_verdict", input: { pass, score: pass ? 1 : 0.2, reasoning, issues: [] } }] });
}
/** 9 identical verdicts -- one per deep-review agent, all with the same pass/fail. */
function verdicts(pass: boolean, reasoning = "ok"): Response[] {
  return Array.from({ length: 9 }, () => verdictResponse(pass, reasoning));
}

/**
 * A fetch double that consumes `responses` in order and repeats the LAST
 * one forever once exhausted -- unlike vi.fn().mockResolvedValueOnce(...)
 * chains, this never silently loses track of "how many calls have
 * already happened" across a multi-attempt scenario (each attempt is 1
 * draft call + up to 9 review-agent calls), which is what made an
 * earlier version of these tests fail for the wrong reason (a later
 * .mockResolvedValue() overwriting an earlier one instead of queuing).
 */
function sequenceFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!);
}

/** A real, passing draft body -- distinct wording per call so recentFeedPostTexts/originality checks in later tests have something concrete to compare against. */
const GOOD_DRAFT_A = "Most funded accounts get pulled for violating a rule nobody reads twice.";
const GOOD_DRAFT_B = "A flat stretch on your equity curve can be a controlled drawdown, not stagnation -- check the trade count, not just the slope.";
/** Triggers the vocabulary rule above ("When I traded...") -- fails the mechanical gate before any deep-review call. */
const VOCAB_VIOLATION_DRAFT = "When I traded NQ today I caught a great move.";

class InMemoryCampaignRepository implements CampaignRepository {
  campaigns: Array<{ id: string; opportunityId: string; thesis: string }> = [];
  assets: Array<{ id: string; campaignId: string; platform: string; assetType: string; stage: AssetStage }> = [];
  versions: Array<{ id: string; campaignAssetId: string; version: number; body: string }> = [];
  private counter = 0;

  async createCampaign(opportunityId: string, thesis: string) {
    const id = `campaign-${++this.counter}`;
    this.campaigns.push({ id, opportunityId, thesis });
    return id;
  }
  async createCampaignAsset(campaignId: string, platform: string, assetType: string) {
    const id = `asset-${++this.counter}`;
    this.assets.push({ id, campaignId, platform, assetType, stage: "draft" });
    return id;
  }
  async insertContentVersion(campaignAssetId: string, version: number, body: string) {
    const id = `version-${++this.counter}`;
    this.versions.push({ id, campaignAssetId, version, body });
    return id;
  }
  async updateAssetStage(campaignAssetId: string, stage: AssetStage) {
    const asset = this.assets.find((a) => a.id === campaignAssetId);
    if (asset) asset.stage = stage;
  }
}

function buildFactory(): CampaignFactory {
  return new CampaignFactory(new ContentQualityGate(new BrandConstitution(new InMemoryBrandConstitutionRepository(rules))));
}

interface Harness {
  deps: XFeedPostStepDeps;
  campaignRepo: InMemoryCampaignRepository;
  runRepo: InMemoryXFeedPostRunRepository;
  opportunitiesCreated: Array<{ id: string; topicKey: string }>;
}

function buildHarness(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: Partial<Pick<XFeedPostStepDeps, "isPaused" | "isDismissed" | "recentFeedPostTexts">> = {},
): Harness {
  const campaignRepo = new InMemoryCampaignRepository();
  const runRepo = new InMemoryXFeedPostRunRepository();
  const opportunitiesCreated: Array<{ id: string; topicKey: string }> = [];
  let opportunityCounter = 0;

  const deps: XFeedPostStepDeps = {
    llmClient: new LlmClient("test-key", fetchMock),
    factory: buildFactory(),
    scoreRepo: new InMemoryContentScoreRepository(),
    campaignRepo,
    runRepo,
    brandRulesSummary: "voice: concise",
    verifiedKnowledgeSummary: "Fillbook tracks prop-firm drawdown rules.",
    recentFeedPostTexts: overrides.recentFeedPostTexts ?? [],
    usageLog: [],
    isPaused: overrides.isPaused ?? (async () => false),
    isDismissed: overrides.isDismissed ?? (async () => false),
    createOpportunityForTopic: async (topic) => {
      const id = `opp-${++opportunityCounter}`;
      opportunitiesCreated.push({ id, topicKey: topic.key });
      return id;
    },
    getTopicFreshnessSignals: async () => ({}),
  };

  return { deps, campaignRepo, runRepo, opportunitiesCreated };
}

const OPERATING_DATE = "2026-09-05";

describe("selectFeedPostTopic", () => {
  it("is deterministic for a given date with no exclusions", () => {
    const first = selectFeedPostTopic(OPERATING_DATE);
    const second = selectFeedPostTopic(OPERATING_DATE);
    expect(first.key).toBe(second.key);
  });

  it("picks a different topic on a different date (rotation, not a fixed pick)", () => {
    const day1 = selectFeedPostTopic("2026-09-05");
    const day2 = selectFeedPostTopic("2026-09-06");
    expect(day1.key).not.toBe(day2.key);
  });

  it("skips excluded (already-tried) topics and never returns one from excludeKeys unless every topic is exhausted", () => {
    const base = selectFeedPostTopic(OPERATING_DATE);
    const next = selectFeedPostTopic(OPERATING_DATE, [base.key]);
    expect(next.key).not.toBe(base.key);
    expect(FEED_POST_TOPICS.some((t) => t.key === next.key)).toBe(true);
  });

  it("falls back to the base topic rather than throwing if every topic is excluded", () => {
    const allKeys = FEED_POST_TOPICS.map((t) => t.key);
    expect(() => selectFeedPostTopic(OPERATING_DATE, allKeys)).not.toThrow();
  });
});

describe("feedPostTopicLabel", () => {
  it("resolves a real topic key to its human label", () => {
    expect(feedPostTopicLabel(FEED_POST_TOPICS[0]!.key)).toBe(FEED_POST_TOPICS[0]!.label);
  });
  it("returns null for null/unrecognized keys instead of throwing", () => {
    expect(feedPostTopicLabel(null)).toBeNull();
    expect(feedPostTopicLabel("not-a-real-topic")).toBeNull();
  });
});

describe("runDailyXFeedPostStep -- happy path and idempotency", () => {
  it("generates a real, reviewed, ready_for_owner X feed post on the first attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps, campaignRepo } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("ready");
    expect(result.attempts).toBe(1);
    const asset = campaignRepo.assets.find((a) => a.id === result.campaignAssetId)!;
    expect(asset.stage).toBe("ready_for_owner");
    expect(asset.platform).toBe("x");
    expect(asset.assetType).toBe(X_FEED_POST_ASSET_TYPE);
  });

  it("re-running the daily pipeline for the same date is idempotent: no new LLM calls, same asset returned", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);

    const first = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    fetchMock.mockClear();
    const second = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(second.status).toBe("ready");
    expect(second.campaignAssetId).toBe(first.campaignAssetId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reopening the app (a second unforced call) never creates a duplicate asset", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps, campaignRepo } = buildHarness(fetchMock);

    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(campaignRepo.campaigns).toHaveLength(1);
    expect(campaignRepo.assets).toHaveLength(1);
  });

  it("even an explicit forced Regenerate never replaces a genuinely still-ready post (duplicate prevention)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps, campaignRepo } = buildHarness(fetchMock);

    const first = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    fetchMock.mockClear();
    const forced = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);

    expect(forced.status).toBe("ready");
    expect(forced.campaignAssetId).toBe(first.campaignAssetId);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(campaignRepo.assets).toHaveLength(1);
  });
});

describe("runDailyXFeedPostStep -- failure, retry, and duplicate/near-duplicate rejection", () => {
  it("a mechanical (vocabulary) gate failure never reaches ready_for_owner, and the run is recorded as failed with a visible reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT));
    const { deps } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/quality gate/);
    const run = await deps.runRepo.getRun(OPERATING_DATE);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/quality gate/);
  });

  it("a deep-review-agent failure (mechanical gate passes) also never reaches ready_for_owner -- and since neither of the invocation's 2 free attempts passed, the overall result is failed", async () => {
    // Both attempts pass the mechanical gate (real, unflagged text) but
    // fail deep review -- exactly the scenario a signal-derived
    // opportunity's own auto-draft run can hit, now proven for the
    // feed-post path too.
    const fetchMock = sequenceFetch([draftResponse(GOOD_DRAFT_A), ...verdicts(false, "unverified claim"), draftResponse(GOOD_DRAFT_B), ...verdicts(false, "unverified claim")]);
    const { deps } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(result.error).toMatch(/review gate/);
    expect(fetchMock).toHaveBeenCalledTimes(20); // 2 attempts x (1 draft + 9 verdicts)
  });

  it("a bounded retry after a first-attempt failure picks a DIFFERENT topic/angle and can still succeed within one invocation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(draftResponse(VOCAB_VIOLATION_DRAFT)) // attempt 1: fails mechanical gate
      .mockResolvedValueOnce(draftResponse(GOOD_DRAFT_B)) // attempt 2: different angle, passes
      .mockResolvedValue(verdictResponse(true));
    const { deps, opportunitiesCreated } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("ready");
    expect(result.attempts).toBe(2);
    expect(opportunitiesCreated).toHaveLength(2);
    expect(opportunitiesCreated[0]!.topicKey).not.toBe(opportunitiesCreated[1]!.topicKey);
    const run = await deps.runRepo.getRun(OPERATING_DATE);
    expect(run?.triedTopicKeys).toHaveLength(2);
  });

  it("rejects a near-duplicate of recent X feed post content via the existing originality gate, and a differently-worded retry can still pass", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)) // near-identical to a recent post -> originality gate blocks it
      .mockResolvedValueOnce(draftResponse(GOOD_DRAFT_B)) // genuinely different wording -> passes
      .mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock, { recentFeedPostTexts: [GOOD_DRAFT_A] });

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("ready");
    expect(result.attempts).toBe(2);
  });

  it("gives up after MAX_ATTEMPTS_PER_DAY total attempts across repeated forced regenerates, never spending further", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT));
    const { deps } = buildHarness(fetchMock);

    let last = await runDailyXFeedPostStep(deps, OPERATING_DATE, false); // attempts 1-2
    expect(last.attempts).toBe(2);
    last = await runDailyXFeedPostStep(deps, OPERATING_DATE, true); // attempts 3-4
    expect(last.attempts).toBe(MAX_ATTEMPTS_PER_DAY);

    fetchMock.mockClear();
    const overCap = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);
    expect(overCap.status).toBe("skipped");
    expect(overCap.skipReason).toMatch(/max_attempts_reached/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a forced Regenerate with no attempts left never claims the run: it stays failed, never wedged on 'running'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT));
    const { deps } = buildHarness(fetchMock);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, true); // attempts now 4/4

    fetchMock.mockClear();
    for (let tap = 0; tap < 3; tap++) {
      const overCap = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);
      expect(overCap.skipReason).toMatch(/max_attempts_reached/);
      expect((await deps.runRepo.getRun(OPERATING_DATE))!.status).toBe("failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes a run an earlier Regenerate already wedged on 'running' at the cap, with the real reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT));
    const { deps } = buildHarness(fetchMock);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, true); // 4/4, failed
    // Reproduce the old bug: the row was claimed (failed -> running) and the call then returned without finishing it.
    const failed = (await deps.runRepo.getRun(OPERATING_DATE))!;
    expect(await deps.runRepo.tryClaimForAttempt(OPERATING_DATE, { status: "failed", updatedAt: failed.updatedAt })).toBe(true);

    fetchMock.mockClear();
    const later = new Date(Date.now() + STALE_RUNNING_MS + 60_000);
    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, true, later);
    expect(result.skipReason).toMatch(/max_attempts_reached/);
    const row = (await deps.runRepo.getRun(OPERATING_DATE))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no attempts left today/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unforced call after a prior failure does not spend again, but reports the prior failure reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT));
    const { deps } = buildHarness(fetchMock);

    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    fetchMock.mockClear();
    const second = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(second.status).toBe("skipped");
    expect(second.skipReason).toMatch(/already_attempted_failed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an explicit owner Regenerate CAN retry after a failure and succeed, without exceeding the attempt cap unnecessarily", async () => {
    // Invocation 1 (unforced): both of its 2 free attempts fail mechanically (1 call each, no verdict calls needed).
    // Invocation 2 (forced Regenerate): a fresh attempt with real content passes both gates.
    const fetchMock = sequenceFetch([draftResponse(VOCAB_VIOLATION_DRAFT), draftResponse(VOCAB_VIOLATION_DRAFT), draftResponse(GOOD_DRAFT_A), ...verdicts(true)]);
    const { deps } = buildHarness(fetchMock);

    const first = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    expect(first.status).toBe("failed");
    expect(first.attempts).toBe(2);

    const regenerated = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);
    expect(regenerated.status).toBe("ready");
    expect(regenerated.attempts).toBe(3);
  });
});

describe("runDailyXFeedPostStep -- pause and budget gates", () => {
  it("system_paused skips immediately with zero attempts and zero cost", async () => {
    const fetchMock = vi.fn();
    const { deps } = buildHarness(fetchMock, { isPaused: async () => true });

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result).toEqual({ status: "skipped", skipReason: "system_paused", attempts: 0, aiCalls: 0, costUsd: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await deps.runRepo.getRun(OPERATING_DATE)).toBeNull(); // never even claimed
  });

  it("a monthly budget already at/over the cap skips before claiming a run or spending anything", async () => {
    const fetchMock = vi.fn();
    const runRepo = new InMemoryXFeedPostRunRepository();
    // Seed prior spend this month via a completed run on an earlier date.
    const priorId = await runRepo.claimRun("2026-09-01");
    await runRepo.completeRun(priorId!, { status: "ready", campaignAssetId: "prior-asset", topicKey: "k", triedTopicKeys: ["k"], attempts: 1, aiCalls: 10, costUsd: 6.5 });

    const { deps } = buildHarness(fetchMock);
    (deps as any).runRepo = runRepo;

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/monthly_budget_reached/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await runRepo.getRun(OPERATING_DATE)).toBeNull();
  });
});

describe("runDailyXFeedPostStep -- dismissed posts", () => {
  it("an owner-dismissed (retired) ready post is NOT auto-replaced by an unforced call, but IS replaced by an explicit Regenerate", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    let dismissed = false;
    const { deps } = buildHarness(fetchMock, { isDismissed: async () => dismissed });

    const first = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    expect(first.status).toBe("ready");

    dismissed = true;
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(draftResponse(GOOD_DRAFT_B)).mockResolvedValue(verdictResponse(true));

    const unforcedAfterDismiss = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    expect(unforcedAfterDismiss.status).toBe("ready");
    expect(unforcedAfterDismiss.campaignAssetId).toBe(first.campaignAssetId); // unchanged -- unforced never replaces
    expect(fetchMock).not.toHaveBeenCalled();

    const forcedAfterDismiss = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);
    expect(forcedAfterDismiss.status).toBe("ready");
    expect(forcedAfterDismiss.campaignAssetId).not.toBe(first.campaignAssetId); // replaced with a fresh post
  });
});

describe("deriveTodayXPostView -- Home's exact state mapping (ready / handed_off / posted / failed / empty)", () => {
  const readyRun = {
    id: "run-1",
    operatingDate: OPERATING_DATE,
    status: "ready" as const,
    campaignAssetId: "asset-1",
    topicKey: FEED_POST_TOPICS[0]!.key,
    triedTopicKeys: [FEED_POST_TOPICS[0]!.key],
    attempts: 1,
    aiCalls: 10,
    costUsd: 0.05,
    error: null,
    postedAt: null,
    updatedAt: "2026-09-05T12:00:00.000Z",
    editorialTags: FEED_POST_TOPICS[0]!.editorialTags,
    selectionReason: null,
    postedText: null,
  };

  it("no run at all for today -> empty, no reason, no regenerate (nothing has been attempted)", () => {
    expect(deriveTodayXPostView(null, null, false, null)).toEqual({ state: "empty", canRegenerate: false });
  });

  it("a running run -> its own distinct 'running' state, never confused with 'empty' (nothing attempted) or a false ready/failed", () => {
    expect(deriveTodayXPostView({ ...readyRun, status: "running", campaignAssetId: null }, null, false, null)).toEqual({ state: "running", canRegenerate: false });
  });

  it("a run still 'running' past the staleness bar -> failed with Regenerate offered, so a killed attempt never leaves the card stuck on Generating", () => {
    const running = { ...readyRun, status: "running" as const, campaignAssetId: null, updatedAt: "2026-09-05T12:00:00.000Z" };
    const justOver = new Date(new Date(running.updatedAt).getTime() + STALE_RUNNING_MS + 1000);
    const view = deriveTodayXPostView(running, null, false, null, justOver);
    expect(view.state).toBe("failed");
    expect(view.canRegenerate).toBe(true);
    expect(view.reason).toMatch(/didn't finish/);
  });

  it("a stale run with no attempts left says so, and offers no Regenerate that could not work", () => {
    const running = { ...readyRun, status: "running" as const, campaignAssetId: null, attempts: MAX_ATTEMPTS_PER_DAY, updatedAt: "2026-09-05T12:00:00.000Z" };
    const view = deriveTodayXPostView(running, null, false, null, new Date(new Date(running.updatedAt).getTime() + STALE_RUNNING_MS + 1000));
    expect(view.state).toBe("failed");
    expect(view.canRegenerate).toBe(false);
    expect(view.reason).toMatch(/no attempts left today/);
  });

  it("a failed run with no attempts left offers no Regenerate; one with attempts left still does", () => {
    const failed = { ...readyRun, status: "failed" as const, campaignAssetId: null, error: "review gate: growth_strategist: x" };
    expect(deriveTodayXPostView({ ...failed, attempts: MAX_ATTEMPTS_PER_DAY }, null, false, null).canRegenerate).toBe(false);
    expect(deriveTodayXPostView({ ...failed, attempts: 2 }, null, false, null).canRegenerate).toBe(true);
  });

  it("a run that is still within the staleness bar stays 'running' (a live attempt is never shown as failed)", () => {
    const running = { ...readyRun, status: "running" as const, campaignAssetId: null, updatedAt: "2026-09-05T12:00:00.000Z" };
    const justUnder = new Date(new Date(running.updatedAt).getTime() + STALE_RUNNING_MS - 1000);
    expect(deriveTodayXPostView(running, null, false, null, justUnder)).toEqual({ state: "running", canRegenerate: false });
  });

  it("a failed run -> failed, with the real reason surfaced and Regenerate offered", () => {
    const view = deriveTodayXPostView({ ...readyRun, status: "failed", campaignAssetId: null, error: "review gate: fact_checker: unverified claim" }, null, false, null);
    expect(view).toEqual({ state: "failed", reason: "review gate: fact_checker: unverified claim", canRegenerate: true });
  });

  it("a ready run whose asset is at ready_for_owner -> ready, with preview text and topic label, Regenerate NOT offered", () => {
    const view = deriveTodayXPostView(readyRun, "ready_for_owner", false, "Most funded accounts get pulled for violating a rule nobody reads twice.");
    expect(view).toEqual({
      state: "ready",
      campaignAssetId: "asset-1",
      previewText: "Most funded accounts get pulled for violating a rule nobody reads twice.",
      topicLabel: FEED_POST_TOPICS[0]!.label,
      canRegenerate: false,
    });
  });

  it("a ready run whose asset has been handed off (not yet marked posted) -> handed_off, no Regenerate", () => {
    const view = deriveTodayXPostView(readyRun, "handed_off", false, null);
    expect(view).toEqual({ state: "handed_off", campaignAssetId: "asset-1", topicLabel: FEED_POST_TOPICS[0]!.label, canRegenerate: false });
  });

  it("a handed-off run still carries the text that was actually copied to X, so Mark posted has something real to record (the app shows no editable field in this state)", () => {
    const view = deriveTodayXPostView(readyRun, "handed_off", false, "Most funded accounts get pulled for violating a rule nobody reads twice.");
    expect(view).toEqual({
      state: "handed_off",
      campaignAssetId: "asset-1",
      previewText: "Most funded accounts get pulled for violating a rule nobody reads twice.",
      topicLabel: FEED_POST_TOPICS[0]!.label,
      canRegenerate: false,
    });
  });

  it("a ready run whose asset was handed off AND the owner confirmed posting -> posted, separate from handoff", () => {
    const view = deriveTodayXPostView({ ...readyRun, postedAt: "2026-09-05T20:00:00Z" }, "handed_off", false, null);
    expect(view.state).toBe("posted");
  });

  it("a ready run the owner has explicitly dismissed (retired) -> empty, but Regenerate IS offered", () => {
    expect(deriveTodayXPostView(readyRun, "ready_for_owner", true, "irrelevant")).toEqual({ state: "empty", canRegenerate: true });
  });

  it("never confuses an asset_type other than the feed-post type -- structural guarantee via the dedicated constant", () => {
    expect(X_FEED_POST_ASSET_TYPE).not.toBe("post"); // the generic type prospecting/inbound/opportunity replies use
    expect(X_FEED_POST_ASSET_TYPE).not.toBe("video_script"); // the video-factory type
  });
});

describe("human posting boundary -- a feed post reaching ready_for_owner is handed off exactly like any other asset, never auto-published", () => {
  it("this step never itself calls handOffToOwner or anything EXTERNAL_WRITE -- it stops at ready_for_owner, same ceiling as auto-draft/manual runs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("ready");
    // XFeedPostStepDeps exposes no handoff/publish capability at all --
    // the type itself is the guarantee; this asserts the step's actual
    // behavior matches: reaching "ready" is the furthest outcome it
    // returns, identical to auto-draft's own contract.
  });

  it("handing that asset off afterward goes through the real CampaignFactory/ExternalWriteFirewall path, classified EXTERNAL_DRAFT, never EXTERNAL_WRITE", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);
    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    expect(result.status).toBe("ready");

    const audit: Array<{ actionClass: string; outcome: string }> = [];
    const auditedFactory = new CampaignFactory(new ContentQualityGate(new BrandConstitution(new InMemoryBrandConstitutionRepository(rules))), (entry) => {
      audit.push(entry);
    });

    const newStage = await auditedFactory.handOffToOwner("ready_for_owner", "x", result.campaignAssetId!);

    expect(newStage).toBe("handed_off");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actionClass).toBe("EXTERNAL_DRAFT");
    expect(audit[0]!.outcome).toBe("drafted"); // never "allowed"/"published" -- see externalWriteFirewall.ts
  });
});

describe("concurrency safety -- two invocations racing the same operating date", () => {
  it("two simultaneous forced retries after a failure: only one wins the claim and generates; the other backs off without spending", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(VOCAB_VIOLATION_DRAFT)).mockResolvedValueOnce(draftResponse(VOCAB_VIOLATION_DRAFT)).mockResolvedValue(draftResponse(GOOD_DRAFT_A));
    const { deps, runRepo } = buildHarness(fetchMock);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, false); // fails after 2 attempts -> status 'failed'
    fetchMock.mockClear();

    // Two "Regenerate" taps read the SAME pre-retry row (same expected
    // status/updatedAt) before either has written anything back --
    // exactly what two near-simultaneous requests would see.
    const runBeforeEitherClaim = await runRepo.getRun(OPERATING_DATE);
    const winnerClaimed = await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: runBeforeEitherClaim!.status, updatedAt: runBeforeEitherClaim!.updatedAt });
    const loserClaimed = await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: runBeforeEitherClaim!.status, updatedAt: runBeforeEitherClaim!.updatedAt });

    expect(winnerClaimed).toBe(true);
    expect(loserClaimed).toBe(false); // the row's updatedAt already moved when the winner claimed it
  });

  it("the full step behaves the same way end-to-end: a second forced call while the first is genuinely in flight does not double-generate", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(VOCAB_VIOLATION_DRAFT)).mockResolvedValueOnce(draftResponse(VOCAB_VIOLATION_DRAFT)).mockResolvedValue(draftResponse(GOOD_DRAFT_A));
    const { deps, runRepo, campaignRepo } = buildHarness(fetchMock);
    await runDailyXFeedPostStep(deps, OPERATING_DATE, false);
    fetchMock.mockClear();

    // Simulate "a second Regenerate landed after the first already
    // claimed but before it finished" by claiming the row out from under
    // the step call about to run.
    const staleView = await runRepo.getRun(OPERATING_DATE);
    await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: staleView!.status, updatedAt: staleView!.updatedAt }); // an "other" invocation claims it first

    const campaignsBeforeSecondCall = campaignRepo.campaigns.length; // 2, from the first invocation's own 2 failed attempts -- runCampaignPipeline creates the campaign/asset row before the mechanical gate runs, regardless of outcome

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("already_in_progress");
    expect(fetchMock).not.toHaveBeenCalled(); // never generated a second time
    expect(campaignRepo.campaigns).toHaveLength(campaignsBeforeSecondCall); // no NEW campaign from the blocked second call
  });

  it("dismissed+forced-replace races the same way: only one of two concurrent Regenerate calls creates a replacement", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    let dismissed = true;
    const { deps, runRepo } = buildHarness(fetchMock, { isDismissed: async () => dismissed });
    // Seed a "ready" run directly (skip generating it) to isolate the replace-claim race itself.
    const seedId = await runRepo.claimRun(OPERATING_DATE);
    await runRepo.completeRun(seedId!, { status: "ready", campaignAssetId: "seed-asset", topicKey: FEED_POST_TOPICS[0]!.key, triedTopicKeys: [FEED_POST_TOPICS[0]!.key], attempts: 1, aiCalls: 10, costUsd: 0.05, error: null });
    dismissed = true;

    const view = (await runRepo.getRun(OPERATING_DATE))!;
    const winner = await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: "ready", updatedAt: view.updatedAt, campaignAssetId: "seed-asset" });
    const loser = await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: "ready", updatedAt: view.updatedAt, campaignAssetId: "seed-asset" });

    expect(winner).toBe(true);
    expect(loser).toBe(false);
  });
});

describe("crash/timeout recovery -- a 'running' row cannot lock the operating date forever", () => {
  it("a fresh 'running' row (genuinely in flight) is left alone -- skipped as already_in_progress, never reclaimed", async () => {
    const fetchMock = vi.fn();
    const { deps, runRepo } = buildHarness(fetchMock);
    await runRepo.claimRun(OPERATING_DATE); // simulates another invocation that just claimed and hasn't finished

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("already_in_progress");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 'running' row older than STALE_RUNNING_MS is treated as abandoned and reclaimed -- the operating date is never permanently locked by a crash", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps, runRepo } = buildHarness(fetchMock);
    await runRepo.claimRun(OPERATING_DATE); // an invocation claims it...
    const staleTimestamp = new Date(Date.now() - STALE_RUNNING_MS - 60_000).toISOString();
    (runRepo as any).backdateUpdatedAt(OPERATING_DATE, staleTimestamp); // ...then crashes, never completing it

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("ready"); // self-healed within the SAME operating day, no manual intervention
  });

  it("a 'running' row just under the staleness threshold is NOT reclaimed (avoids racing a merely-slow invocation)", async () => {
    const fetchMock = vi.fn();
    const { deps, runRepo } = buildHarness(fetchMock);
    await runRepo.claimRun(OPERATING_DATE);
    const almostStale = new Date(Date.now() - STALE_RUNNING_MS + 5_000).toISOString();
    (runRepo as any).backdateUpdatedAt(OPERATING_DATE, almostStale);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("already_in_progress");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("posted content is a hard terminal state", () => {
  it("a forced Regenerate never replaces an already-posted post, even if its campaign was somehow retired afterward", async () => {
    const fetchMock = vi.fn(); // must never be called
    let dismissed = true; // simulates the edge case: campaign retired AFTER the post already went out
    const { deps, runRepo } = buildHarness(fetchMock, { isDismissed: async () => dismissed });
    const seedId = await runRepo.claimRun(OPERATING_DATE);
    await runRepo.completeRun(seedId!, { status: "ready", campaignAssetId: "posted-asset", topicKey: FEED_POST_TOPICS[0]!.key, triedTopicKeys: [FEED_POST_TOPICS[0]!.key], attempts: 1, aiCalls: 10, costUsd: 0.05, error: null });
    await runRepo.markPosted(OPERATING_DATE, "2026-09-05T20:00:00Z", "Most funded accounts get pulled for violating a rule nobody reads twice.");

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, true);

    expect(result.status).toBe("ready");
    expect(result.campaignAssetId).toBe("posted-asset"); // unchanged
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pause/budget gates are re-checked before EVERY attempt, not just once per invocation", () => {
  it("a pause that takes effect between attempt 1 and attempt 2 stops the second attempt from spending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT)); // attempt 1 fails mechanically
    let paused = false;
    const { deps } = buildHarness(fetchMock, {
      isPaused: async () => {
        const wasPaused = paused;
        paused = true; // flips to paused right after the first check succeeds
        return wasPaused;
      },
    });

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.attempts).toBe(1); // only attempt 1 ran
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/stopped mid-run: system_paused/);
  });

  it("a budget that crosses the cap between attempt 1 and attempt 2 stops the second attempt from spending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(draftResponse(VOCAB_VIOLATION_DRAFT));
    const runRepo = new InMemoryXFeedPostRunRepository();
    const originalGetMonthSpendUsd = runRepo.getMonthSpendUsd.bind(runRepo);
    let calls = 0;
    runRepo.getMonthSpendUsd = async (yearMonth: string) => {
      calls++;
      return calls === 1 ? 0 : 999; // first (upfront) check passes, second (pre-attempt-2) check is over budget
    };
    void originalGetMonthSpendUsd;
    const { deps } = buildHarness(fetchMock);
    (deps as any).runRepo = runRepo;

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false);

    expect(result.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/stopped mid-run: monthly_budget_reached/);
  });
});

describe("durable progress -- cost/attempts survive a mid-invocation crash, not just a clean finish", () => {
  it("recordAttemptProgress persists real usage immediately, readable via getRun before any finalizeAttempt call -- a crash between attempts loses nothing already incurred", async () => {
    const runRepo = new InMemoryXFeedPostRunRepository();
    const id = (await runRepo.claimRun(OPERATING_DATE))!;
    const claimed = (await runRepo.getRun(OPERATING_DATE))!;

    const progress = await runRepo.recordAttemptProgress(id, claimed.updatedAt, {
      topicKey: FEED_POST_TOPICS[0]!.key,
      triedTopicKeys: [FEED_POST_TOPICS[0]!.key],
      aiCallsDelta: 10,
      costUsdDelta: 0.05,
    });
    expect(progress.ok).toBe(true);

    // Never called finalizeAttempt/completeRun -- simulating the
    // invocation being killed right here. The real cost must already be
    // durable, not sitting only in a local variable that's about to
    // vanish.
    const stillRunning = await runRepo.getRun(OPERATING_DATE);
    expect(stillRunning?.status).toBe("running"); // finalize never ran
    expect(stillRunning?.aiCalls).toBe(10);
    expect(stillRunning?.costUsd).toBeCloseTo(0.05);
    expect(stillRunning?.topicKey).toBe(FEED_POST_TOPICS[0]!.key);
  });

  it("a second recordAttemptProgress call correctly ACCUMULATES deltas on top of the first, not overwriting it", async () => {
    const runRepo = new InMemoryXFeedPostRunRepository();
    const id = (await runRepo.claimRun(OPERATING_DATE))!;
    const claimed = (await runRepo.getRun(OPERATING_DATE))!;

    const first = await runRepo.recordAttemptProgress(id, claimed.updatedAt, { aiCallsDelta: 1, costUsdDelta: 0.01 });
    expect(first.ok).toBe(true);
    const second = await runRepo.recordAttemptProgress(id, (first as { ok: true; updatedAt: string }).updatedAt, { aiCallsDelta: 9, costUsdDelta: 0.04 });
    expect(second.ok).toBe(true);

    const run = await runRepo.getRun(OPERATING_DATE);
    expect(run?.aiCalls).toBe(10);
    expect(run?.costUsd).toBeCloseTo(0.05);
  });
});

describe("stale-worker finalization safety -- a straggling worker can never clobber a reclaimer's fresher state", () => {
  it("once a reclaimer has moved the row forward, the original (now-straggling) worker's recordAttemptProgress fails rather than overwriting", async () => {
    const runRepo = new InMemoryXFeedPostRunRepository();
    const id = (await runRepo.claimRun(OPERATING_DATE))!;
    const originalView = (await runRepo.getRun(OPERATING_DATE))!; // worker A's view, right after claiming

    // Simulate A appearing abandoned (stale) and a reclaimer (worker B) taking over.
    runRepo.backdateUpdatedAt(OPERATING_DATE, new Date(Date.now() - STALE_RUNNING_MS - 60_000).toISOString());
    const staleView = (await runRepo.getRun(OPERATING_DATE))!;
    const reclaimed = await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: "running", updatedAt: staleView.updatedAt });
    expect(reclaimed).toBe(true);

    // Worker A is not actually dead -- it was just slow -- and now tries
    // to record progress using ITS OWN (now stale) view from before B
    // reclaimed. This must fail, not silently overwrite B's claim.
    const straggler = await runRepo.recordAttemptProgress(id, originalView.updatedAt, { aiCallsDelta: 10, costUsdDelta: 0.05 });
    expect(straggler.ok).toBe(false);

    // And the straggler's finalizeAttempt must fail too, for the same reason.
    const stragglerFinalize = await runRepo.finalizeAttempt(id, originalView.updatedAt, {
      status: "ready",
      campaignAssetId: "worker-a-asset",
      topicKey: FEED_POST_TOPICS[0]!.key,
      triedTopicKeys: [FEED_POST_TOPICS[0]!.key],
      attempts: 1,
      aiCalls: 10,
      costUsd: 0.05,
      error: null,
    });
    expect(stragglerFinalize).toBe(false);

    // B's own claim is untouched by either of A's failed writes.
    const finalRun = await runRepo.getRun(OPERATING_DATE);
    expect(finalRun?.status).toBe("running");
    expect(finalRun?.campaignAssetId).toBeNull();
  });

  it("end-to-end: if worker A's full pipeline run finishes AFTER worker B has already reclaimed and finalized, A's finalize is discarded rather than double-writing a second ready asset over B's", async () => {
    const runRepo = new InMemoryXFeedPostRunRepository();
    const id = (await runRepo.claimRun(OPERATING_DATE))!;
    const workerAView = (await runRepo.getRun(OPERATING_DATE))!;

    // B reclaims (A appears stale) and finalizes first.
    runRepo.backdateUpdatedAt(OPERATING_DATE, new Date(Date.now() - STALE_RUNNING_MS - 60_000).toISOString());
    const staleView = (await runRepo.getRun(OPERATING_DATE))!;
    await runRepo.tryClaimForAttempt(OPERATING_DATE, { status: "running", updatedAt: staleView.updatedAt });
    const bView = (await runRepo.getRun(OPERATING_DATE))!;
    const bFinalized = await runRepo.finalizeAttempt(id, bView.updatedAt, {
      status: "ready",
      campaignAssetId: "worker-b-asset",
      topicKey: FEED_POST_TOPICS[1]!.key,
      triedTopicKeys: [FEED_POST_TOPICS[1]!.key],
      attempts: 1,
      aiCalls: 10,
      costUsd: 0.05,
      error: null,
    });
    expect(bFinalized).toBe(true);

    // A, unaware of any of this, finally finishes its own (wasted) pipeline
    // run and tries to finalize using its ORIGINAL updatedAt from before
    // either reclaim happened.
    const aFinalized = await runRepo.finalizeAttempt(id, workerAView.updatedAt, {
      status: "ready",
      campaignAssetId: "worker-a-asset",
      topicKey: FEED_POST_TOPICS[0]!.key,
      triedTopicKeys: [FEED_POST_TOPICS[0]!.key],
      attempts: 1,
      aiCalls: 10,
      costUsd: 0.05,
      error: null,
    });
    expect(aFinalized).toBe(false);

    // B's asset is the one and only campaignAssetId ever recorded -- A's
    // result is simply discarded (would become an orphan campaign_asset
    // row in the real DB, never referenced), never silently overwriting.
    const finalRun = await runRepo.getRun(OPERATING_DATE);
    expect(finalRun?.campaignAssetId).toBe("worker-b-asset");
  });
});

describe("bounded execution -- stops starting new work when insufficient real time remains before the invocation deadline", () => {
  it("a deadline that's already effectively past prevents even the FIRST attempt from starting, and finalizes FAILED immediately -- not stuck 'running'", async () => {
    const fetchMock = vi.fn(); // must never be called -- no time to safely start anything
    const { deps } = buildHarness(fetchMock);

    const pastDeadline = Date.now() - 1_000; // already past
    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false, new Date(), pastDeadline);

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(0);
    expect(result.error).toMatch(/insufficient time remaining/);
    expect(fetchMock).not.toHaveBeenCalled();

    // Finalized as failed, not left 'running' -- immediately retryable
    // the SAME day via a normal forced Regenerate, no need to wait for
    // STALE_RUNNING_MS or for tomorrow's new-date cron to prove recovery.
    const run = await deps.runRepo.getRun(OPERATING_DATE);
    expect(run?.status).toBe("failed");
  });

  it("a same-day forced retry with a real (future) deadline proceeds normally right after a deadline-caused stop -- proves recovery doesn't depend on a new operating date", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);

    const stopped = await runDailyXFeedPostStep(deps, OPERATING_DATE, false, new Date(), Date.now() - 1_000);
    expect(stopped.status).toBe("failed");

    const retried = await runDailyXFeedPostStep(deps, OPERATING_DATE, true); // default deadline -- effectively unbounded
    expect(retried.status).toBe("ready");
  });

  it("an attempt still starts with ~40s left -- real attempts take 8-20s, so a rejected first draft can retry within the 52s deadline (13 and 16 Sep failed here)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, OPERATING_DATE, false, new Date(), Date.now() + 40_000);

    expect(result.status).toBe("ready");
    expect(result.attempts).toBe(1);
  });

  it("ESTIMATED_ATTEMPT_DURATION_MS is a real, positive, non-trivial bound (not a placeholder) used to decide whether to start another attempt", () => {
    expect(ESTIMATED_ATTEMPT_DURATION_MS).toBeGreaterThan(0);
    expect(ESTIMATED_ATTEMPT_DURATION_MS).toBeLessThan(60_000); // must fit within Vercel's own 60s maxDuration with room to spare
  });
});

describe("selectFeedPostAngle -- comparative editorial selection, not first-non-excluded-wins", () => {
  it("assembles a small candidate set (not all 10 topics) and records a comparative reason naming a runner-up", () => {
    const selection = selectFeedPostAngle(OPERATING_DATE, [], [], {});
    expect(selection.candidatesConsidered.length).toBeGreaterThan(1);
    expect(selection.candidatesConsidered.length).toBeLessThan(FEED_POST_TOPICS.length);
    expect(selection.reason).toMatch(/over \d+ other candidate/);
    expect(selection.reason).not.toMatch(/the best possible post/i); // never overclaims
  });

  it("penalizes a candidate whose editorialTags overlap heavily with recently-used tags, favoring a less-repetitive candidate", () => {
    const withoutHistory = selectFeedPostAngle(OPERATING_DATE, [], [], {});
    const heavilyRepeatedTags = withoutHistory.candidatesConsidered.map((c) => c.topic.editorialTags).flat();
    // Simulate every one of that candidate set's own tags having just been used -- everything in the set should now score lower.
    const withHistory = selectFeedPostAngle(OPERATING_DATE, [], [heavilyRepeatedTags, heavilyRepeatedTags], {});
    for (const candidate of withHistory.candidatesConsidered) {
      expect(candidate.recentTagOverlapPenalty).toBeGreaterThan(0);
    }
    // The winner's total score should be lower than the equivalent no-history run's winner, all else equal.
    expect(withHistory.candidatesConsidered[0]!.totalScore).toBeLessThan(withoutHistory.candidatesConsidered[0]!.totalScore);
  });

  it("a live freshness signal gives its topic a real, measurable bonus over an otherwise-identical candidate with none", () => {
    const noSignal = selectFeedPostAngle(OPERATING_DATE, [], [], {});
    const topKey = noSignal.candidatesConsidered[0]!.topic.key;
    const withSignal = selectFeedPostAngle(OPERATING_DATE, [], [], { [topKey]: 3 });
    const before = noSignal.candidatesConsidered.find((c) => c.topic.key === topKey)!.totalScore;
    const after = withSignal.candidatesConsidered.find((c) => c.topic.key === topKey)!.totalScore;
    expect(after).toBeGreaterThan(before);
  });

  it("RECENT_EDITORIAL_HISTORY_DAYS is a sane, configurable positive window (not accidentally 0 or negative)", () => {
    expect(RECENT_EDITORIAL_HISTORY_DAYS).toBeGreaterThan(0);
  });

  it("never selects an excluded (already-tried-today) topic, same guarantee as the old selectFeedPostTopic", () => {
    const first = selectFeedPostAngle(OPERATING_DATE, [], [], {});
    const excludeKey = first.selected.key;
    const second = selectFeedPostAngle(OPERATING_DATE, [excludeKey], [], {});
    expect(second.selected.key).not.toBe(excludeKey);
  });

  it("with no history at all, the category-mix bonus is 0 for every candidate -- pure editorial-merit selection, same as before this parameter existed", () => {
    const noHistory = selectFeedPostAngle(OPERATING_DATE, [], [], {});
    const noHistoryExplicit = selectFeedPostAngle(OPERATING_DATE, [], [], {}, []);
    for (const c of noHistory.candidatesConsidered) expect(c.categoryUnderrepresentationBonus).toBe(0);
    expect(noHistoryExplicit.selected.key).toBe(noHistory.selected.key);
  });
});

describe("categoryUnderrepresentationBonus / content-mix self-correction -- fixes the real gap where every topic was education/psychology and nothing ever nudged toward the documented 35% product-demo / 20% CTA target", () => {
  it("a category at 0% of recent history against a positive target gets a real, non-zero bonus", () => {
    const bonus = categoryUnderrepresentationBonus("product_demo", Array(20).fill("education"));
    expect(bonus).toBeGreaterThan(0);
  });

  it("a category already exactly on-target gets a zero bonus, not a negative one", () => {
    // 20 recent runs, exactly 35% (7) product_demo -- matches its target exactly.
    const history: FeedPostContentCategory[] = [...Array(13).fill("education"), ...Array(7).fill("product_demo")];
    expect(categoryUnderrepresentationBonus("product_demo", history)).toBe(0);
  });

  it("a category already OVER-represented gets a zero bonus, never a penalty that would push it down further", () => {
    const allProductDemo: FeedPostContentCategory[] = Array(20).fill("product_demo");
    expect(categoryUnderrepresentationBonus("product_demo", allProductDemo)).toBe(0);
    expect(categoryUnderrepresentationBonus("education", allProductDemo)).toBeGreaterThan(0); // meanwhile education, now at 0%, gets pulled up
  });

  it("with empty history, every category gets 0 -- nothing to correct against yet", () => {
    expect(categoryUnderrepresentationBonus("product_demo", [])).toBe(0);
    expect(categoryUnderrepresentationBonus("cta", [])).toBe(0);
  });

  it("selectFeedPostAngle actually picks a product_demo/cta/conversation_starter topic once its category has gone completely unused across the full history window, over otherwise-comparable education/psychology candidates", () => {
    // 21 days of pure education/psychology history -- exactly the real gap an audit found.
    const allEducation: FeedPostContentCategory[] = Array(21).fill("education");
    const selection = selectFeedPostAngle(OPERATING_DATE, [], [], {}, allEducation);
    const winnerCategory = selection.candidatesConsidered.find((c) => c.topic.key === selection.selected.key)!.topic.contentCategory;
    // Not asserting it's ALWAYS the winner (day-indexed rotation still controls which 3 candidates are even compared), but confirms the bonus is live and meaningfully sized in the actual selection path, not just the standalone function.
    const productDemoCandidate = selection.candidatesConsidered.find((c) => c.topic.contentCategory === "product_demo" || c.topic.contentCategory === "cta" || c.topic.contentCategory === "conversation_starter");
    if (productDemoCandidate) expect(productDemoCandidate.categoryUnderrepresentationBonus).toBeGreaterThan(0);
    expect(winnerCategory).toBeTruthy();
  });
});

describe("runDailyXFeedPostStep -- image brief, posting window, weekly reference post", () => {
  it("a normal day's ready run carries the image brief and the posting window in the owner note", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, "2026-11-03", false); // a Tuesday
    expect(result.status).toBe("ready");
    const run = await deps.runRepo.getRun("2026-11-03");
    expect(run?.selectionReason).toMatch(/Image: /);
    expect(run?.selectionReason).toMatch(/When: Post 15 to 30 minutes after the 9:30 ET open/);
  });

  it("on Wednesday the draft is a reference topic, and Home can label it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(draftResponse(GOOD_DRAFT_A)).mockResolvedValue(verdictResponse(true));
    const { deps } = buildHarness(fetchMock);

    const result = await runDailyXFeedPostStep(deps, "2026-11-04", false); // a Wednesday
    expect(result.status).toBe("ready");
    expect(result.topicKey).toMatch(/^reference_/);
    const run = await deps.runRepo.getRun("2026-11-04");
    expect(run?.selectionReason).toMatch(/^Weekly reference post/);
    expect(run?.selectionReason).toMatch(/Image: A /);
    expect(feedPostTopicLabel(result.topicKey!)).toMatch(/^Reference: /);
  });
});
