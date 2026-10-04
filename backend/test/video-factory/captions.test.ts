import { describe, it, expect } from "vitest";
import {
  groupWordsIntoPhrases,
  buildWordHighlightCues,
  buildCaptionCues,
  buildOutroCue,
  mergeBrandNameWordCues,
  secondsToAssTime,
  escapeAssText,
  buildAssFile,
  alignHeadlineToSpeech,
  buildHeadlineWordVariants,
} from "../../scripts/video-factory/captions";
import type { WordCue } from "../../scripts/video-factory/types";

function word(text: string, startSeconds: number, endSeconds: number): WordCue {
  return { text, startSeconds, endSeconds };
}

describe("alignHeadlineToSpeech", () => {
  const spoken = [word("Same", 0.05, 0.3), word("setup.", 0.35, 0.8), word("Bigger", 0.9, 1.2), word("size.", 1.25, 1.6), word("Five", 1.8, 2.0)];

  it("pairs a headline with the first spoken words when they match, ignoring case and punctuation", () => {
    const aligned = alignHeadlineToSpeech("Same setup. Bigger size.", spoken);
    expect(aligned?.map((w) => w.text)).toEqual(["Same", "setup.", "Bigger", "size."]);
    expect(aligned?.[2]).toEqual({ text: "Bigger", startSeconds: 0.9, endSeconds: 1.2 });
    expect(alignHeadlineToSpeech("SAME setup Bigger size", spoken)).not.toBeNull();
  });

  it("returns null when the headline is not literally what is spoken first, so nothing gets highlighted on the wrong words", () => {
    expect(alignHeadlineToSpeech("Your plan says three.", spoken)).toBeNull();
    // a number spelled differently in the headline than in the speech
    expect(alignHeadlineToSpeech("5 contracts.", [word("Five", 0, 0.3), word("contracts.", 0.35, 0.8)])).toBeNull();
  });

  it("returns null for an empty headline or when the speech is shorter than the headline", () => {
    expect(alignHeadlineToSpeech("   ", spoken)).toBeNull();
    expect(alignHeadlineToSpeech("Same setup. Bigger size. Five contracts. Really.", spoken)).toBeNull();
  });
});

describe("buildHeadlineWordVariants", () => {
  const words = [word("Same", 0.05, 0.3), word("setup.", 0.35, 0.8), word("Bigger", 0.9, 1.2), word("size.", 1.25, 1.6)];

  it("emits one variant per word with exactly that word highlighted and popping, on the video timeline", () => {
    const variants = buildHeadlineWordVariants(words, 10, 14);
    expect(variants).toHaveLength(5); // 4 words + the finished-headline tail
    expect(variants[0]!.markup).toBe("{\\c&H00EED322&\\t(0,110,\\fscx120\\fscy120)}Same{\\c&H00FFFFFF&\\fscx100\\fscy100} setup. Bigger size.");
    expect(variants[2]!.markup).toBe("Same setup. {\\c&H00EED322&\\t(0,110,\\fscx120\\fscy120)}Bigger{\\c&H00FFFFFF&\\fscx100\\fscy100} size.");
  });

  it("is on screen from the scene's first frame, runs each variant to the next word's start, and holds the finished headline to the scene end", () => {
    const variants = buildHeadlineWordVariants(words, 10, 14);
    expect(variants[0]!.startSeconds).toBe(10);
    expect(variants[0]!.endSeconds).toBeCloseTo(10.35);
    expect(variants[1]!.startSeconds).toBeCloseTo(10.35);
    expect(variants[3]!.endSeconds).toBeCloseTo(11.6);
    const tail = variants[4]!;
    expect(tail.markup).toBe("Same setup. Bigger size.");
    expect(tail.startSeconds).toBeCloseTo(11.6);
    expect(tail.endSeconds).toBe(14);
    // contiguous: no gap and no overlap, so the headline never flickers or doubles
    for (let i = 1; i < variants.length; i++) expect(variants[i]!.startSeconds).toBeCloseTo(variants[i - 1]!.endSeconds);
  });

  it("never runs outside its scene, even if a word's timing spills past the scene end", () => {
    const variants = buildHeadlineWordVariants(words, 10, 11);
    expect(variants.every((v) => v.startSeconds >= 10 && v.endSeconds <= 11)).toBe(true);
  });
});

