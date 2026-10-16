import { describe, it, expect, vi } from "vitest";
import { LlmClient, MODEL_HAIKU } from "../src/content/llmClient";
import {
  draftProspectingReply,
  checkRelevanceCheap,
  buildProspectingSystemPrompt,
  prospectingPlatformProfile,
  PROSPECTING_TRACKABLE_LINK,
} from "../src/prospecting/prospectingReplyWriter";
import { FILLBOOK_SHOWCASE_VIEWS } from "../src/content/fillbookShowcase";

/** The system value is a plain string, or an array of text blocks when prompt caching is on. */
function systemText(system: unknown): string {
  return Array.isArray(system) ? system.map((block: { text: string }) => block.text).join(" ") : (system as string);
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function replyResponse(reply: string, mentionsFillbook: boolean, usesLink: boolean, isRelevant = true) {
  return jsonResponse({ content: [{ type: "tool_use", name: "submit_reply", input: { isRelevant, reply, mentionsFillbook, usesLink } }] });
}

async function capturePrompt(platform: string, extra: Partial<Parameters<typeof draftProspectingReply>[1]> = {}) {
  const fetchMock = vi.fn().mockResolvedValue(replyResponse("...", false, false));
  const llmClient = new LlmClient("test-key", fetchMock);
  await draftProspectingReply(llmClient, { platform, authorHandle: "someone", postText: "hi", discoveryQuery: "drawdown", ...extra }, "", "");
  const [, options] = fetchMock.mock.calls[0]!;
  const body = JSON.parse((options as { body: string }).body);
  return { system: systemText(body.system), user: body.messages[0].content as string };
}

/** The single-style prompt (PROSPECTING_TWO_OPTION_DRAFTS off), which is what these assertions were written against. */
function singleStyleSystem(platform: string): { system: string } {
  return { system: buildProspectingSystemPrompt(prospectingPlatformProfile(platform)) };
}

describe("draftProspectingReply", () => {
  it("passes the real post text, author handle, and discovery topic into the prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyResponse("Most firms reset at end of day, worth checking your rulebook.", false, false));
    const llmClient = new LlmClient("test-key", fetchMock);

    const result = await draftProspectingReply(
      llmClient,
      { platform: "x", authorHandle: "someTrader", postText: "does trailing drawdown reset daily or lock in?", discoveryQuery: "trailing_drawdown" },
      "voice: concise",
      "",
    );

    expect(result).toEqual({
      isRelevant: true,
      reply: "Most firms reset at end of day, worth checking your rulebook.",
      mentionsFillbook: false,
      usesLink: false,
    });
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.messages[0].content).toContain("From: @someTrader");
    expect(body.messages[0].content).toContain("does trailing drawdown reset daily or lock in?");
    expect(body.messages[0].content).toContain("trailing_drawdown");
  });

  it("does not fabricate an author handle when none is known", async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyResponse("Good question.", false, false));
    const llmClient = new LlmClient("test-key", fetchMock);

    await draftProspectingReply(llmClient, { platform: "x", authorHandle: null, postText: "hi", discoveryQuery: "drawdown" }, "", "");

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.messages[0].content).toContain("From: @unknown");
  });

  it("REFINED (2026-09-25): on X, a reply to a problem Fillbook answers shows what Fillbook would show them, as the point of the reply rather than an aside", async () => {
    const { system } = singleStyleSystem("x");

    expect(system).not.toMatch(/90%\+/);
    expect(system).not.toContain("thoughtful trader or builder joining the conversation");
    expect(system).not.toContain("Conversation beats performing expertise");
    expect(system).toContain("show them what Fillbook would\nshow them about that exact problem");
    expect(system).toContain("The Fillbook sentence is the point of the reply, not an aside");
    expect(system).toMatch(/When NO view fits/);
    expect(system).toContain("never \"check it out\"");
    expect(system).toContain("Never impersonate an individual trader or conceal");
  });

  it("lists every verified Fillbook view with what it shows, so the reply can only describe real screens", async () => {
    const { system } = singleStyleSystem("x");

    for (const view of FILLBOOK_SHOWCASE_VIEWS) {
      expect(system).toContain(`- ${view.id}: for ${view.problems}. Fillbook shows ${view.shows}.`);
    }
    expect(system).toMatch(/Worked examples/);
    expect(system).toMatch(/never copy these/);
  });

  it("asks the model to declare which view it showed, or none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyResponse("x", false, false));
    const llmClient = new LlmClient("test-key", fetchMock);
    await draftProspectingReply(llmClient, { platform: "x", authorHandle: null, postText: "hi", discoveryQuery: "drawdown" }, "", "");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    const schema = body.tools[0].input_schema;
    expect(schema.required).toContain("showcase");
    expect(schema.properties.showcase.enum).toEqual([...FILLBOOK_SHOWCASE_VIEWS.map((view) => view.id), "none"]);
  });

  it("an unrecognized platform also keeps the conservative default, never X's more structured one", async () => {
    const { system } = singleStyleSystem("mastodon");
    expect(system).toMatch(/90%\+/);
  });

  it("passes through the model's own mentionsFillbook/usesLink flags rather than inferring them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(replyResponse("Fillbook actually tracks that automatically -- fillbookhq.com/go/prospecting", true, true));
    const llmClient = new LlmClient("test-key", fetchMock);

    const result = await draftProspectingReply(
      llmClient,
      { platform: "x", authorHandle: "trader1", postText: "wish I had a way to track this automatically", discoveryQuery: "trading_journal" },
      "",
      "",
    );

    expect(result.mentionsFillbook).toBe(true);
    expect(result.usesLink).toBe(true);
  });

  /**
   * Regression coverage for a real, confirmed bug: the model had no
   * structured way to say "this post doesn't actually fit" except by
   * writing that admission into the reply text itself (e.g. "this event
   * isn't futures related"), which then got shown to the owner as if it
   * were a usable draft. isRelevant is the model's own escape hatch --
   * the prompt instructs it to judge honestly, and the caller
   * (prospectingHandlers.ts) checks the flag before ever persisting or
   * returning a draft.
   */
  describe("isRelevant", () => {
    it("passes through the model's own isRelevant=true", async () => {
      const fetchMock = vi.fn().mockResolvedValue(replyResponse("Good question.", false, false, true));
      const llmClient = new LlmClient("test-key", fetchMock);

      const result = await draftProspectingReply(llmClient, { platform: "x", authorHandle: "someone", postText: "hi", discoveryQuery: "drawdown" }, "", "");

      expect(result.isRelevant).toBe(true);
    });

    it("passes through the model's own isRelevant=false, with an empty reply, rather than inferring relevance", async () => {
      const fetchMock = vi.fn().mockResolvedValue(replyResponse("", false, false, false));
      const llmClient = new LlmClient("test-key", fetchMock);

      const result = await draftProspectingReply(
        llmClient,
        { platform: "x", authorHandle: "someone", postText: "a sci-fi story about an algorithm and a civilization", discoveryQuery: "hesitation_trading" },
        "",
        "",
      );

      expect(result.isRelevant).toBe(false);
      expect(result.reply).toBe("");
    });

    it("the system prompt instructs the model to judge relevance honestly FIRST, before writing anything", async () => {
      const { system } = await capturePrompt("x");

      expect(system).toMatch(/judge isRelevant honestly/i);
      expect(system).toContain("set isRelevant=false");
      expect(system).toMatch(/confident "this isn't relevant" is the correct, expected outcome/i);
    });
  });

  describe("platform awareness", () => {
    it("an X candidate is framed as an X post with X's short-reply shape and the trackable link", async () => {
      const { system, user } = await capturePrompt("x");

      expect(system).toContain("public X post on X");
      expect(system).toContain("Shape for X:");
      expect(system).toContain("one or two sentences");
      expect(system).toContain(PROSPECTING_TRACKABLE_LINK);
      expect(system).not.toContain("Reddit");
      expect(user).toContain("Platform: X");
      expect(user).toContain("From: @someone");
    });

    it("an unknown platform gets a neutral profile instead of X language or a crash", async () => {
      const { system, user } = await capturePrompt("mastodon");

      expect(system).toContain("public mastodon post on mastodon");
      expect(system).not.toContain("X post");
      expect(user).toContain("Platform: mastodon");
    });

    it("platform lookup is case-insensitive and every profile pins the single allowed link", () => {
      expect(prospectingPlatformProfile("X").displayName).toBe("X");
      for (const platform of ["x", "unknown"]) {
        const profile = prospectingPlatformProfile(platform);
        expect(profile.trackableLink).toBe(PROSPECTING_TRACKABLE_LINK);
        expect(buildProspectingSystemPrompt(profile)).toContain(PROSPECTING_TRACKABLE_LINK);
      }
    });
  });
});

