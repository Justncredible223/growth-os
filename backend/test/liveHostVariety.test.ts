import { describe, expect, it } from "vitest";
import { OPENING_DEFAULTS, asksChat, claimsChatReaction, stripChatReactionClaims, openingKey, opensWithWelcome, overusedBits, repeatsOpening, saidDisclaimer, varietyGuidance, varietyProblem } from "../src/liveHost/liveHostVariety";

describe("overusedBits", () => {
  it("flags a bit used twice in the last six lines and not one used once", () => {
    const lines = ["The market's closed again.", "I have no hands.", "Stops are suggestions.", "Market is closed, so here we are."];
    expect(overusedBits(lines)).toEqual(["the market being closed"]);
    expect(overusedBits(["Fresh line one.", "Fresh line two."])).toEqual([]);
  });
});

describe("openings", () => {
  it("ignores the name when comparing openings", () => {
    expect(openingKey("Marcus, welcome. Glad you came.")).toBe(openingKey("Dee, welcome. Different words."));
    expect(repeatsOpening("Sam, welcome. Something else.", ["Marcus, welcome. Old line.", "Other."])).toBe(true);
    expect(repeatsOpening("Sam, that stop had a name.", ["Marcus, welcome. Old line."])).toBe(false);
  });

  it("spots the welcome tic", () => {
    expect(opensWithWelcome("Marcus, welcome. You walked into a stream.")).toBe(true);
    expect(opensWithWelcome("Welcome in. Pull up a chair.")).toBe(true);
    expect(opensWithWelcome("A stop that moves is a suggestion box.")).toBe(false);
  });
});

describe("invented chat reactions", () => {
  it("catches claims about what chat did", () => {
    for (const text of [
      "Chat went so quiet I thought I'd lost the last two of you.",
      "Chat was split on that one.",
      "Nobody guessed, which tells me everything.",
      "Chat said fifty percent and chat was right.",
      "You all went quiet when I said math.",
    ]) expect(claimsChatReaction(text), text).toBe(true);
  });

  it("leaves ordinary lines alone", () => {
    for (const text of [
      "Chat, type a number from one to ten.",
      "A trader moved his stop and called it research.",
      "I read every journal in the chat of my mind, and none of them moved a stop twice.",
      "The stop is a suggestion box.",
    ]) expect(claimsChatReaction(text), text).toBe(false);
  });

  it("is a problem only when nobody has spoken", () => {
    const guidance = varietyGuidance([], false);
    const ctx = { isSegment: true, isOpening: false, viewerAskedForAdvice: false };
    expect(varietyProblem("Chat went so quiet I could hear the mouse.", guidance, [], { ...ctx, viewerSpoke: false })).toContain("nobody in chat has said anything");
    expect(varietyProblem("Chat went so quiet I could hear the mouse.", guidance, [], { ...ctx, viewerSpoke: true })).toBeNull();
  });
});

describe("stripChatReactionClaims", () => {
  it("drops the sentence that claims a reaction and keeps the rest", () => {
    expect(stripChatReactionClaims("Nobody guessed, which tells me everything. The answer is one thousand. Fifty percent of two thousand.")).toBe("The answer is one thousand. Fifty percent of two thousand.");
  });

  it("leaves a line alone when there is no claim, or when the claim is the whole line", () => {
    expect(stripChatReactionClaims("Fifty percent of two thousand is one thousand.")).toBe("Fifty percent of two thousand is one thousand.");
    expect(stripChatReactionClaims("Chat went so quiet.")).toBe("Chat went so quiet.");
  });
});

describe("the Tilt-o-Meter rating and opening defaults", () => {
  it("wants a rating on the Tilt-o-Meter", () => {
    const guidance = varietyGuidance([], true);
    const ctx = { isSegment: true, isOpening: false, viewerAskedForAdvice: false, segmentId: "tilt_o_meter" };
    expect(varietyProblem("A trader moves his stop. How tilted is that?", guidance, [], { ...ctx, tiltLevel: null })).toContain("Tilt-o-Meter rating");
    expect(varietyProblem("A trader moves his stop. Seven out of ten.", guidance, [], { ...ctx, tiltLevel: 7 })).toBeNull();
    expect(varietyProblem("A different segment entirely.", guidance, [], { ...ctx, segmentId: "roast_my_trade", tiltLevel: null })).toBeNull();
  });

  it("lists the defaults an opening must avoid", () => {
    expect(OPENING_DEFAULTS).toContain("the market being closed");
  });
});

describe("chat asks and the disclaimer", () => {
  it("recognises a closing ask to chat", () => {
    expect(asksChat("A good one. Chat, which gravestone has your name on it?")).toBe(true);
    expect(asksChat("Type your number in chat.")).toBe(true);
    expect(asksChat("A trader moved his stop and wrote a poem about it.")).toBe(false);
  });

  it("recognises the disclaimer", () => {
    expect(saidDisclaimer("This is entertainment, not financial advice.")).toBe(true);
    expect(saidDisclaimer("Nothing to see here.")).toBe(false);
  });
});

describe("varietyGuidance and varietyProblem", () => {
  const recent = ["Chat, type a number.", "Marcus, welcome. The market is closed.", "Dee, welcome. Market's closed. Not financial advice."];
  it("does not allow a chat ask right after one, or in an empty room", () => {
    expect(varietyGuidance(recent, true).askChat).toBe(false);
    expect(varietyGuidance(["A plain line."], true).askChat).toBe(true);
    expect(varietyGuidance(["A plain line."], false).askChat).toBe(false);
  });

  it("explains why a draft should be rewritten, and lets a fresh one through", () => {
    const guidance = varietyGuidance(recent, true);
    const ctx = { isSegment: false, isOpening: false, viewerAskedForAdvice: false };
    expect(varietyProblem("The market's closed, so who cares.", guidance, recent, ctx)).toContain("the market being closed");
    expect(varietyProblem("Sam, welcome. Fresh words here.", { ...guidance, avoid: [] }, recent, ctx)).toContain("welcome");
    expect(varietyProblem("That is not financial advice, mind.", varietyGuidance(["x"], true), ["x"], ctx)).toBeNull();
    expect(varietyProblem("A stop that moves is a hostage negotiation.", guidance, recent, ctx)).toBeNull();
  });

  it("lets the opening say the disclaimer and a viewer who asks for advice get it", () => {
    const guidance = varietyGuidance(recent, true);
    expect(varietyProblem("This is entertainment, not financial advice.", { ...guidance, avoid: [] }, ["x"], { isSegment: true, isOpening: true, viewerAskedForAdvice: false })).toBeNull();
    expect(varietyProblem("I do not give advice, this is not financial advice.", { ...guidance, avoid: [] }, ["x"], { isSegment: false, isOpening: false, viewerAskedForAdvice: true })).toBeNull();
  });
});
