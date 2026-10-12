import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSupabaseClient, asSupabase } from "./helpers/fakeSupabase";
import { ingestInboundMentions } from "../src/inbound/inboundIngestion";
import { InMemoryInboundRepository } from "../src/inbound/inMemoryInboundRepository";
import { InMemoryIngestionCursorStore } from "../src/signals/adapters/ingestionCursorStore";
import { closeOwnAccountItems, isOwnAccountAuthor, OWN_ACCOUNT_NOTE } from "../src/inbound/ownAccount";
import { draftResponseForInbound, listInbound, summarizeInbound, InboundActionError } from "../src/inbound/inboundHandlers";
import { assessInboundDraft } from "../src/inbound/inboundDraftPolicy";
import { draftInboundResponse, buildInboundSystemPrompt } from "../src/inbound/inboundResponseWriter";
import { LlmClient } from "../src/content/llmClient";
import { draftWithRetries, containsFalseGiveawayClaim, containsOwnPostImpersonationClaim } from "../src/content/xReplyGuardrails";
import type { XMention } from "../src/signals/adapters/xAdapter";

const OUR_ID = "our-id";
const GIVEAWAY_TEXT = "GIVEAWAY: Win a free year of Fillbook Elite ($399.90 value). Follow @FillbookHQ and enter at fillbookhq.com/giveaway";

function mention(o: Partial<XMention> & Pick<XMention, "id" | "text">): XMention {
  return { authorId: "u-1", authorHandle: "someTrader", createdAt: new Date("2026-10-12T12:00:00Z"), publicMetrics: null, inReplyToUserId: null, conversationId: null, referencedTweets: [], ...o };
}
function deps(mentions: XMention[]) {
  return {
    adapter: { fetchOwnMentions: async () => mentions } as any,
    repo: new InMemoryInboundRepository(),
    findCreatorIdByHandle: async () => null,
  };
}
function row(o: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: "eng-1", platform: "x", external_id: "ext-1", conversation_id: null, in_reply_to_external_id: null, author_handle: "someTrader",
    author_external_id: "user-1", creator_id: null, body: "how does trailing drawdown work?", in_response_to_text: null, public_metrics: {},
    priority: "p4_mention", status: "needs_response", draft_response: null, draft_uses_link: null, responded_at: null, responded_note: null,
    is_repeat_engager: false, observed_at: now, source_reference: null, created_at: now, updated_at: now, ...o,
  };
}
function toolResponse(reply: string, usesLink = false) {
  return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "submit_reply", input: { reply, usesLink } }], usage: { input_tokens: 1, output_tokens: 1 } }), text: async () => "" } as Response;
}
function base(externalId: string, handle: string, authorId: string) {
  return {
    platform: "x", externalId, conversationId: null, inReplyToExternalId: null, authorHandle: handle, authorExternalId: authorId, creatorId: null,
    body: "hello", inResponseToText: null, publicMetrics: {}, priority: "p4_mention" as const, status: "needs_response" as const, draftResponse: null,
    draftUsesLink: null, respondedAt: null, respondedNote: null, isRepeatEngager: false, observedAt: new Date().toISOString(), sourceReference: null,
  };
}

describe("own-account check", () => {
  it("matches by id or case-insensitive handle, never a lookalike", () => {
    expect(isOwnAccountAuthor({ platform: "x", authorHandle: "FillbookHQ" })).toBe(true);
    expect(isOwnAccountAuthor({ platform: "x", authorHandle: "@FILLBOOKHQ" })).toBe(true);
    expect(isOwnAccountAuthor({ platform: "x", authorId: OUR_ID, authorHandle: null }, { userId: OUR_ID })).toBe(true);
    expect(isOwnAccountAuthor({ platform: "x", authorHandle: "FillbookHQ_" })).toBe(false);
    expect(isOwnAccountAuthor({ platform: "x", authorHandle: "Fi11bookHQ" })).toBe(false);
    expect(isOwnAccountAuthor({ platform: "youtube", authorHandle: "FillbookHQ" })).toBe(false);
  });
});

