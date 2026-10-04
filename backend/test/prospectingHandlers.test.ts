import { describe, it, expect, vi } from "vitest";
import { recoveryFromVisibility, type RecoveryState } from "../src/prospecting/prospectingRecovery";
import { computeMentionBudget } from "../src/prospecting/prospectingMentionBudget";
import {
  draftProspectingCandidateReply,
  listProspectingQueue,
  markProspectingReplied,
  ProspectingActionError,
} from "../src/prospecting/prospectingHandlers";
import { PROSPECTING_TRACKABLE_LINK, type ProspectingDraftContext } from "../src/prospecting/prospectingReplyWriter";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

/** Minimal in-memory ProspectingRepository -- enough to drive the handlers without Supabase, and records every outreach call verbatim. */
class InMemoryProspectingRepository implements ProspectingRepository {
  rows = new Map<string, ProspectingCandidate>();
  outreach: Array<{ platform: string; authorExternalId: string; authorHandle: string | null }> = [];

  seed(candidate: ProspectingCandidate) {
    this.rows.set(candidate.id, candidate);
  }

  async upsertIfNew(candidate: NewProspectingCandidate): Promise<{ id: string; created: boolean }> {
    const id = `${candidate.platform}-${candidate.externalId}`;
    const created = !this.rows.has(id);
    if (created) this.rows.set(id, { ...candidate, id, status: "new", shownAt: null, openedAt: null, draftReply: null, finalReply: null, replyMentionsFillbook: null, replyUsedLink: null, repliedAt: null, skipReason: null, createdAt: "", updatedAt: "" });
    return { id, created };
  }

  async listByStatus(statuses: ProspectingStatus[]): Promise<ProspectingCandidate[]> {
    return [...this.rows.values()].filter((r) => statuses.includes(r.status));
  }

  async listRepliedSince(since: Date): Promise<ProspectingCandidate[]> {
    return [...this.rows.values()].filter((r) => r.status === "replied" && r.repliedAt !== null && new Date(r.repliedAt) >= since);
  }

  async getById(id: string): Promise<ProspectingCandidate | null> {
    return this.rows.get(id) ?? null;
  }

  async markShown(ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) this.rows.set(id, { ...row, status: "shown" });
    }
  }

  async updateStatus(id: string, status: ProspectingStatus, fields: Partial<ProspectingCandidate> = {}): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    this.rows.set(id, { ...row, ...defined, status });
  }

  async hasPriorOutreach(platform: string, authorExternalId: string): Promise<boolean> {
    return this.outreach.some((o) => o.platform === platform && o.authorExternalId === authorExternalId);
  }

  async recordOutreach(platform: string, authorExternalId: string, authorHandle: string | null): Promise<void> {
    this.outreach.push({ platform, authorExternalId, authorHandle });
  }

  async expireStale(): Promise<number> {
    return 0;
  }
}

