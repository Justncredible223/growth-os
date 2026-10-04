import { describe, it, expect } from "vitest";
import { PARAGRAPH_MIN_CHARS, hasParagraphBreaks } from "../src/content/contentQualityGate";

const longBlock = "Most journals get abandoned because they ask you to remember what you felt three trades ago. ".repeat(3).trim();

describe("hasParagraphBreaks (X posts are laid out in short paragraphs)", () => {
  it("lets a short post through without a blank line", () => {
    expect(hasParagraphBreaks("One line. Short enough.")).toBe(true);
    expect(hasParagraphBreaks("a".repeat(PARAGRAPH_MIN_CHARS))).toBe(true);
  });

  it("rejects a long single block", () => {
    expect(longBlock.length).toBeGreaterThan(PARAGRAPH_MIN_CHARS);
    expect(hasParagraphBreaks(longBlock)).toBe(false);
    expect(hasParagraphBreaks(longBlock.replace(/\. /g, ".\n"))).toBe(false); // single line breaks are not paragraphs
  });

  it("accepts a long post with a blank line between parts", () => {
    expect(hasParagraphBreaks(`${longBlock}\n\nFillbook's Daily Brief summarizes your last session.`)).toBe(true);
    expect(hasParagraphBreaks(`${longBlock}\r\n\r\nSecond part.`)).toBe(true);
  });
});
