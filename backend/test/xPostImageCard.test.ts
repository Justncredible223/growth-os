import { describe, expect, it } from "vitest";
import { REFERENCE_TOPICS } from "../src/content/xFeedPostExtras";
import { buildXPostImageCard, cardHeadline, cardNumbersTraceToPost, xPostImageCardEnabled, type XPostImageCard } from "../src/content/xPostImageCard";

const POST = "Intraday trailing: run a trade to +$1,500 open, give it all back, and your floor can still move up $1,500.\n\nFillbook shows the buffer from your synced trades.";

describe("buildXPostImageCard (deterministic: no model writes anything on the card)", () => {
  it("builds a headline card whose numbers are copied verbatim from the post, labelled SAMPLE DATA", () => {
    const card = buildXPostImageCard("drawdown", POST, {})!;
    expect(card.kind).toBe("post");
    expect(card.title.startsWith("Intraday trailing")).toBe(true);
    expect(card.numbers).toEqual(["$1,500"]);
    expect(card.sampleData).toBe(true);
    expect(cardNumbersTraceToPost(card, POST)).toBe(true);
  });

  it("a post with no figure gets no SAMPLE DATA label and no numbers", () => {
    const card = buildXPostImageCard("journal", "Most journals die in week three. Make yours a two minute habit.", { X_POST_SCREEN_CARDS: "off" })!;
    expect(card.numbers).toEqual([]);
    expect(card.sampleData).toBe(false);
  });

  it("every Wednesday reference topic has a fixed card with no figure drawn from anywhere", () => {
    for (const t of REFERENCE_TOPICS) {
      const card = buildXPostImageCard(t.key, "caption text", {})!;
      expect(card.kind).toBe("reference");
      expect(card.rows.length).toBeGreaterThanOrEqual(3);
      expect(card.numbers).toEqual([]);
      expect(card.sampleData).toBe(false);
    }
  });

  it("drops a card whose figure cannot be traced to the post", () => {
    const forged: XPostImageCard = { version: 1, kind: "post", title: "Lost $422 in 8 trades", rows: [], numbers: ["$422"], sampleData: true };
    expect(cardNumbersTraceToPost(forged, "Lost money in a few trades.")).toBe(false);
    expect(cardNumbersTraceToPost(forged, "Lost $422 in 8 trades. Ouch.")).toBe(true);
  });

  it("the kill switch X_POST_IMAGE_CARD=off removes the card; nothing else turns it off", () => {
    expect(xPostImageCardEnabled({ X_POST_IMAGE_CARD: "off" })).toBe(false);
    expect(xPostImageCardEnabled({ X_POST_IMAGE_CARD: "on" })).toBe(true);
    expect(xPostImageCardEnabled({})).toBe(true);
    expect(buildXPostImageCard("drawdown", POST, { X_POST_IMAGE_CARD: "off" })).toBeNull();
  });

  it("empty text gives no card", () => {
    expect(buildXPostImageCard("drawdown", "   ", {})).toBeNull();
    expect(buildXPostImageCard("drawdown", null, {})).toBeNull();
  });
});

describe("cardHeadline", () => {
  it("keeps a whole first sentence that fits on the card instead of chopping it at 70 characters", () => {
    const h = cardHeadline(POST);
    expect(h).toBe("Intraday trailing: run a trade to +$1,500 open, give it all back, and your floor can still move up $1,500.");
    expect(h.endsWith("...")).toBe(false);
  });

  it("a very long sentence is cut at a word, never mid-word, with an ellipsis", () => {
    const long = `${"word ".repeat(60).trim()}.`;
    const h = cardHeadline(long);
    expect(h.length).toBeLessThanOrEqual(150);
    expect(h.endsWith("...")).toBe(true);
    expect(h.replace("...", "").trim().split(" ").every((w) => w === "word")).toBe(true);
  });
});