function candidate(overrides: Partial<ProspectingCandidate>): ProspectingCandidate {
  return {
    id: "cand-1",
    platform: "x",
    externalId: "123",
    discoveryQuery: "trailing_drawdown",
    authorHandle: "someTrader",
    authorExternalId: "author-123",
    authorName: "Some Trader",
    authorFollowerCount: 100,
    authorVerified: false,
    postText: "does trailing drawdown reset daily?",
    postUrl: "https://x.com/i/web/status/123",
    postCreatedAt: null,
    publicMetrics: {},
    opportunityScore: 70,
    scoreBreakdown: {},
    creatorCandidate: false,
    status: "ready",
    shownAt: null,
    openedAt: null,
    draftReply: "Most firms reset EOD.",
    finalReply: null,
    replyMentionsFillbook: false,
    replyUsedLink: false,
    repliedAt: null,
    skipReason: null,
    discoveredAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

const fakeClient = {} as any;

/**
 * Regression coverage for the 2026-09-07 freshness/audience-quality
 * review's diagnostics addition: before this existed, an empty or small
 * daily set from listProspectingQueue was ambiguous -- "genuinely nothing
 * found" and "plenty of backlog, all of it too old/too weak today" looked
 * identical from the API response alone. These prove the counts are
 * real, additive, and actually distinguish those cases.
 */
describe("listProspectingQueue -- selection diagnostics", () => {
  const NOW = new Date("2026-09-07T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

  it("reports counts that are additive and distinguish selected / below-quality-bar / too-old", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "fresh-strong", status: "new", opportunityScore: 70, postCreatedAt: hoursAgo(1), authorExternalId: "a" }));
    repo.seed(candidate({ id: "weak", status: "new", opportunityScore: 10, postCreatedAt: hoursAgo(1), authorExternalId: "b" }));
    repo.seed(candidate({ id: "ancient", status: "new", opportunityScore: 90, postCreatedAt: hoursAgo(24 * 10), authorExternalId: "c" }));

    const { candidates, diagnostics } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(candidates.map((c) => c.id)).toEqual(["fresh-strong"]);
    expect(diagnostics).toEqual({ totalConsidered: 3, selected: 1, deferred: 0, belowQualityBar: 1, tooOldForToday: 1 });
  });

  it("never leaves an empty daily set ambiguous -- diagnostics show whether the backlog is genuinely clear or just mostly too old", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "stale-1", status: "shown", opportunityScore: 95, postCreatedAt: hoursAgo(24 * 6), authorExternalId: "a" }));
    repo.seed(candidate({ id: "stale-2", status: "shown", opportunityScore: 95, postCreatedAt: hoursAgo(24 * 8), authorExternalId: "b" }));

    const { candidates, diagnostics } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(candidates).toHaveLength(0);
    expect(diagnostics.totalConsidered).toBe(2);
    expect(diagnostics.tooOldForToday).toBe(2); // NOT a genuinely empty backlog -- both excluded for age specifically
    expect(diagnostics.belowQualityBar).toBe(0);
  });

  it("reports a genuinely empty backlog as zero everywhere, not conflated with an age or quality exclusion", async () => {
    const repo = new InMemoryProspectingRepository();
    const { candidates, diagnostics } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(candidates).toHaveLength(0);
    expect(diagnostics).toEqual({ totalConsidered: 0, selected: 0, deferred: 0, belowQualityBar: 0, tooOldForToday: 0 });
  });
});

/**
 * Regression coverage for a real, confirmed bug (2026-09-07): the owner's
 * phone showed crypto-only posts ("$USELESS locked in the profits...
 * a 15% move in less than 2h") as actionable Prospecting cards under the
 * "Overtrading volume" topic label. The mechanical relevance gate
 * (prospectingRelevance.ts) already correctly rejected this text -- the
 * bug was that nothing called it until the owner tapped Draft reply.
 * This closes it at the one place every non-terminal candidate passes
 * through before ever becoming visible: listProspectingQueue itself.
 */
describe("recovery mode (X limiting the account's replies, 2026-09-26)", () => {
  const NOW = new Date("2026-09-26T18:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();
  const on = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "dropped", recentMedian: 2.5, recentCount: 30, baselineMedian: 7, baselineCount: 20 });
  const off = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });

  it("switches on only when reply views have dropped", async () => {
    expect((await on()).active).toBe(true);
    expect((await off()).active).toBe(false);
    expect(recoveryFromVisibility({ status: "not_enough_data", recentMedian: null, recentCount: 0, baselineMedian: null, baselineCount: 0 }).active).toBe(false);
  });

  it("while on, the queue offers only posts under 4 hours old and the daily cap drops to 2", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "fresh", status: "new", opportunityScore: 70, postCreatedAt: hoursAgo(1), authorExternalId: "a" }));
    repo.seed(candidate({ id: "older", status: "new", opportunityScore: 90, postCreatedAt: hoursAgo(6), authorExternalId: "b" }));
    repo.seed(candidate({ id: "r1", status: "replied", repliedAt: hoursAgo(2), authorExternalId: "c" }));
    repo.seed(candidate({ id: "r2", status: "replied", repliedAt: hoursAgo(5), authorExternalId: "d" }));

    const result = await listProspectingQueue(fakeClient, NOW, { repo, loadRecovery: on });

    expect(result.candidates.map((c) => c.id)).toEqual(["fresh"]);
    expect(result.recovery.active).toBe(true);
    expect(result.pacing).toMatchObject({ dailyCap: 2, repliedLast24h: 2, reason: "daily_cap" });
  });

  it("while off, the normal 12h window and cap of 10 apply", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "fresh", status: "new", opportunityScore: 70, postCreatedAt: hoursAgo(1), authorExternalId: "a" }));
    repo.seed(candidate({ id: "older", status: "new", opportunityScore: 90, postCreatedAt: hoursAgo(6), authorExternalId: "b" }));

    const result = await listProspectingQueue(fakeClient, NOW, { repo, loadRecovery: off });

    expect(result.candidates.map((c) => c.id).sort()).toEqual(["fresh", "older"]);
    expect(result.pacing.dailyCap).toBe(10);
  });

  it("while on, a draft that names Fillbook is rejected and redrafted with the recovery note", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-rec", platform: "x", status: "shown", draftReply: null, postText: "Moved my stop again and blew the eval. Futures trading is brutal." }));
    const named = { isRelevant: true, reply: "Fillbook's trade log shows every moved stop next to your plan.", mentionsFillbook: true, usesLink: false, showcase: "size_vs_plan" };
    const plain = { isRelevant: true, reply: "The stop you moved is the one that decides the eval. Write the invalidation price down before entry.", mentionsFillbook: false, usesLink: false, showcase: "none" };
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => (drafter.mock.calls.length === 1 ? named : plain));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-rec", {
      repo,
      drafter,
      loadGrounding: async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" }),
      cheapRelevanceCheck: async () => true,
      loadStyleExamples: async () => [],
      loadRecovery: on,
    });

    expect(drafter.mock.calls[0]![0].recoveryNote).toMatch(/RECOVERY MODE IS ON/);
    expect(drafter.mock.calls[1]![0].retryFeedback).toMatch(/recovery mode/);
    expect(updated.draftReply).toBe(plain.reply);
  });
});

