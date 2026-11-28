import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveryFromVisibility, type RecoveryState } from "../src/prospecting/prospectingRecovery";
import type { ProspectingDraftResult } from "../src/prospecting/prospectingReplyWriter";
import { draftProspectingCandidateReply, draftScreenedOutPost, listProspectingQueue, markProspectingAlreadyHandled, markProspectingOpened, markProspectingReplied, markProspectingSkipped } from "../src/prospecting/prospectingHandlers";
import { REPLY_CHECKS_KEY, REPLY_CHECK_F5_KEY } from "../src/prospecting/prospectingReplyCheckLog";
import { MAX_MERGE_ATTEMPTS, SupabaseProspectingRepository } from "../src/prospecting/supabaseProspectingRepository";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

/** APP-PR364-CONCURRENCY-1128: a draft (or the queue's cleanup) still running can never undo a reply, and merges keep each other's keys. */

/** Honours onlyFrom like the real repository: a conditional write lands only from the listed statuses. */
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
  async markShown() {}
  async updateStatus(id: string, status: ProspectingStatus, fields: Record<string, any> = {}) {
    const r = this.rows.get(id);
    if (!r) return false;
    const { breakdownPatch, onlyFrom, ...rest } = fields;
    if (onlyFrom && !onlyFrom.includes(r.status)) return false;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const scoreBreakdown = { ...r.scoreBreakdown, ...(breakdownPatch ?? {}), ...(rest.postedStyle ? { posted_style: rest.postedStyle } : {}) };
    this.rows.set(id, { ...r, ...defined, scoreBreakdown, status });
    return true;
  }
  async hasPriorOutreach() {
    return false;
  }
  async recordOutreach() {}
  async expireStale() {
    return 0;
  }
  async listScreenedOut() {
    return [];
  }
}

const POST = "Is the trailing drawdown on my Topstep 50K combine calculated end of day or intraday when I trade NQ futures?";
function row(over: Partial<ProspectingCandidate> = {}): ProspectingCandidate {
  const now = new Date().toISOString();
  return {
    id: "c1",
    platform: "x",
    externalId: "1",
    discoveryQuery: "trailing_drawdown",
    authorHandle: "someTrader",
    authorExternalId: "a1",
    authorName: null,
    authorFollowerCount: 500,
    authorVerified: false,
    postText: POST,
    postUrl: "https://x.com/i/web/status/1",
    postCreatedAt: now,
    publicMetrics: {},
    opportunityScore: 70,
    scoreBreakdown: { freshness: "10" },
    creatorCandidate: false,
    status: "shown",
    shownAt: null,
    openedAt: null,
    draftReply: null,
    finalReply: null,
    replyMentionsFillbook: null,
    replyUsedLink: null,
    repliedAt: null,
    skipReason: null,
    discoveredAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const SHARP = "End of day on that combine, so the floor only moves after the close.";
const HELPFUL = "Pull up the account's rule page and note when the floor updates before the next session.";
const two = (): ProspectingDraftResult => ({ isRelevant: true, reply: SHARP, helpfulReply: HELPFUL, mentionsFillbook: false, usesLink: false, showcase: "none" });
const off = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });
const client = {} as any;

afterEach(() => vi.restoreAllMocks());

