import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/approvals";
import { recoveryFromVisibility, type RecoveryState } from "../src/prospecting/prospectingRecovery";
import type { ProspectingDraftContext, ProspectingDraftResult } from "../src/prospecting/prospectingReplyWriter";
import {
  OWNER_OVERRIDE_DRAFT_NOTE,
  ProspectingConflictError,
  draftProspectingCandidateReply,
  draftScreenedOutPost,
  listProspectingQueue,
  markProspectingReplied,
} from "../src/prospecting/prospectingHandlers";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

const NOW = new Date("2026-10-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

class Repo implements ProspectingRepository {
  rows = new Map<string, ProspectingCandidate>();
  seed(c: ProspectingCandidate) {
    this.rows.set(c.id, c);
  }
  async upsertIfNew(_c: NewProspectingCandidate) {
    return { id: "x", created: true };
  }
  async listByStatus(statuses: ProspectingStatus[]) {
    return [...this.rows.values()].filter((r) => statuses.includes(r.status));
  }
  async listRepliedSince(since: Date) {
    return [...this.rows.values()].filter((r) => r.status === "replied" && r.repliedAt && new Date(r.repliedAt) >= since);
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async markShown(ids: string[]) {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r) this.rows.set(id, { ...r, status: "shown" });
    }
  }
  async updateStatus(id: string, status: ProspectingStatus, fields: Record<string, any> = {}) {
    const r = this.rows.get(id);
    if (!r) return;
    const { breakdownPatch, ...rest } = fields;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    this.rows.set(id, { ...r, ...defined, ...(breakdownPatch ? { scoreBreakdown: { ...r.scoreBreakdown, ...breakdownPatch } } : {}), status });
  }
  async hasPriorOutreach() {
    return false;
  }
  async recordOutreach() {}
  async expireStale() {
    return 0;
  }
  async listScreenedOut(since: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.status === "not_relevant" && r.skipReason === "screened_out_at_discovery" && new Date(r.updatedAt) >= since)
      .slice(0, limit);
  }
}

function maybeRow(over: Partial<ProspectingCandidate> = {}): ProspectingCandidate {
  return {
    id: "m1",
    platform: "x",
    externalId: "1",
    discoveryQuery: "trailing_drawdown",
    authorHandle: "someTrader",
    authorExternalId: "a1",
    authorName: null,
    authorFollowerCount: 500,
    authorVerified: false,
    // Deliberately fails the free regex pre-filter, to prove the override skips it.
    postText: "rough day, markets are wild lately",
    postUrl: "https://x.com/i/web/status/1",
    postCreatedAt: hoursAgo(60),
    publicMetrics: {},
    opportunityScore: 10,
    scoreBreakdown: {},
    creatorCandidate: false,
    status: "not_relevant",
    shownAt: null,
    openedAt: null,
    draftReply: null,
    finalReply: null,
    replyMentionsFillbook: null,
    replyUsedLink: null,
    repliedAt: null,
    skipReason: "screened_out_at_discovery",
    discoveredAt: hoursAgo(61),
    createdAt: hoursAgo(61),
    updatedAt: hoursAgo(5),
    ...over,
  };
}

const SHARP = "Wild days punish oversized positions first, so I cut size before anything else.";
const HELPFUL = "Volatile sessions widen your stops in dollars. Check the daily loss limit before you take the next trade.";
const good = (over: Partial<ProspectingDraftResult> = {}): ProspectingDraftResult => ({ isRelevant: true, reply: SHARP, helpfulReply: HELPFUL, mentionsFillbook: false, usesLink: false, showcase: "none", ...over });

const off = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });
const baseDeps = (repo: Repo, drafter: any, extra: Record<string, unknown> = {}) => ({
  repo,
  drafter,
  loadGrounding: async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" }),
  cheapRelevanceCheck: vi.fn(async () => false), // would reject, must never be consulted
  loadStyleExamples: async () => [],
  loadRecovery: off,
  ...extra,
});
const client = {} as any;