describe("listProspectingQueue -- reply pacing", () => {
  const NOW = new Date("2026-09-25T12:00:00Z");
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

  it("returns pacing from the replies actually posted, so the app can hold the next one", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "r1", status: "replied", repliedAt: minutesAgo(10), authorExternalId: "a" }));
    repo.seed(candidate({ id: "r2", status: "replied", repliedAt: minutesAgo(3000), authorExternalId: "b" }));

    const { pacing } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(pacing).toMatchObject({ repliedLast24h: 1, lastRepliedAt: minutesAgo(10), reason: "cooldown", nextReplyAt: minutesAgo(-10) });
  });
});

describe("listProspectingQueue -- filters out irrelevant candidates before they become actionable", () => {
  const NOW = new Date("2026-09-07T12:00:00Z");

  it("excludes the exact crypto posts that exposed this bug live from the returned queue, and moves them to not_relevant", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "crypto-1", status: "shown", postText: "$USELESS locked in the profits", authorExternalId: "a" }));
    repo.seed(candidate({ id: "crypto-2", status: "new", postText: "Not bad a 15% move in less than 2h...", authorExternalId: "b" }));
    repo.seed(candidate({ id: "genuine-futures", status: "new", postText: "Been trading MNQ futures for two years, still get nervous before the open.", authorExternalId: "c" }));

    const { candidates } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(candidates.map((c) => c.id)).toEqual(["genuine-futures"]);
    expect((await repo.getById("crypto-1"))!.status).toBe("not_relevant");
    expect((await repo.getById("crypto-2"))!.status).toBe("not_relevant");
    // Content is preserved, never deleted -- still readable via Prospecting history.
    expect((await repo.getById("crypto-1"))!.postText).toBe("$USELESS locked in the profits");
  });

  it("does not affect a genuine futures/prop-firm candidate's status or its place in the returned queue", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "propfirm-1", status: "new", opportunityScore: 80, postText: "Failed my prop firm evaluation because of a trailing drawdown rule.", authorExternalId: "a" }));

    const { candidates } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(candidates.map((c) => c.id)).toEqual(["propfirm-1"]);
    expect((await repo.getById("propfirm-1"))!.status).toBe("shown");
  });

  it("a crypto post that also clearly discusses futures/prop-firm/funded-account context remains eligible and reaches the queue", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(
      candidate({
        id: "crypto-futures",
        status: "new",
        opportunityScore: 70,
        postText: "Blew up my funded account trying to revenge trade back losses from a bad crypto futures position",
        authorExternalId: "a",
      }),
    );

    const { candidates } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(candidates.map((c) => c.id)).toEqual(["crypto-futures"]);
    expect((await repo.getById("crypto-futures"))!.status).toBe("shown");
  });

  it("excludes irrelevant candidates from totalConsidered -- they were never really 'considered' for today's selection at all", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "crypto-1", status: "new", postText: "$USELESS locked in the profits", authorExternalId: "a" }));
    repo.seed(candidate({ id: "genuine-1", status: "new", opportunityScore: 70, postText: "My funded account got pulled today.", authorExternalId: "b" }));

    const { diagnostics } = await listProspectingQueue(fakeClient, NOW, { repo });

    expect(diagnostics).toEqual({ totalConsidered: 1, selected: 1, deferred: 0, belowQualityBar: 0, tooOldForToday: 0 });
  });
});

