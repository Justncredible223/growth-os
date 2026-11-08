import { describe, expect, it, vi } from "vitest";
import { CATALOG_COPY_EDITOR_NOTE, runReviewAgent } from "../src/content/reviewAgents";

function fakeClient() {
  const callTool = vi.fn(async () => ({ pass: true, score: 1, reasoning: "ok", issues: [] }));
  return { client: { callTool } as any, callTool };
}

const base = { platform: "tiktok", brandRulesSummary: "voice rules", verifiedKnowledgeSummary: "Edge Score has five parts." };

describe("catalog explainer copy-editor rubric", () => {
  it("gives the copy editor the narrow rubric for a catalog explainer", async () => {
    const { client, callTool } = fakeClient();
    await runReviewAgent(client, "copy_editor", "Edge Score is one score for five parts.", { ...base, isCatalogExplainer: true });
    const user = (callTool.mock.calls[0] as unknown[])[1] as string;
    expect(user).toContain(CATALOG_COPY_EDITOR_NOTE);
    expect(user).toContain("narration is already recorded");
    expect(user).toContain("If no qualifying defect exists, PASS.");
  });

  it("does not change the copy editor for anything that is not a catalog explainer", async () => {
    const { client, callTool } = fakeClient();
    await runReviewAgent(client, "copy_editor", "A normal post.", base);
    expect((callTool.mock.calls[0] as unknown[])[1] as string).not.toContain("CATALOG EXPLAINER");
  });

  it("never gives the narrow rubric to the fact, claims, brand or integrity reviewers", async () => {
    for (const agent of ["fact_checker", "skeptic", "brand_guardian", "integrity_reviewer", "trader"] as const) {
      const { client, callTool } = fakeClient();
      await runReviewAgent(client, agent, "Edge Score is one score for five parts.", { ...base, isCatalogExplainer: true });
      expect((callTool.mock.calls[0] as unknown[])[1] as string).not.toContain("CATALOG EXPLAINER");
    }
  });
});
