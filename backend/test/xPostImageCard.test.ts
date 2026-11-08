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
    const card = buildXPostImageCard("journal", "Most journals die in week three. Make yours a two minute habit.", {})!;
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
    expect(motifForPost("Journal two lines after each session.")).toBe("journal");
    expect(motifForPost("Markets are open Monday.")).toBe("target");
  });

  it("a post card carries its motif, and the motif adds no words or numbers", () => {
    const card = buildXPostImageCard("drawdown", "Trailing drawdown only moves up when you make new highs.", {})!;
    expect(card.motif).toBe("drawdown");
    expect(card.numbers).toEqual([]);
  });
});
