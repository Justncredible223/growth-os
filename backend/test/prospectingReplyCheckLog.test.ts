import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveryFromVisibility, type RecoveryState } from "../src/prospecting/prospectingRecovery";
import type { ProspectingDraftContext, ProspectingDraftResult } from "../src/prospecting/prospectingReplyWriter";
import { draftProspectingCandidateReply, draftScreenedOutPost, markProspectingReplied } from "../src/prospecting/prospectingHandlers";
import { REPLY_CHECKS_KEY, REPLY_CHECK_F5_KEY, f5Result, postCheckResults, type ReplyCheckRecord } from "../src/prospecting/prospectingReplyCheckLog";
import { whyNotReplyWorthy } from "../src/prospecting/prospectingRelevance";
import { SupabaseProspectingRepository } from "../src/prospecting/supabaseProspectingRepository";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

/** APP-DEFECT-1128: the F1 to F5 outcomes are stored (codes only) so the reply checks can be measured. */

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
    if (!r) return true;
    const { breakdownPatch, onlyFrom: _onlyFrom, ...rest } = fields;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    this.rows.set(id, { ...r, ...defined, ...(breakdownPatch ? { scoreBreakdown: { ...r.scoreBreakdown, ...breakdownPatch } } : {}), status });
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

const FUTURES_POST = "Is the trailing drawdown on my Topstep 50K combine calculated end of day or intraday when I trade NQ futures?";
const GROK_POST = "Hey @grok is a trailing drawdown with a consistency rule the hardest setup on a Topstep combine for NQ traders?";
const SICK_POST = "Feel so sick today on a red NQ day with the trailing drawdown on my Topstep combine at 300 left";

function row(over: Partial<ProspectingCandidate> = {}): ProspectingCandidate {
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
    postText: FUTURES_POST,
    postUrl: "https://x.com/i/web/status/1",
    postCreatedAt: new Date().toISOString(),
    publicMetrics: {},
    opportunityScore: 70,
    scoreBreakdown: {},
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
    discoveredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const SHARP = "End of day on that combine, so the floor only moves after the close.";
const HELPFUL = "Pull up the account's rule page and note when the floor updates before the next session.";
const LENS = "In a log, compare average points per trade before and after the size-down.";
const WIN_RATE = "A 1:1 target only works if your win rate stays above about 52% after commissions, so that number is the one to check.";
const two = (over: Partial<ProspectingDraftResult> = {}): ProspectingDraftResult => ({ isRelevant: true, reply: SHARP, helpfulReply: HELPFUL, mentionsFillbook: false, usesLink: false, showcase: "none", ...over });

const off = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });
const deps = (repo: Repo, drafter: any, extra: Record<string, unknown> = {}) => ({
  repo,
  drafter,
  loadGrounding: async () => ({ brandRulesSummary: "rules", verifiedKnowledgeSummary: "facts" }),
  cheapRelevanceCheck: async () => true,
  loadStyleExamples: async () => [],
  loadRecovery: off,
  fillbookOptionEnabled: false,
  ...extra,
});
const client = {} as any;
const stored = (repo: Repo, id = "c1"): ReplyCheckRecord => JSON.parse(repo.rows.get(id)!.scoreBreakdown[REPLY_CHECKS_KEY]!);

afterEach(() => vi.restoreAllMocks());

describe("postCheckResults (F3, F4 at draft time)", () => {
  it("a post that clears the free gate passed both", () => {
    expect(whyNotReplyWorthy(FUTURES_POST)).toBeNull();
    expect(postCheckResults(FUTURES_POST, {}, false)).toEqual({ f3: "pass", f4: "pass", gateReason: null });
  });
  it("names which check hit, and marks a check that never ran as not_run", () => {
    expect(postCheckResults(GROK_POST, {}, false)).toEqual({ f3: "not_run", f4: "hit", gateReason: "addressed_to_grok" });
    expect(postCheckResults(SICK_POST, {}, false)).toEqual({ f3: "hit", f4: "pass", gateReason: "sensitive_personal" });
    expect(postCheckResults("rough day, markets are wild lately", {}, false)).toMatchObject({ f3: "not_run", f4: "not_run" });
  });
  it("an off-market author: the real gate already ran F4 before the author check, so F4 is read, not marked not_run", () => {
    const FX = { authorHandle: "FundYourFX", authorName: "Fund Your FX" };
    const plain = "Trailing drawdown or static drawdown on a $100K funded account? Which one would you choose?";
    expect(postCheckResults(plain, FX, false)).toEqual({ f3: "not_run", f4: "pass", gateReason: "off_market_author" });
    const tagged = `Hey @grok ${plain}`;
    expect(whyNotReplyWorthy(tagged, FX)).toBe("off_market_author");
    expect(postCheckResults(tagged, FX, false)).toEqual({ f3: "not_run", f4: "hit", gateReason: "off_market_author" });
  });
  it("an owner override skips the gate, so neither ran", () => {
    expect(postCheckResults(GROK_POST, {}, true)).toEqual({ f3: "not_run", f4: "not_run", gateReason: null });
  });
});

