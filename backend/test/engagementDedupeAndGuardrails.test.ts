import { describe, expect, it } from "vitest";
import { findNearDuplicate, normalizeForDedupe, selectDistinct, similarity } from "../src/engagement/dedupe";
import { checkEngagementComment } from "../src/engagement/commentGuardrails";

describe("near-duplicate detection", () => {
  it("treats punctuation and case differences as the same comment", () => {
    expect(similarity("Moving the stop at 2R saved me twice.", "moving the stop at 2r saved me twice")).toBe(1);
    expect(normalizeForDedupe("Hi, THERE!!")).toBe("hi there");
  });

  it("catches a comment with one word changed", () => {
    const a = "That second entry after the sweep is exactly where I usually get chopped out.";
    const b = "That second entry after the sweep is exactly where I always get chopped out.";
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it("catches a templated opener on otherwise different text", () => {
    const a = "The part about sizing down after a loss is something I never did consistently.";
    const b = "The part about sizing down after a rough week made me rethink my Monday rules.";
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.9);
  });

  it("does not flag genuinely different comments", () => {
    const a = "Why does the 9:30 open fake out so many breakout entries?";
    const b = "Curious whether the consistency rule counts a single huge win day.";
    expect(similarity(a, b)).toBeLessThan(0.3);
    expect(findNearDuplicate(a, [b])).toBeNull();
  });

  it("only treats very short comments as duplicates when identical", () => {
    expect(similarity("Same here.", "Same here, honestly.")).toBe(0);
    expect(similarity("Same here.", "same here")).toBe(1);
  });

  it("selects distinct candidates against history and against each other", () => {
    const history = ["Trailing drawdown locks once you are up the starting buffer, which most people miss."];
    const picked = selectDistinct(
      [
        "Trailing drawdown locks once you are up the starting buffer, which people miss.",
        "Why not scale out at the first target when the day's range is already tight?",
        "Why not scale out at the first target when the day range is already tight?",
      ],
      history,
    );
    expect(picked.accepted).toEqual(["Why not scale out at the first target when the day's range is already tight?"]);
    expect(picked.rejected).toHaveLength(2);
  });

  it("compares against a window of 200 recent comments", () => {
    const history = Array.from({ length: 200 }, (_, i) => `Unique comment number ${i} about setup ${i * 7} and risk ${i * 13}.`);
    history.push("Only a 9:30 open sweep that reclaims the level gets my attention these days.");
    expect(findNearDuplicate("Only a 9:30 open sweep that reclaims the level gets my attention these days", history)?.index).toBe(200);
  });
});

describe("engagement comment guardrails", () => {
  const good = "Taking the second entry only after the sweep reclaims the level is the rule I keep breaking.";

  it("accepts a specific, non-promotional comment", () => {
    expect(checkEngagementComment(good, "youtube")).toBeNull();
  });

  it.each([
    ["links", "Same setup here, wrote it up at example.com for anyone curious."],
    ["check out", "Same setup here, you should check it out sometime."],
    ["link in bio", "Same setup here, more details link in bio."],
    ["own channel", "Same exact setup on my channel last week."],
    ["subscribe", "Same setup here, subscribe for more of the same."],
    ["brand name", "Same setup here, we log these in Fillbook every day."],
    ["handle mention", "Same setup here @someone you will like this one."],
    ["generic praise", "Great video, super helpful stuff here."],
    ["emoji", "Same setup here \u{1F525} works every time."],
    ["hashtag", "Same setup here, works every time #futures"],
    ["em dash", "Same setup here — works every time for me."],
    ["advice", "You should buy the dip at this level honestly."],
    ["claim", "Our traders made a lot using exactly this setup every week."],
  ])("rejects %s", (_name, text) => {
    expect(checkEngagementComment(text, "youtube")).not.toBeNull();
  });

  it("enforces TikTok's shorter comment limit", () => {
    const long = "Sizing down after two losses is the one rule that actually changed my month, and I keep forgetting it when the open is fast and loud and everything on the screen looks like a setup I should take.";
    expect(long.length).toBeGreaterThan(150);
    expect(checkEngagementComment(long, "tiktok")).toMatch(/too long/);
    expect(checkEngagementComment(long, "youtube")).toBeNull();
  });

  it("rejects text that is too short", () => {
    expect(checkEngagementComment("Same.", "youtube")).toMatch(/too short/);
  });
});