/**
 * checkRelevanceCheap is a cheap (MODEL_HAIKU), relevance-only precheck
 * that runs before the expensive full draftProspectingReply call -- it
 * asks the same "is this genuinely relevant" question alone, with no
 * reply drafted, so a candidate that turns out irrelevant is rejected for
 * a fraction of the cost of a full draft.
 */
describe("checkRelevanceCheap", () => {
  function relevanceResponse(isRelevant: boolean) {
    return jsonResponse({ content: [{ type: "tool_use", name: "submit_relevance", input: { isRelevant } }] });
  }

  it("calls the Claude API on MODEL_HAIKU, not the default drafting model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(relevanceResponse(true));
    const llmClient = new LlmClient("test-key", fetchMock);

    await checkRelevanceCheap(llmClient, { platform: "x", authorHandle: "someone", postText: "does trailing drawdown reset daily?", discoveryQuery: "trailing_drawdown" });

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.model).toBe(MODEL_HAIKU);
  });

  it("returns true when the model judges the post relevant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(relevanceResponse(true));
    const llmClient = new LlmClient("test-key", fetchMock);

    const result = await checkRelevanceCheap(llmClient, { platform: "x", authorHandle: "someone", postText: "Been trading MNQ futures for two years.", discoveryQuery: "futures" });

    expect(result).toBe(true);
  });

  it("returns false when the model judges the post irrelevant, without ever drafting a reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(relevanceResponse(false));
    const llmClient = new LlmClient("test-key", fetchMock);

    const result = await checkRelevanceCheap(llmClient, { platform: "x", authorHandle: "someone", postText: "a sci-fi story about an algorithm and a civilization", discoveryQuery: "hesitation_trading" });

    expect(result).toBe(false);
  });

  it("passes the post text and discovery topic into the prompt, but never sends brand rules or verified knowledge (kept minimal on purpose)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(relevanceResponse(true));
    const llmClient = new LlmClient("test-key", fetchMock);

    await checkRelevanceCheap(llmClient, { platform: "x", authorHandle: "someone", postText: "does trailing drawdown reset daily?", discoveryQuery: "trailing_drawdown" });

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.messages[0].content).toContain("does trailing drawdown reset daily?");
    expect(body.messages[0].content).toContain("trailing_drawdown");
    expect(body.max_tokens).toBeLessThanOrEqual(256);
  });
});