describe("ingestion skips self-authored posts", () => {
  const now = new Date("2026-10-12T13:00:00Z");

  it("skips by handle (case-insensitive) and by id, and still stores other authors", async () => {
    const d = deps([
      mention({ id: "1", text: GIVEAWAY_TEXT, authorId: "x", authorHandle: "FILLBOOKHQ" }),
      mention({ id: "2", text: "self reply", authorId: OUR_ID, authorHandle: null }),
      mention({ id: "3", text: "is this real?", authorId: "u-9", authorHandle: "realUser" }),
    ]);
    const result = await ingestInboundMentions(d, new InMemoryIngestionCursorStore(), OUR_ID, now);
    expect(result).toMatchObject({ fetched: 3, inserted: 1, skippedOwnAccount: 2 });
    expect(d.repo.all().map((r) => r.externalId)).toEqual(["3"]);
  });

  it("a lookalike handle posting the same text IS still stored and flagged for response", async () => {
    const d = deps([
      mention({ id: "1", text: GIVEAWAY_TEXT, authorId: "evil-1", authorHandle: "FillbookHQ_" }),
      mention({ id: "2", text: GIVEAWAY_TEXT, authorId: "evil-2", authorHandle: "Fi11bookHQ" }),
    ]);
    const result = await ingestInboundMentions(d, new InMemoryIngestionCursorStore(), OUR_ID, now);
    expect(result.inserted).toBe(2);
    expect(d.repo.all().every((r) => r.status === "needs_response")).toBe(true);
  });

  it("closes already-stored self-authored rows, idempotently, leaving other authors untouched", async () => {
    const d = deps([]);
    const own = await d.repo.upsertIfNew({ ...base("own-1", "FillbookHQ", "x"), body: GIVEAWAY_TEXT });
    await d.repo.upsertIfNew(base("other-1", "someTrader", "u-5"));
    const first = await ingestInboundMentions(d, new InMemoryIngestionCursorStore(), OUR_ID, now);
    expect(first.closedOwnAccount).toBe(1);
    const closed = await d.repo.getById(own.id);
    expect(closed).toMatchObject({ status: "closed", respondedNote: OWN_ACCOUNT_NOTE, body: GIVEAWAY_TEXT });
    const second = await ingestInboundMentions(d, new InMemoryIngestionCursorStore(), OUR_ID, now);
    expect(second.closedOwnAccount).toBeUndefined();
    expect(d.repo.all().find((r) => r.externalId === "other-1")!.status).toBe("needs_response");
    expect(d.repo.all()).toHaveLength(2); // nothing deleted
    expect(await closeOwnAccountItems(d.repo)).toEqual([]);
  });
});

describe("stored self-authored item on queue load and drafting", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is excluded from the needs-response queue and summary, closed with 'own account', and not deleted", async () => {
    const client = new FakeSupabaseClient({
      inbound_engagements: [
        row({ id: "own", author_handle: "FillbookHQ", author_external_id: "any", body: GIVEAWAY_TEXT, draft_response: "This is an impersonation account.", status: "draft_ready" }),
        row({ id: "lookalike", author_handle: "FillbookHQ_", author_external_id: "evil", body: GIVEAWAY_TEXT }),
        row({ id: "real", author_handle: "someTrader", author_external_id: "u2" }),
      ],
      creators: [],
    });
    const items = await listInbound(asSupabase(client));
    expect(items.map((i) => i.id).sort()).toEqual(["lookalike", "real"]);
    expect((await summarizeInbound(asSupabase(client))).needsResponse).toBe(2);
    const stored = client.tables.inbound_engagements!.find((r) => r.id === "own")!;
    expect(stored).toMatchObject({ status: "closed", responded_note: "own account", draft_response: "This is an impersonation account." });
    expect(client.tables.inbound_engagements).toHaveLength(3);
  });

  it("never drafts for a self-authored item", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(toolResponse("anything"));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new FakeSupabaseClient({
      inbound_engagements: [row({ id: "own", author_handle: "fillbookhq", body: GIVEAWAY_TEXT })],
      brand_rules: [],
      knowledge_documents: [],
      cost_events: [],
    });
    await expect(draftResponseForInbound(asSupabase(client), "own")).rejects.toThrow(InboundActionError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.tables.inbound_engagements![0]).toMatchObject({ status: "closed", responded_note: "own account", draft_response: null });
  });
});

