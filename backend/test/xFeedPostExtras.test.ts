import { describe, expect, it } from "vitest";
import {
  REFERENCE_TOPICS,
  POSTING_WINDOW_NOTE,
  buildImageSpec,
  composeOwnerNote,
  headlineFromPost,
  isReferencePostDay,
  numbersInPost,
  pickReferenceTopic,
} from "../src/content/xFeedPostExtras.js";
import { feedPostTopicLabel } from "../src/content/dailyXFeedPost.js";

describe("reference post day", () => {
  it("is Wednesday only", () => {
    expect(isReferencePostDay("2026-11-04")).toBe(true); // Wednesday
    for (const d of ["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]) expect(isReferencePostDay(d)).toBe(false);
  });

  it("rotates through the reference topics week by week and skips tried ones", () => {
    const keys = new Set([pickReferenceTopic("2026-11-04")!.key, pickReferenceTopic("2026-11-11")!.key, pickReferenceTopic("2026-11-18")!.key]);
    expect(keys.size).toBe(REFERENCE_TOPICS.length);
    const first = pickReferenceTopic("2026-11-04")!;
    expect(pickReferenceTopic("2026-11-04", [first.key])!.key).not.toBe(first.key);
    expect(pickReferenceTopic("2026-11-04", REFERENCE_TOPICS.map((t) => t.key))).toBeNull();
  });

  it("has labels for the Home card, and no topic carries a firm-specific number or a link", () => {
    for (const t of REFERENCE_TOPICS) {
      expect(feedPostTopicLabel(t.key)).toBe(t.label);
      expect(t.rationale).toMatch(/NO link in the post body/);
      expect(t.rationale).toMatch(/rulebook/);
      expect(t.rationale).toMatch(/DXtrade/);
      expect(t.rationale).toMatch(/Core or Elite/);
      expect(t.imageSpec).not.toMatch(/\$\s?\d|\d\s?%/);
      expect(t.imageSpec).not.toMatch(/https?:/);
    }
  });
});

describe("image spec and posting window", () => {
  it("uses the fixed brief for a reference topic", () => {
    const t = REFERENCE_TOPICS[0]!;
    expect(buildImageSpec(t, "anything")).toBe(t.imageSpec);
  });

  it("builds a brief from the draft for a normal day, quoting only numbers the post states", () => {
    const text = "Rule: after two losing trades, max size drops to 1 contract. Capped at $300 a day.";
    const spec = buildImageSpec({ key: "x", label: "Discipline" }, text);
    expect(spec).toContain("Headline in large text:");
    expect(spec).toContain("$300");
    expect(spec).toContain("1 contract");
    expect(spec).not.toMatch(/\d{4,}/);
  });

  it("says so when the post has no number instead of inventing one", () => {
    expect(buildImageSpec({ key: "x", label: "Journaling" }, "Most journals die in week three.")).toContain("states no number");
    expect(numbersInPost("No figures here")).toEqual([]);
  });

  it("shortens a long first sentence", () => {
    expect(headlineFromPost("a".repeat(120)).length).toBeLessThanOrEqual(70);
  });

  it("the owner note keeps the reason, then the image, then the window", () => {
    const note = composeOwnerNote('Selected "Discipline" (score 14.9)', { key: "x", label: "Discipline" }, "Stay small after two losses.");
    expect(note.startsWith('Selected "Discipline"')).toBe(true);
    expect(note.indexOf("Image:")).toBeGreaterThan(note.indexOf("Selected"));
    expect(note.indexOf("When:")).toBeGreaterThan(note.indexOf("Image:"));
    expect(note).toContain(POSTING_WINDOW_NOTE);
    expect(POSTING_WINDOW_NOTE).toMatch(/9:30 ET/);
    expect(POSTING_WINDOW_NOTE).toMatch(/about 10:00 ET/);
    expect(POSTING_WINDOW_NOTE).toMatch(/4:00 ET/);
    expect(POSTING_WINDOW_NOTE).toMatch(/2 hours/);
    // No 2-hour impressions check is taught: under ~200 impressions is only an eligibility condition, not a diagnosis.
    expect(POSTING_WINDOW_NOTE).not.toMatch(/impression/i);
  });

  it("only the drawdown reference post suggests a first reply with the calculator, never in the post body", () => {
    const drawdown = REFERENCE_TOPICS.find((t) => t.key === "reference_drawdown_types")!;
    const note = composeOwnerNote("why", drawdown, "caption");
    expect(note).toContain("First reply");
    expect(note).toContain("https://www.fillbookhq.com/tools/prop-firm-drawdown-calculator");
    expect(note.indexOf("First reply")).toBeGreaterThan(note.indexOf("Image:"));
    expect(note.indexOf("When:")).toBeGreaterThan(note.indexOf("First reply"));
    expect(drawdown.rationale).toMatch(/NO link in the post body/);
    for (const t of REFERENCE_TOPICS.filter((x) => x.key !== "reference_drawdown_types")) {
      expect(composeOwnerNote("why", t, "caption")).not.toContain("First reply");
    }
    expect(composeOwnerNote("why", { key: "x", label: "Discipline" }, "Stay small.")).not.toContain("First reply");
  });

  it("marks the reference post in the note", () => {
    expect(composeOwnerNote("why", REFERENCE_TOPICS[1]!, "caption")).toMatch(/^Weekly reference post/);
  });
});
