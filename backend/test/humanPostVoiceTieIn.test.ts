import { describe, it, expect } from "vitest";
import { HUMAN_POST_VOICE_RULES } from "../src/content/humanReplyVoice";

describe("HUMAN_POST_VOICE_RULES product tie-in", () => {
  // 2026-10-15 (owner goal: stop losing followers): a product_demo or cta post ties back to Fillbook; education, psychology
  // and conversation_starter posts do not have to, and the growth_strategist review no longer fails them for it. When a
  // tie-in IS used it is still a clause tied to a verified capability, never a pitch.
  it("ties product and cta posts back to a verified Fillbook capability, as a clause and not a pitch, and frees the rest", () => {
    expect(HUMAN_POST_VOICE_RULES).toMatch(/A product_demo or cta post ties back to Fillbook/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/does\s+not have to/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/ONE short, plain clause/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/verified knowledge/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/no\s+feature list/);
    expect(HUMAN_POST_VOICE_RULES).not.toMatch(/welcome, tied to one concrete thing/);
  });

  it("keeps the honesty limits: nothing live or real-time, no promised outcome", () => {
    expect(HUMAN_POST_VOICE_RULES).toMatch(/never live or real-time monitoring/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/never a promise of any outcome/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/Never promise or imply profit/);
  });

  // The first version of the tie-in produced "computes the buffer from your synced trades so you know where you stand",
  // which the skeptic and fact_checker rejected as implying real-time knowledge (2026-10-02). The clause is limited to
  // what the screen shows, never when Fillbook knows it.
  it("limits the tie-in to what a screen shows and bans the timing phrases that failed review", () => {
    expect(HUMAN_POST_VOICE_RULES).toMatch(/WHAT the screen shows, never WHEN Fillbook knows it/);
    expect(HUMAN_POST_VOICE_RULES).toMatch(/imported or synced CLOSED trades/);
    for (const phrase of ["know where you stand", "as it happens", "while you trade", "mid-session", "before you breach", "in real time", "instantly", "alerts you before"]) {
      expect(HUMAN_POST_VOICE_RULES, phrase).toContain(`"${phrase}"`);
    }
  });

  // 2026-10-02: the writer followed the safe shape and then appended "so you see the number before you decide to press
  // it", which the hook_specialist rejected as presenting Fillbook as protective. Banning single phrases kept losing to
  // new ones, so the rule forbids the kind of tail and offers sentences that stop where the screen description stops.
  it("forbids purpose, benefit and timing tails on the tie-in, and gives sentences that stop at what the screen shows", () => {
    expect(HUMAN_POST_VOICE_RULES).toMatch(/ONE plain sentence that says what the screen shows and then STOPS/);
    for (const tail of ["so you ...", "before you ...", "when you ...", "to help you ...", "lets you ...", "tells you ...", "keeps you ..."]) {
      expect(HUMAN_POST_VOICE_RULES, tail).toContain(`"${tail}"`);
    }
    expect(HUMAN_POST_VOICE_RULES).toMatch(/does\s+not protect an account or prevent orders/);
    expect(HUMAN_POST_VOICE_RULES).toContain(`"Fillbook's Account Health shows your buffer from your synced trades."`);
    expect(HUMAN_POST_VOICE_RULES).toContain("for you to\n  review afterwards");
  });
});