describe("markProspectingReplied -- outreach is recorded in the candidate's own platform namespace", () => {
  it("an X reply still records X outreach keyed by the X author id", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-1", platform: "x", authorHandle: "xTrader", authorExternalId: "9001" }));

    await markProspectingReplied(fakeClient, "x-1", undefined, undefined, undefined, { repo });

    expect(repo.outreach).toEqual([{ platform: "x", authorExternalId: "9001", authorHandle: "xTrader" }]);
    expect(await repo.hasPriorOutreach("x", "9001")).toBe(true);
    expect(await repo.hasPriorOutreach("youtube", "9001")).toBe(false);
  });

  it("stores an edited final reply only when it differs from the draft, and keeps the model's flags when the caller passes none", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-2", draftReply: "draft", replyMentionsFillbook: true, replyUsedLink: false }));

    const same = await markProspectingReplied(fakeClient, "x-2", "draft", undefined, undefined, { repo });
    expect(same.finalReply).toBeNull();
    expect(same.replyMentionsFillbook).toBe(true);

    repo.seed(candidate({ id: "x-3", draftReply: "draft" }));
    const edited = await markProspectingReplied(fakeClient, "x-3", "edited by hand", undefined, undefined, { repo });
    expect(edited.finalReply).toBe("edited by hand");
  });

  it("does not record outreach when the author has no stable external id", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-4", authorExternalId: null }));

    await markProspectingReplied(fakeClient, "x-4", undefined, undefined, undefined, { repo });

    expect(repo.outreach).toEqual([]);
  });

  it("throws ProspectingActionError for an unknown id", async () => {
    const repo = new InMemoryProspectingRepository();
    await expect(markProspectingReplied(fakeClient, "missing", undefined, undefined, undefined, { repo })).rejects.toThrow(ProspectingActionError);
  });
});

/**
 * Regression coverage for the system_settings.paused gate added to
 * scheduled discovery (runProspectingSearch/runPartnershipDiscoveryStep):
 * reviewing an already-discovered candidate must never be affected by
 * pause state, since pausing is meant to stop unattended spend, not lock
 * the owner out of their own queue. Neither handler here accepts or
 * consults an isPaused dependency at all, and fakeClient is `{} as any` --
 * if either handler ever grew a `client.from("system_settings")` read
 * (accidentally coupling review to the pause flag), these tests would fail
 * immediately with "fakeClient.from is not a function" rather than silently
 * passing.
 */
describe("existing candidate review is unaffected by system pause state", () => {
  const loadGrounding = async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" });
  const cheapRelevanceCheck = async () => true;

  it("draftProspectingCandidateReply succeeds with no isPaused dependency in play", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "paused-1", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "EOD for most firms.", mentionsFillbook: false, usesLink: false }));

    const updated = await draftProspectingCandidateReply(fakeClient, "paused-1", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(updated.status).toBe("ready");
    expect(updated.draftReply).toBe("EOD for most firms.");
  });

  it("markProspectingReplied succeeds with no isPaused dependency in play", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "paused-2", authorExternalId: "9002" }));

    const updated = await markProspectingReplied(fakeClient, "paused-2", undefined, undefined, undefined, { repo });

    expect(updated.status).toBe("replied");
    expect(await repo.hasPriorOutreach("x", "9002")).toBe(true);
  });
});

