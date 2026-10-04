import { describe, it, expect } from "vitest";
import { PINNED_COMMENT, PINNED_COMMENT_LINK, buildPinnedComment } from "../src/video/pinnedComment";
import { MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";

describe("buildPinnedComment", () => {
  it("gives every video the same comment, and always points at the free sample", () => {
    expect(buildPinnedComment("Moved stops cost $656")).toBe(buildPinnedComment("Moved stops cost $656"));
    for (const plan of MOTION_SCENE_PLANS) {
      expect(buildPinnedComment(plan.hook)).toBe(PINNED_COMMENT);
      expect(buildPinnedComment(plan.hook)).toContain(PINNED_COMMENT_LINK);
    }
  });

  it("keeps the guardrails: sample data is said, nothing is promised, nothing is called live", () => {
    expect(PINNED_COMMENT).toMatch(/sample|demo/i);
    expect(PINNED_COMMENT).not.toMatch(/\b(live|real[- ]?time|guarantee|profit|pass(?:ing)? (?:your|the) eval|you will)\b/i);
    expect(PINNED_COMMENT).not.toMatch(/[*_#@]/); // plain text: no markup, no hashtags, no mentions
    expect(PINNED_COMMENT.length).toBeLessThanOrEqual(150); // well inside both platforms' comment limits
  });

  it("starts with the link, so TikTok's cut-off preview bubble still shows it", () => {
    expect(PINNED_COMMENT.indexOf(PINNED_COMMENT_LINK)).toBe(0);
    expect(PINNED_COMMENT.slice(0, 70)).toContain(PINNED_COMMENT_LINK);
  });

  it("opens with the invitation to look, not a defensive disclaimer about the whole video", () => {
    expect(PINNED_COMMENT).not.toMatch(/^everything in this video/i);
  });
});

describe("tracked link (owner approval 2026-10-04)", () => {
  const id = "9f3c2a71-5b0e-4d8a-8c11-aaaaaaaaaaaa";
  it("tags the link with the video's own id and leaves the rest of the wording alone", () => {
    const tracked = buildPinnedComment("hook", id);
    expect(tracked.startsWith(`${PINNED_COMMENT_LINK}?utm_source=video&utm_content=9f3c2a71`)).toBe(true);
    expect(tracked.endsWith(PINNED_COMMENT.slice(PINNED_COMMENT_LINK.length))).toBe(true);
  });
  it("stays inside the comment limit and the guardrails", () => {
    const tracked = buildPinnedComment("hook", id);
    expect(tracked.length).toBeLessThanOrEqual(180);
    expect(tracked).not.toMatch(/\b(live|real[- ]?time|guarantee|profit)\b/i);
  });
  it("keeps the plain link when no id is given", () => {
    expect(buildPinnedComment("hook")).toBe(PINNED_COMMENT);
  });
});
