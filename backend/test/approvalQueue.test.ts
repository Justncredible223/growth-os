import { describe, expect, it } from "vitest";
import { approvalSource, readableTitle, similarCounts } from "../src/content/approvalQueue";

describe("approval queue helpers (P1 2026-11-15)", () => {
  it("names the source of a draft", () => {
    expect(approvalSource({ assetType: "x_feed_post", isAutoDraft: false, metadataSource: "hq_handoff" })).toBe("hq");
    expect(approvalSource({ assetType: "video_script", isAutoDraft: true })).toBe("video");
    expect(approvalSource({ assetType: "x_feed_post", isAutoDraft: true })).toBe("auto");
    expect(approvalSource({ assetType: "x_feed_post", isAutoDraft: false })).toBe("manual");
  });

  it("uses the post's first sentence as the title, cut at a word", () => {
    expect(readableTitle("See how close you are to your prop firm's rule lines.\n\nFillbook imports trades.", "HQ X draft hq-126")).toBe("See how close you are to your prop firm's rule lines.");
    expect(readableTitle("   ", "HQ X draft hq-1")).toBe("HQ X draft hq-1");
    const long = readableTitle(`${"word ".repeat(40)}end.`, "x");
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("...")).toBe(true);
  });

  it("counts how many other waiting drafts say nearly the same thing", () => {
    const a = "See how close you are to your prop firm's rule lines. Fillbook imports your trades from a CSV export. See the line before you cross it.";
    const b = "Seeing how close you are to your prop firm's rule lines is easier in one journal. Fillbook imports trades from a CSV export. See the line before you cross it.";
    const c = "Log one line after every session: what you planned and what you did.";
    expect(similarCounts([a, b, c])).toEqual([1, 1, 0]);
    expect(similarCounts([a, ""])).toEqual([0, 0]);
  });
});
