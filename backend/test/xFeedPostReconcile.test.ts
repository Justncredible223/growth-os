import { describe, expect, it } from "vitest";
import { matchDraftToTweet, normalizeForMatch, reconcilePostedDrafts, wordOverlap, type OwnTweetRow } from "../src/content/xFeedPostReconcile";
import type { XFeedPostRun } from "../src/content/dailyXFeedPost";

const DRAFT = "Up $1,500 by 11am on a trailing drawdown account? Check whether your floor trails intraday or locks at the close.\n\nIntraday trailing follows your unrealized peak.";
const tweet = (over: Partial<OwnTweetRow>): OwnTweetRow => ({ tweet_id: "t1", text: DRAFT, created_at: "2026-11-08T17:00:00Z", in_reply_to_tweet_id: null, ...over });
const run = (over: Partial<XFeedPostRun>): XFeedPostRun => ({ operatingDate: "2026-11-08", status: "ready", campaignAssetId: "a1", postedAt: null, ...over }) as XFeedPostRun;

describe("matching a draft to the account's own tweets", () => {
  it("ignores case, links and spacing", () => {
    expect(normalizeForMatch("Hello   WORLD https://t.co/abc")).toBe("hello world");
    expect(wordOverlap(DRAFT, DRAFT.toUpperCase() + " https://t.co/xyz")).toBe(1);
  });

  it("matches the same post after a small edit, and rejects a different post", () => {
    const edited = DRAFT.replace("Check whether", "Check if");
    expect(matchDraftToTweet(DRAFT, [tweet({ text: edited })])).not.toBeNull();
    expect(matchDraftToTweet(DRAFT, [tweet({ text: "Journal two lines after each session and review the week on Friday." })])).toBeNull();
  });

  it("never matches a reply", () => {
    expect(matchDraftToTweet(DRAFT, [tweet({ in_reply_to_tweet_id: "999" })])).toBeNull();
  });
});

describe("reconcilePostedDrafts", () => {
  function deps(runs: XFeedPostRun[], tweets: OwnTweetRow[], drafts: Record<string, string>) {
    const marked: Array<{ date: string; at: string; text: string }> = [];
    return {
      marked,
      d: {
        listRecentRuns: async () => runs,
        markPosted: async (date: string, at: string, text: string) => void marked.push({ date, at, text }),
        draftTextFor: async (id: string) => drafts[id] ?? null,
        ownTweetsSince: async () => tweets,
      },
    };
  }
  const now = new Date("2026-11-09T12:00:00Z");

  it("marks an unposted draft as posted with the tweet's real time and text", async () => {
    const x = deps([run({})], [tweet({})], { a1: DRAFT });
    const out = await reconcilePostedDrafts(x.d, now);
    expect(out).toMatchObject({ checked: 1, matched: 1, markedDates: ["2026-11-08"] });
    expect(x.marked).toEqual([{ date: "2026-11-08", at: "2026-11-08T17:00:00Z", text: DRAFT }]);
  });

  it("leaves a draft alone when nothing matches, when it is already posted, dismissed or failed", async () => {
    const x = deps(
      [run({ operatingDate: "2026-11-08" }), run({ operatingDate: "2026-11-07", postedAt: "2026-11-07T10:00:00Z" }), run({ operatingDate: "2026-11-06", dismissed: true }), run({ operatingDate: "2026-11-05", status: "failed" })],
      [tweet({ text: "Something else entirely about journaling habits and weekly reviews that nobody drafted." })],
      { a1: DRAFT },
    );
    const out = await reconcilePostedDrafts(x.d, now);
    expect(out.checked).toBe(1);
    expect(out.matched).toBe(0);
    expect(x.marked).toHaveLength(0);
  });

  it("uses one tweet for one day only", async () => {
    const x = deps([run({ operatingDate: "2026-11-08" }), run({ operatingDate: "2026-11-07", campaignAssetId: "a2" })], [tweet({})], { a1: DRAFT, a2: DRAFT });
    const out = await reconcilePostedDrafts(x.d, now);
    expect(out.matched).toBe(1);
  });
});
