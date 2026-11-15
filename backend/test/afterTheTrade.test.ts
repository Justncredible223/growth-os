import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AFTER_THE_TRADE_ORDER,
  AFTER_THE_TRADE_PILOTS,
  CLOSE_LINE,
  HOOK_CUTS,
  HOOK_FORBIDDEN_WORDS,
  KEPT_BEATS,
  RULE_CUTS,
  STRATEGY_HOOKS,
  afterTheTradeOrder,
  hookChart,
  isStrategyHookCut,
} from "../src/shortform/afterTheTrade";
import { EXPLAINERS_OFFERED, EXPLAINER_PILOTS } from "../src/shortform/explainers";
import { MOTION_SCENE_PLANS, OFFERED_DAILY_CONCEPT_IDS, isNarratedMockPlan, isOfferedPlan } from "../src/shortform/motionPlans";
import { loadManifest, validateScenePlan } from "../src/shortform/scenePlan";
import { renderBar } from "../src/shortform/storyScore";
import { nearCopies } from "../src/shortform/conceptVariety";
import { VOICE_DIR, findSuppliedVoice } from "../scripts/video-factory/suppliedVoice";
import { buildVideoScriptFromScenePlan } from "../src/content/videoScriptWriter";
import { OFFICIAL_HANDLE } from "../src/shortform/types";

const manifest = loadManifest();
const explainer = (id: string) => EXPLAINER_PILOTS.find((p) => p.planId === id)!;
const sourceOf = (planId: string) => {
  const slug = planId.replace(/^after-(?:hook-)?\d+-/, "");
  return EXPLAINER_PILOTS.find((p) => p.planId.endsWith(`-${slug}`) && EXPLAINERS_OFFERED.includes(p.planId))!;
};
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);
const figures = (text: string) => text.match(/\$?\d[\d,.]*%?/g) ?? [];

describe("After the trade (team decision 2026-11-14)", () => {
  it("has one rule cut per offered explainer and seven strategy-hook cuts, every one resolvable by the catalog", () => {
    expect(RULE_CUTS).toHaveLength(EXPLAINERS_OFFERED.length);
    expect(HOOK_CUTS).toHaveLength(STRATEGY_HOOKS.length);
    for (const p of AFTER_THE_TRADE_PILOTS) expect(MOTION_SCENE_PLANS, p.planId).toContain(p);
    expect(new Set(AFTER_THE_TRADE_PILOTS.map((p) => p.planId)).size).toBe(AFTER_THE_TRADE_PILOTS.length);
    // A rule cut keeps its explainer's number, so after-06 is explain-06.
    for (const p of RULE_CUTS) expect(EXPLAINERS_OFFERED, p.planId).toContain(p.planId.replace(/^after-/, "explain-"));
  });

  it("are valid six-beat plans that clear the render bar, narrated like the explainers", () => {
    for (const p of AFTER_THE_TRADE_PILOTS) {
      expect(p.scenes, p.planId).toHaveLength(KEPT_BEATS.length);
      const v = validateScenePlan(p, manifest, { checkFiles: true });
      expect(v.issues.filter((i) => i.severity === "error"), p.planId).toEqual([]);
      expect(renderBar(p).ok, `${p.planId}: ${JSON.stringify(renderBar(p).fixes)}`).toBe(true);
      expect(isNarratedMockPlan(p), p.planId).toBe(true);
    }
  });

  it("plan 20 to 35 seconds, the format's length", () => {
    for (const p of AFTER_THE_TRADE_PILOTS) {
      const total = p.scenes.reduce((n, s) => n + s.durationSeconds, 0);
      expect(total, p.planId).toBeGreaterThanOrEqual(20);
      expect(total, p.planId).toBeLessThanOrEqual(35);
    }
  });

  it("keep the explainer's verified beats word for word, figures and evidence included", () => {
    for (const p of AFTER_THE_TRADE_PILOTS) {
      const src = sourceOf(p.planId);
      const from = isStrategyHookCut(p) ? 1 : 0;
      KEPT_BEATS.forEach((n, i) => {
        if (i < from) return;
        const kept = p.scenes[i]!;
        const orig = src.scenes[n - 1]!;
        expect(kept.narration, `${p.planId} beat ${i + 1}`).toBe(orig.narration);
        expect(kept.headline, `${p.planId} beat ${i + 1}`).toBe(orig.headline);
        expect(kept.disclosure, `${p.planId} beat ${i + 1}`).toBe(orig.disclosure);
        expect(kept.claims.map((c) => c.evidence), `${p.planId} beat ${i + 1}`).toEqual(orig.claims.map((c) => c.evidence));
      });
    }
  });

  it("close on exactly the agreed line and the handle, and invite nowhere else", () => {
    for (const p of AFTER_THE_TRADE_PILOTS) {
      const last = p.scenes[p.scenes.length - 1]!;
      expect(last.cta, p.planId).toBe(`${CLOSE_LINE} ${OFFICIAL_HANDLE}`);
      expect(p.scenes.filter((s) => s.cta).map((s) => s.sceneId), p.planId).toEqual([last.sceneId]);
    }
    expect(CLOSE_LINE).toBe("Review your trades and prop-firm rules with Fillbook.");
  });

  it("have titles of their own, so a made explainer never marks its cut as made by title", () => {
    const titles = MOTION_SCENE_PLANS.map((p) => p.title.toLowerCase());
    for (const p of AFTER_THE_TRADE_PILOTS) expect(titles.filter((t) => t === p.title.toLowerCase()), p.title).toHaveLength(1);
  });

  it("reuse the explainers' recorded parts: every rule cut has a file for every beat, and no new recording is needed", () => {
    for (const p of RULE_CUTS) {
      expect(p.voiceParts, p.planId).toEqual(KEPT_BEATS.map((n) => `${sourceOf(p.planId).planId}-${n}`));
      expect(findSuppliedVoice(p.planId, p.scenes.length, undefined, p.voiceParts)?.kind, p.planId).toBe("parts");
    }
  });

  it("mark a hook recorded exactly when its new opening line is on disk, and otherwise never offer it", () => {
    STRATEGY_HOOKS.forEach((h, i) => {
      const cut = HOOK_CUTS[i]!;
      expect(cut.voiceParts![0], cut.planId).toBe(`${cut.planId}-1`);
      const onDisk = ["mp3", "wav", "m4a"].some((ext) => existsSync(join(VOICE_DIR, `${cut.planId}-1.${ext}`)));
      expect(h.recorded, `${cut.planId}: recorded flag vs file on disk`).toBe(onDisk);
      expect(OFFERED_DAILY_CONCEPT_IDS.includes(cut.planId), cut.planId).toBe(h.recorded);
      expect(cut.voiceParts!.slice(1), cut.planId).toEqual(KEPT_BEATS.slice(1).map((n) => `${h.explainer}-${n}`));
    });
  });
});

