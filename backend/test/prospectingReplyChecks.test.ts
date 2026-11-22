import { describe, it, expect } from "vitest";
import {
  isAddressedToGrok,
  logLensProblem,
  sensitivePersonalReason,
  unsupportedFactProblem,
  usesLogLens,
} from "../src/prospecting/prospectingReplyChecks";
import { isReplyWorthyBase, whyNotReplyWorthy } from "../src/prospecting/prospectingRelevance";
import { checkReplyGuardrails } from "../src/content/xReplyGuardrails";
import { namesFillbook } from "../src/prospecting/prospectingRecovery";

/** Regression tests for the 2026-11-21 audit of the last 20 posted Prospecting replies (ChatGPT decision F1 to F5). */

describe("F4: posts addressed to @grok", () => {
  it("catches the audit posts", () => {
    expect(isAddressedToGrok("Hey @grok  How much can a good futures trader REALISTICALLY make per month?")).toBe(true);
    expect(isAddressedToGrok("Hey @Grok If you were a trader, would you trade ICT concepts or Order Flow?")).toBe(true);
  });
  it("does not catch other handles or the word grok", () => {
    expect(isAddressedToGrok("I finally grok trailing drawdown on my Topstep account")).toBe(false);
    expect(isAddressedToGrok("@groktrader thinks futures are easy")).toBe(false);
  });
  it("is dropped by the free gate with its own reason", () => {
    const post = "Hey @grok is a trailing drawdown with a consistency rule the hardest setup on a Topstep combine for NQ traders?";
    expect(isReplyWorthyBase(post)).toBe(false);
    expect(whyNotReplyWorthy(post)).toBe("addressed_to_grok");
  });
});

describe("F3: illness, grief and money trouble", () => {
  it("catches the audit posts", () => {
    expect(sensitivePersonalReason("I feel so sick today. I will try to be back with content tomorrow if I feel better.")).toBe("illness_or_grief");
    expect(sensitivePersonalReason("I've been struggling trading for the past year. The debt is the sole reason I keep going.")).toBe("money_distress");
    expect(sensitivePersonalReason("Lost my dad last week, back to the screens now")).toBe("illness_or_grief");
  });
  it("leaves ordinary trading talk alone", () => {
    expect(sensitivePersonalReason("I'm sick of getting stopped out at the low on every NQ trade")).toBeNull();
    expect(sensitivePersonalReason("Struggling with the consistency rule on my Apex 50K, trailing drawdown is tight")).toBeNull();
    expect(sensitivePersonalReason("Passed 5x $50K Static Trading Combines. Great start to the week")).toBeNull();
  });
  it("is dropped by the free gate for a futures-related post", () => {
    const post = "Feel so sick today on a red NQ day with the trailing drawdown on my Topstep combine at 300 left";
    expect(isReplyWorthyBase(post)).toBe(false);
    expect(whyNotReplyWorthy(post)).toBe("sensitive_personal");
  });
});

describe("F2: numbers and firm rules the verified knowledge does not contain", () => {
  const POST_RR = "If you're struggling as a trader, your risk-to-reward might be part of the problem. Everyone wants 1:2, 1:3 or even 1:4 trades.";
  it("blocks the audit's invented win-rate threshold", () => {
    const reply = "A 1:1 target only works if your win rate stays above about 52% after commissions, so that number is the one to check.";
    expect(unsupportedFactProblem(reply, POST_RR)).toMatch(/threshold \(52%\)/);
  });
  it("blocks the audit's firm-rule claim", () => {
    const reply = "Static drawdown on a permanent funded account takes away the trailing floor creeping up after every green day, and Topstep still has that on most accounts.";
    expect(unsupportedFactProblem(reply, "Personally I think Topstep have missed the point here, people trade perps for static drawdown")).toMatch(/firm's rule as fact/);
  });
  it("allows a number from the post, a question, and something framed as a check", () => {
    expect(unsupportedFactProblem("At 80% win rate and 1:1 you are still short once commissions land.", "A) 80% win rate, 1:1 RR")).toBeNull();
    expect(unsupportedFactProblem("Does Topstep still count that day?", "Topstep day")).toBeNull();
    expect(unsupportedFactProblem("Check whether it clears breakeven after costs; Topstep's rule on that is worth reading.", "x")).toBeNull();
  });
  it("allows the audit's good replies", () => {
    const good = [
      "On MNQ, $12 is 6 points on one contract, so that $156 day is roughly 78 points of net capture.",
      "At $64.50 an account the fine print is the deal, so check the funded account cap and any activation fee per pass.",
      "A 7k buffer after a 5k day means a trailing floor probably moved with that peak, so the room left can be smaller than the balance suggests.",
    ];
    for (const r of good) expect(unsupportedFactProblem(r, "$645 for 10x $50K accounts, 7k buffer, +$156.62 on $MNQ")).toBeNull();
  });
});

describe("F1: the journal-lens shape", () => {
  const lens = [
    "Tag every trade as plan or off-plan and keep a separate net P&L total for each.",
    "In a log, sort a month by trades per day and compare net P&L on one-trade days against five-plus days.",
    "Sort a month by their place in the day and compare net P&L on trade one against trades four and up.",
  ];
  it("recognizes the audit's replies as the lens", () => {
    for (const t of lens) expect(usesLogLens(t), t).toBe(true);
    expect(usesLogLens("Being sick on a Friday has one upside.")).toBe(false);
  });
  it("asks for a different shape once two of the recent replies already use it", () => {
    const text = "In a log, compare average points per trade before and after the size-down.";
    expect(logLensProblem(text, lens)).toMatch(/different shape/);
    expect(logLensProblem(text, [lens[0]!, "A plain reply.", "Another plain one."])).toBeNull();
    expect(logLensProblem("A plain observation about their size.", lens)).toBeNull();
  });
});

describe("F5: stock phrase and the Fillbook flag", () => {
  it("bans 'heavy lifting'", () => {
    expect(checkReplyGuardrails("That 30% is doing a lot of heavy lifting.", false)?.reason).toMatch(/stock AI vocabulary/);
  });
  it("derives the flag from the text itself", () => {
    expect(namesFillbook("Tag your first week back as its own group in the log and compare trades per day.")).toBe(false);
    expect(namesFillbook("Fillbook's Exit efficiency card shows how much of each winner was kept.")).toBe(true);
  });
});