describe("a draft still running never undoes a reply", () => {
  it("the owner marks the card replied while the draft is written: the draft is not saved and the reply, posted style and F5 stay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    repo.seed(row());
    const drafter = vi.fn(async () => {
      // The owner posts by hand and taps Replied while the model call is in flight.
      await markProspectingReplied(client, "c1", "My own reply about the close.", undefined, undefined, { repo, loadRecovery: off });
      return two();
    });
    await expect(
      draftProspectingCandidateReply(client, "c1", { repo, drafter, loadGrounding: async () => ({ brandRulesSummary: "r", verifiedKnowledgeSummary: "k" }), cheapRelevanceCheck: async () => true, loadStyleExamples: async () => [], loadRecovery: off, fillbookOptionEnabled: false }),
    ).rejects.toThrow(/changed while the draft was being written \(it is now replied\)/);
    const after = repo.rows.get("c1")!;
    expect(after.status).toBe("replied");
    expect(after.finalReply).toBe("My own reply about the close.");
    expect(after.draftReply).toBeNull();
    expect(after.scoreBreakdown[REPLY_CHECK_F5_KEY]).toBe("hit");
    expect(after.scoreBreakdown.freshness).toBe("10");
    expect(after.scoreBreakdown[REPLY_CHECKS_KEY]).toBeUndefined();
  });

  it("a gate rejection at draft time does not move a row that was replied meanwhile", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    repo.seed(row());
    const cheapRelevanceCheck = async () => {
      await markProspectingReplied(client, "c1", "Mine.", undefined, undefined, { repo, loadRecovery: off });
      return false;
    };
    await expect(draftProspectingCandidateReply(client, "c1", { repo, drafter: vi.fn(), cheapRelevanceCheck, loadRecovery: off })).rejects.toThrow(/Not eligible/);
    expect(repo.rows.get("c1")!.status).toBe("replied");
    expect(repo.rows.get("c1")!.skipReason).toBeNull();
  });

  const draftDeps = (repo: Repo, drafter: any, extra: Record<string, unknown> = {}) => ({
    repo,
    drafter,
    loadGrounding: async () => ({ brandRulesSummary: "r", verifiedKnowledgeSummary: "k" }),
    cheapRelevanceCheck: async () => true,
    loadStyleExamples: async () => [],
    loadRecovery: off,
    fillbookOptionEnabled: false,
    ...extra,
  });

  it.each([
    ["skipped", (repo: Repo) => markProspectingSkipped(client, "c1", "not for us", { repo })],
    ["already handled", (repo: Repo) => markProspectingAlreadyHandled(client, "c1", { repo })],
    ["expired", async (repo: Repo) => void (await repo.updateStatus("c1", "expired", { onlyFrom: ["new", "shown", "drafting", "ready"] }))],
  ])("a draft finishing after the card was %s leaves it as the owner or the queue set it", async (now, act) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    repo.seed(row());
    const drafter = vi.fn(async () => {
      await act(repo);
      return two();
    });
    await expect(draftProspectingCandidateReply(client, "c1", draftDeps(repo, drafter))).rejects.toThrow(new RegExp(`it is now ${now}`));
    expect(repo.rows.get("c1")!.draftReply).toBeNull();
  });

  it("the free gate's write at draft time does not move a row replied meanwhile", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    // A @grok post fails the free gate; the reply lands just before the gate's write (simulated by replying first, then drafting).
    repo.seed(row({ postText: "Hey @grok is a trailing drawdown with a consistency rule the hardest setup on a Topstep combine for NQ traders?" }));
    const getById = repo.getById.bind(repo);
    let first = true;
    repo.getById = async (id: string) => {
      const r = await getById(id);
      if (first) {
        first = false;
        await markProspectingReplied(client, "c1", "Mine.", undefined, undefined, { repo, loadRecovery: off });
      }
      return r;
    };
    await expect(draftProspectingCandidateReply(client, "c1", draftDeps(repo, vi.fn()))).rejects.toThrow(/Not eligible/);
    expect(repo.rows.get("c1")!.status).toBe("replied");
  });

  it("the drafter judging the post irrelevant does not move a row replied meanwhile", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    repo.seed(row());
    const drafter = vi.fn(async () => {
      await markProspectingReplied(client, "c1", "Mine.", undefined, undefined, { repo, loadRecovery: off });
      return { ...two(), isRelevant: false };
    });
    await expect(draftProspectingCandidateReply(client, "c1", draftDeps(repo, drafter))).rejects.toThrow(/relevant/);
    expect(repo.rows.get("c1")!.status).toBe("replied");
  });
});