describe("strategy hooks: a question about the account, never about the trade", () => {
  it("each open one offered explainer, at most one hook per explainer", () => {
    for (const h of STRATEGY_HOOKS) expect(EXPLAINERS_OFFERED, h.explainer).toContain(h.explainer);
    expect(new Set(STRATEGY_HOOKS.map((h) => h.explainer)).size).toBe(STRATEGY_HOOKS.length);
  });

  it("use no entry, level, target, direction or signal words", () => {
    for (const h of STRATEGY_HOOKS) for (const t of [h.headline, h.caption, h.say]) expect(t, h.explainer).not.toMatch(HOOK_FORBIDDEN_WORDS);
    for (const p of HOOK_CUTS) expect(p.scenes[0]!.narration, p.planId).not.toMatch(HOOK_FORBIDDEN_WORDS);
  });

  it("are one spoken sentence, a question, inside the card's limits", () => {
    for (const h of STRATEGY_HOOKS) {
      expect(sentences(h.say), h.say).toHaveLength(1);
      expect(h.say.trim().endsWith("?") || /\b(but|so)\b/i.test(h.say), h.say).toBe(true);
      expect(h.headline.length, h.headline).toBeLessThanOrEqual(34);
      expect(h.caption.length, h.caption).toBeLessThanOrEqual(110);
    }
  });

  it("never borrow the demo account's figures, so the drawn setup is never presented as their cause", () => {
    for (const p of HOOK_CUTS) {
      const hookFigures = figures(`${p.scenes[0]!.headline} ${p.scenes[0]!.narration} ${p.scenes[0]!.captionText}`);
      const demo = p.scenes.slice(1).map((s) => `${s.headline} ${s.narration} ${s.captionText}`).join(" ");
      for (const f of hookFigures) expect(demo.includes(f) && /\$|%/.test(f), `${p.planId}: hook figure ${f} also in the demo beats`).toBe(false);
      // The hook card carries no demo-data disclosure and no product data; its chart is a drawn illustration.
      expect(p.scenes[0]!.disclosure, p.planId).toBeNull();
      expect(p.scenes[0]!.chart, p.planId).toBeUndefined();
      expect(p.scenes[0]!.teach?.chart, p.planId).toBeDefined();
    }
  });

  it("draw the strategy videos' own illustrations, with no Entry marker on them", () => {
    for (const h of STRATEGY_HOOKS) {
      const chart = hookChart(h);
      expect(chart.overlays.some((o) => o.kind === "marker"), h.chartFrom).toBe(false);
    }
  });

  it("say on the caption and description that the chart is an illustration and the figures are demo data", () => {
    for (const p of HOOK_CUTS) {
      const v = buildVideoScriptFromScenePlan(p);
      expect(v.tiktokCaption, p.planId).toMatch(/illustration, not a recommendation/i);
      expect(v.tiktokCaption, p.planId).toMatch(/demo account data/i);
      expect(v.youtubeDescription, p.planId).toMatch(/drawn illustration, not a real market and not a recommendation/i);
    }
    for (const p of RULE_CUTS) expect(buildVideoScriptFromScenePlan(p).tiktokCaption, p.planId).not.toMatch(/illustration/i);
  });
});