describe("draftScreenedOutPost -- owner override", () => {
  it("accepts a 7-day model-screen rejection, skips both model relevance gates, and makes a normal ready card", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    const drafter = vi.fn(async (_c: ProspectingDraftContext) => good({ isRelevant: false }));
    const deps = baseDeps(repo, drafter);
    const updated = await draftScreenedOutPost(client, "m1", deps, NOW);
    expect(deps.cheapRelevanceCheck).not.toHaveBeenCalled();
    expect(drafter).toHaveBeenCalledTimes(1);
    expect(drafter.mock.calls[0]![0].ownerOverrideNote).toBe(OWNER_OVERRIDE_DRAFT_NOTE);
    expect(updated.status).toBe("ready");
    expect(updated.draftOptions?.map((o) => o.style)).toEqual(["sharp", "helpful"]);
    expect(updated.draftReply).toBe(SHARP);
    expect(updated.scoreBreakdown.owner_override).toBe("true");
    expect(updated.scoreBreakdown.owner_override_at).toBeTruthy();
  });

  it("refuses rows that are not recent model-screen rejections, before any model call", async () => {
    const repo = new Repo();
    repo.seed(maybeRow({ id: "old", updatedAt: hoursAgo(24 * 8) }));
    repo.seed(maybeRow({ id: "manual", skipReason: null }));
    repo.seed(maybeRow({ id: "shown", status: "shown" }));
    repo.seed(maybeRow({ id: "replied", status: "replied" }));
    const drafter = vi.fn(async () => good());
    for (const id of ["old", "manual", "shown", "replied"]) {
      await expect(draftScreenedOutPost(client, id, baseDeps(repo, drafter), NOW)).rejects.toBeInstanceOf(ProspectingConflictError);
    }
    expect(drafter).not.toHaveBeenCalled();
  });

  it("a double tap after success returns the same card without drafting again", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    const drafter = vi.fn(async () => good());
    await draftScreenedOutPost(client, "m1", baseDeps(repo, drafter), NOW);
    const again = await draftScreenedOutPost(client, "m1", baseDeps(repo, drafter), NOW);
    expect(again.status).toBe("ready");
    expect(drafter).toHaveBeenCalledTimes(1);
  });

  it("still regenerates a draft that breaks a hard guardrail", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    const drafter = vi.fn(async (_c: ProspectingDraftContext) => (drafter.mock.calls.length === 1 ? good({ reply: "word ".repeat(70) }) : good()));
    const updated = await draftScreenedOutPost(client, "m1", baseDeps(repo, drafter), NOW);
    expect(drafter).toHaveBeenCalledTimes(2);
    expect(drafter.mock.calls[1]![0].retryFeedback).toMatch(/too long/);
    expect(updated.draftReply).toBe(SHARP);
  });

  it("still drops an option that names Fillbook in a cold reply (it is never shown)", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    const drafter = vi.fn(async () => good({ helpfulReply: "Fillbook shows your daily loss room in dollars for each account." }));
    const updated = await draftScreenedOutPost(client, "m1", baseDeps(repo, drafter), NOW);
    expect(drafter).toHaveBeenCalledTimes(3);
    expect(updated.draftOptions?.map((o) => o.style)).toEqual(["sharp"]);
    expect(JSON.stringify(updated.draftOptions)).not.toMatch(/Fillbook/);
  });

  it("a failed draft leaves the row untouched and still in the Maybe list", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    const drafter = vi.fn(async () => {
      throw new Error("skipped -- daily LLM budget reached");
    });
    await expect(draftScreenedOutPost(client, "m1", baseDeps(repo, drafter), NOW)).rejects.toThrow(/budget/);
    const row = await repo.getById("m1");
    expect(row!.status).toBe("not_relevant");
    expect(row!.draftReply).toBeNull();
    expect(row!.scoreBreakdown.owner_override).toBeUndefined();
    const q = await listProspectingQueue(client, NOW, { repo, loadRecovery: off });
    expect(q.maybe.map((m) => m.id)).toEqual(["m1"]);
    expect(q.candidates).toEqual([]);
  });

  it("recovery mode does not block drafting but the recovery note still reaches the drafter and Fillbook stays out", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    const on = async () => recoveryFromVisibility({ status: "dropped", recentMedian: 2.5, recentCount: 30, baselineMedian: 7, baselineCount: 20 });
    const drafter = vi.fn(async (_c: ProspectingDraftContext) => good());
    await draftScreenedOutPost(client, "m1", baseDeps(repo, drafter, { loadRecovery: on }), NOW);
    expect(drafter.mock.calls[0]![0].recoveryNote).toMatch(/RECOVERY MODE IS ON/);
    expect(drafter.mock.calls[0]![0].fillbookOption).toBe(false);
  });

  it("the next queue shows the card (past 12h, under the score floor, failing the regex) and the Maybe list drops it", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    await draftScreenedOutPost(client, "m1", baseDeps(repo, vi.fn(async () => good())), new Date());
    const soon = new Date(Date.now() + 3600_000);
    const q = await listProspectingQueue(client, soon, { repo, loadRecovery: off });
    expect(q.candidates.map((c) => c.id)).toEqual(["m1"]);
    expect(q.maybe).toEqual([]);
    expect(q.diagnostics.selected).toBe(1);
    // 25 hours later the window has closed and the normal gates apply again.
    const later = new Date(Date.now() + 25 * 3600_000);
    const q2 = await listProspectingQueue(client, later, { repo, loadRecovery: off });
    expect(q2.candidates).toEqual([]);
  });

  it("the normal draft path still refuses a closed-out card", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    await expect(draftProspectingCandidateReply(client, "m1", baseDeps(repo, vi.fn()))).rejects.toThrow(/already not relevant/);
  });

  it("replying to an overridden card uses the normal path and keeps its pacing record", async () => {
    const repo = new Repo();
    repo.seed(maybeRow());
    await draftScreenedOutPost(client, "m1", baseDeps(repo, vi.fn(async () => good())), NOW);
    const replied = await markProspectingReplied(client, "m1", undefined, undefined, undefined, { repo });
    expect(replied.status).toBe("replied");
    expect(replied.postedStyle).toBe("sharp");
    const q = await listProspectingQueue(client, new Date(Date.now() + 60_000), { repo, loadRecovery: off });
    expect(q.pacing.repliedLast24h).toBe(1);
  });
});

describe("draft-maybe auth", () => {
  const APP = "app-token-0123456789-abcdefghijklmnop";
  const AUTOMATION = "automation-token-0123456789-abcdefghijklmnop";
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.APP_API_TOKEN = APP;
    process.env.APP_API_TOKEN_AUTOMATION = AUTOMATION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  it("refuses the automation token", async () => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    await handler({ method: "POST", query: { resource: "prospecting" }, headers: { authorization: `Bearer ${AUTOMATION}` }, body: { action: "draft-maybe", id: "m1" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
