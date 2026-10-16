import { describe, it, expect } from "vitest";
import { computeMentionBudget, MAX_MENTION_SHARE, MENTION_WINDOW } from "../src/prospecting/prospectingMentionBudget";
import { SHOWCASE_REPLY_GUIDANCE } from "../src/content/fillbookShowcase";
import { HUMAN_REPLY_VOICE_RULES } from "../src/content/humanReplyVoice";
import { buildProspectingSystemPrompt, prospectingPlatformProfile } from "../src/prospecting/prospectingReplyWriter";
import { buildInboundSystemPrompt } from "../src/inbound/inboundResponseWriter";

/**
 * 2026-10-15: the account keeps losing followers. Cold and inbound replies are tuned to be worth following and to pitch
 * less. These pin the numbers and the wording so a later edit cannot quietly undo it.
 */
function posted(total: number, naming: number) {
  return Array.from({ length: total }, (_, i) => ({
    repliedAt: new Date(Date.UTC(2026, 9, 1, 0, total - i)).toISOString(),
    finalReply: i < naming ? "Fillbook puts that setup on its own row." : "That stop is the trade.",
    draftReply: null,
  })) as any;
}

describe("mention budget", () => {
  it("allows about one reply in five to name Fillbook", () => {
    expect(MAX_MENTION_SHARE).toBeCloseTo(0.2, 5);
    expect(MENTION_WINDOW).toBe(12);
  });

  it("two of the last twelve is fine, a third one is held back", () => {
    expect(computeMentionBudget(posted(12, 2)).exhausted).toBe(false);
    expect(computeMentionBudget(posted(12, 3)).exhausted).toBe(true);
  });

  it("does not judge a tiny sample", () => {
    expect(computeMentionBudget(posted(4, 4)).exhausted).toBe(false);
  });
});

describe("reply wording for retention", () => {
  it("tells the writer to be worth following and never to ask for a follow", () => {
    expect(HUMAN_REPLY_VOICE_RULES).toContain("BE WORTH FOLLOWING");
    expect(HUMAN_REPLY_VOICE_RULES).toMatch(/Never ask for a follow, a like or a repost/);
    expect(HUMAN_REPLY_VOICE_RULES).toMatch(/one thing a trader can keep/);
  });

  it("keeps the giveaway answer possible when someone asks how to enter", () => {
    expect(HUMAN_REPLY_VOICE_RULES).toMatch(/someone asking how to enter the giveaway/);
    expect(HUMAN_REPLY_VOICE_RULES).toMatch(/Do not bring up the giveaway, a plan or a price on your own/);
  });

  it("states the Essentials price only when asked, and still never to a prop trader", () => {
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/Do not bring up a plan or a price on your own/);
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/only when a trader on their own money asked what\s+it costs/);
    expect(SHOWCASE_REPLY_GUIDANCE).toMatch(/Never mention it to a prop-firm trader/);
    expect(SHOWCASE_REPLY_GUIDANCE).not.toMatch(/end the Fillbook sentence with that fact/);
  });

  for (const [name, prompt] of [
    ["cold reply (Prospecting)", buildProspectingSystemPrompt(prospectingPlatformProfile("x"))],
    ["inbound reply", buildInboundSystemPrompt("x")],
  ] as const) {
    it(`${name} prompt carries both`, () => {
      expect(prompt).toContain("BE WORTH FOLLOWING");
      expect(prompt).toMatch(/Do not bring up a plan or a price on your own/);
    });
  }
});