describe("Draft anyway (owner override)", () => {
  const maybe = () => row({ status: "not_relevant", skipReason: "screened_out_at_discovery", updatedAt: new Date().toISOString() });
  const deps = (repo: Repo, drafter: any) => ({ repo, drafter, loadGrounding: async () => ({ brandRulesSummary: "r", verifiedKnowledgeSummary: "k" }), cheapRelevanceCheck: async () => false, loadStyleExamples: async () => [], loadRecovery: off, fillbookOptionEnabled: false });

  it("is not saved when the Maybe row changed meanwhile", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    repo.seed(maybe());
    const drafter = vi.fn(async () => {
      await markProspectingAlreadyHandled(client, "c1", { repo });
      return two();
    });
    await expect(draftScreenedOutPost(client, "c1", deps(repo, drafter), new Date())).rejects.toThrow(/it is now already handled/);
    expect(repo.rows.get("c1")!.status).toBe("already_handled");
    expect(repo.rows.get("c1")!.draftReply).toBeNull();
  });

  it("a double tap hands back the card the first draft filled instead of a false conflict", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = new Repo();
    repo.seed(maybe());
    let calls = 0;
    const drafter = vi.fn(async () => {
      calls++;
      // The second tap's model call finishes after the first tap already saved the card.
      if (calls === 2) await new Promise((r) => setTimeout(r, 5));
      return two();
    });
    const d = deps(repo, drafter);
    const [a, b] = await Promise.all([draftScreenedOutPost(client, "c1", d, new Date()), draftScreenedOutPost(client, "c1", d, new Date())]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(b.draftReply).toBe(SHARP);
  });
});

describe("other writes never undo a reply", () => {
  it("Copy + Open's timestamp does not move a row replied meanwhile", async () => {
    const repo = new Repo();
    repo.seed(row({ status: "ready", draftReply: SHARP, replyMentionsFillbook: false }));
    const getById = repo.getById.bind(repo);
    repo.getById = async (id: string) => {
      const r = await getById(id);
      repo.getById = getById;
      await markProspectingReplied(client, "c1", undefined, undefined, undefined, { repo, loadRecovery: off });
      return r;
    };
    await markProspectingOpened(client, "c1", { repo });
    expect(repo.rows.get("c1")!.status).toBe("replied");
  });
});

describe("the queue's cleanup never undoes a reply", () => {
  it("a card replied between the queue read and its expiry write stays replied", async () => {
    const NOW = new Date("2026-11-28T12:00:00Z");
    const repo = new Repo();
    repo.seed(row({ id: "old", status: "shown", postCreatedAt: new Date(NOW.getTime() - 10 * 24 * 3600_000).toISOString(), authorExternalId: "z" }));
    const list = repo.listByStatus.bind(repo);
    repo.listByStatus = async (statuses: ProspectingStatus[]) => {
      const snapshot = await list(statuses);
      // The owner marks it replied right after the queue read its snapshot.
      const r = repo.rows.get("old")!;
      repo.rows.set("old", { ...r, status: "replied", repliedAt: NOW.toISOString() });
      return snapshot;
    };
    await listProspectingQueue(client, NOW, { repo, loadRecovery: off });
    expect(repo.rows.get("old")!.status).toBe("replied");
  });
});

/** A fake PostgREST client for the real repository: records each UPDATE and lets a test change the row between the read and the write. */
function fakeClient(initial: Record<string, unknown>, onRead?: (n: number, rowRef: { row: Record<string, unknown> }) => void) {
  const ref = { row: { ...initial } };
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, string, unknown]>; landed: boolean }> = [];
  let reads = 0;
  const from = () => {
    const filters: Array<[string, string, unknown]> = [];
    let mode: "select" | "update" = "select";
    let values: Record<string, unknown> = {};
    const matches = () =>
      filters.every(([op, col, v]) => (op === "eq" ? ref.row[col] === v : op === "in" ? (v as unknown[]).includes(ref.row[col]) : true));
    const chain: any = {
      select: () => (mode === "update" ? chain : ((mode = "select"), chain)),
      update: (v: Record<string, unknown>) => ((mode = "update"), (values = v), chain),
      eq: (col: string, v: unknown) => (filters.push(["eq", col, v]), chain),
      in: (col: string, v: unknown[]) => (filters.push(["in", col, v]), chain),
      maybeSingle: async () => {
        reads++;
        const data = { score_breakdown: ref.row.score_breakdown, updated_at: ref.row.updated_at, status: ref.row.status };
        onRead?.(reads, ref);
        return { data, error: null };
      },
      then: (resolve: (r: unknown) => void) => {
        const landed = matches();
        updates.push({ values, filters: [...filters], landed });
        if (landed) ref.row = { ...ref.row, ...values };
        resolve({ data: landed ? [{ id: ref.row.id }] : [], error: null });
      },
    };
    return chain;
  };
  return { client: { from } as any, ref, updates };
}

