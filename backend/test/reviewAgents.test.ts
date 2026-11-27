import { describe, it, expect, vi } from "vitest";
import { LlmClient } from "../src/content/llmClient";
import { runReviewAgent } from "../src/content/reviewAgents";

/**
 * Review agents send their system prompt as a cached content-block array
 * ([{ type: "text", text, cache_control }]) since a975258 added prompt caching,
 * while other LlmClient callers still send a plain string. Normalize both to
 * the prompt text so assertions check what the model actually reads.
 */
function systemText(init: RequestInit): string {
  const system = JSON.parse(init.body as string).system as string | Array<{ type: string; text: string }>;
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n");
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const context = {
  platform: "X",
  brandRulesSummary: "voice: concise, intelligent, relatable",
  verifiedKnowledgeSummary: "Fillbook is a futures trading journal.",
};

describe("runReviewAgent", () => {
  it("returns a structured verdict for a given agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [
          {
            type: "tool_use",
            name: "submit_verdict",
            input: { pass: false, score: 0.3, reasoning: "Generic opener, no real hook", issues: ["rewrite the first line"] },
          },
        ],
      }),
    );
    const client = new LlmClient("test-key", fetchMock);

    const verdict = await runReviewAgent(client, "hook_specialist", "Here's the thing about futures...", context);

    expect(verdict).toEqual({
      agent: "hook_specialist",
      pass: false,
      score: 0.3,
      reasoning: "Generic opener, no real hook",
      issues: ["rewrite the first line"],
    });
  });

  it("includes the platform, brand rules, and verified knowledge in the prompt sent to the model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: "tool_use", name: "submit_verdict", input: { pass: true, score: 1, reasoning: "ok", issues: [] } }] }),
    );
    const client = new LlmClient("test-key", fetchMock);

    await runReviewAgent(client, "fact_checker", "Fillbook supports 8 brokers.", context);

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    const userMessage = body.messages[0].content as string;
    expect(userMessage).toContain("Platform: X");
    expect(userMessage).toContain("concise, intelligent, relatable");
    expect(userMessage).toContain("Fillbook is a futures trading journal.");
    expect(userMessage).toContain("Fillbook supports 8 brokers.");
  });

  it("uses a distinct system prompt per agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: "tool_use", name: "submit_verdict", input: { pass: true, score: 1, reasoning: "ok", issues: [] } }] }),
    );
    const client = new LlmClient("test-key", fetchMock);

    await runReviewAgent(client, "brand_guardian", "some content", context);
    await runReviewAgent(client, "trader", "some content", context);

    const brandGuardianSystem = systemText(fetchMock.mock.calls[0]![1]);
    const traderSystem = systemText(fetchMock.mock.calls[1]![1]);
    expect(brandGuardianSystem).not.toBe(traderSystem);
    expect(brandGuardianSystem).toContain("Brand Constitution");
    expect(traderSystem).toContain("futures day trader");
  });
});

describe("runReviewAgent -- a reply without an explicit verdict", () => {
  const reply = (input: unknown) => new LlmClient("test-key", vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use", name: "submit_verdict", input }] })));

  it.each([
    ["an empty reply", {}],
    ["a score with no verdict", { score: 0.9, reasoning: "good", issues: [] }],
    ["a text verdict", { pass: "false", score: 0.2, reasoning: "no", issues: [] }],
    ["a null verdict", { pass: null, score: 0.2, reasoning: "no", issues: [] }],
  ])("is an error, never a stored pass or fail: %s", async (_name, input) => {
    await expect(runReviewAgent(reply(input), "trader", "text", context)).rejects.toThrow(/no explicit pass\/fail verdict/);
  });

  it("keeps an explicit verdict that has no score", async () => {
    expect((await runReviewAgent(reply({ pass: false, reasoning: "no", issues: [] }), "trader", "text", context)).pass).toBe(false);
  });
});

describe("runReviewAgent -- partnership pitch context", () => {
  const pitchContext = {
    ...context,
    contentFormat: "partnership_pitch" as const,
    pitchRecipientOrganization: "Apex Journaling Coach LLC",
    pitchChannel: "email" as const,
  };

  function fetchMockPass() {
    return vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use", name: "submit_verdict", input: { pass: true, score: 1, reasoning: "ok", issues: [] } }] }));
  }

  it("tells every reviewer this is a partnership pitch, including the recipient and channel -- never the generic post/reply framing", async () => {
    const fetchMock = fetchMockPass();
    const client = new LlmClient("test-key", fetchMock);

    await runReviewAgent(client, "growth_strategist", "Hi Dana -- ...", pitchContext);

    const userMessage = JSON.parse(fetchMock.mock.calls[0]![1].body as string).messages[0].content as string;
    expect(userMessage).toContain("PARTNERSHIP PITCH");
    expect(userMessage).toContain("Apex Journaling Coach LLC");
    expect(userMessage).toContain("email");
    expect(userMessage).not.toContain("REPLY to a real X user's mention");
  });

  it("uses the X DM wording (not email) when pitchChannel is x", async () => {
    const fetchMock = fetchMockPass();
    const client = new LlmClient("test-key", fetchMock);

    await runReviewAgent(client, "hook_specialist", "Hi Jordan -- ...", { ...pitchContext, pitchChannel: "x" });

    const userMessage = JSON.parse(fetchMock.mock.calls[0]![1].body as string).messages[0].content as string;
    expect(userMessage).toContain("X DM");
  });

  it("hook_specialist, growth_strategist, conversion_reviewer, and fact_checker each carry real partnership-pitch guidance in their own system prompt", async () => {
    const pitchAwareAgents = ["hook_specialist", "growth_strategist", "conversion_reviewer", "fact_checker"] as const;
    for (const agent of pitchAwareAgents) {
      const fetchMock = fetchMockPass();
      const client = new LlmClient("test-key", fetchMock);
      await runReviewAgent(client, agent, "some pitch text", pitchContext);
      const systemPrompt = systemText(fetchMock.mock.calls[0]![1]);
      expect(systemPrompt).toContain("PARTNERSHIP PITCH");
    }
  });

  it("conversion_reviewer is asked to judge the pitch's ask, not a generic CTA", async () => {
    const fetchMock = fetchMockPass();
    const client = new LlmClient("test-key", fetchMock);

    await runReviewAgent(client, "conversion_reviewer", "Would you be open to a quick call?", pitchContext);

    const systemPrompt = systemText(fetchMock.mock.calls[0]![1]);
    expect(systemPrompt).toContain("PARTNERSHIP PITCH");
    expect(systemPrompt.toLowerCase()).toContain("proportionate");
  });
});

describe("normalizeIssues", () => {
  it("accepts every shape the model has returned for issues", async () => {
    const { normalizeIssues } = await import("../src/content/reviewAgents");
    expect(normalizeIssues(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeIssues("one issue")).toEqual(["one issue"]);
    expect(normalizeIssues('["x", "y"]')).toEqual(["x", "y"]);
    expect(normalizeIssues("")).toEqual([]);
    expect(normalizeIssues(undefined)).toEqual([]);
    expect(normalizeIssues(null)).toEqual([]);
  });
});
