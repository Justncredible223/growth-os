import { describe, expect, it } from "vitest";
import { matchInstantAnswer } from "../src/liveHost/liveHostInstant.js";
import { checkSpokenLine } from "../src/liveHost/liveHostGuardrails.js";

const ctx = { authorName: "Alex", websiteAllowed: true, recentLines: [] as string[] };

describe("instant answers", () => {
  it.each([
    ["HELLO", "greeting"],
    ["hey tilt", "greeting"],
    ["WHAT IS FILLBOOK HQ", "what-is-fillbook"],
    ["what's fillbook", "what-is-fillbook"],
    ["how much does it cost", "price"],
    ["is it free?", "price"],
    ["who are you", "who"],
    ["are you an ai", "is-ai"],
    ["what can it do", "features"],
    ["where is the link", "where"],
    ["what is a trailing drawdown", "trailing-drawdown"],
    ["how does the daily loss limit work", "daily-loss-limit"],
    ["what is the consistency rule", "consistency-rule"],
    ["what is a revenge trade", "revenge-trade"],
    ["mnq vs nq", "mnq-vs-nq"],
    ["what is a prop firm", "prop-firm"],
    ["what is an eval", "evaluation"],
    ["thanks tilt", "thanks"],
  ])("answers %s without a model", (body, key) => {
    expect(matchInstantAnswer(body, ctx)?.key).toBe(key);
  });

  it("leaves real questions and long messages to the model", () => {
    expect(matchInstantAnswer("how do I size a trade with a 20 point stop on MNQ", ctx)).toBeNull();
    expect(matchInstantAnswer("is the trailing drawdown on this firm intraday or end of day", ctx)).toBeNull();
    expect(matchInstantAnswer("my plans for tonight are a revenge trade", ctx)).toBeNull();
    expect(matchInstantAnswer("what is the trailing drawdown on topstep", ctx)).toBeNull();
  });

  it("every line passes the spoken-line checks and states only approved prices", () => {
    const bodies = ["hello", "what is fillbook", "how much", "who are you", "are you ai", "what can it do", "link", "what is a trailing drawdown", "how does the daily loss limit work", "what is the consistency rule", "what is a revenge trade", "mnq vs nq", "what is a prop firm", "what is an eval", "why journal", "thanks tilt"];
    for (const body of bodies) {
      for (const websiteAllowed of [true, false]) {
        const answer = matchInstantAnswer(body, { ...ctx, websiteAllowed });
        expect(answer, body).not.toBeNull();
        expect(checkSpokenLine(answer!.text, { fillbookMentionAllowed: true, websiteMentionAllowed: websiteAllowed }), `${body} ${websiteAllowed}`).toBeNull();
      }
    }
  });

  it("never says the website on a TikTok stream and points to the bio", () => {
    const answer = matchInstantAnswer("what is fillbook", { ...ctx, websiteAllowed: false });
    expect(answer?.text).toContain("link in the bio");
    expect(answer?.text).not.toMatch(/fillbookhq/i);
  });

  it("does not repeat the same words back to back", () => {
    const first = matchInstantAnswer("hello", ctx)!;
    const second = matchInstantAnswer("hello", { ...ctx, recentLines: [first.text] })!;
    expect(second.text).not.toBe(first.text);
  });
});
