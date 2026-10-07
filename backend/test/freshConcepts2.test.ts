import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { FRESH_PILOTS, FRESH_CONCEPT_ORDER } from "../src/shortform/freshConcepts";
import { FRESH2_PILOTS, FRESH2_CONCEPT_ORDER, FRESH_LANES } from "../src/shortform/freshConcepts2";
import { nearCopies } from "../src/shortform/conceptVariety";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS, EXTRA_OFFERED_CONCEPT_IDS, dailyPosition, isOfferedPlan } from "../src/shortform/motionPlans";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { scoreStory, renderBar } from "../src/shortform/storyScore";
import { buildMockHtml } from "../scripts/video-factory/mockCard";
import type { SceneSpec } from "../src/shortform/types";

const manifest = loadManifest();
const words = (t: string) => t.trim().split(/\s+/).length;
const frame = (s: SceneSpec) => ({ chart: s.chart!, headline: s.headline, captionText: s.captionText, cta: s.cta, holdSeconds: s.durationSeconds });
/** A screen-recording variant (ids like fresh-02b-...) stands in for the card version of the same idea (fresh-02-...): it keeps its number. */
const ideaOf = (id: string) => id.replace(/^(fresh-\d{2})[a-z]?-.*$/, "$1");
const own = [...FRESH_CONCEPT_ORDER, ...FRESH2_CONCEPT_ORDER];
const offeredAll = [...OFFERED_DAILY_CONCEPT_IDS];
/** The 30 requested days; the 3 card versions of the recorded ideas follow as hidden fallbacks (a near-copy of its recording, so never requested alongside it). */
const pool = offeredAll.slice(0, 30);
const planOf = (id: string) => MOTION_SCENE_PLANS.find((p) => p.planId === id)!;