describe("draftProspectingCandidateReply -- per-reply trackable link substitution", () => {
  const loadGrounding = async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" });
  const cheapRelevanceCheck = async () => true;

  it("replaces the static placeholder link with a real per-candidate short link when usesLink is true", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "link-1", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({
      isRelevant: true,
      reply: `Worth a look: ${PROSPECTING_TRACKABLE_LINK}`,
      mentionsFillbook: true,
      usesLink: true,
    }));

    const updated = await draftProspectingCandidateReply(fakeClient, "link-1", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(updated.draftReply).not.toContain(PROSPECTING_TRACKABLE_LINK);
    expect(updated.draftReply).toContain("fillbook-growth-os.vercel.app/api/ingest");
    expect(updated.draftReply).toContain("key=prospecting%3Alink-1");
  });

  it("leaves the reply untouched when usesLink is false, even if it happens to contain the placeholder text", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "link-2", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({
      isRelevant: true,
      reply: "No link here.",
      mentionsFillbook: false,
      usesLink: false,
    }));

    const updated = await draftProspectingCandidateReply(fakeClient, "link-2", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(updated.draftReply).toBe("No link here.");
  });
});

describe("draftProspectingCandidateReply -- the candidate's platform reaches the drafter", () => {
  const loadGrounding = async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" });
  const cheapRelevanceCheck = async () => true;

  it("an X candidate is drafted with platform=x", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-1", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "EOD for most firms.", mentionsFillbook: false, usesLink: false }));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-1", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(drafter).toHaveBeenCalledTimes(1);
    expect(drafter.mock.calls[0]![0]).toMatchObject({ platform: "x" });
    expect(updated.status).toBe("ready");
    expect(updated.draftReply).toBe("EOD for most firms.");
    expect(updated.replyMentionsFillbook).toBe(false);
  });

  it("REFINED: rejects and never persists a draft that trips the mechanical reply guardrail -- an overly promotional banned phrase -- even though the model's own flags say mentionsFillbook=false", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-2", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({
      isRelevant: true,
      reply: "Struggling with this? Check out our platform, it solves exactly this!",
      mentionsFillbook: false,
      usesLink: false,
    }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-2", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/banned generic phrase/);

    const row = await repo.getById("x-2");
    expect(row!.status).toBe("shown"); // never advanced to 'ready' -- the rejected draft was never persisted
    expect(row!.draftReply).toBeNull();
  });

  const overLimit = "word ".repeat(70);

  it("regenerates a hard-rejected draft with the reason fed back, and saves the fixed one", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-retry", platform: "x", status: "shown", draftReply: null }));
    const badDraft = { isRelevant: true, reply: overLimit, mentionsFillbook: false, usesLink: false };
    const goodDraft = { isRelevant: true, reply: "EOD for most firms.", mentionsFillbook: false, usesLink: false };
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => (drafter.mock.calls.length === 1 ? badDraft : goodDraft));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-retry", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(drafter).toHaveBeenCalledTimes(2);
    expect(drafter.mock.calls[0]![0].retryFeedback).toBeUndefined();
    expect(drafter.mock.calls[1]![0].retryFeedback).toMatch(/too long/);
    expect(updated.status).toBe("ready");
    expect(updated.draftReply).toBe("EOD for most firms.");
  });

  it("gives up after MAX_DRAFT_ATTEMPTS on a hard problem and never persists the draft", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-giveup", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: overLimit, mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-giveup", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/too long/);

    expect(drafter).toHaveBeenCalledTimes(3);
    expect((await repo.getById("x-giveup"))!.draftReply).toBeNull();
  });

  it("shows a draft with only a soft style tell after one retry instead of refusing it", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-soft", platform: "x", status: "shown", draftReply: null }));
    const softDraft = { isRelevant: true, reply: "Halving size is the move most traders skip.", mentionsFillbook: false, usesLink: false };
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => softDraft);

    const updated = await draftProspectingCandidateReply(fakeClient, "x-soft", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(drafter).toHaveBeenCalledTimes(2);
    expect(drafter.mock.calls[1]![0].retryFeedback).toMatch(/most traders/);
    expect(updated.status).toBe("ready");
    expect(updated.draftReply).toBe(softDraft.reply);
  });

  it("retries once when the draft picked a Fillbook view but never shows it, and keeps the retry that does", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-showcase", platform: "x", status: "shown", draftReply: null }));
    const vague = { isRelevant: true, reply: "One setup is usually eating what the others make.", mentionsFillbook: false, usesLink: false, showcase: "setup_breakdown" };
    const shown = {
      isRelevant: true,
      reply: "One setup is usually eating what the others make. Fillbook puts each setup on its own row with its own win rate and net P&L.",
      mentionsFillbook: true,
      usesLink: false,
      showcase: "setup_breakdown",
    };
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => (drafter.mock.calls.length === 1 ? vague : shown));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-showcase", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(drafter).toHaveBeenCalledTimes(2);
    expect(drafter.mock.calls[1]![0].retryFeedback).toMatch(/setup_breakdown/);
    expect(updated.draftReply).toBe(shown.reply);
  });

  it("does not retry when the model says the post is not relevant", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-irrelevant", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: false, reply: "", mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-irrelevant", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/relevant/);
    expect(drafter).toHaveBeenCalledTimes(1);
  });

  it("REFINED: rejects a draft with an unsupported customer-result claim", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-3", platform: "x", status: "shown", draftReply: null }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({
      isRelevant: true,
      reply: "Our traders saved 30% on drawdown violations after switching.",
      mentionsFillbook: true,
      usesLink: false,
    }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-3", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(ProspectingActionError);
  });
});

