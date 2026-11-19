import { describe, expect, it } from "vitest";
import { buildPostReceipt, hookLineOf, hookLineProblem, wordOverlap } from "../src/content/xPostReceipt";
import { buildXPostImageCard } from "../src/content/xPostImageCard";

const POST = "Up $1,500 by 11am on a trailing drawdown account?\n\nCheck whether your floor trails intraday or locks at the close. Same day, very different floor.\n\nIntraday trailing follows your unrealized peak. Give back $900 of open profit and the floor still moved up the full $1,500.";
const card = buildXPostImageCard(null, POST, {});

describe("the post receipt lists only what was actually checked", () => {
  it("shows every line green for a clean draft that all reviewers passed", () => {
    const items = buildPostReceipt({ text: POST, reviewersPassed: 9, reviewersTotal: 9, recentPostedTexts: ["Journal two lines after each session and review the week on Friday."], imageCard: card });
    expect(items.map((i) => i.ok)).toEqual(items.map(() => true));
    expect(items[0]!.label).toBe("9 of 9 reviewers passed this exact draft");
    expect(items.some((i) => i.label.includes("figure in the picture"))).toBe(true);
    expect(items.some((i) => i.label.includes("sample data"))).toBe(true);
  });

  it("flags a link, an em dash, a missing review record and a repeat of a recent post", () => {
    const bad = "Read more at fillbookhq.com — the same day, very different floor, trailing drawdown, intraday or end of day.";
    const items = buildPostReceipt({ text: bad, reviewersPassed: 0, reviewersTotal: 0, recentPostedTexts: [bad], imageCard: null });
    const byLabel = (needle: string) => items.find((i) => i.label.toLowerCase().includes(needle))!;
    expect(byLabel("no review record").ok).toBe(false);
    expect(byLabel("link").ok).toBe(false);
    expect(byLabel("wording").ok).toBe(false);
    expect(byLabel("recent post").ok).toBe(false);
  });

  it("marks a reviewer shortfall red rather than hiding it", () => {
    const items = buildPostReceipt({ text: POST, reviewersPassed: 8, reviewersTotal: 9, recentPostedTexts: [], imageCard: card });
    expect(items[0]).toEqual({ label: "8 of 9 reviewers passed this exact draft", ok: false });
  });

  it("measures overlap ignoring case and links", () => {
    expect(wordOverlap("Hello world https://t.co/x", "HELLO WORLD")).toBe(1);
    expect(wordOverlap("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("hook line (first line of the post, 2026-11-18 decision)", () => {
  it("takes the first non-empty line", () => {
    expect(hookLineOf("\n\nA trailing floor moves with every new high.\n\nMore.")).toBe("A trailing floor moves with every new high.");
  });
  it("accepts a short, specific first line", () => {
    expect(hookLineProblem("A trailing floor moves with every new high.\n\nWhy it matters.")).toBeNull();
  });
  it("flags a first line that is a whole paragraph", () => {
    expect(hookLineProblem("Up $1,500 by 11am on a trailing drawdown account? Check whether your floor trails intraday or locks at the close. Same day, very different floor.")).toMatch(/characters/);
  });
  it("flags thread wording and an empty post", () => {
    for (const t of ["1/ Three personal rules for funded traders", "A thread on drawdown rules", "Part 1 of the rules", "\u{1F9F5} Drawdown rules"]) expect(hookLineProblem(t), t).toMatch(/thread/);
    expect(hookLineProblem("   ")).toMatch(/no first line/);
  });
  it("shows up in the receipt, green for a hook and red for a paragraph", () => {
    const ok = buildPostReceipt({ text: POST, reviewersPassed: 9, reviewersTotal: 9, recentPostedTexts: [], imageCard: null });
    expect(ok.find((i) => /First line/.test(i.label))).toEqual({ label: "First line is a short hook", ok: true });
    const bad = buildPostReceipt({ text: "x ".repeat(60) + "\n\nMore.", reviewersPassed: 9, reviewersTotal: 9, recentPostedTexts: [], imageCard: null });
    expect(bad.find((i) => /First line/.test(i.label))!.ok).toBe(false);
  });
});