describe("score_breakdown merges keep each other's keys (optimistic, no SQL)", () => {
  const base = { id: "c1", status: "ready", updated_at: "2026-11-28T10:00:00.000001+00:00", score_breakdown: { freshness: "10" } };

  it("guards the write on the updated_at it read", async () => {
    const { client, ref, updates } = fakeClient(base);
    const ok = await new SupabaseProspectingRepository(client).updateStatus("c1", "replied", { postedStyle: "sharp", breakdownPatch: { [REPLY_CHECK_F5_KEY]: "pass" }, onlyFrom: ["ready"] });
    expect(ok).toBe(true);
    expect(updates[0]!.filters).toContainEqual(["eq", "updated_at", base.updated_at]);
    expect(ref.row.score_breakdown).toEqual({ freshness: "10", posted_style: "sharp", [REPLY_CHECK_F5_KEY]: "pass" });
  });

  it("a write that lands between the read and the update is re-read and kept", async () => {
    const { client, ref, updates } = fakeClient(base, (n, r) => {
      // Right after the first read, another request saves the draft's reply_checks.
      if (n === 1) r.row = { ...r.row, updated_at: "2026-11-28T10:00:01.000001+00:00", score_breakdown: { ...(r.row.score_breakdown as object), [REPLY_CHECKS_KEY]: "{}" } };
    });
    const ok = await new SupabaseProspectingRepository(client).updateStatus("c1", "replied", { postedStyle: "helpful", onlyFrom: ["ready"] });
    expect(ok).toBe(true);
    expect(updates.map((u) => u.landed)).toEqual([false, true]);
    expect(ref.row.score_breakdown).toEqual({ freshness: "10", [REPLY_CHECKS_KEY]: "{}", posted_style: "helpful" });
  });

  it("does not write at all once the status has left onlyFrom", async () => {
    const { client, updates } = fakeClient({ ...base, status: "replied" });
    const ok = await new SupabaseProspectingRepository(client).updateStatus("c1", "ready", { breakdownPatch: { [REPLY_CHECKS_KEY]: "{}" }, onlyFrom: ["shown"] });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it(`after ${MAX_MERGE_ATTEMPTS} misses it writes once without the guard, as before`, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let stamp = 0;
    const { client, ref, updates } = fakeClient(base, (_n, r) => {
      r.row = { ...r.row, updated_at: `2026-11-28T10:00:0${++stamp}.000001+00:00` };
    });
    const ok = await new SupabaseProspectingRepository(client).updateStatus("c1", "ready", { breakdownPatch: { [REPLY_CHECKS_KEY]: "{}" } });
    expect(ok).toBe(true);
    expect(updates).toHaveLength(MAX_MERGE_ATTEMPTS + 1);
    expect(updates.slice(0, MAX_MERGE_ATTEMPTS).every((u) => !u.landed)).toBe(true);
    expect(updates[MAX_MERGE_ATTEMPTS]!.filters.some(([, col]) => col === "updated_at")).toBe(false);
    expect((ref.row.score_breakdown as Record<string, string>)[REPLY_CHECKS_KEY]).toBe("{}");
  });
});

describe("the queue's not_relevant filter never undoes a reply", () => {
  it("a card replied between the queue read and the filter write stays replied", async () => {
    const NOW = new Date("2026-11-28T12:00:00Z");
    const repo = new Repo();
    repo.seed(row({ id: "junk", status: "shown", postText: "rough day, markets are wild lately", postCreatedAt: NOW.toISOString(), authorExternalId: "j" }));
    const list = repo.listByStatus.bind(repo);
    repo.listByStatus = async (statuses: ProspectingStatus[]) => {
      const snapshot = await list(statuses);
      const r = repo.rows.get("junk")!;
      repo.rows.set("junk", { ...r, status: "replied", repliedAt: NOW.toISOString() });
      return snapshot;
    };
    await listProspectingQueue(client, NOW, { repo, loadRecovery: off });
    expect(repo.rows.get("junk")!.status).toBe("replied");
  });
});