describe("draftProspectingReply prompt caching", () => {
  it("marks the large static system prompt for caching and leaves the post text out of it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyResponse("EOD for most firms.", false, false));
    await draftProspectingReply(new LlmClient("test-key", fetchMock), { platform: "x", authorHandle: "a", postText: "UNIQUE-POST-TEXT", discoveryQuery: "drawdown" }, "rules", "facts");

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    // Anything per-request in the cached block would change it every call and defeat the cache.
    expect(body.system[0].text).not.toContain("UNIQUE-POST-TEXT");
  });

  it("sends an identical system block for two different posts, so the second call can hit the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(replyResponse("EOD for most firms.", false, false));
    const client = new LlmClient("test-key", fetchMock);
    await draftProspectingReply(client, { platform: "x", authorHandle: "a", postText: "first post", discoveryQuery: "q1" }, "rules", "facts");
    await draftProspectingReply(client, { platform: "x", authorHandle: "b", postText: "second post", discoveryQuery: "q2", retryFeedback: "too long" }, "rules", "facts");

    const system = (i: number) => JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body).system[0].text;
    expect(system(0)).toBe(system(1));
  });

  it("keeps the cheap relevance check uncached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "tool_use", name: "submit_relevance", input: { isRelevant: true } }] }));
    await checkRelevanceCheap(new LlmClient("test-key", fetchMock), { platform: "x", authorHandle: "a", postText: "hi", discoveryQuery: "q" });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(typeof body.system).toBe("string");
  });
});