describe("the 21 more fresh hook-first concepts (freshConcepts2.ts) and the 30-day pool", () => {
  it("make 21 plans, numbered fresh-10 to fresh-30, all resolvable", () => {
    expect(FRESH2_PILOTS).toHaveLength(21);
    expect(FRESH2_CONCEPT_ORDER.map((id) => Number(id.slice(6, 8)))).toEqual(Array.from({ length: 21 }, (_, i) => i + 10));
    for (const p of FRESH2_PILOTS) expect(MOTION_SCENE_PLANS).toContain(p);
  });

  it("the offered pool is exactly 30 distinct ideas: the 9 + the 21, once each (a recording variant stands in for its card version), in one explicit order", () => {
    expect(offeredAll).toHaveLength(33);
    expect(offeredAll.slice(30)).toEqual(["fresh-02-plan-said-3", "fresh-04-setup-lost-422", "fresh-06-five-revenge"]);
    expect(pool).toHaveLength(30);
    expect(new Set(pool).size).toBe(30);
    expect(pool.map(ideaOf).sort()).toEqual(own.map(ideaOf).sort());
    expect(new Set(pool.map(ideaOf)).size).toBe(30);
    expect(EXTRA_OFFERED_CONCEPT_IDS).toEqual([]);
    expect(MOTION_SCENE_PLANS.filter(isOfferedPlan).map((p) => p.planId).sort()).toEqual([...offeredAll].sort());
    offeredAll.forEach((id, i) => expect(dailyPosition(id)).toBe(i));
  });

  it("opens with the strongest universal hooks in days 1-10", () => {
    const first10 = pool.slice(0, 10).map(ideaOf);
    for (const idea of ["fresh-06", "fresh-02", "fresh-01", "fresh-12", "fresh-07"]) expect(first10, idea).toContain(idea);
    expect(ideaOf(pool[0]!)).toBe("fresh-06");
  });

  it("never runs more than two of one lane in a row, and the mix is about 70/30 prop-firm pain to own-money discipline", () => {
    for (const id of own) expect(FRESH_LANES[id], id).toBeDefined();
    const lane = (id: string) => FRESH_LANES[own.find((o) => ideaOf(o) === ideaOf(id))!]!;
    for (let i = 2; i < pool.length; i++) {
      const [a, b, c] = [lane(pool[i - 2]!), lane(pool[i - 1]!), lane(pool[i]!)];
      expect(a === b && b === c, `${pool[i - 2]} / ${pool[i - 1]} / ${pool[i]}`).toBe(false);
    }
    const prop = pool.filter((id) => lane(id) === "prop").length;
    expect(prop / pool.length).toBeGreaterThanOrEqual(0.6);
    expect(prop / pool.length).toBeLessThanOrEqual(0.75);
  });

  it("never serve two concepts about the same recording back to back", () => {
    for (let i = 1; i < pool.length; i++) expect(planOf(pool[i]!).scenes[0]!.assetId, `day ${i + 1}`).not.toBe(planOf(pool[i - 1]!).scenes[0]!.assetId);
  });

  it("are valid plans that clear the A/A+ render bar and cite verified facts on every beat", () => {
    for (const p of FRESH2_PILOTS) {
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, p.planId).toBe(true);
      expect(["A", "A+"], p.planId).toContain(scoreStory(p).grade);
      for (const s of p.scenes) {
        const evidence = s.claims.flatMap((c) => c.evidence);
        expect(evidence.length, s.sceneId).toBeGreaterThan(0);
        for (const e of evidence) expect(manifest.assets.find((a) => a.id === e.assetId)?.facts.some((f) => f.key === e.factKey), `${s.sceneId}: ${e.factKey}`).toBe(true);
      }
    }
  });

  it("each draw on one recording and carry that recording's own data label on every beat and on the slide", () => {
    for (const p of FRESH2_PILOTS) {
      const asset = manifest.assets.find((a) => a.id === p.scenes[0]!.assetId)!;
      expect(asset, p.planId).toBeDefined();
      expect(["Demo data", "EXAMPLE DATA"], p.planId).toContain(asset.dataLabel);
      for (const s of p.scenes) {
        expect(s.assetId, s.sceneId).toBe(asset.id);
        expect(s.disclosure, s.sceneId).toBe(asset.dataLabel);
        expect(s.chart!.mock!.tag, s.sceneId).toBe(asset.dataLabel);
        if (!s.cta) expect(buildMockHtml(frame(s)), s.sceneId).toContain(asset.dataLabel!.toUpperCase()); // the closing invitation slide is the dimmed card with the handle
      }
    }
  });

  it("open on the hook (a figure or a question in the first spoken line) and end on a question; no other beat is a question", () => {
    for (const p of FRESH2_PILOTS) {
      const first = p.scenes[0]!.narration;
      expect(/\d|\?/.test(`${first} ${p.hook}`), `${p.planId} opening "${first}" / hook "${p.hook}"`).toBe(true);
      expect(first, p.planId).not.toMatch(/^(?:your )?fillbook/i);
      const last = p.scenes[p.scenes.length - 1]!;
      expect(last.narration.trim().endsWith("?"), `${p.planId} closing`).toBe(true);
      expect(last.cta, p.planId).not.toBeNull();
      p.scenes.slice(1, -1).forEach((s) => expect(s.narration.trim().endsWith("?"), s.sceneId).toBe(false));
    }
  });

  it("no two concepts in the pool open on the same hook or say the same thing (near-copies)", () => {
    const plans = pool.map(planOf);
    for (let i = 0; i < plans.length; i++) {
      for (let j = i + 1; j < plans.length; j++) expect(nearCopies(plans[i]!, plans[j]!), `${plans[i]!.planId} vs ${plans[j]!.planId}`).toBe(false);
    }
    // Only a recording and its own card version are twins (that is how one hides the other).
    for (const id of offeredAll.slice(30)) for (const other of pool) expect(nearCopies(planOf(id), planOf(other)), `${id} vs ${other}`).toBe(ideaOf(id) === ideaOf(other));
    const hooks = FRESH2_PILOTS.map((p) => p.hook.toLowerCase());
    expect(new Set(hooks).size).toBe(hooks.length);
    for (const p of FRESH_PILOTS) expect(hooks).not.toContain(p.hook.toLowerCase());
  });

  it("name Fillbook, keep lines to 7 words and whole dollars, and frame behavior labels as flags", () => {
    for (const p of FRESH2_PILOTS) {
      expect(p.scenes.map((s) => s.narration).join(" "), p.planId).toMatch(/\bFillbook\b/);
      for (const s of p.scenes) {
        expect(words(s.narration), `${p.planId}: "${s.narration}"`).toBeLessThanOrEqual(7);
        expect(s.narration, p.planId).not.toMatch(/\$[\d,]+\.\d/);
        for (const text of [s.narration, s.captionText, s.takeaway, s.headline]) {
          if (/\b(?:revenge|oversized|tilt|fomo|overtrad\w*)\b/i.test(text)) expect(text, p.planId).toMatch(/\b(?:flag\w*|tagged|possible|review)\b/i);
        }
      }
    }
  });

  it("never claim the product is live or real-time, prevents a breach, promises a pass or a payout, or gives advice", () => {
    for (const p of FRESH2_PILOTS) {
      const all = p.scenes.map((s) => `${s.narration} ${s.captionText} ${s.takeaway}`).join(" ") + ` ${p.title}`;
      expect(all, p.planId).not.toMatch(/\b(?:live|real[- ]?time|guarantee\w*|prevent\w*|you will pass|helps? you pass|payout|should|must)\b/i);
    }
  });

  it("opt in to the hook-first look: frame 0 of beat 1 already shows the hook headline and every opening figure, with no entrance animation", () => {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    for (const p of FRESH2_PILOTS) {
      expect(p.scenes.every((s) => s.chart?.hookFirst === true), p.planId).toBe(true);
      const s = p.scenes[0]!;
      const html = buildMockHtml(frame(s));
      for (const line of s.chart!.lines) expect(html, `${p.planId} hook line`).toContain(esc(line));
      for (const fig of s.chart!.mock!.opening) expect(html, p.planId).toContain(`>${esc(fig.value)}</div>`);
      expect(html, p.planId).not.toMatch(/data-a="/);
    }
  });

  it("the older ui.* captures are labelled EXAMPLE DATA, and their screenshots exist", () => {
    const ui = FRESH2_PILOTS.filter((p) => p.scenes[0]!.assetId?.startsWith("ui."));
    expect(ui.length).toBeGreaterThanOrEqual(4);
    for (const p of ui) {
      for (const s of p.scenes) expect(s.disclosure).toBe("EXAMPLE DATA");
      const file = manifest.assets.find((a) => a.id === p.scenes[0]!.assetId)!.file;
      expect(existsSync(new URL(`../scripts/video-factory/assets/${file}`, import.meta.url)), file).toBe(true);
    }
  });
});
