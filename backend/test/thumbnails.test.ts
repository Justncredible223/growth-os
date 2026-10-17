import { describe, it, expect } from "vitest";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS } from "../src/shortform/motionPlans";
import { THUMB_HEADLINE_MAX, THUMB_SAFE, headlinePieces, thumbnailSpecFor } from "../src/shortform/thumbnails";
import { ILLUSTRATION_TAG } from "../src/shortform/strategyCharts";
import { buildThumbnailHtml } from "../scripts/video-factory/mockCard";

const planOf = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id)!;
const offered = OFFERED_DAILY_CONCEPT_IDS.map(planOf);

describe("thumbnailSpecFor", () => {
  it("a strategy video's cover shows its drawn chart in full, tagged STRATEGY, with the illustration line", () => {
    const spec = thumbnailSpecFor(planOf("strategy-01-orb-range-trigger"));
    expect(spec.tag).toBe("STRATEGY");
    expect(spec.fine).toBe(ILLUSTRATION_TAG);
    expect(spec.visual?.kind).toBe("chart");
    if (spec.visual?.kind === "chart") expect(spec.visual.chart.overlays.length).toBeGreaterThanOrEqual(3); // the stop-and-target beat, not the bare range
  });

  it("an explainer's cover shows the app's own figures as big tiles, labelled demo data", () => {
    const spec = thumbnailSpecFor(planOf("explain-01-copy-trading-risk"));
    expect(spec.tag).toBe("EXPLAINED");
    expect(spec.visual?.kind).toBe("tiles");
    expect(spec.fine).toMatch(/demo data|example data/i);
    expect(spec.headline).toBe("Same trade. Two accounts. Each lost $1,201.");
  });

  it("every offered video has a short headline and a visual, and never internal campaign text", () => {
    expect(offered).toHaveLength(30);
    for (const p of offered) {
      const spec = thumbnailSpecFor(p);
      expect(spec.headline.length, p.planId).toBeGreaterThan(8);
      expect(spec.headline.length, p.planId).toBeLessThanOrEqual(THUMB_HEADLINE_MAX);
      expect(spec.visual, p.planId).not.toBeNull();
      expect(`${spec.headline} ${spec.tag} ${spec.fine}`, p.planId).not.toMatch(/motion concept|screen recording|opportunit/i);
    }
  });

  it("covers are distinct, so no two tiles on the grid look the same", () => {
    expect(new Set(offered.map((p) => thumbnailSpecFor(p).headline)).size).toBe(30);
  });
});

describe("headlinePieces", () => {
  it("picks out dollar amounts, percentages, plain numbers and multiples", () => {
    expect(headlinePieces("Moved the stop 4 times. Lost $656.").filter((p) => p.figure).map((p) => p.text)).toEqual(["4", "$656"]);
    expect(headlinePieces("46% from one day. Firm limit: only 40%.").filter((p) => p.figure).map((p) => p.text)).toEqual(["46%", "40%"]);
    expect(headlinePieces("Lost $127, then sized up 2.5x").filter((p) => p.figure).map((p) => p.text)).toEqual(["$127", "2.5x"]);
    expect(headlinePieces("Plan said 3.").map((p) => p.text).join("")).toBe("Plan said 3.");
  });
});

describe("the cover layout", () => {
  const boxes = (html: string) =>
    [...html.matchAll(/data-box="(thumb\w+)" style="left:(\d+)px;top:(\d+)px;width:(\d+)px;height:(\d+)px/g)].map((m) => ({ name: m[1]!, x: +m[2]!, y: +m[3]!, w: +m[4]!, h: +m[5]! }));

  it("every box sits inside the 3:4 centre of the frame that a profile-grid tile shows", () => {
    for (const p of offered) {
      const found = boxes(buildThumbnailHtml(thumbnailSpecFor(p)));
      expect(found.length, p.planId).toBeGreaterThanOrEqual(5);
      for (const b of found) {
        expect(b.x, `${p.planId} ${b.name}`).toBeGreaterThanOrEqual(THUMB_SAFE.x);
        expect(b.y, `${p.planId} ${b.name}`).toBeGreaterThanOrEqual(THUMB_SAFE.y);
        expect(b.x + b.w, `${p.planId} ${b.name}`).toBeLessThanOrEqual(THUMB_SAFE.x + THUMB_SAFE.w);
        expect(b.y + b.h, `${p.planId} ${b.name}`).toBeLessThanOrEqual(THUMB_SAFE.y + THUMB_SAFE.h);
      }
    }
  });

  it("the headline never overlaps the picture under it", () => {
    for (const p of offered) {
      const found = boxes(buildThumbnailHtml(thumbnailSpecFor(p)));
      const head = found.find((b) => b.name === "thumbHead")!;
      const visual = found.find((b) => b.name === "thumbVisual")!;
      expect(head.y + head.h, p.planId).toBeLessThanOrEqual(visual.y);
    }
  });

  it("colours the headline's figures and carries the tag and fine print", () => {
    const html = buildThumbnailHtml(thumbnailSpecFor(planOf("explain-03-moving-stops")));
    expect(html).toContain('<span class="fig bad">$656</span>');
    expect(html).toContain("EXPLAINED");
    expect(html).toMatch(/demo data/i);
  });
});
