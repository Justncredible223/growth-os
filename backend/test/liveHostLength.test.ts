import { describe, expect, it } from "vitest";
import { spokenWordLimit, splitSentences, trimToWords, wordCount } from "../src/liveHost/liveHostLength";

const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

describe("wordCount", () => {
  it("counts words and ignores extra spaces", () => {
    expect(wordCount("  one   two three ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("spokenWordLimit", () => {
  it("is tightest for welcomes, then duo replies, and absent for ordinary solo replies", () => {
    expect(spokenWordLimit({ duo: false, show: false, segment: false, joinWelcome: true })).toBe(40);
    expect(spokenWordLimit({ duo: true, show: true, segment: true, joinWelcome: false })).toBe(60);
    expect(spokenWordLimit({ duo: true, show: false, segment: false, joinWelcome: false })).toBe(55);
    expect(spokenWordLimit({ duo: false, show: false, segment: true, joinWelcome: false })).toBe(70);
    expect(spokenWordLimit({ duo: false, show: false, segment: false, joinWelcome: false })).toBeNull();
  });
});

describe("trimToWords", () => {
  it("leaves a line that fits alone", () => {
    expect(trimToWords("Short line. Another one.", 40)).toBe("Short line. Another one.");
  });

  it("drops middle sentences and keeps the hook and the turn", () => {
    const text = `Hook sentence here. ${words(20, "a")}. ${words(20, "b")}. Turn to you, Justin?`;
    const out = trimToWords(text, 30);
    expect(out.startsWith("Hook sentence here.")).toBe(true);
    expect(out.endsWith("Turn to you, Justin?")).toBe(true);
    expect(wordCount(out)).toBeLessThanOrEqual(30);
  });

  it("never drops the entertainment-not-advice sentence, even if that leaves it over the limit", () => {
    const text = `${words(20, "a")}. This is entertainment, not advice. ${words(20, "b")}.`;
    const out = trimToWords(text, 12);
    expect(out).toContain("This is entertainment, not advice.");
  });

  it("keeps only the hook when the hook and the turn cannot both fit", () => {
    const text = `${words(15, "a")}. ${words(15, "b")}.`;
    const out = trimToWords(text, 16);
    expect(out).toBe(`${words(15, "a")}.`);
  });

  it("cuts a single over-long sentence at the limit and closes it", () => {
    const out = trimToWords(words(50), 10);
    expect(wordCount(out)).toBe(10);
    expect(out.endsWith(".")).toBe(true);
  });

  it("never returns an empty string for non-empty text", () => {
    for (const limit of [1, 3, 8]) expect(trimToWords("One two three four five. Six seven eight nine ten. Eleven twelve.", limit).length).toBeGreaterThan(0);
  });
});

describe("splitSentences", () => {
  it("keeps the punctuation with each sentence", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
    expect(splitSentences("No end punctuation")).toEqual(["No end punctuation"]);
  });
});