describe("topic motif (Risk Blueprint theme)", () => {
  it("picks a motif by rule from the post text, never from a model", async () => {
    const { motifForPost } = await import("../src/content/xPostImageCard");
    expect(motifForPost("Your Edge Score is one number for five parts.")).toBe("edge_score");
    expect(motifForPost("Trailing drawdown only moves up.")).toBe("drawdown");
    expect(motifForPost("Hit the daily loss limit and you are done.")).toBe("loss_limit");
    expect(motifForPost("Five numbers before a payout request.")).toBe("payout");
    expect(motifForPost("One big day can break the consistency rule.")).toBe("consistency");
    expect(motifForPost("Trade fewer contracts than you think.")).toBe("sizing");
    expect(motifForPost("Clean-slate size comes from your plan. Position sizing in the hour after a loss comes from the number you want back.")).toBe("sizing");
    // The sizing picture shows size crossing the plan, so a neutral sizing post gets the fallback instead.
    expect(motifForPost("Pick your contracts from your stop distance.")).toBe("target");
    expect(motifForPost("Journal two lines after each session.")).toBe("journal");
    expect(motifForPost("Markets are open Monday.")).toBe("target");
  });

  it("a post card carries its motif, and the motif adds no words or numbers", () => {
    const card = buildXPostImageCard("drawdown", "Trailing drawdown only moves up when you make new highs.", {})!;
    expect(card.motif).toBe("drawdown");
    expect(card.numbers).toEqual([]);
  });
});

describe("card v2: the picture adds to the post instead of repeating it (owner 2026-11-08)", () => {
  const POST = "Up $1,500 by 11am on a trailing drawdown account? Check whether your floor trails intraday or locks at the close. Same day, very different floor.\n\nIntraday trailing follows your unrealized peak. Give back $900 of open profit and the floor still moved up the full $1,500.\n\nEnd-of-day trailing only moves on the closing balance.";

  it("picks a short verbatim sentence as the card's line, not the post's first sentence", async () => {
    const { shortHook } = await import("../src/content/xPostImageCard");
    const hook = shortHook(POST)!;
    expect(hook).toBe("Same day, very different floor.");
    expect(POST.includes(hook)).toBe(true);
  });

  it("returns no hook when no sentence is a good length", async () => {
    const { shortHook } = await import("../src/content/xPostImageCard");
    expect(shortHook("Ok.")).toBeNull();
    expect(shortHook("x".repeat(200) + ".")).toBeNull();
  });

  it("marks a post that names both intraday and end-of-day trailing as a comparison", async () => {
    const { isTrailingComparison } = await import("../src/content/xPostImageCard");
    expect(isTrailingComparison(POST)).toBe(true);
    expect(isTrailingComparison("Trailing drawdown only moves up.")).toBe(false);
    const card = buildXPostImageCard(null, POST, {})!;
    expect(card.motif).toBe("drawdown");
    expect(card.compare).toBe(true);
    expect(card.hook).toBe("Same day, very different floor.");
    expect(card.numbers).toEqual(["$1,500", "$900"]);
    expect(cardNumbersTraceToPost(card, POST)).toBe(true);
  });

  it("labels each figure with the words that precede it in the post, verbatim", async () => {
    const { figureNotesFor } = await import("../src/content/xPostImageCard");
    expect(figureNotesFor(POST, ["$1,500", "$900"])).toEqual(["Up", "Give back"]);
  });
});