/**
 * Regression coverage for a real, confirmed bug: Prospecting surfaced
 * posts with zero connection to futures/trading (a sci-fi story teaser
 * scored 51 and got queued), and when drafted anyway, the model's only
 * way to flag the mismatch was writing it into the reply text itself
 * (e.g. "this event isn't futures related") -- shown to the owner as if
 * it were a usable draft. Two independent gates close this: a mechanical
 * $0 pre-filter (prospectingRelevance.ts) that runs before any LLM call,
 * and the model's own isRelevant flag for content that slips past it.
 */
describe("draftProspectingCandidateReply -- relevance gates", () => {
  const loadGrounding = async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" });
  const cheapRelevanceCheck = async () => true;

  it("rejects an obviously irrelevant (sci-fi) post before ever calling the drafter -- the mechanical pre-filter", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(
      candidate({
        id: "x-scifi",
        status: "shown",
        draftReply: null,
        postText:
          "What if trust begins where certainty ends? In #2084, a civilization built on prediction discovers the one thing an algorithm cannot give you: a reason...",
      }),
    );
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "should never be called", mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-scifi", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/not eligible for drafting/i);

    expect(drafter).not.toHaveBeenCalled();
    const row = await repo.getById("x-scifi");
    expect(row!.status).toBe("not_relevant");
    expect(row!.draftReply).toBeNull();
  });

  it("rejects the exact crypto post that exposed the live bug -- '$USELESS locked in the profits' -- before ever calling the drafter", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-crypto", status: "shown", draftReply: null, postText: "$USELESS locked in the profits" }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "should never be called", mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-crypto", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/not eligible for drafting/i);

    expect(drafter).not.toHaveBeenCalled();
    const row = await repo.getById("x-crypto");
    expect(row!.status).toBe("not_relevant");
    expect(row!.draftReply).toBeNull();
  });

  it("rejects a generic non-trading post (bare 'entry'/'performance' words only) before calling the drafter", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(
      candidate({
        id: "x-generic",
        status: "shown",
        draftReply: null,
        postText: "Every entry into the competition counts toward your final performance score.",
      }),
    );
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "should never be called", mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-generic", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/not eligible for drafting/i);
    expect(drafter).not.toHaveBeenCalled();
  });

  it("a genuine futures post passes the pre-filter and reaches the drafter", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-futures", status: "shown", draftReply: null, postText: "Been trading MNQ futures for two years, still get nervous before the open." }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "Two years in and still nervous is normal. It means you still respect the risk.", mentionsFillbook: false, usesLink: false }));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-futures", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(drafter).toHaveBeenCalledTimes(1);
    expect(updated.status).toBe("ready");
  });

  it("hands the owner's recent edits to the drafter as style examples, and a failed lookup never blocks drafting", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-style", status: "shown", draftReply: null, postText: "Been trading MNQ futures for two years, still get nervous before the open." }));
    const examples = [{ theirPost: "p", aiDraft: "Great point!", ownerFinal: "Same. Log the loser first." }];
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "Nervous before the open is normal. Respect the risk.", mentionsFillbook: false, usesLink: false }));

    await draftProspectingCandidateReply(fakeClient, "x-style", { repo, drafter, loadGrounding, cheapRelevanceCheck, loadStyleExamples: async () => examples });
    expect(drafter.mock.calls[0]![0].styleExamples).toEqual(examples);

    repo.seed(candidate({ id: "x-style2", status: "shown", draftReply: null, postText: "Been trading MNQ futures for two years, still get nervous before the open." }));
    const updated = await draftProspectingCandidateReply(fakeClient, "x-style2", { repo, drafter, loadGrounding, cheapRelevanceCheck, loadStyleExamples: async () => [] });
    expect(updated.status).toBe("ready");
  });

  it("a genuine prop-firm/drawdown post (no 'futures' word at all) passes the pre-filter and reaches the drafter", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(
      candidate({
        id: "x-propfirm",
        status: "shown",
        draftReply: null,
        postText: "Failed my prop firm evaluation because of a trailing drawdown rule I didn't fully understand.",
      }),
    );
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "That rule catches a lot of people. Worth reading the fine print before the next attempt.", mentionsFillbook: false, usesLink: false }));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-propfirm", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(drafter).toHaveBeenCalledTimes(1);
    expect(updated.status).toBe("ready");
  });

  it("the pre-filter passes but the model itself judges the post not relevant -- no draft is persisted, never shown as if usable", async () => {
    const repo = new InMemoryProspectingRepository();
    // postText passes the mechanical pre-filter (contains "trading"), but
    // the model itself determines the post isn't genuinely about trading
    // -- e.g. "trading cards" or "horse trading" style non-financial use.
    repo.seed(candidate({ id: "x-modeljudged", status: "shown", draftReply: null, postText: "Spent the whole weekend trading Pokemon cards with my kid at the local shop." }));
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({
      isRelevant: false,
      reply: "",
      mentionsFillbook: false,
      usesLink: false,
    }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-modeljudged", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/not eligible for drafting/i);

    expect(drafter).toHaveBeenCalledTimes(1); // pre-filter passed, so it DID reach the drafter this time
    const row = await repo.getById("x-modeljudged");
    expect(row!.status).toBe("not_relevant");
    expect(row!.draftReply).toBeNull(); // never persisted, regardless of what draft.reply contained
  });
});

