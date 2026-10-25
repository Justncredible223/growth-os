import { describe, it, expect, vi } from "vitest";
import { LlmClient } from "../src/content/llmClient";
import { recoveryFromVisibility, type RecoveryState } from "../src/prospecting/prospectingRecovery";
import {
  PROSPECTING_COLD_NO_PITCH_GUIDANCE,
  PROSPECTING_TWO_OPTION_STYLE_BLOCK,
  draftProspectingReply,
  type ProspectingDraftContext,
  type ProspectingDraftResult,
} from "../src/prospecting/prospectingReplyWriter";
import { acceptedFillbookOption, draftProspectingCandidateReply } from "../src/prospecting/prospectingHandlers";
import { matchPostedStyle, optionSoftProblem, parseDraftOptions } from "../src/prospecting/prospectingDraftOptions";
import { replyStyleSection, type OwnPostRow } from "../src/posting/weeklyDigest";
import type { NewProspectingCandidate, ProspectingCandidate, ProspectingRepository, ProspectingStatus } from "../src/prospecting/types";

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
    return [...this.rows.values()].filter((r) => r.status === "replied" && r.repliedAt !== null && new Date(r.repliedAt) >= since);
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async markShown() {}
  async updateStatus(id: string, status: ProspectingStatus, fields: Partial<ProspectingCandidate> = {}) {
    const row = this.rows.get(id);
    if (!row) return;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    this.rows.set(id, { ...row, ...defined, status });
  }
  async hasPriorOutreach() {
    return false;
  }
  async recordOutreach() {}
  async expireStale() {
    return 0;
  }
}

function candidate(overrides: Partial<ProspectingCandidate> = {}): ProspectingCandidate {
  return {
    id: "c1",
    platform: "x",
    externalId: "123",
    discoveryQuery: "trailing_drawdown",
    authorHandle: "someTrader",
    authorExternalId: "author-1",
    authorName: "Some Trader",
    authorFollowerCount: 2000,
    authorVerified: false,
    postText: "Passed my eval then blew the funded account in two days. Does trailing drawdown lock once you are up?",
    postUrl: "https://x.com/i/web/status/123",
    postCreatedAt: null,
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
    discoveredAt: "2026-10-16T00:00:00Z",
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
    ...overrides,
  };
}

const SHARP = "Two payouts secured, then size doubled the same afternoon. The floor was never the problem.";
const HELPFUL = "On most firms the trailing floor stops at the starting balance once you are up the drawdown amount. Check yours before sizing up.";
const FILLBOOK_REPLY = "Trailing drawdown locks at the starting balance once you are up the drawdown amount. Fillbook's buffer view shows that room in dollars for each account.";

const off = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "ok", recentMedian: 8, recentCount: 5, baselineMedian: 7, baselineCount: 20 });
const on = async (): Promise<RecoveryState> => recoveryFromVisibility({ status: "dropped", recentMedian: 2.5, recentCount: 30, baselineMedian: 7, baselineCount: 20 });

function draft(over: Partial<ProspectingDraftResult> = {}): ProspectingDraftResult {
  return { isRelevant: true, reply: SHARP, helpfulReply: HELPFUL, fillbookReply: FILLBOOK_REPLY, mentionsFillbook: true, usesLink: false, showcase: "account_buffer", ...over };
}

function deps(repo: Repo, drafts: ProspectingDraftResult[], recovery = off, seen: ProspectingDraftContext[] = []) {
  let i = 0;
  return {
    repo,
    drafter: async (context: ProspectingDraftContext) => {
      seen.push(context);
      return drafts[Math.min(i++, drafts.length - 1)]!;
    },
    loadGrounding: async () => ({ brandRulesSummary: "", verifiedKnowledgeSummary: "" }),
    cheapRelevanceCheck: async () => true,
    loadStyleExamples: async () => [],
    loadRecovery: recovery,
  };
}

function fetchFor(input: ProspectingDraftResult) {
  const body = { content: [{ type: "tool_use", name: "submit_reply", input }] };
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response);
}

