import { describe, it, expect } from "vitest";
import { PINNED_COMMENT, PINNED_COMMENT_PHRASE, buildPinnedComment } from "../src/video/pinnedComment";
import { MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";

describe("buildPinnedComment", () => {
  it("gives every video the same comment, and always points at the bio link", () => {
    expect(buildPinnedComment("Moved stops cost $656")).toBe(buildPinnedComment("Moved stops cost $656"));
    for (const plan of MOTION_SCENE_PLANS) {
      expect(buildPinnedComment(plan.hook, "asset-id")).toBe(PINNED_COMMENT);
      expect(buildPinnedComment(plan.hook)).toContain(PINNED_COMMENT_PHRASE);
    }
  });

  it("has no URL in it (links in comments are not tappable and drew a Promotional label)", () => {
    expect(PINNED_COMMENT).not.toMatch(/https?:|www\.|\.com|utm_/i);
  });

  it("keeps the guardrails: sample data is said, nothing is promised, nothing is called live", () => {
    expect(PINNED_COMMENT).toMatch(/sample|demo/i);
    expect(PINNED_COMMENT).not.toMatch(/\b(live|real[- ]?time|guarantee|profit|pass(?:ing)? (?:your|the) eval|you will)\b/i);
    expect(PINNED_COMMENT).not.toMatch(/[*_#@]/); // plain text: no markup, no hashtags, no mentions
    expect(PINNED_COMMENT.length).toBeLessThanOrEqual(150); // well inside both platforms' comment limits
  });

  it("opens with the invitation to look, not a defensive disclaimer about the whole video", () => {
    expect(PINNED_COMMENT).not.toMatch(/^everything in this video/i);
    expect(PINNED_COMMENT).toMatch(/^Open this same screen/);
  });
});