/**
 * Coverage for the cheap (MODEL_HAIKU) relevance precheck: it sits between
 * the free regex pre-filter and the expensive MODEL_SONNET drafting call,
 * so a post that clears the regex but isn't actually relevant is rejected
 * without ever paying for a full draft.
 */
describe("draftProspectingCandidateReply -- cheap relevance precheck", () => {
  const loadGrounding = async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" });

  it("rejects a post the cheap check judges irrelevant before ever calling the expensive drafter", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-cheap-reject", status: "shown", draftReply: null, postText: "Spent the whole weekend trading Pokemon cards with my kid." }));
    const cheapRelevanceCheck = vi.fn(async (_ctx: ProspectingDraftContext) => false);
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "should never be called", mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-cheap-reject", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/not eligible for drafting/i);

    expect(cheapRelevanceCheck).toHaveBeenCalledTimes(1);
    expect(drafter).not.toHaveBeenCalled();
    const row = await repo.getById("x-cheap-reject");
    expect(row!.status).toBe("not_relevant");
    expect(row!.draftReply).toBeNull();
  });

  it("proceeds to the expensive drafter once the cheap check judges the post relevant", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-cheap-pass", status: "shown", draftReply: null, postText: "Been trading MNQ futures for two years, still get nervous before the open." }));
    const cheapRelevanceCheck = vi.fn(async (_ctx: ProspectingDraftContext) => true);
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "Nervous after two years just means you still respect the risk.", mentionsFillbook: false, usesLink: false }));

    const updated = await draftProspectingCandidateReply(fakeClient, "x-cheap-pass", { repo, drafter, loadGrounding, cheapRelevanceCheck });

    expect(cheapRelevanceCheck).toHaveBeenCalledTimes(1);
    expect(drafter).toHaveBeenCalledTimes(1);
    expect(updated.status).toBe("ready");
  });

  it("never runs the cheap check at all for a post the free regex pre-filter already rejects", async () => {
    const repo = new InMemoryProspectingRepository();
    repo.seed(candidate({ id: "x-regex-reject", status: "shown", draftReply: null, postText: "$USELESS locked in the profits" }));
    const cheapRelevanceCheck = vi.fn(async (_ctx: ProspectingDraftContext) => true);
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => ({ isRelevant: true, reply: "should never be called", mentionsFillbook: false, usesLink: false }));

    await expect(draftProspectingCandidateReply(fakeClient, "x-regex-reject", { repo, drafter, loadGrounding, cheapRelevanceCheck })).rejects.toThrow(/not eligible for drafting/i);

    expect(cheapRelevanceCheck).not.toHaveBeenCalled();
    expect(drafter).not.toHaveBeenCalled();
  });
});

