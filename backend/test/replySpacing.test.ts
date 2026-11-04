import { describe, expect, it } from "vitest";
import { paragraphizeReply, SPACING_MIN_CHARS } from "../src/content/replySpacing";

describe("paragraphizeReply (owner rule 2026-11-04: two-part replies get a blank line, not one run-on block)", () => {
  it("puts the first sentence and the rest on separate paragraphs", () => {
    const text = "Trailing drawdown locks at the starting balance once you are up 2k. Fillbook's Rules page would show how much room is left to that lock.";
    expect(paragraphizeReply(text)).toBe(
      "Trailing drawdown locks at the starting balance once you are up 2k.\n\nFillbook's Rules page would show how much room is left to that lock.",
    );
  });

  it("leaves a short or single-sentence reply on one line", () => {
    expect(paragraphizeReply("Fair point. Size is the real culprit.")).toBe("Fair point. Size is the real culprit.");
    const one = "Apex trailing drawdown locks at the starting balance once you are up the full threshold amount on the account.";
    expect(one.length).toBeGreaterThan(SPACING_MIN_CHARS);
    expect(paragraphizeReply(one)).toBe(one);
  });

  it("does not split after abbreviations or inside numbers", () => {
    const text = "Winners cut early look fine vs. a fixed 1.5R target on paper over a small sample of trades in a single month of data.";
    expect(paragraphizeReply(text)).toBe(text);
  });

  it("keeps a model's own paragraph breaks and squeezes extra blank lines", () => {
    expect(paragraphizeReply("First thought.  \n\n\n\nSecond thought.")).toBe("First thought.\n\nSecond thought.");
  });

  it("changes whitespace only: the words are identical and in order", () => {
    const text = "One setup lost money all month while the overall win rate stayed fine. A By setup view would have shown it. Worth a look at that setup first.";
    const out = paragraphizeReply(text);
    expect(out.replace(/\s+/g, " ")).toBe(text);
    expect(out.split("\n\n")).toHaveLength(2);
  });

  it("is skipped when the extra character would pass the length limit", () => {
    const first = "A".repeat(100) + ".";
    const second = "B".repeat(177) + ".";
    const text = `${first} ${second}`;
    expect(text.length).toBe(280);
    expect(paragraphizeReply(text)).toBe(text);
    expect(paragraphizeReply(text, 281)).toContain("\n\n");
  });
});