describe("f5Result", () => {
  it("is pass when the stored flag held, hit when it had to change, not_run without posted text", () => {
    expect(f5Result("plain", false, false)).toBe("pass");
    expect(f5Result("Fillbook shows it", false, true)).toBe("hit");
    expect(f5Result(null, false, false)).toBe("not_run");
    // No draft-time flag but posted text: F5 sets the flag, which counts as a change.
    expect(f5Result("plain", null, false)).toBe("hit");
  });
});

describe("draft outcomes are stored on the row (codes only)", () => {
  it("a clean two-option draft: shown_clean, F1 ran on the helpful option only, F2 passed on both", async () => {
    const repo = new Repo();
    repo.seed(row());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await draftProspectingCandidateReply(client, "c1", deps(repo, vi.fn(async () => two())));
    const rec = stored(repo);
    expect(rec).toMatchObject({ v: 1, ownerOverride: false, f3: "pass", f4: "pass", disposition: "shown_clean", shownAttempt: 1, shownWithF1: false, shownWithSoft: false });
    expect(rec.attempts).toEqual([
      {
        n: 1,
        relevant: true,
        options: [
          { style: "sharp", f1: "not_run", f2: "pass", otherHard: false, otherSoft: false },
          { style: "helpful", f1: "pass", f2: "pass", otherHard: false, otherSoft: false },
        ],
      },
    ]);
    const raw = repo.rows.get("c1")!.scoreBreakdown[REPLY_CHECKS_KEY]!;
    expect(raw).not.toContain(SHARP);
    expect(raw).not.toContain(HELPFUL);
    expect(raw).not.toContain("Topstep");
    expect(log.mock.calls.some(([line]) => String(line).startsWith("[prospecting] reply_checks ") && String(line).includes("shown_clean") && String(line).includes("\"candidateId\":\"c1\""))).toBe(true);
  });

  it("F2 hits the helpful option on every attempt: only the sharp option is shown", async () => {
    const repo = new Repo();
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async (_c: ProspectingDraftContext) => two({ helpfulReply: WIN_RATE }));
    const updated = await draftProspectingCandidateReply(client, "c1", deps(repo, drafter));
    expect(updated.draftOptions?.map((o) => o.style)).toEqual(["sharp"]);
    const rec = stored(repo);
    expect(rec.disposition).toBe("shown_one_option");
    expect(rec.attempts).toHaveLength(3);
    for (const a of rec.attempts) expect(a.options[1]).toMatchObject({ style: "helpful", f2: "hit", otherHard: false });
    expect(rec.shownWithF1).toBe(false);
  });

  it("F1 hits after two recent lens replies: one retry, then shown anyway and flagged", async () => {
    const repo = new Repo();
    const now = new Date().toISOString();
    repo.seed(row({ id: "r1", status: "replied", repliedAt: now, draftReply: "Tag every trade as plan or off-plan and keep a separate net P&L total for each." }));
    repo.seed(row({ id: "r2", status: "replied", repliedAt: now, draftReply: "In a log, sort a month by trades per day and compare net P&L on one-trade days against five-plus days." }));
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async () => two({ helpfulReply: LENS }));
    await draftProspectingCandidateReply(client, "c1", deps(repo, drafter));
    expect(drafter).toHaveBeenCalledTimes(2);
    const rec = stored(repo);
    expect(rec.attempts.map((a) => a.options[1]!.f1)).toEqual(["hit", "hit"]);
    expect(rec).toMatchObject({ disposition: "shown_soft_flag", shownWithF1: true, shownWithSoft: true });
  });

  it("an earlier soft attempt wins over later hard ones: the shown attempt is the first", async () => {
    const repo = new Repo();
    const now = new Date().toISOString();
    repo.seed(row({ id: "r1", status: "replied", repliedAt: now, draftReply: "Tag every trade as plan or off-plan and keep a separate net P&L total for each." }));
    repo.seed(row({ id: "r2", status: "replied", repliedAt: now, draftReply: "In a log, sort a month by trades per day and compare net P&L on one-trade days against five-plus days." }));
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async () => (drafter.mock.calls.length === 1 ? two({ helpfulReply: LENS }) : two({ reply: "word ".repeat(70) })));
    const updated = await draftProspectingCandidateReply(client, "c1", deps(repo, drafter));
    expect(updated.draftReply).toBe(SHARP);
    const rec = stored(repo);
    expect(rec.attempts).toHaveLength(3);
    expect(rec).toMatchObject({ disposition: "shown_soft_flag", shownAttempt: 1, shownWithF1: true });
  });

  it("F1 is not_run when the helpful option already has another soft problem", async () => {
    const repo = new Repo();
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async () => two({ helpfulReply: "Halving size is the move most traders skip." }));
    await draftProspectingCandidateReply(client, "c1", deps(repo, drafter));
    const helpful = stored(repo).attempts[0]!.options[1]!;
    expect(helpful).toMatchObject({ style: "helpful", f1: "not_run", otherSoft: true });
  });

  it("the cheap relevance check turning the post away records irrelevant_at_draft with no attempts", async () => {
    const repo = new Repo();
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn();
    await expect(draftProspectingCandidateReply(client, "c1", deps(repo, drafter, { cheapRelevanceCheck: async () => false }))).rejects.toThrow(/Not eligible/);
    expect(drafter).not.toHaveBeenCalled();
    expect(stored(repo)).toMatchObject({ disposition: "irrelevant_at_draft", f3: "pass", f4: "pass", attempts: [] });
  });

  it("an owner override whose drafts all fail leaves the Maybe row exactly as it was", async () => {
    const repo = new Repo();
    const maybe = row({ status: "not_relevant", skipReason: "screened_out_at_discovery", scoreBreakdown: { freshness: "10" } });
    repo.seed(maybe);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async () => ({ isRelevant: true, reply: "word ".repeat(70), mentionsFillbook: false, usesLink: false, showcase: "none" }));
    await expect(draftScreenedOutPost(client, "c1", deps(repo, drafter), new Date())).rejects.toThrow();
    expect(repo.rows.get("c1")).toEqual(maybe);
  });

  it("a single-reply draft records F2 and marks F1 as not run", async () => {
    const repo = new Repo();
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async () => ({ isRelevant: true, reply: SHARP, mentionsFillbook: false, usesLink: false, showcase: "none" }));
    await draftProspectingCandidateReply(client, "c1", deps(repo, drafter));
    expect(stored(repo).attempts[0]!.options).toEqual([{ style: "single", f1: "not_run", f2: "pass", otherHard: false, otherSoft: false }]);
  });

  it("F2 is not_run when an earlier hard check already failed", async () => {
    const repo = new Repo();
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const overLimit = "word ".repeat(70);
    const drafter = vi.fn(async () => (drafter.mock.calls.length === 1 ? { isRelevant: true, reply: overLimit, mentionsFillbook: false, usesLink: false, showcase: "none" } : { isRelevant: true, reply: SHARP, mentionsFillbook: false, usesLink: false, showcase: "none" }));
    await draftProspectingCandidateReply(client, "c1", deps(repo, drafter));
    const rec = stored(repo);
    expect(rec.attempts[0]!.options[0]).toMatchObject({ f2: "not_run", otherHard: true });
    expect(rec.attempts[1]!.options[0]).toMatchObject({ f2: "pass", otherHard: false });
    expect(rec).toMatchObject({ disposition: "shown_clean", shownAttempt: 2 });
  });

  it("a draft rejected on every attempt leaves the row untouched and is counted in the log only", async () => {
    const repo = new Repo();
    repo.seed(row());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const drafter = vi.fn(async () => ({ isRelevant: true, reply: "word ".repeat(70), mentionsFillbook: false, usesLink: false, showcase: "none" }));
    await expect(draftProspectingCandidateReply(client, "c1", deps(repo, drafter))).rejects.toThrow(/too long/);
    expect(repo.rows.get("c1")!.scoreBreakdown[REPLY_CHECKS_KEY]).toBeUndefined();
    expect(repo.rows.get("c1")!.status).toBe("shown");
    const line = log.mock.calls.map(([l]) => String(l)).find((l) => l.startsWith("[prospecting] reply_checks "));
    const rec = JSON.parse(line!.slice("[prospecting] reply_checks ".length)) as ReplyCheckRecord;
    expect(rec).toMatchObject({ disposition: "rejected_hard", shownWithF1: false, shownWithSoft: false });
    expect(rec.attempts).toHaveLength(3);
  });

  it("a @grok post turned away at draft time records F4 hit", async () => {
    const repo = new Repo();
    repo.seed(row({ postText: GROK_POST }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(draftProspectingCandidateReply(client, "c1", deps(repo, vi.fn()))).rejects.toThrow(/Not eligible/);
    expect(stored(repo)).toMatchObject({ disposition: "gate_at_draft", f4: "hit", f3: "not_run", gateReason: "addressed_to_grok", attempts: [] });
  });

  it("the drafter judging the post irrelevant records irrelevant_at_draft with the attempt", async () => {
    const repo = new Repo();
    repo.seed(row());
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(draftProspectingCandidateReply(client, "c1", deps(repo, vi.fn(async () => two({ isRelevant: false }))))).rejects.toThrow(/relevant/);
    expect(stored(repo)).toMatchObject({ disposition: "irrelevant_at_draft", attempts: [{ n: 1, relevant: false, options: [] }] });
  });
});