describe("mergeBrandNameWordCues", () => {
  it("merges an adjacent Fill + book pair into one Fillbook cue spanning both", () => {
    const words = [word("Try", 0, 0.1), word("Fill", 0.15, 0.35), word("book", 0.35, 0.55), word("today.", 0.6, 0.9)];
    const merged = mergeBrandNameWordCues(words);
    expect(merged).toEqual([
      word("Try", 0, 0.1),
      { text: "Fillbook", startSeconds: 0.15, endSeconds: 0.55 },
      word("today.", 0.6, 0.9),
    ]);
  });

  it("turns the hyphenated spoken name back into Fillbook, keeping its timing and any ending", () => {
    const words = [word("Try", 0, 0.1), word("Fill-book", 0.15, 0.55), word("Fill-book's", 0.6, 1.0)];
    expect(mergeBrandNameWordCues(words)).toEqual([word("Try", 0, 0.1), word("Fillbook", 0.15, 0.55), word("Fillbook's", 0.6, 1.0)]);
  });

  it("matches case-insensitively and ignores trailing punctuation", () => {
    const words = [word("fill", 0, 0.2), word("book.", 0.2, 0.4)];
    expect(mergeBrandNameWordCues(words)).toEqual([{ text: "Fillbook", startSeconds: 0, endSeconds: 0.4 }]);
  });

  it("merges multiple separate occurrences", () => {
    const words = [word("Fill", 0, 0.2), word("book", 0.2, 0.4), word("and", 0.4, 0.5), word("Fill", 0.5, 0.7), word("book", 0.7, 0.9)];
    const merged = mergeBrandNameWordCues(words);
    expect(merged.map((w) => w.text)).toEqual(["Fillbook", "and", "Fillbook"]);
  });

  it("leaves words alone when Fill and book aren't adjacent", () => {
    const words = [word("Fill", 0, 0.2), word("your", 0.2, 0.4), word("book.", 0.4, 0.6)];
    expect(mergeBrandNameWordCues(words)).toEqual(words);
  });

  it("treats the whole first sentence as the hook when its words carry sentence punctuation", () => {
    const words = [
      word("You", 0, 0.2),
      word("already", 0.25, 0.6),
      word("know", 0.65, 0.9),
      word("which", 1.0, 1.2),
      word("trade", 1.25, 1.6),
      word("repeat.", 1.65, 2.1),
      word("It's", 2.6, 2.8),
      word("the", 2.85, 2.95),
      word("one", 3.0, 3.2),
    ];
    const cues = buildCaptionCues(words);
    expect(cues.filter((c) => c.startSeconds < 2.2).every((c) => c.style === "Hook")).toBe(true);
    expect(cues.filter((c) => c.startSeconds >= 2.6).every((c) => c.style === "Caption")).toBe(true);
  });

  it("falls back to a ~2.4s window when the words carry no punctuation", () => {
    const words = [
      word("You", 0, 0.3),
      word("already", 0.35, 0.8),
      word("know", 0.85, 1.2),
      word("the", 1.9, 2.1), // pause > 0.35s -> new phrase, still inside the window
      word("trade", 2.15, 2.4),
      word("Log", 2.9, 3.1), // starts after the window
      word("it", 3.15, 3.3),
    ];
    const cues = buildCaptionCues(words);
    expect(cues.filter((c) => c.startSeconds < 2.4).every((c) => c.style === "Hook")).toBe(true);
    expect(cues.filter((c) => c.startSeconds >= 2.9).every((c) => c.style === "Caption")).toBe(true);
  });

  it("returns an empty list for no words", () => {
    expect(mergeBrandNameWordCues([])).toEqual([]);
  });
});