describe("the Fillbook option, option C (2026-10-25)", () => {
  it("the prompt asks for it, lists the vetted views, and the schema carries the field", async () => {
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toContain("OPTION C");
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toContain("fillbookReply");
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toContain("The Fillbook views you may show");
    expect(PROSPECTING_TWO_OPTION_STYLE_BLOCK).toContain("OPTION A and OPTION B never name Fillbook");
    expect(PROSPECTING_COLD_NO_PITCH_GUIDANCE).toContain("Option C");
    const fetchMock = fetchFor(draft());
    const result = await draftProspectingReply(new LlmClient("test-key", fetchMock), { platform: "x", authorHandle: "t", postText: "hi", discoveryQuery: "drawdown", fillbookOption: true }, "", "");
    expect(result.fillbookReply).toBe(FILLBOOK_REPLY);
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(sent.tools[0].input_schema.required).toEqual(expect.arrayContaining(["fillbookReply"]));
    expect(JSON.stringify(sent.messages)).toContain("Option C (the Fillbook option) is ALLOWED for this post.");
  });

  it("tells the model option C is not allowed when the context says so", async () => {
    const fetchMock = fetchFor(draft({ fillbookReply: "", mentionsFillbook: false, showcase: "none" }));
    await draftProspectingReply(new LlmClient("test-key", fetchMock), { platform: "x", authorHandle: "t", postText: "hi", discoveryQuery: "drawdown", fillbookOption: false }, "", "");
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(JSON.stringify(sent.messages)).toContain("NOT ALLOWED");
  });

  it("adds a third option after sharp and helpful, leaves draftReply on the first, and records that Fillbook is named", async () => {
    const repo = new Repo();
    repo.seed(candidate({ id: "c-fb" }));
    const seen: ProspectingDraftContext[] = [];
    const out = await draftProspectingCandidateReply({} as any, "c-fb", deps(repo, [draft()], off, seen));
    expect(seen[0]!.fillbookOption).toBe(true);
    expect(out.draftOptions?.map((o) => o.style)).toEqual(["sharp", "helpful", "fillbook"]);
    expect(out.draftReply).toBe(SHARP);
    expect(out.replyMentionsFillbook).toBe(true);
  });

  it("is not offered while recovery mode is on, even if the model writes one", async () => {
    const repo = new Repo();
    repo.seed(candidate({ id: "c-rec" }));
    const seen: ProspectingDraftContext[] = [];
    const out = await draftProspectingCandidateReply({} as any, "c-rec", deps(repo, [draft()], on, seen));
    expect(seen[0]!.fillbookOption).toBe(false);
    expect(out.draftOptions?.map((o) => o.style)).toEqual(["sharp", "helpful"]);
  });

  it("is not offered once recent replies already name Fillbook too often (the 1 in 5 budget)", async () => {
    const repo = new Repo();
    for (let i = 0; i < 6; i++) {
      repo.seed(candidate({ id: `old-${i}`, status: "replied", repliedAt: new Date(Date.now() - (i + 1) * 3600_000).toISOString(), finalReply: i < 3 ? "Fillbook's buffer view shows that." : "Plain advice about sizing.", draftReply: "x" }));
    }
    repo.seed(candidate({ id: "c-budget" }));
    const seen: ProspectingDraftContext[] = [];
    const out = await draftProspectingCandidateReply({} as any, "c-budget", deps(repo, [draft()], off, seen));
    expect(seen[0]!.fillbookOption).toBe(false);
    expect(out.draftOptions?.map((o) => o.style)).toEqual(["sharp", "helpful"]);
  });

  it("drops a bad option C quietly without costing options A and B", async () => {
    const bad = [
      draft({ fillbookReply: "Trailing drawdown locks at the starting balance once you are up the drawdown amount." }), // never names Fillbook
      draft({ showcase: "none" }),
      draft({ showcase: "not_a_real_view" }),
      draft({ fillbookReply: "Check it out: Fillbook's buffer view shows that room in dollars." }), // banned pitch phrase
      draft({ fillbookReply: "Trailing drawdown locks once you are up. Fillbook's buffer view shows that room — for each account." }), // dash
      draft({ fillbookReply: "Fillbook will make you profitable by showing every buffer." }), // profit promise
      draft({ fillbookReply: "" }),
    ];
    for (const [i, d] of bad.entries()) {
      const repo = new Repo();
      repo.seed(candidate({ id: `bad-${i}` }));
      const out = await draftProspectingCandidateReply({} as any, `bad-${i}`, deps(repo, [d]));
      expect(out.draftOptions?.map((o) => o.style), `case ${i}`).toEqual(["sharp", "helpful"]);
    }
  });

  it("acceptedFillbookOption returns the text only when allowed and clean", () => {
    expect(acceptedFillbookOption(draft(), true)).toEqual({ style: "fillbook", text: FILLBOOK_REPLY });
    expect(acceptedFillbookOption(draft(), false)).toBeNull();
    expect(acceptedFillbookOption(draft({ fillbookReply: undefined }), true)).toBeNull();
    // A draft that declares a link is refused as a whole by the handler (cold replies never include one); the option itself also refuses it.
    expect(acceptedFillbookOption(draft({ usesLink: true }), true)).toBeNull();
  });

  it("options A and B still may not name Fillbook, even when option C is allowed", async () => {
    const repo = new Repo();
    repo.seed(candidate({ id: "c-ab" }));
    const named = draft({ reply: "Fillbook shows the floor in dollars so the size does not creep." });
    const out = await draftProspectingCandidateReply({} as any, "c-ab", deps(repo, [named, draft()]));
    expect(out.draftOptions?.find((o) => o.style === "sharp")!.text).toBe(SHARP);
  });

  it("is recognised by the style tag, the parser and the Monday report", () => {
    const options = [
      { style: "sharp" as const, text: SHARP },
      { style: "helpful" as const, text: HELPFUL },
      { style: "fillbook" as const, text: FILLBOOK_REPLY },
    ];
    expect(parseDraftOptions(JSON.stringify(options))).toEqual(options);
    expect(matchPostedStyle(FILLBOOK_REPLY, options, SHARP)).toBe("fillbook");
    expect(optionSoftProblem("fillbook", FILLBOOK_REPLY)).toBeNull();
    expect(optionSoftProblem("fillbook", "Trailing drawdown locks at the starting balance.")).toMatch(/Fillbook/);
    const posts: OwnPostRow[] = [1, 2, 3].map((n) => ({ tweetId: String(n), kind: "reply", text: "x", createdAt: "2026-10-26T18:00:00Z", impressions: 10 * n, likes: n, prospectingCandidateId: `c${n}` }));
    const lines = replyStyleSection(posts, new Map([["c1", "fillbook"], ["c2", "fillbook"], ["c3", "fillbook"]]));
    expect(lines?.join(" ")).toMatch(/fillbook: 3 replies, median 20 views/);
  });
});
