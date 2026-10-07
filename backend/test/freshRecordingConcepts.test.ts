import { describe, it, expect } from "vitest";
import { FRESH_PILOTS } from "../src/shortform/freshConcepts";
import { RECORDING_PILOTS, RECORDING_CONCEPT_ORDER, cardVersionOf } from "../src/shortform/freshRecordingConcepts";
import { RECORDING, computeRecordingLayout, mapToFrame, recordingSafetyProblems } from "../src/shortform/recordingLayout";
import { computeScenePlanHash, loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar, scoreStory } from "../src/shortform/storyScore";
import { isNarratedMockPlan, isOfferedPlan, isRecordingPlan, isPayoffPlan, MOTION_SCENE_PLANS } from "../src/shortform/motionPlans";
import { nearCopies } from "../src/shortform/conceptVariety";
import { buildRecordingCues } from "../scripts/video-factory/recordingCues";
import { PLATFORM_OVERLAY_ZONES } from "../scripts/video-factory/render";
import { manualMotionConceptTitle } from "../src/opportunities/manualMotionConcept";

const manifest = loadManifest();
const card = (id: string) => FRESH_PILOTS.find((p) => p.planId === id)!;

describe("the 3 screen-recording alternatives of fresh concepts", () => {
  it("are fresh-02b, fresh-04b and fresh-06b, each standing in for one card concept", () => {
    expect(RECORDING_CONCEPT_ORDER).toEqual(["fresh-02b-plan-said-3-recording", "fresh-04b-setup-lost-422-recording", "fresh-06b-five-revenge-recording"]);
    expect(RECORDING_CONCEPT_ORDER.map((id) => cardVersionOf(id))).toEqual(["fresh-02-plan-said-3", "fresh-04-setup-lost-422", "fresh-06-five-revenge"]);
    expect(cardVersionOf("fresh-02-plan-said-3")).toBeUndefined();
    for (const p of RECORDING_PILOTS) {
      expect(isRecordingPlan(p), p.planId).toBe(true);
      expect(isOfferedPlan(p), p.planId).toBe(true);
      expect(isNarratedMockPlan(p), p.planId).toBe(true);
      expect(isPayoffPlan(p), p.planId).toBe(true);
      expect(MOTION_SCENE_PLANS).toContain(p);
      expect(p.scenes.every((s) => s.layout === "recording" && s.crop && s.clipTimeRangeSeconds && s.recording)).toBe(true);
    }
  });

  it("say exactly what their card version says: the same hook and the same five spoken lines, takeaways and invitation", () => {
    for (const p of RECORDING_PILOTS) {
      const c = card(cardVersionOf(p.planId)!);
      expect(p.hook, p.planId).toBe(c.hook);
      expect(p.scenes.map((s) => s.narration), p.planId).toEqual(c.scenes.map((s) => s.narration));
      expect(p.scenes.map((s) => s.takeaway), p.planId).toEqual(c.scenes.map((s) => s.takeaway));
      expect(p.scenes.map((s) => s.cta), p.planId).toEqual(c.scenes.map((s) => s.cta));
      expect(p.scenes[0]!.assetId, p.planId).toBe(c.scenes[0]!.assetId);
      // The hook is drawn in the first scene's first lines, word for word.
      expect(p.scenes[0]!.recording!.lines.join(" "), p.planId).toBe(p.hook);
    }
  });

  it("pass claim/evidence validation with no errors, clear the A/A+ render bar, and have their own title and hash", () => {
    const titles = new Set(FRESH_PILOTS.map((p) => manualMotionConceptTitle({ id: p.planId, title: p.title, hook: p.hook, topic: p.topic })));
    for (const p of RECORDING_PILOTS) {
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
      expect(["A", "A+"], p.planId).toContain(scoreStory(p).grade);
      expect(titles.has(manualMotionConceptTitle({ id: p.planId, title: p.title, hook: p.hook, topic: p.topic })), p.planId).toBe(false);
      expect(computeScenePlanHash(p), p.planId).not.toBe(computeScenePlanHash(card(cardVersionOf(p.planId)!)));
    }
  });

  it("show only recorded footage of the demo account: labelled Demo data on every beat, a usable clip range of at least 4.2 s, no private region in the crop", () => {
    for (const p of RECORDING_PILOTS) {
      for (const s of p.scenes) {
        const asset = manifest.assets.find((a) => a.id === s.assetId)!;
        expect(asset.kind).toBe("screen_recording");
        expect(s.disclosure, s.sceneId).toBe("Demo data");
        const r = s.clipTimeRangeSeconds!;
        expect(r.end - r.start, s.sceneId).toBeGreaterThanOrEqual(4.19);
        // Every cited fact is on screen for the whole range this scene plays (the fact windows are where the recording holds still).
        for (const ev of s.claims.flatMap((c) => c.evidence)) {
          const w = asset.facts.find((f) => f.key === ev.factKey)!.timeRangeSeconds!;
          expect(r.start, `${s.sceneId} ${ev.factKey}`).toBeGreaterThanOrEqual(w.start);
          expect(r.end, `${s.sceneId} ${ev.factKey}`).toBeLessThanOrEqual(w.end + 0.01);
        }
        for (const priv of asset.privateRegions) {
          const c = s.crop!;
          const overlaps = priv.region.x < c.x + c.w && c.x < priv.region.x + priv.region.w && priv.region.y < c.y + c.h && c.y < priv.region.y + priv.region.h;
          expect(overlaps, `${s.sceneId} shows a ${priv.kind}`).toBe(false);
        }
      }
    }
  });

  it("keep the card, the rings and every line of text inside the safe zones: nothing at x >= 930 from y 740, nothing at y >= 1600", () => {
    for (const p of RECORDING_PILOTS) {
      for (const s of p.scenes) {
        const rec = s.recording!;
        const layout = computeRecordingLayout(s.crop!, { headline: s.headline, captionText: s.captionText, cta: s.cta, hook: rec.hook }, rec.lines);
        expect(recordingSafetyProblems(layout), s.sceneId).toEqual([]);
        const c = layout.card;
        expect(c.x + c.width, s.sceneId).toBeLessThanOrEqual(PLATFORM_OVERLAY_ZONES.rightColumn.x);
        expect(layout.bottom, s.sceneId).toBeLessThanOrEqual(PLATFORM_OVERLAY_ZONES.captionTop);
        expect(c.scale, s.sceneId).toBeGreaterThan(0.85);
        // Rings sit on the card (with their padding they stay left of the right-hand button column too).
        for (const h of rec.highlights) {
          const r = mapToFrame(layout, s.crop!, h);
          expect(r.x, s.sceneId).toBeGreaterThanOrEqual(c.x - 0.5);
          expect(r.y, s.sceneId).toBeGreaterThanOrEqual(c.y - 0.5);
          // A ring (with its 8 px padding) may only reach the button column's x if it ends above the column's top.
          if (r.x + r.w + 8 >= PLATFORM_OVERLAY_ZONES.rightColumn.x) expect(r.y + r.h + 8, s.sceneId).toBeLessThan(PLATFORM_OVERLAY_ZONES.rightColumn.y);
          expect(r.y + r.h, s.sceneId).toBeLessThanOrEqual(c.y + c.height + 0.5);
        }
        // The crop never reaches the app header or the recording's corner button.
        expect(s.crop!.y, s.sceneId).toBeGreaterThanOrEqual(140);
        expect(s.crop!.y + s.crop!.h, s.sceneId).toBeLessThanOrEqual(1740);
      }
    }
  });

  it("draw the hook as large text from the very first frame (no fade, no pop) and ring the figure on every beat", () => {
    for (const p of RECORDING_PILOTS) {
      let start = 0;
      for (const [i, s] of p.scenes.entries()) {
        const rec = s.recording!;
        const layout = computeRecordingLayout(s.crop!, { headline: s.headline, captionText: s.captionText, cta: s.cta, hook: rec.hook }, rec.lines);
        const cues = buildRecordingCues({ spec: rec, layout, crop: s.crop!, captionText: s.captionText, cta: s.cta, start, end: start + s.durationSeconds });
        const text = cues.filter((c) => c.layer === 2);
        const headline = text.slice(0, layout.headlineLines.length);
        expect(headline.map((c) => c.startSeconds), s.sceneId).toEqual(headline.map(() => start));
        for (const c of headline) expect(c.text, s.sceneId).not.toMatch(/\\fad|\\t\(|\\move/);
        if (i === 0) expect(layout.headlineFont, p.planId).toBeGreaterThanOrEqual(120);
        expect(cues.filter((c) => c.layer === 3), s.sceneId).toHaveLength(rec.highlights.length);
        start += s.durationSeconds;
      }
    }
  });

  it("are near-copies of their own card version (same spoken lines) and of no other concept, so the pool offers one of the two", () => {
    for (const p of RECORDING_PILOTS) {
      const own = card(cardVersionOf(p.planId)!);
      expect(nearCopies(p, own), p.planId).toBe(true);
      for (const other of FRESH_PILOTS.filter((c) => c !== own)) expect(nearCopies(p, other), `${p.planId} vs ${other.planId}`).toBe(false);
    }
  });
});

describe("recordingLayout", () => {
  const text = { headline: "One line", captionText: "Fillbook · Reports", cta: null, hook: false };

  it("puts a 1000 px crop in the safe column at 0.88x and a narrow crop at no more than 1.25x", () => {
    expect(computeRecordingLayout({ x: 0, y: 200, w: 1000, h: 400 }, text).card).toMatchObject({ x: 40, width: 880, scale: 0.88 });
    const narrow = computeRecordingLayout({ x: 0, y: 200, w: 500, h: 300 }, text).card;
    expect(narrow.scale).toBe(RECORDING.maxScale);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(920);
  });

  it("reports a card so tall that its text would run into the platforms' caption area", () => {
    const tall = computeRecordingLayout({ x: 0, y: 140, w: 1000, h: 1600 }, text);
    expect(recordingSafetyProblems(tall).join(" ")).toMatch(/safe bottom/);
  });
});
