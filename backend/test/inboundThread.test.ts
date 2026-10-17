import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabaseClient } from "./helpers/fakeSupabase";
import { MAX_THREAD_TURNS, buildInboundThread, formatThread } from "../src/inbound/inboundThread";
import { assessInboundDraft, LACKS_CONTEXT } from "../src/inbound/inboundDraftPolicy";
import { LlmClient } from "../src/content/llmClient";
import { draftInboundResponse } from "../src/inbound/inboundResponseWriter";
import type { InboundEngagement } from "../src/inbound/types";

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

function row(over: Partial<InboundEngagement> = {}): InboundEngagement {
  return {
    id: "row-now",
    platform: "x",
    externalId: "t-now",
    conversationId: "conv-1",
    inReplyToExternalId: "t-ours",
    authorHandle: "dontlovedave",
    authorExternalId: "u1",
    creatorId: null,
    body: "@FillbookHQ how so",
    inResponseToText: null,
    publicMetrics: {},
    priority: "p1_direct_reply",
    status: "needs_response",
    draftResponse: null,
    draftUsesLink: null,
    respondedAt: null,
    respondedNote: null,
    isRepeatEngager: true,
    observedAt: "2026-10-17T19:32:00Z",
    sourceReference: null,
    createdAt: "x",
    updatedAt: "x",
    ...over,
  };
}

const inboundRow = (o: Record<string, unknown>) => ({ id: `r-${o.external_id}`, platform: "x", status: "responded", draft_response: null, final_response: null, in_reply_to_external_id: null, ...o });

describe("buildInboundThread: the exact case from the owner's screenshot", () => {
  const fake = new FakeSupabaseClient({
    prospecting_candidates: [{ id: "cand-1", author_handle: "dontlovedave", post_text: "well, in addition to my sad niche i'll use this medium as my trading journal." }],
    x_own_posts: [
      { tweet_id: "t-ours", kind: "reply", text: "X is the worst journal format. You can't search your own posts and threads disappear in three days.", created_at: "2026-10-17T02:00:00Z", in_reply_to_tweet_id: "t-orig", prospecting_candidate_id: "cand-1" },
    ],
    inbound_engagements: [],
  });

  it("gives the drafter the post we replied to and what we said, so 'how so' is a question about our own line", async () => {
    const thread = await buildInboundThread(asClient(fake), row());
    expect(thread.map((t) => t.who)).toEqual(["original", "us"]);
    expect(thread[0]!.handle).toBe("dontlovedave");
    expect(thread[1]!.text).toContain("X is the worst journal format");
    expect(formatThread(thread)).toBe(
      "@dontlovedave (the post we replied to): well, in addition to my sad niche i'll use this medium as my trading journal.\nFillbook (us): X is the worst journal format. You can't search your own posts and threads disappear in three days.",
    );
  });

  it("puts the thread into the prompt, in place of the empty parent text", async () => {
    const thread = formatThread(await buildInboundThread(asClient(fake), row()));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "submit_reply", input: { reply: "x", usesLink: false } }] }), text: async () => "" } as Response);
    await draftInboundResponse(new LlmClient("k", fetchMock), { platform: "x", authorHandle: "dontlovedave", messageText: "@FillbookHQ how so", inResponseToText: null, thread, isRepeatEngager: true, priorInteractionCount: 1 }, "voice", "");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    const user = body.messages[0].content as string;
    expect(user).toContain("The conversation so far (oldest first");
    expect(user).toContain("Fillbook (us): X is the worst journal format");
    expect(user).not.toContain("no parent post text available");
  });
});