describe("groupWordsIntoPhrases", () => {
  it("keeps closely-spoken words in one phrase", () => {
    const words = [word("Your", 0, 0.2), word("funded", 0.22, 0.5), word("account.", 0.52, 0.9)];
    expect(groupWordsIntoPhrases(words)).toEqual([words]);
  });

  it("breaks a phrase at a natural pause (>= 0.35s gap)", () => {
    const words = [word("Your", 0, 0.2), word("account.", 0.25, 0.5), word("Here", 0.9, 1.1)];
    const phrases = groupWordsIntoPhrases(words);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]!.map((w) => w.text)).toEqual(["Your", "account."]);
    expect(phrases[1]!.map((w) => w.text)).toEqual(["Here"]);
  });

  it("breaks a phrase once it exceeds the max word count, even with no pause", () => {
    const words = Array.from({ length: 8 }, (_, i) => word(`w${i}`, i * 0.1, i * 0.1 + 0.09));
    const phrases = groupWordsIntoPhrases(words);
    expect(phrases.length).toBeGreaterThan(1);
    expect(phrases[0]!.length).toBeLessThanOrEqual(6);
  });

  it("breaks a phrase once it exceeds the max character count", () => {
    const words = [
      word("supercalifragilisticexpialidocious", 0, 0.5),
      word("anotherlongword", 0.5, 1.0),
      word("short", 1.0, 1.2),
    ];
    const phrases = groupWordsIntoPhrases(words);
    expect(phrases.length).toBeGreaterThan(1);
  });

  it("returns an empty list for no words", () => {
    expect(groupWordsIntoPhrases([])).toEqual([]);
  });
});

describe("buildWordHighlightCues", () => {
  it("emits one cue per word, each highlighting only that word", () => {
    const phrase = [word("Your", 0, 0.3), word("funded", 0.35, 0.7), word("account.", 0.75, 1.0)];
    const cues = buildWordHighlightCues(phrase, "Caption");
    expect(cues).toHaveLength(3);
    expect(cues[0]!.text).toBe("{\\c&H00EED322&\\fscx114\\fscy114}Your{\\c&H00FFFFFF&\\fscx100\\fscy100} funded account.");
    expect(cues[1]!.text).toBe("Your {\\c&H00EED322&\\fscx114\\fscy114}funded{\\c&H00FFFFFF&\\fscx100\\fscy100} account.");
    expect(cues[2]!.text).toBe("Your funded {\\c&H00EED322&\\fscx114\\fscy114}account.{\\c&H00FFFFFF&\\fscx100\\fscy100}");
    expect(cues.every((c) => c.style === "Caption")).toBe(true);
  });

  it("extends each word's display window to the next word's start, avoiding flicker in natural gaps", () => {
    const phrase = [word("Your", 0, 0.2), word("account.", 0.3, 0.5)];
    const cues = buildWordHighlightCues(phrase, "Caption");
    expect(cues[0]!.startSeconds).toBe(0);
    expect(cues[0]!.endSeconds).toBe(0.3);
    expect(cues[1]!.startSeconds).toBe(0.3);
    expect(cues[1]!.endSeconds).toBe(0.5);
  });

  it("strips literal braces from word text before wrapping the active word", () => {
    const phrase = [word("50%", 0, 0.3), word("{risk}", 0.3, 0.6)];
    const cues = buildWordHighlightCues(phrase, "Caption");
    expect(cues[1]!.text).toBe("50% {\\c&H00EED322&\\fscx114\\fscy114}risk{\\c&H00FFFFFF&\\fscx100\\fscy100}");
  });
});

describe("buildCaptionCues", () => {
  it("tags the first phrase's cues as Hook and later phrases as Caption", () => {
    const words = [
      word("Your", 0, 0.2),
      word("account.", 0.25, 0.5),
      word("Here", 0.9, 1.1),
      word("it", 1.15, 1.3),
    ];
    const cues = buildCaptionCues(words);
    const firstPhraseCues = cues.filter((c) => c.startSeconds < 0.5);
    const restCues = cues.filter((c) => c.startSeconds >= 0.9);
    expect(firstPhraseCues.every((c) => c.style === "Hook")).toBe(true);
    expect(restCues.every((c) => c.style === "Caption")).toBe(true);
  });

  it("returns an empty list for no words", () => {
    expect(buildCaptionCues([])).toEqual([]);
  });
});