describe("the offered order", () => {
  it("is the 20 rule cuts in the explainers' day order while no hook is recorded", () => {
    expect(STRATEGY_HOOKS.every((h) => !h.recorded)).toBe(true);
    expect([...AFTER_THE_TRADE_ORDER]).toEqual(RULE_CUTS.map((p) => p.planId));
    expect([...OFFERED_DAILY_CONCEPT_IDS]).toEqual([...AFTER_THE_TRADE_ORDER]);
    expect(MOTION_SCENE_PLANS.filter(isOfferedPlan).every((p) => p.planId.startsWith("after-"))).toBe(true);
  });

  it("puts a recorded hook cut every third place, in place of its explainer's rule cut, deterministically", () => {
    const allRecorded = STRATEGY_HOOKS.map((h) => ({ ...h, recorded: true }));
    const order = afterTheTradeOrder(allRecorded);
    expect(order).toEqual(afterTheTradeOrder(allRecorded));
    expect(order).toHaveLength(EXPLAINERS_OFFERED.length);
    order.forEach((id, i) => {
      // While rule cuts last (13 of them with all 7 hooks recorded), every third place is a hook; the last hook follows them.
      if (i < 18) expect(id.startsWith("after-hook-"), `place ${i + 1}: ${id}`).toBe((i + 1) % 3 === 0);
    });
    // Each explainer once: its hook cut or its rule cut, never both.
    const slugs = order.map((id) => id.replace(/^after-(?:hook-)?\d+-/, ""));
    expect(new Set(slugs).size).toBe(order.length);
    // With only some hooks recorded, those take every third place and the rest stay rule cuts.
    const two = STRATEGY_HOOKS.map((h, i) => ({ ...h, recorded: i < 2 }));
    const partial = afterTheTradeOrder(two);
    expect(partial.filter((id) => id.startsWith("after-hook-"))).toEqual([HOOK_CUTS[0]!.planId, HOOK_CUTS[1]!.planId]);
    expect(partial[2]).toBe(HOOK_CUTS[0]!.planId);
    expect(partial[5]).toBe(HOOK_CUTS[1]!.planId);
  });

  it("never offers two near-copies, and treats each cut as a near-copy of its own explainer (a made explainer hides its cut)", () => {
    const offered = OFFERED_DAILY_CONCEPT_IDS.map((id) => MOTION_SCENE_PLANS.find((p) => p.planId === id)!);
    for (let i = 0; i < offered.length; i++) for (let j = 0; j < i; j++) expect(nearCopies(offered[i]!, offered[j]!), `${offered[i]!.planId} ~ ${offered[j]!.planId}`).toBe(false);
    for (const p of AFTER_THE_TRADE_PILOTS) expect(nearCopies(p, sourceOf(p.planId)), p.planId).toBe(true);
    for (const [i, h] of STRATEGY_HOOKS.entries()) expect(nearCopies(HOOK_CUTS[i]!, RULE_CUTS.find((r) => r.planId.endsWith(h.explainer.replace(/^explain-\d+/, "")))!)).toBe(true);
    expect(explainer(STRATEGY_HOOKS[0]!.explainer)).toBeDefined();
  });
});
