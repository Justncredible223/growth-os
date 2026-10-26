import { describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ opts: [] as any[] }));
vi.mock("../src/cost/recordedLlmClient.js", () => ({
  createRecordedLlmClient: (_client: unknown, opts: any) => {
    recorded.opts.push(opts);
    return { fake: true };
  },
}));
vi.mock("../src/prospecting/prospectingReplyWriter.js", async (orig) => {
  const actual = await orig<typeof import("../src/prospecting/prospectingReplyWriter.js")>();
  return {
    ...actual,
    draftProspectingReply: vi.fn(async () => ({
      isRelevant: true,
      reply: "Wild days punish oversized positions first, so I cut size before anything else.",
      helpfulReply: "Volatile sessions widen your stops in dollars. Check the daily loss limit before you take the next trade.",
      mentionsFillbook: false,
      usesLink: false,
      showcase: "none",
    })),
  };
});

import { draftScreenedOutPost } from "../src/prospecting/prospectingHandlers";

describe("draftScreenedOutPost cost recording", () => {
  it("drafts through the recorded client under the prospecting-draft step as an owner action", async () => {
    const row: any = {
      id: "m1", platform: "x", externalId: "1", discoveryQuery: "trailing_drawdown", authorHandle: "a", authorExternalId: "a1",
      postText: "rough day", postUrl: "u", scoreBreakdown: {}, status: "not_relevant", skipReason: "screened_out_at_discovery",
      updatedAt: new Date().toISOString(), draftReply: null,
    };
    const rows = new Map<string, any>([["m1", row]]);
    const repo: any = {
      getById: async (id: string) => rows.get(id) ?? null,
      updateStatus: async (id: string, status: string, f: any = {}) => {
        const { breakdownPatch, ...rest } = f;
        rows.set(id, { ...rows.get(id), ...rest, status, scoreBreakdown: { ...rows.get(id).scoreBreakdown, ...(breakdownPatch ?? {}) } });
      },
      listRepliedSince: async () => [],
    };
    await draftScreenedOutPost({} as any, "m1", {
      repo,
      loadGrounding: async () => ({ brandRulesSummary: "r", verifiedKnowledgeSummary: "k" }),
      loadStyleExamples: async () => [],
      loadRecovery: async () => ({ active: false, maxPostAgeHours: null, dailyCap: null }) as any,
    });
    expect(recorded.opts.map((o) => o.step)).toEqual(["prospecting-draft"]);
    expect(recorded.opts[0].tier).toBe("owner");
    expect(rows.get("m1").status).toBe("ready");
  });
});