describe("buildOutroCue", () => {
  it("spans exactly the trailing silence pad window", () => {
    const cue = buildOutroCue(30, 2.5);
    expect(cue.startSeconds).toBe(27.5);
    expect(cue.endSeconds).toBe(30);
    expect(cue.style).toBe("Outro");
  });

  it("includes the brand name and URL on separate lines", () => {
    const cue = buildOutroCue(30, 2.5);
    expect(cue.text).toContain("FILLBOOK");
    expect(cue.text).toContain("fillbookhq.com");
    expect(cue.text).toContain("\\N");
  });

  it("never starts before zero even if the pad exceeds total duration", () => {
    const cue = buildOutroCue(1, 2.5);
    expect(cue.startSeconds).toBe(0);
  });
});

describe("secondsToAssTime", () => {
  it("formats sub-minute durations", () => {
    expect(secondsToAssTime(3.5)).toBe("0:00:03.50");
  });

  it("formats durations with minutes and hours", () => {
    expect(secondsToAssTime(65.25)).toBe("0:01:05.25");
    expect(secondsToAssTime(3661.1)).toBe("1:01:01.10");
  });

  it("formats zero", () => {
    expect(secondsToAssTime(0)).toBe("0:00:00.00");
  });
});

describe("escapeAssText", () => {
  it("strips literal braces that would open an ASS override block", () => {
    expect(escapeAssText("50% {risk} explained")).toBe("50% risk explained");
  });

  it("converts newlines to the ASS hard line break", () => {
    expect(escapeAssText("line one\nline two")).toBe("line one\\Nline two");
  });

  it("leaves normal text untouched", () => {
    expect(escapeAssText("Your funded account, explained.")).toBe("Your funded account, explained.");
  });
});

describe("buildAssFile", () => {
  it("includes the known-good header (PlayResX/PlayResY matching render resolution, Alignment=5)", () => {
    const ass = buildAssFile([], []);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Style: Hook,");
    expect(ass).toContain("Style: Caption,");
    expect(ass).toContain("Style: SceneLabel,");
    expect(ass).toContain("Style: Outro,");
  });

  it("emits one Dialogue line per caption cue with correct style, interpolating pre-formed text verbatim", () => {
    const ass = buildAssFile([{ text: "{\\c&H00EED322&}The{\\c&H00FFFFFF&} hook", startSeconds: 0, endSeconds: 2, style: "Hook" }], []);
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:02.00,Hook,,0,0,0,,{\\c&H00EED322&}The{\\c&H00FFFFFF&} hook");
  });

  it("emits scene label dialogue on a separate layer from captions, escaping the label text", () => {
    const ass = buildAssFile(
      [{ text: "caption", startSeconds: 0, endSeconds: 2, style: "Caption" }],
      [{ label: "FILLBOOK", startSeconds: 0, endSeconds: 2 }],
    );
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:02.00,SceneLabel,,0,0,0,,FILLBOOK");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,caption");
  });
});

describe("platform safe zone", () => {
  it("keeps caption, hook and outro text 170px in from both edges, clear of the TikTok/Shorts/Reels right-hand action column", () => {
    const ass = buildAssFile([], []);
    for (const style of ["Caption", "Hook", "Outro"]) {
      const fields = ass.split("\n").find((l) => l.startsWith(`Style: ${style},`))!.split(",");
      const [marginL, marginR] = [Number(fields[fields.length - 4]), Number(fields[fields.length - 3])];
      expect(marginL).toBeGreaterThanOrEqual(170);
      expect(marginR).toBeGreaterThanOrEqual(170);
    }
  });
});