describe("buildInboundThread: a longer back-and-forth", () => {
  it("rebuilds reply, reply to our reply, and a reply to that, oldest first", async () => {
    const fake = new FakeSupabaseClient({
      prospecting_candidates: [{ id: "c1", author_handle: "peter", post_text: "You want trading to pay your rent, but you no get a trading journal!" }],
      x_own_posts: [
        { tweet_id: "our1", kind: "reply", text: "The pattern shows up clearest in win rate by setup.", created_at: "2026-10-16T22:00:00Z", in_reply_to_tweet_id: "peter-post", prospecting_candidate_id: "c1" },
        { tweet_id: "our2", kind: "reply", text: "Sort by setup and look at the worst one first.", created_at: "2026-10-17T02:00:00Z", in_reply_to_tweet_id: "them2", prospecting_candidate_id: null },
      ],
      inbound_engagements: [
        inboundRow({ external_id: "them1", conversation_id: "conv-9", author_handle: "peter", body: "Exactly u have a point", in_reply_to_external_id: "our1", observed_at: "2026-10-16T23:00:00Z" }),
        inboundRow({ external_id: "them2", conversation_id: "conv-9", author_handle: "peter", body: "ok but how do I sort it", in_reply_to_external_id: "our1", observed_at: "2026-10-17T01:00:00Z" }),
      ],
    });
    const current = row({ externalId: "them3", conversationId: "conv-9", inReplyToExternalId: "our2", observedAt: "2026-10-17T05:00:00Z", authorHandle: "peter", body: "got it, thanks" });
    const thread = await buildInboundThread(asClient(fake), current);
    expect(thread.map((t) => `${t.who}:${t.text.split(" ").slice(0, 3).join(" ")}`)).toEqual([
      "original:You want trading",
      "us:The pattern shows",
      "them:Exactly u have",
      "them:ok but how",
      "us:Sort by setup",
    ]);
  });

  it("covers a reply we posted but x_own_posts has not read back yet, using the owner's final wording", async () => {
    const fake = new FakeSupabaseClient({
      x_own_posts: [],
      inbound_engagements: [
        inboundRow({ external_id: "m1", conversation_id: "conv-2", author_handle: "sam", body: "do you track drawdown?", observed_at: "2026-10-17T10:00:00Z", status: "responded", draft_response: "Yes, both limits.", final_response: "Yes, both the trailing floor and the daily limit." }),
      ],
    });
    const current = row({ externalId: "m2", conversationId: "conv-2", inReplyToExternalId: "unknown-tweet", observedAt: "2026-10-17T11:00:00Z", authorHandle: "sam", body: "which firms?" });
    const thread = await buildInboundThread(asClient(fake), current);
    expect(thread.map((t) => t.who)).toEqual(["them", "us"]);
    expect(thread[1]!.text).toBe("Yes, both the trailing floor and the daily limit.");
  });

  it("does not list a message twice when it is found by both routes, and keeps only the newest turns", async () => {
    const posts = Array.from({ length: 12 }, (_, i) => ({ tweet_id: `o${i}`, kind: "reply", text: `our line ${i}`, created_at: `2026-10-1${i % 10}T0${i % 10}:00:00Z`, in_reply_to_tweet_id: i === 0 ? null : `o${i - 1}`, prospecting_candidate_id: null }));
    const fake = new FakeSupabaseClient({ x_own_posts: posts, inbound_engagements: [] });
    const thread = await buildInboundThread(asClient(fake), row({ inReplyToExternalId: "o11", conversationId: null }));
    expect(thread.length).toBeLessThanOrEqual(MAX_THREAD_TURNS);
    expect(new Set(thread.map((t) => t.text)).size).toBe(thread.length);
  });

  it("is empty for a first message, an unknown parent, a loop, or a non-X row, and never throws on a read error", async () => {
    const empty = new FakeSupabaseClient({ x_own_posts: [], inbound_engagements: [] });
    expect(await buildInboundThread(asClient(empty), row({ inReplyToExternalId: null, conversationId: null }))).toEqual([]);
    expect(await buildInboundThread(asClient(empty), row({ inReplyToExternalId: "nope", conversationId: null }))).toEqual([]);
    expect(await buildInboundThread(asClient(empty), row({ platform: "youtube" }))).toEqual([]);
    const loop = new FakeSupabaseClient({
      x_own_posts: [{ tweet_id: "a", kind: "reply", text: "A", created_at: "2026-10-17T00:00:00Z", in_reply_to_tweet_id: "b", prospecting_candidate_id: null }, { tweet_id: "b", kind: "reply", text: "B", created_at: "2026-10-17T01:00:00Z", in_reply_to_tweet_id: "a", prospecting_candidate_id: null }],
      inbound_engagements: [],
    });
    expect((await buildInboundThread(asClient(loop), row({ inReplyToExternalId: "a", conversationId: null }))).length).toBe(2);
    const broken = new FakeSupabaseClient({});
    broken.failTable("x_own_posts", { message: "relation does not exist" });
    await expect(buildInboundThread(asClient(broken), row({ conversationId: null }))).resolves.toEqual([]);
  });
});

describe("a draft that gives up is refused", () => {
  it("rejects replies that say they lack context", () => {
    for (const reply of ["I don't have context for what you're asking about.", "I can't see the thread, which part do you mean?", "Not sure what you're asking about.", "No context here, sorry."]) {
      expect(LACKS_CONTEXT.test(reply), reply).toBe(true);
      expect(assessInboundDraft({ reply, usesLink: false }, { messageText: "how so" }).hard, reply).toMatch(/lacks context|cannot see the conversation/);
    }
  });

  it("lets a real answer or a short clarifying question through", () => {
    for (const reply of ["Because you can't filter your own posts by setup, so a month of trades stays a scroll.", "Which part do you mean?"]) {
      expect(LACKS_CONTEXT.test(reply), reply).toBe(false);
      expect(assessInboundDraft({ reply, usesLink: false }, { messageText: "how so" }).hard, reply).toBeNull();
    }
  });
});