describe("giveaway knowledge and guardrails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("system prompt carries the true giveaway facts and forbids denying them", () => {
    const prompt = buildInboundSystemPrompt("x");
    expect(prompt).toContain("fillbookhq.com/giveaway");
    expect(prompt).toContain("$399.90");
    expect(prompt).toContain("NOT an impersonation");
    expect(prompt).toContain("NEVER write that Fillbook does not run giveaways");
  });

  it("a user asking 'is this giveaway real?' gets an accurate draft pointing at fillbookhq.com/giveaway", async () => {
    const question = "is this giveaway real? looks too good to be true";
    const good = "Yes, it's real. It's free to enter and the official rules are at fillbookhq.com/giveaway.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolResponse("This is an impersonation account. Fillbook does not run giveaways and does not ask anyone to follow or enter."))
      .mockResolvedValueOnce(toolResponse("Yes it is real, check the details on our page.", false))
      .mockResolvedValueOnce(toolResponse(good, true));
    const llm = new LlmClient("test-key", fetchMock);
    const { draft } = await draftWithRetries({
      generate: (retryFeedback) =>
        draftInboundResponse(
          llm,
          { platform: "x", authorHandle: "realUser", messageText: question, inResponseToText: null, isRepeatEngager: false, priorInteractionCount: 0, ...(retryFeedback ? { retryFeedback } : {}) },
          "",
          "",
        ),
      assess: (c) => assessInboundDraft(c, { messageText: question }),
    });
    expect(draft?.reply).toBe(good);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const bad of ["does not run giveaways", "impersonation", "does not ask anyone to follow", "shorteners"]) {
      expect(draft!.reply).not.toContain(bad);
    }
  });

  it("rejects false claims regardless of phrasing", () => {
    for (const text of [
      "Fillbook does not run giveaways for 'Elite' or any plan.",
      "We never run giveaways.",
      "Fillbook doesn't ask anyone to follow or enter at a link.",
      "Fillbook does not use throwaway shorteners.",
      "That giveaway is fake.",
    ]) {
      expect(containsFalseGiveawayClaim(text), text).not.toBeNull();
    }
    expect(containsFalseGiveawayClaim("Yes it's real, rules at fillbookhq.com/giveaway.")).toBeNull();
    expect(containsFalseGiveawayClaim("We will never ask you to enter your password.")).toBeNull();
  });

  it("rejects impersonation framing for a self post, and the policy rejects drafting at all", () => {
    expect(containsOwnPostImpersonationClaim("This is an impersonation account.")).not.toBeNull();
    const verdict = assessInboundDraft({ reply: "Thanks for entering.", usesLink: false }, { messageText: GIVEAWAY_TEXT, authorIsOwnAccount: true });
    expect(verdict.hard).toMatch(/own account/);
  });

  it("a lookalike posting the giveaway text may still be called out, and other domains stay rejected", () => {
    const ok = assessInboundDraft({ reply: "That is not our account. The only official page is fillbookhq.com/giveaway.", usesLink: true }, { messageText: GIVEAWAY_TEXT });
    expect(ok.hard).toBeNull();
    const bad = assessInboundDraft({ reply: "Go to scam.example.com/giveaway", usesLink: true }, { messageText: GIVEAWAY_TEXT });
    expect(bad.hard).not.toBeNull();
  });
});