describe("mention budget (cold replies naming Fillbook too often, 2026-09-30)", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
  const grounding = async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" });
  const recoveryOff = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });
  const named = { isRelevant: true, reply: "Fillbook's trade log shows every moved stop next to your plan.", mentionsFillbook: true, usesLink: false, showcase: "size_vs_plan" };
  const plain = { isRelevant: true, reply: "The stop you moved is the one that decides the eval. Write the invalidation price down before entry.", mentionsFillbook: false, usesLink: false, showcase: "none" };

  function seedReplied(repo: InMemoryProspectingRepository, mentions: number, total: number) {
    for (let i = 0; i < total; i++) {
      repo.seed(candidate({ id: `r-${i}`, status: "replied", draftReply: i < mentions ? "Fillbook shows that view." : "Plain advice.", repliedAt: hoursAgo(i + 1) }));
    }
    repo.seed(candidate({ id: "x-mb", platform: "x", status: "shown", draftReply: null, postText: "Moved my stop again and blew the eval. Futures trading is brutal." }));
  }

  const deps = (repo: InMemoryProspectingRepository, drafter: (ctx: ProspectingDraftContext) => Promise<typeof named | typeof plain>) => ({
    repo,
    drafter,
    loadGrounding: grounding,
    cheapRelevanceCheck: async () => true,
    loadStyleExamples: async () => [],
    loadRecovery: recoveryOff,
  });

  it("computes the share from posted replies and ignores a sample that is too small", () => {
    const rows = (n: number, named_: number) =>
      Array.from({ length: n }, (_, i) => candidate({ id: `c-${i}`, status: "replied", draftReply: i < named_ ? "Fillbook shows it." : "Plain.", repliedAt: hoursAgo(i + 1) }));
    expect(computeMentionBudget(rows(4, 4)).exhausted).toBe(false);
    expect(computeMentionBudget(rows(10, 2)).exhausted).toBe(false);
    expect(computeMentionBudget(rows(10, 6))).toMatchObject({ exhausted: true, sampled: 10 });
  });

  it("uses the edited final reply over the draft, and only the most recent window", () => {
    const old = Array.from({ length: 20 }, (_, i) => candidate({ id: `o-${i}`, status: "replied", draftReply: "Fillbook shows it.", repliedAt: hoursAgo(1000 + i) }));
    const fresh = Array.from({ length: 12 }, (_, i) => candidate({ id: `f-${i}`, status: "replied", draftReply: "Fillbook shows it.", finalReply: "Edited, no product.", repliedAt: hoursAgo(i + 1) }));
    expect(computeMentionBudget([...old, ...fresh]).exhausted).toBe(false);
  });

  it("leaves the draft free to name Fillbook while the recent share is within budget", async () => {
    const repo = new InMemoryProspectingRepository();
    seedReplied(repo, 2, 10);
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => named);
    const updated = await draftProspectingCandidateReply(fakeClient, "x-mb", deps(repo, drafter));
    expect(drafter.mock.calls[0]![0].recoveryNote).toBeUndefined();
    expect(updated.draftReply).toBe(named.reply);
  });

  it("when the budget is exhausted, tells the drafter to leave Fillbook out and redrafts one that names it", async () => {
    const repo = new InMemoryProspectingRepository();
    seedReplied(repo, 8, 10);
    const drafter = vi.fn(async (_ctx: ProspectingDraftContext) => (drafter.mock.calls.length === 1 ? named : plain));
    const updated = await draftProspectingCandidateReply(fakeClient, "x-mb", deps(repo, drafter));
    expect(drafter.mock.calls[0]![0].recoveryNote).toMatch(/MENTION BUDGET REACHED/);
    expect(drafter.mock.calls[1]![0].retryFeedback).toMatch(/pitch it too often/);
    expect(updated.draftReply).toBe(plain.reply);
  });
});
