import { describe, it, expect } from "vitest";
import { chooseCuts, chooseCutsBySize, chooseCutsBySlots, checkShares, internalPauseCount, lineWeight, numberSyllables, partSpans } from "../scripts/video-factory/splitRecording";
import type { Silence } from "../scripts/video-factory/suppliedVoice";

const sil = (start: number, length: number): Silence => ({ start, end: start + length });

describe("estimating how long a line takes to say", () => {
  it("counts the syllables of spoken numbers", () => {
    expect(numberSyllables(5)).toBe(1);
    expect(numberSyllables(17)).toBe(3);
    expect(numberSyllables(25)).toBe(3);
    expect(numberSyllables(1725)).toBe(10); // one thousand seven hundred twenty-five
    expect(numberSyllables(3060)).toBe(5); // three thousand sixty
  });

  it("weights money, percent, decimals and ampersands the way they are said", () => {
    expect(lineWeight("Best day: $3,100.")).toBe(1 + 1 + (numberSyllables(3) + 2 + numberSyllables(100)) + 2);
    expect(lineWeight("It wins 88%.")).toBe(1 + 1 + numberSyllables(88) + 2);
    expect(lineWeight("But your norm is 2.7.")).toBeGreaterThan(lineWeight("But your norm is 2."));
    expect(lineWeight("net P&L")).toBe(1 + 3);
  });

  it("counts the pauses a line leaves inside itself", () => {
    expect(internalPauseCount("Buffer to the floor: $1,725.")).toBe(1);
    expect(internalPauseCount("Overall, you are 92% on plan.")).toBe(1);
    expect(internalPauseCount("Find your own room.")).toBe(0);
    expect(internalPauseCount("But today's limit is $1,000.")).toBe(0); // the comma in a number is not a pause
    expect(internalPauseCount("It adds net P&L and trade count.")).toBe(0);
  });
});

describe("cutting at the longest pauses", () => {
  // Five lines: full stops leave 0.5 s, a colon in line 2 leaves 0.2 s.
  const silences = [sil(2.0, 0.5), sil(4.0, 0.2), sil(5.9, 0.5), sil(8.0, 0.5), sil(10.0, 0.5)];

  it("takes the N-1 longest pauses, in time order, cut in the middle of each", () => {
    const choice = chooseCuts(silences, 12, 5)!;
    expect(choice.cuts.map((c) => c.at)).toEqual([2.25, 6.15, 8.25, 10.25]);
    expect(choice.nextBest).toBeCloseTo(0.2);
    expect(choice.ratio).toBeCloseTo(2.5);
  });

  it("ignores lead-in and tail silences and pauses too short to be a boundary", () => {
    const choice = chooseCuts([sil(0, 0.3), sil(2.0, 0.5), sil(3.0, 0.05), sil(5.9, 0.5), sil(8.0, 0.5), sil(10.0, 0.5), sil(11.8, 0.2)], 12, 5)!;
    expect(choice.cuts).toHaveLength(4);
    expect(choice.ratio).toBe(Infinity);
  });

  it("gives up when there are fewer pauses than lines minus one", () => {
    expect(chooseCuts([sil(2, 0.5), sil(5, 0.5)], 12, 5)).toBeNull();
  });

  it("reports a low ratio when a pause inside a line is as long as a boundary", () => {
    const choice = chooseCuts([sil(2.0, 0.45), sil(4.0, 0.44), sil(5.9, 0.4), sil(8.0, 0.43), sil(10.0, 0.45)], 12, 5)!;
    expect(choice.ratio).toBeLessThan(1.3);
  });
});

describe("checking a cut against the words", () => {
  const lines = ["Fillbook compares progress across your accounts.", "One account: 52% to target.", "But the other: 13%.", "Health scores sit beside them.", "Compare your own accounts."];

  it("accepts parts whose lengths match what the words predict", () => {
    const check = checkShares(lines, [3.0, 3.1, 2.5, 1.9, 1.8]);
    expect(check.ok).toBe(true);
    expect(check.worst).toBeLessThan(0.07);
  });

  it("refuses parts where a cut fell inside a line", () => {
    const check = checkShares(lines, [3.0, 1.2, 4.4, 1.9, 1.8]);
    expect(check.ok).toBe(false);
  });

  it("lays the parts end to end", () => {
    expect(partSpans([{ at: 2, pause: 0.4 }, { at: 5, pause: 0.4 }], 9)).toEqual([[0, 2], [2, 5], [5, 9]]);
  });
});

describe("cutting a file whose colons pause as long as its full stops", () => {
  const lines = ["Fillbook compares progress across your accounts.", "One account: 52% to target.", "But the other: 13%.", "Health scores sit beside them.", "Compare your own accounts."];
  // Real day-4 pauses: boundary, colon, boundary, colon, boundary, boundary. The colon pauses are as long as the boundaries.
  const silences = [sil(2.72, 0.46), sil(3.86, 0.34), sil(5.91, 0.37), sil(6.93, 0.34), sil(8.52, 0.49), sil(10.64, 0.33)];

  it("cannot tell them apart by length", () => {
    expect(chooseCuts(silences, 12.5, 5)!.ratio).toBeLessThan(1.3);
  });

  it("matches the pauses to the punctuation in order and cuts after each line", () => {
    const choice = chooseCutsBySlots(silences, 12.5, lines)!;
    expect(choice.cuts.map((c) => Math.round(c.at * 10) / 10)).toEqual([3, 6.1, 8.8, 10.8]);
  });

  it("refuses the order match when the number of pauses is not the number the punctuation predicts", () => {
    expect(chooseCutsBySlots(silences.slice(0, 5), 12.5, lines)).toBeNull();
  });

  it("choosing by part size alone refuses when two choices fit about equally well", () => {
    expect(chooseCutsBySize(silences, 12.5, lines)).toBeNull();
    // A file of five identical lines with evenly spaced identical pauses has no best choice.
    const same = ["A b c d.", "A b c d.", "A b c d.", "A b c d.", "A b c d."];
    expect(chooseCutsBySize([sil(2, 0.4), sil(4, 0.4), sil(6, 0.4), sil(8, 0.4), sil(10, 0.4), sil(12, 0.4)], 14, same)).toBeNull();
  });
});
