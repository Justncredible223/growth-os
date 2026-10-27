import { describe, expect, it } from "vitest";
import { TAG_ONE_IN, replyTagProblem, tagGateOpen, taggableHandles } from "../src/prospecting/prospectingTagging.js";

describe("taggableHandles", () => {
  it("returns only accounts the post names, not the author or our own account, once each", () => {
    const post = "@BigTrader what do you do after a blown eval? @bigtrader also @FillbookHQ and @Other_Guy @alice";
    expect(taggableHandles(post, "alice")).toEqual(["BigTrader", "Other_Guy"]);
  });
  it("ignores email-like text", () => {
    expect(taggableHandles("mail me a@b.com", null)).toEqual([]);
  });
});

describe("tagGateOpen", () => {
  it("is stable per candidate and opens for roughly one in five", () => {
    expect(tagGateOpen("abc")).toBe(tagGateOpen("abc"));
    const open = Array.from({ length: 2000 }, (_, i) => tagGateOpen(`cand-${i}`)).filter(Boolean).length;
    expect(open / 2000).toBeGreaterThan(0.15);
    expect(open / 2000).toBeLessThan(0.25);
    expect(TAG_ONE_IN).toBe(5);
  });
});

describe("replyTagProblem", () => {
  const body = "That stop sits inside the usual noise on NQ, so widening it before the open fixes most of those exits.";
  it("allows a reply with no tag", () => expect(replyTagProblem(body, [])).toBeNull());
  it("rejects any tag when tagging is closed", () => expect(replyTagProblem(`@x ${body}`, [])).toMatch(/not allowed/));
  it("allows one tag from the allowed list inside a real reply", () => expect(replyTagProblem(`${body} @BigTrader sizes this the same way.`, ["BigTrader"])).toBeNull());
  it("rejects a tag that the post did not name", () => expect(replyTagProblem(`${body} @Random`, ["BigTrader"])).toMatch(/not named in the post/));
  it("rejects two tags", () => expect(replyTagProblem(`${body} @BigTrader @Other`, ["BigTrader", "Other"])).toMatch(/more than one/));
  it("rejects a reply that is mostly a tag", () => expect(replyTagProblem("@BigTrader thoughts on this?", ["BigTrader"])).toMatch(/mostly a tag/));
});