describe("picture style test: real Fillbook screen vs drawn card (ChatGPT + App 2026-11-15)", () => {
  it("assigns the arm from the post text alone, so the test can be re-scored from what was posted", async () => {
    const { styleArmForText } = await import("../src/content/xPostImageCard");
    const t = "Your Edge Score is one number for five parts.";
    expect(styleArmForText(t)).toBe(styleArmForText(`  ${t.toUpperCase()}\n`));
    const arms = Array.from({ length: 200 }, (_, i) => styleArmForText(`Post number ${i} about the drawdown floor.`));
    const screens = arms.filter((a) => a === "screen").length;
    expect(screens).toBeGreaterThan(70);
    expect(screens).toBeLessThan(130);
  });

  it("never uses a screen when the post has its own figures (the screen's made-up numbers could contradict it)", async () => {
    const { cardStyleFor } = await import("../src/content/xPostImageCard");
    for (let i = 0; i < 20; i++) expect(cardStyleFor(`Trailing floor ${i}.`, "drawdown", true, false, {}).style).toBe("drawn");
  });

  it("never uses a screen for a comparison card, a motif with no screen, or with the kill switch off", async () => {
    const { cardStyleFor } = await import("../src/content/xPostImageCard");
    for (let i = 0; i < 20; i++) {
      const t = `Some post ${i}.`;
      expect(cardStyleFor(t, "drawdown", false, true, {}).style).toBe("drawn");
      expect(cardStyleFor(t, "payout", false, false, {}).style).toBe("drawn");
      expect(cardStyleFor(t, "drawdown", false, false, { X_POST_SCREEN_CARDS: "off" }).style).toBe("drawn");
    }
  });

  it("a screen card names its screen and is always labelled sample data; a drawn card is unchanged", async () => {
    const { styleArmForText } = await import("../src/content/xPostImageCard");
    const words = ["calm", "slow", "plain", "steady", "quiet", "simple", "clear", "early", "late", "small"];
    const posts = words.map((w) => `Trailing drawdown only moves up when you make new highs on a ${w} day.`);
    const screenPost = posts.find((p) => styleArmForText(p) === "screen")!;
    const drawnPost = posts.find((p) => styleArmForText(p) === "drawn")!;
    const s = buildXPostImageCard(null, screenPost, {})!;
    expect(s.style).toBe("screen");
    expect(s.screen).toBe("buffer");
    expect(s.sampleData).toBe(true);
    expect(s.numbers).toEqual([]);
    const d = buildXPostImageCard(null, drawnPost, {})!;
    expect(d.style).toBe("drawn");
    expect(d.screen).toBeUndefined();
    expect(d.sampleData).toBe(false);
  });
});

describe("picture style test report (ChatGPT 2026-11-15: check the split per topic before reading results)", () => {
  it("the arm read back from a post matches the card that post got", async () => {
    const { pictureArmForPost } = await import("../src/content/xPostImageCard");
    const posts = ["Trailing drawdown only moves up.", "Your Edge Score is one number for five parts.", "Journal two lines after each session.", "Markets are open Monday.", "Five numbers before a payout request.", "Lost $422 in 8 trades on the trailing floor."];
    for (const p of posts) {
      const card = buildXPostImageCard(null, p, {})!;
      const arm = pictureArmForPost(p);
      if (arm === "not_eligible") expect(card.style).toBe("drawn");
      else expect(card.style).toBe(arm);
    }
    expect(pictureArmForPost("Five numbers before a payout request.")).toBe("not_eligible");
    expect(pictureArmForPost("Lost $422 in 8 trades on the trailing floor.")).toBe("not_eligible");
  });

  it("tallies posts by topic and arm and flags a lopsided topic", async () => {
    const { pictureTestTally, styleArmForText } = await import("../src/content/xPostImageCard");
    const words = ["calm", "slow", "plain", "steady", "quiet", "simple", "clear", "early", "late", "small", "quick", "flat", "wide", "tight"];
    const drawdown = words.map((w) => `Trailing drawdown only moves up on a ${w} day.`);
    const screens = drawdown.filter((p) => styleArmForText(p) === "screen");
    const t = pictureTestTally([...drawdown, "Five numbers before a payout request."]);
    const row = t.rows.find((r) => r.motif === "drawdown")!;
    expect(row.screen + row.drawn).toBe(drawdown.length);
    expect(row.screen).toBe(screens.length);
    expect(t.rows.find((r) => r.motif === "payout")!.notEligible).toBe(1);
    const lopsided = pictureTestTally(screens.length >= 4 ? screens : drawdown.filter((p) => styleArmForText(p) === "drawn"));
    expect(lopsided.unbalancedTopics).toEqual(["drawdown"]);
  });
});

describe("short line never a disclaimer (Fold check 2026-11-15)", () => {
  it("skips 'Not financial advice.' and similar when choosing the picture's line", async () => {
    const { shortHook } = await import("../src/content/xPostImageCard");
    expect(shortHook("Seeing your rule lines is easier when trades sit in one journal. Not financial advice.")).toBeNull();
    expect(shortHook("Not financial advice. Log every trade the same day.")).toBe("Log every trade the same day.");
    expect(shortHook("Past results do not guarantee anything. Size from your plan.")).toBe("Size from your plan.");
  });
});