describe("F5 on mark replied", () => {
  it("stores hit when an edit made the posted text name Fillbook, pass when the flag held", async () => {
    // Separate repos: the reply pacing would hold a second reply a moment after the first.
    const edited = new Repo();
    edited.seed(row({ id: "a", status: "ready", draftReply: SHARP, replyMentionsFillbook: false }));
    await markProspectingReplied(client, "a", "Fillbook shows the floor for each account.", undefined, undefined, { repo: edited, loadRecovery: off });
    expect(edited.rows.get("a")!.scoreBreakdown[REPLY_CHECK_F5_KEY]).toBe("hit");
    expect(edited.rows.get("a")!.replyMentionsFillbook).toBe(true);

    const asDrafted = new Repo();
    asDrafted.seed(row({ id: "b", status: "ready", draftReply: SHARP, replyMentionsFillbook: false }));
    await markProspectingReplied(client, "b", undefined, undefined, undefined, { repo: asDrafted, loadRecovery: off });
    expect(asDrafted.rows.get("b")!.scoreBreakdown[REPLY_CHECK_F5_KEY]).toBe("pass");
  });

  it("counts a stale draft-time flag as a change: Option C named Fillbook, a plain option was posted", async () => {
    const repo = new Repo();
    repo.seed(row({ id: "c", status: "ready", draftReply: SHARP, replyMentionsFillbook: true }));
    await markProspectingReplied(client, "c", undefined, undefined, undefined, { repo, loadRecovery: off });
    expect(repo.rows.get("c")!.replyMentionsFillbook).toBe(false);
    expect(repo.rows.get("c")!.scoreBreakdown[REPLY_CHECK_F5_KEY]).toBe("hit");
  });
});

describe("the app never sees the stored keys", () => {
  it("getById leaves reply_checks and reply_check_f5 out of scoreBreakdown", async () => {
    const data = { ...row(), score_breakdown: { freshness: "10", [REPLY_CHECKS_KEY]: "{}", [REPLY_CHECK_F5_KEY]: "pass" }, id: "c1" };
    const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }) };
    const repo = new SupabaseProspectingRepository({ from: () => chain } as any);
    const got = await repo.getById("c1");
    expect(got!.scoreBreakdown).toEqual({ freshness: "10" });
  });
});
